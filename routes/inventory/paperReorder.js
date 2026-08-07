import express from "express";
import mongoose from "mongoose";
import PaperStock from "../../models/inventory/PaperStock.js";
import PendingProduction from "../../models/inventory/PendingProduction.js";
import ProductionBinding from "../../models/utilities/productionBinding.js";
import Die from "../../models/utilities/die_model.js";
import LabelSalesOrder from "../../models/inventory/LabelSalesOrder.js";
import ColorLabelSalesOrder from "../../models/inventory/ColorLabelSalesOrder.js";

const router = express.Router();

const STANDARD_ROLL_METERS = 1000;

// Same formula as formatRunningMeters/computeRequiredRolls in
// routes/system/machine.js (the Assign Production / machine queue figure) —
// duplicated rather than imported since that file doesn't export them.
// Repeat length (m) = (Label Height + Label Gap, mm) / 1000; a standard
// 1000 m roll holds (1000 / repeat length) x Across Ups labels.
function requiredRunningMeters(balanceQty, item, die) {
  const qty = Number(balanceQty) || 0;
  const across = Number(die?.dieFlatAcross);
  const repeatLengthM = ((Number(item?.labelHeight) || 0) + (Number(item?.labelGap) || 0)) / 1000;
  if (!qty || !across || !repeatLengthM) return null;
  const capacityPerRoll = (STANDARD_ROLL_METERS / repeatLengthM) * across;
  return Math.round((qty / capacityPerRoll) * STANDARD_ROLL_METERS);
}

// Derived straight from Required Mtrs (a flat 1000 m per roll) rather than
// its own independent calc off the die/label geometry -- so this column can
// never disagree with the Required Mtrs figure next to it; a roll is just
// however many whole 1000 m lengths that requirement rounds up to.
function requiredRolls(mtrs) {
  if (mtrs == null) return null;
  return Math.ceil(mtrs / STANDARD_ROLL_METERS);
}

// A paper "spec" for stock purposes is vendor + prod code + family + size —
// the same identity getPaperStockSummary() in routes/fairdesk_route.js uses,
// since size lives on PaperStock rather than on the Paper master.
function paperKey(vendorName, prodCode, family, paperSize) {
  return [vendorName, prodCode, family, paperSize]
    .map((v) => String(v || "").trim().toUpperCase())
    .join("||");
}

function newGroup(key, vendorName, prodCode, family, paperSize) {
  return {
    key,
    vendorName: vendorName || "",
    prodCode: prodCode || "",
    family: family || "",
    paperSize: paperSize || "",
    paperId: null,
    paperProductId: "",
    availableRolls: 0,
    availableMtrs: 0,
    wipAllottedMtrs: 0,
    requiredMtrs: 0,
    requiredRolls: 0,
    hasIncompleteRequirement: false,
    orders: [],
  };
}

// Paper re-order for production: which paper specs are short, given what's on
// hand right now against the running metres every still-unassigned sales
// order will need. Demand is Pending Production only (see
// GET /labels/production/pending) — orders already assigned to a machine have
// already had reels earmarked for them (allottedRollIds), so they're
// subtracted out of availability below instead of counted as fresh demand.
router.get("/paper-reorder", async (req, res) => {
  try {
    const pendingOrders = await PendingProduction.find({ assignedMachineId: null })
      .populate({ path: "userId", select: "clientName userName" })
      .populate({ path: "itemId", select: "productId clientName userName labelHeight labelGap labelWidth jobType paperType" })
      .sort({ createdAt: 1 })
      .lean();

    const labelOrderIds = pendingOrders.filter((o) => o.onModel === "Label").map((o) => o._id);
    const colorLabelOrderIds = pendingOrders.filter((o) => o.onModel === "ColorLabel").map((o) => o._id);

    const [labelOrders, colorLabelOrders] = await Promise.all([
      labelOrderIds.length ? LabelSalesOrder.find({ _id: { $in: labelOrderIds } }).select("poDate createdAt").lean() : [],
      colorLabelOrderIds.length ? ColorLabelSalesOrder.find({ _id: { $in: colorLabelOrderIds } }).select("poDate createdAt").lean() : [],
    ]);

    const poDateMap = new Map([
      ...labelOrders.map((o) => [String(o._id), o.poDate || o.createdAt]),
      ...colorLabelOrders.map((o) => [String(o._id), o.poDate || o.createdAt]),
    ]);

    const userIds = [...new Set(pendingOrders.map((o) => String(o.userId?._id || "")).filter(Boolean))];
    const itemIds = [...new Set(pendingOrders.map((o) => String(o.itemId?._id || "")).filter(Boolean))];

    // A Production Binding names the paper spec + die for a given client+label
    // -- same lookup routes/fairdesk_route.js's Assign Production route uses,
    // done here in bulk for every pending order at once.
    const bindings = userIds.length && itemIds.length
      ? await ProductionBinding.find({ userId: { $in: userIds }, labelProductId: { $in: itemIds } })
          .sort({ _id: -1 })
          .lean()
      : [];
    const bindingMap = new Map();
    for (const b of bindings) {
      const key = `${b.userId}||${b.labelProductId}`;
      if (!bindingMap.has(key)) bindingMap.set(key, b); // most recent binding wins
    }

    const dieIds = [...new Set(
      [...bindingMap.values()].map((b) => String(b.dieId || "")).filter((id) => mongoose.isValidObjectId(id)),
    )];
    const dies = dieIds.length
      ? await Die.find({ _id: { $in: dieIds } }).select("dieFlatAcross dieDieNo").lean()
      : [];
    const dieMap = new Map(dies.map((d) => [String(d._id), d]));

    const paperGroups = new Map();
    const unbound = [];

    for (const order of pendingOrders) {
      const item = order.itemId || {};
      const balance = Math.max((Number(order.quantity) || 0) - (Number(order.dispatchedQuantity) || 0), 0);
      if (!balance) continue;

      const binding = bindingMap.get(`${order.userId?._id}||${item._id}`);
      const clientName = order.userId?.clientName || item.clientName || "N/A";

      if (!binding || !binding.prodPaperCode || !binding.prodVendorName || !binding.prodPaperSize) {
        unbound.push({
          orderId: String(order._id),
          productId: item.productId || "N/A",
          clientName,
          poNumber: order.poNumber || "",
          balanceQty: balance,
        });
        continue;
      }

      const die = dieMap.get(String(binding.dieId));
      const mtrs = requiredRunningMeters(balance, item, die);
      const rolls = requiredRolls(mtrs);

      const key = paperKey(binding.prodVendorName, binding.prodPaperCode, binding.prodPaperFamily, binding.prodPaperSize);
      if (!paperGroups.has(key)) {
        paperGroups.set(
          key,
          newGroup(key, binding.prodVendorName, binding.prodPaperCode, binding.prodPaperFamily, binding.prodPaperSize),
        );
      }
      const group = paperGroups.get(key);
      if (mtrs == null) {
        group.hasIncompleteRequirement = true; // die missing an Across Ups figure -- can't size this order
      } else {
        // Rolls for the group are derived once from the group's total metres
        // below (not summed here) -- summing each order's own rounded-up
        // roll count would generally overstate the group figure (two orders
        // needing 400 m each round up to 1 roll apiece, i.e. 2, but together
        // they only need ceil(800/1000) = 1), and would make this column
        // disagree with Required Mtrs the same way it did before this fix.
        group.requiredMtrs += mtrs;
      }
      group.orders.push({
        orderId: String(order._id),
        productId: item.productId || "N/A",
        clientName,
        poNumber: order.poNumber || "",
        poDate: poDateMap.get(String(order._id)) || null,
        balanceQty: balance,
        requiredMtrs: mtrs,
        requiredRolls: rolls,
        dieNo: die?.dieDieNo || "",
        labelWidth: item.labelWidth || "",
        labelHeight: item.labelHeight || "",
      });
    }

    // Supply side, grouped the same way.
    const stockRows = await PaperStock.find({ quantity: { $gt: 0 } })
      .select("paper paperSize quantity paperMtrs")
      .populate({ path: "paper", select: "vendorName prodCode family paperProductId" })
      .lean();

    for (const row of stockRows) {
      const p = row.paper;
      if (!p) continue;
      const key = paperKey(p.vendorName, p.prodCode, p.family, row.paperSize);
      if (!paperGroups.has(key)) {
        paperGroups.set(key, newGroup(key, p.vendorName, p.prodCode, p.family, row.paperSize));
      }
      const group = paperGroups.get(key);
      group.paperId = group.paperId || String(p._id);
      group.paperProductId = group.paperProductId || p.paperProductId || "";
      group.availableRolls += Number(row.quantity) || 0;
      group.availableMtrs += Number(row.paperMtrs) || 0;
    }

    // Reels already earmarked for a WIP order (assigned to a machine, not yet
    // run) are on hand but not actually free for the pending orders below --
    // same "allotted" reasoning as getPaperStockSummary() in
    // routes/fairdesk_route.js, in running metres rather than roll count.
    const wipOrders = await PendingProduction.find(
      // producedAt: null -- a finished job's unconsumed rolls are no longer a
      // live claim on this paper.
      { assignedMachineId: { $ne: null }, producedAt: null, allottedRollIds: { $exists: true, $ne: [] } },
      { allottedRollIds: 1 },
    ).lean();
    const claimedRollIds = [...new Set(wipOrders.flatMap((o) => (o.allottedRollIds || []).map(String)))];
    if (claimedRollIds.length) {
      const claimedRolls = await PaperStock.find({ _id: { $in: claimedRollIds } })
        .select("paper paperSize paperMtrs")
        .populate({ path: "paper", select: "vendorName prodCode family" })
        .lean();
      for (const roll of claimedRolls) {
        const p = roll.paper;
        if (!p) continue;
        const group = paperGroups.get(paperKey(p.vendorName, p.prodCode, p.family, roll.paperSize));
        if (group) group.wipAllottedMtrs += Number(roll.paperMtrs) || 0;
      }
    }

    const groups = [...paperGroups.values()].map((g) => {
      const effectiveMtrs = g.availableMtrs - g.wipAllottedMtrs;
      const balanceMtrs = effectiveMtrs - g.requiredMtrs;
      const paperSizeNum = Number(g.paperSize) || 0;
      const groupRequiredRolls = requiredRolls(g.requiredMtrs);
      return {
        ...g,
        effectiveMtrs,
        balanceMtrs,
        requiredRolls: groupRequiredRolls,
        // Sq Mtrs = Required Rolls x Size -- how much roll-width area the
        // required rolls for this paper spec work out to.
        sqMtrs: (groupRequiredRolls || 0) * paperSizeNum,
        shortage: balanceMtrs < 0,
        _children: g.orders.map((o) => ({
          orderId: o.orderId,
          productId: o.productId,
          clientName: o.clientName,
          poNumber: o.poNumber,
          poDate: o.poDate,
          balanceQty: o.balanceQty,
          requiredMtrs: o.requiredMtrs,
          requiredRolls: o.requiredRolls,
          sqMtrs: (o.requiredRolls || 0) * paperSizeNum,
          dieNo: o.dieNo,
          labelWidth: o.labelWidth,
          labelHeight: o.labelHeight,
        })),
      };
    });

    // Shortages first (worst shortfall leading), then busiest specs, then the rest.
    groups.sort((a, b) => {
      if (a.shortage !== b.shortage) return a.shortage ? -1 : 1;
      if (a.shortage) return a.balanceMtrs - b.balanceMtrs;
      return b.requiredMtrs - a.requiredMtrs;
    });

    const totalSqMtrs = groups.reduce((sum, g) => sum + (g.sqMtrs || 0), 0);

    // Opened from the Purchase (Re-Order) tab: this is a buying view, so the
    // "no Production Binding on file" pending list isn't relevant there -- it
    // belongs to the Production tab's copy of this page. Suppress it here.
    const showUnbound = req.query.from !== "purchase";

    res.render("inventory/orders/paperReorder.ejs", {
      title: "Paper Re-Order",
      groups,
      unbound: showUnbound ? unbound : [],
      totalSqMtrs,
      CSS: "tableDisp.css",
      JS: false,
      notification: req.flash("notification"),
    });
  } catch (err) {
    console.error("PAPER REORDER ROUTE ERROR:", err);
    res.status(500).send("Internal Server Error");
  }
});

export default router;
