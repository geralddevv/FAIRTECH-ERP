import express from "express";
import mongoose from "mongoose";
import PaperStock from "../../models/inventory/PaperStock.js";
import PendingProduction from "../../models/inventory/PendingProduction.js";
import ProductionBinding from "../../models/utilities/productionBinding.js";
import Die from "../../models/utilities/die_model.js";

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

function requiredRolls(balanceQty, item, die) {
  const across = Number(die?.dieFlatAcross);
  const repeatLengthM = ((Number(item?.labelHeight) || 0) + (Number(item?.labelGap) || 0)) / 1000;
  if (!balanceQty || !across || !repeatLengthM) return null;
  const capacityPerRoll = (STANDARD_ROLL_METERS / repeatLengthM) * across;
  return Math.ceil(balanceQty / capacityPerRoll);
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
      const rolls = requiredRolls(balance, item, die);

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
        group.requiredMtrs += mtrs;
        group.requiredRolls += rolls || 0;
      }
      group.orders.push({
        orderId: String(order._id),
        productId: item.productId || "N/A",
        clientName,
        poNumber: order.poNumber || "",
        balanceQty: balance,
        requiredMtrs: mtrs,
        requiredRolls: rolls,
        dieNo: die?.dieDieNo || "",
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
      { assignedMachineId: { $ne: null }, allottedRollIds: { $exists: true, $ne: [] } },
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
      return {
        ...g,
        effectiveMtrs,
        balanceMtrs,
        shortage: balanceMtrs < 0,
        _children: g.orders.map((o) => ({
          productId: o.productId,
          clientName: o.clientName,
          poNumber: o.poNumber,
          balanceQty: o.balanceQty,
          requiredMtrs: o.requiredMtrs,
          requiredRolls: o.requiredRolls,
          dieNo: o.dieNo,
          assignLink: `/fairtech/labels/production/assign/${o.orderId}`,
        })),
      };
    });

    // Shortages first (worst shortfall leading), then busiest specs, then the rest.
    groups.sort((a, b) => {
      if (a.shortage !== b.shortage) return a.shortage ? -1 : 1;
      if (a.shortage) return a.balanceMtrs - b.balanceMtrs;
      return b.requiredMtrs - a.requiredMtrs;
    });

    res.render("inventory/orders/paperReorder.ejs", {
      title: "Paper Re-Order",
      groups,
      unbound,
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
