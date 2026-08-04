import express from "express";
import mongoose from "mongoose";
import LabelMaster from "../../models/inventory/labelMaster.js";
import OutSourceStock from "../../models/inventory/OutSourceStock.js";
import OutSourceStockLog from "../../models/inventory/OutSourceStockLog.js";
import Location from "../../models/system/location.js";
import { requireAuth } from "../../middleware/auth.js";
import { createLimiter } from "../../utils/limiters.js";

const router = express.Router();

/* RENDER — pick a master label + location, see the balance, add inward stock. */
router.get("/", async (req, res) => {
  try {
    const [masters, locations] = await Promise.all([
      LabelMaster.find()
        .sort({ labelProductId: 1 })
        .select("labelProductId jobName labelFamily labelWidth labelHeight labelGap labelUps labelCore perRollQty")
        .lean(),
      Location.distinct("locationName"),
    ]);

    res.render("stock/outsourceStock", {
      title: "Out Source Stock",
      CSS: false,
      JS: false,
      notification: req.flash("notification"),
      masters,
      locations,
    });
  } catch (err) {
    console.error(err);
    res.redirect("/fairtech");
  }
});

/* BALANCE for one master + location (labels). */
router.get("/balance/:masterId/:location", async (req, res) => {
  try {
    const { masterId, location } = req.params;
    if (!mongoose.isValidObjectId(masterId)) {
      return res.status(400).json({ error: "Invalid master ID." });
    }

    const bal = await OutSourceStock.aggregate([
      { $match: { master: new mongoose.Types.ObjectId(masterId), location } },
      { $group: { _id: null, qty: { $sum: "$quantity" } } },
    ]);

    res.json({ stock: bal[0]?.qty || 0 });
  } catch (err) {
    console.error("OUTSOURCE STOCK BALANCE ERROR:", err);
    res.status(500).json({ error: "Failed to fetch stock balance." });
  }
});

/* STOCK INFO — per-location balances for a master, across all locations. */
router.get("/stock-info/:masterId", async (req, res) => {
  try {
    const { masterId } = req.params;
    if (!mongoose.isValidObjectId(masterId)) {
      return res.json({ totalStock: 0, booked: 0, balance: 0, locations: [] });
    }
    const masterObjectId = new mongoose.Types.ObjectId(masterId);

    const stockAggregation = await OutSourceStock.aggregate([
      { $match: { master: masterObjectId } },
      {
        $group: {
          _id: { location: { $toUpper: { $ifNull: ["$location", "UNKNOWN"] } } },
          qty: { $sum: "$quantity" },
        },
      },
      { $sort: { "_id.location": 1 } },
    ]);

    const stockMap = Object.fromEntries(
      stockAggregation.map((row) => [String(row._id?.location || "UNKNOWN"), Number(row.qty || 0)]),
    );

    const locations = await Location.distinct("locationName");
    const allLocations = Array.from(
      new Set([
        ...locations.map((location) => String(location || "").trim().toUpperCase()).filter(Boolean),
        ...Object.keys(stockMap),
      ]),
    ).sort((a, b) => a.localeCompare(b));

    let totalStock = 0;
    const stockInfoLocations = allLocations.map((location) => {
      const qty = Number(stockMap[location] || 0);
      totalStock += qty;
      // "booked" (order-dispatch consumption) is wired in a later pass; there is
      // no Out Source order flow yet, so booked is genuinely 0 for now.
      return { location, qty, booked: 0, balance: qty };
    });

    return res.json({
      totalStock,
      booked: 0,
      balance: totalStock,
      locations: stockInfoLocations,
    });
  } catch (err) {
    console.error("OUTSOURCE STOCK INFO ERROR:", err);
    return res.json({ totalStock: 0, booked: 0, balance: 0, locations: [] });
  }
});

/* CREATE (INWARD ONLY) */
router.post("/create", requireAuth, createLimiter, async (req, res) => {
  try {
    const { masterId, location, quantity, remarks } = req.body;
    const qty = Number(quantity);

    if (!masterId || !location || !(qty > 0)) {
      return res.status(400).json({ success: false, message: "Invalid stock entry" });
    }
    if (!mongoose.isValidObjectId(masterId)) {
      return res.status(400).json({ success: false, message: "Invalid master label" });
    }

    const masterObjectId = new mongoose.Types.ObjectId(masterId);

    /* CURRENT STOCK */
    const bal = await OutSourceStock.aggregate([
      { $match: { master: masterObjectId, location } },
      { $group: { _id: null, qty: { $sum: "$quantity" } } },
    ]);

    const openingStock = bal[0]?.qty || 0;
    const closingStock = openingStock + qty;

    /* INSERT STOCK */
    await OutSourceStock.create({
      master: masterObjectId,
      location,
      quantity: qty,
      remarks,
    });

    /* LOG ENTRY */
    await OutSourceStockLog.create({
      master: masterObjectId,
      location,
      openingStock,
      quantity: qty,
      closingStock,
      type: "INWARD",
      source: "MANUAL",
      remarks,
      createdBy: req.user?.username || "SYSTEM",
    });

    const masterDoc = await LabelMaster.findById(masterObjectId).select("labelProductId").lean();
    res.locals.auditDescription = `Added ${qty} out source label stock for "${masterDoc?.labelProductId || masterId}" at "${location}"`;
    req.flash("notification", "Out Source stock added successfully");
    res.redirect("/fairtech/outsourcestock");
  } catch (err) {
    console.error(err);
    res.status(400).json({ success: false, message: "Failed to add out source stock" });
  }
});

export default router;
