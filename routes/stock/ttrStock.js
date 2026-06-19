import express from "express";
import mongoose from "mongoose";
import TtrStock from "../../models/inventory/TtrStock.js";
import TtrStockLog from "../../models/inventory/TtrStockLog.js";
import TapeSalesOrder from "../../models/inventory/TapeSalesOrder.js";
import Location from "../../models/system/location.js";
import Ttr from "../../models/inventory/ttr.js";
import { requireAuth } from "../../middleware/auth.js";
import { createLimiter, updateLimiter, deleteLimiter } from "../../utils/limiters.js";

const router = express.Router();

const STOCK_FILTER_KEYS = [
  "ttrType",
  "ttrColor",
  "ttrMaterialCode",
  "ttrWidth",
  "ttrMtrs",
  "ttrInkFace",
  "ttrCoreId",
  "ttrCoreLength",
  "ttrNotch",
  "ttrWinding",
];

const trimOr = (value, fallback = "") => {
  if (value === undefined || value === null) return fallback;
  const out = String(value).trim();
  return out === "" ? fallback : out;
};

async function loadFsTtrRows() {
  const masters = await Ttr.find({})
    .select("ttrProductId ttrType ttrMaterialCode ttrColor ttrWidth ttrMtrs ttrInkFace ttrCoreId ttrCoreLength ttrNotch ttrWinding")
    .lean();

  return masters
    .map((master) => ({
      ttrId: master?._id?.toString() || "",
      ttrProductId: trimOr(master?.ttrProductId),
      ttrType: trimOr(master?.ttrType),
      ttrColor: trimOr(master?.ttrColor),
      ttrMaterialCode: trimOr(master?.ttrMaterialCode),
      ttrWidth: trimOr(master?.ttrWidth),
      ttrMtrs: trimOr(master?.ttrMtrs),
      ttrInkFace: trimOr(master?.ttrInkFace),
      ttrCoreId: trimOr(master?.ttrCoreId),
      ttrCoreLength: trimOr(master?.ttrCoreLength),
      ttrNotch: trimOr(master?.ttrNotch),
      ttrWinding: trimOr(master?.ttrWinding),
    }))
    .filter(
      (row) =>
        row.ttrId &&
        row.ttrType &&
        row.ttrColor &&
        row.ttrMaterialCode &&
        row.ttrWidth &&
        row.ttrMtrs &&
        row.ttrInkFace &&
        row.ttrCoreId &&
        row.ttrCoreLength &&
        row.ttrNotch &&
        row.ttrWinding,
    );
}

async function loadLocationStockMap(ttrId) {
  const stockAggregation = await TtrStock.aggregate([
    { $match: { ttr: new mongoose.Types.ObjectId(ttrId) } },
    {
      $group: {
        _id: { location: { $toUpper: { $ifNull: ["$location", "UNKNOWN"] } } },
        qty: { $sum: "$quantity" },
      },
    },
    { $sort: { "_id.location": 1 } },
  ]);

  const rawMap = Object.fromEntries(
    stockAggregation.map((row) => [String(row._id?.location || "UNKNOWN"), Number(row.qty || 0)]),
  );

  const bookedAggregation = await TapeSalesOrder.aggregate([
    {
      $match: {
        onModel: "Ttr",
        tapeId: new mongoose.Types.ObjectId(ttrId),
        status: { $nin: ["CANCELLED"] },
      },
    },
    {
      $group: {
        _id: { location: { $toUpper: { $ifNull: ["$sourceLocation", "UNKNOWN"] } } },
        bookedQty: { $sum: { $subtract: ["$quantity", { $ifNull: ["$dispatchedQuantity", 0] }] } },
      },
    },
  ]);

  const bookedMap = Object.fromEntries(
    bookedAggregation.map((row) => [String(row._id?.location || "UNKNOWN"), Number(row.bookedQty || 0)]),
  );

  const locations = await Location.distinct("locationName");
  const normalizedLocations = locations
    .map((location) => trimOr(location).toUpperCase())
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b));

  const stockLocations = Array.from(new Set([...Object.keys(rawMap), ...Object.keys(bookedMap), ...normalizedLocations]))
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b));

  let totalStock = 0;
  let totalBooked = 0;

  const stockInfoLocations = stockLocations.map((location) => {
    const qty = Number(rawMap[location] || 0);
    const booked = Number(bookedMap[location] || 0);
    const balance = qty - booked;
    totalStock += qty;
    totalBooked += booked;
    return {
      location,
      qty,
      booked,
      balance,
    };
  });

  return {
    totalStock,
    booked: totalBooked,
    balance: totalStock - totalBooked,
    locations: stockInfoLocations,
  };
}

function distinctValues(rows, key) {
  const values = new Set();
  rows.forEach((row) => {
    const value = trimOr(row[key]);
    if (value) values.add(value);
  });
  return Array.from(values);
}

function rowMatchesFilters(row, selected, excludeKey = "") {
  for (const key of STOCK_FILTER_KEYS) {
    if (key === excludeKey) continue;
    const selectedValue = trimOr(selected[key]);
    if (!selectedValue) continue;
    if (trimOr(row[key]) !== selectedValue) return false;
  }
  return true;
}

/* RENDER */
router.get("/", async (req, res) => {
  try {
    const fsRows = await loadFsTtrRows();
    const types = distinctValues(fsRows, "ttrType");
    const colors = distinctValues(fsRows, "ttrColor");
    const materialCodes = distinctValues(fsRows, "ttrMaterialCode");
    const widths = distinctValues(fsRows, "ttrWidth");
    const mtrsList = distinctValues(fsRows, "ttrMtrs");
    const inkFaces = distinctValues(fsRows, "ttrInkFace");
    const coreIds = distinctValues(fsRows, "ttrCoreId");
    const coreLengths = distinctValues(fsRows, "ttrCoreLength");
    const notches = distinctValues(fsRows, "ttrNotch");
    const windings = distinctValues(fsRows, "ttrWinding");

    const locations = await Location.distinct("locationName");

    res.render("stock/ttrStock.ejs", {
      title: "TTR Stock",
      CSS: false,
      JS: false,
      notification: req.flash("notification"),
      types,
      colors,
      materialCodes,
      widths,
      mtrsList,
      inkFaces,
      coreIds,
      coreLengths,
      notches,
      windings,
      locations,
    });
  } catch (err) {
    console.error(err);
    res.redirect("/fairdesk");
  }
});

/* FILTER SPECS */
router.get("/filter-specs", async (req, res) => {
  try {
    const selected = {
      ttrType: trimOr(req.query.ttrType),
      ttrColor: trimOr(req.query.ttrColor),
      ttrMaterialCode: trimOr(req.query.ttrMaterialCode),
      ttrWidth: trimOr(req.query.ttrWidth),
      ttrMtrs: trimOr(req.query.ttrMtrs),
      ttrInkFace: trimOr(req.query.ttrInkFace),
      ttrCoreId: trimOr(req.query.ttrCoreId),
      ttrCoreLength: trimOr(req.query.ttrCoreLength),
      ttrNotch: trimOr(req.query.ttrNotch),
      ttrWinding: trimOr(req.query.ttrWinding),
    };

    const fsRows = await loadFsTtrRows();
    const types = distinctValues(fsRows.filter((row) => rowMatchesFilters(row, selected, "ttrType")), "ttrType");
    const colors = distinctValues(fsRows.filter((row) => rowMatchesFilters(row, selected, "ttrColor")), "ttrColor");
    const materialCodes = distinctValues(
      fsRows.filter((row) => rowMatchesFilters(row, selected, "ttrMaterialCode")),
      "ttrMaterialCode",
    );
    const widths = distinctValues(fsRows.filter((row) => rowMatchesFilters(row, selected, "ttrWidth")), "ttrWidth");
    const mtrsList = distinctValues(fsRows.filter((row) => rowMatchesFilters(row, selected, "ttrMtrs")), "ttrMtrs");
    const inkFaces = distinctValues(
      fsRows.filter((row) => rowMatchesFilters(row, selected, "ttrInkFace")),
      "ttrInkFace",
    );
    const coreIds = distinctValues(fsRows.filter((row) => rowMatchesFilters(row, selected, "ttrCoreId")), "ttrCoreId");
    const coreLengths = distinctValues(
      fsRows.filter((row) => rowMatchesFilters(row, selected, "ttrCoreLength")),
      "ttrCoreLength",
    );
    const notches = distinctValues(fsRows.filter((row) => rowMatchesFilters(row, selected, "ttrNotch")), "ttrNotch");
    const windings = distinctValues(
      fsRows.filter((row) => rowMatchesFilters(row, selected, "ttrWinding")),
      "ttrWinding",
    );

    res.json({
      types,
      colors,
      materialCodes,
      widths,
      mtrsList,
      inkFaces,
      coreIds,
      coreLengths,
      notches,
      windings,
    });
  } catch (err) {
    console.error("FILTER ERROR:", err);
    res.status(500).json({});
  }
});

/* RESOLVE TTR */
router.post("/resolve", async (req, res) => {
  try {
    const { type, color, materialCode, width, mtrs, inkFace, coreId, coreLength, notch, winding } = req.body;
    const selected = {
      ttrType: trimOr(type),
      ttrColor: trimOr(color),
      ttrMaterialCode: trimOr(materialCode),
      ttrWidth: trimOr(width),
      ttrMtrs: trimOr(mtrs),
      ttrInkFace: trimOr(inkFace),
      ttrCoreId: trimOr(coreId),
      ttrCoreLength: trimOr(coreLength),
      ttrNotch: trimOr(notch),
      ttrWinding: trimOr(winding),
    };

    if (Object.values(selected).some((v) => !v)) {
      return res.json({ found: false });
    }

    const fsRows = await loadFsTtrRows();
    const resolved = fsRows.find((row) => rowMatchesFilters(row, selected));

    if (!resolved) return res.json({ found: false });

    return res.json({
      found: true,
      ttrId: resolved.ttrId,
      TtrProductId: resolved.ttrProductId || resolved.ttrMaterialCode,
    });
  } catch (err) {
    console.error("Resolve error ❌", err);
    return res.json({ found: false });
  }
});

/* BALANCE */
router.get("/balance/:ttrId/:location", async (req, res) => {
  try {
    const { ttrId, location } = req.params;

    const bal = await TtrStock.aggregate([
      { $match: { ttr: new mongoose.Types.ObjectId(ttrId), location } },
      { $group: { _id: null, qty: { $sum: "$quantity" } } },
    ]);

    res.json({ stock: bal[0]?.qty || 0 });
  } catch (err) {
    console.error("Balance error", err);
    res.json({ stock: 0 });
  }
});

router.get("/stock-info/:ttrId", async (req, res) => {
  try {
    const { ttrId } = req.params;
    const stockInfo = await loadLocationStockMap(ttrId);
    res.json(stockInfo);
  } catch (err) {
    console.error("Stock info error", err);
    res.json({ totalStock: 0, locations: [] });
  }
});

/* CREATE (INWARD ONLY) */
router.post("/create", requireAuth, createLimiter, async (req, res) => {
  try {
    const { ttrId, location, quantity, remarks } = req.body;
    const qty = Number(quantity);

    // STRONG VALIDATION
    if (!ttrId || !location || qty <= 0) {
      return res.status(400).json({ success: false, message: "Invalid stock entry" });
    }

    const ttrObjectId = new mongoose.Types.ObjectId(ttrId);

    /* CURRENT STOCK */
    const bal = await TtrStock.aggregate([
      { $match: { ttr: ttrObjectId, location } },
      { $group: { _id: null, qty: { $sum: "$quantity" } } },
    ]);

    const openingStock = bal[0]?.qty || 0;
    const closingStock = openingStock + qty;

    /* INSERT STOCK */
    await TtrStock.create({
      ttr: ttrObjectId,
      location,
      quantity: qty,
      remarks,
    });

    /* LOG ENTRY */
    await TtrStockLog.create({
      ttr: ttrObjectId,
      location,
      openingStock,
      quantity: qty,
      closingStock,
      type: "INWARD",
      source: "MANUAL",
      remarks,
      createdBy: req.user?.username || "SYSTEM",
    });

    req.flash("notification", "TTR stock added successfully");
    res.redirect("/fairdesk/ttrstock");
  } catch (err) {
    console.error(err);
    res.status(400).json({ success: false, message: "Failed to add TTR stock" });
  }
});

export default router;
