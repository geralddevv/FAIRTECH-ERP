import express from "express";
import mongoose from "mongoose";
import Tape from "../../models/inventory/tape.js";
import PosRoll from "../../models/inventory/posRoll.js";
import Tafeta from "../../models/inventory/tafeta.js";
import Ttr from "../../models/inventory/ttr.js";
import TapeStock from "../../models/inventory/TapeStock.js";
import TapeStockLog from "../../models/inventory/TapeStockLog.js";
import PosRollStock from "../../models/inventory/PosRollStock.js";
import PosRollStockLog from "../../models/inventory/PosRollStockLog.js";
import TafetaStock from "../../models/inventory/TafetaStock.js";
import TafetaStockLog from "../../models/inventory/TafetaStockLog.js";
import TtrStock from "../../models/inventory/TtrStock.js";
import TtrStockLog from "../../models/inventory/TtrStockLog.js";
import TapeSalesOrder from "../../models/inventory/TapeSalesOrder.js";
import { requireAuth } from "../../middleware/auth.js";
import { createLimiter, updateLimiter, deleteLimiter } from "../../utils/limiters.js";

const router = express.Router();

const toUpperLocation = (value) => String(value || "UNKNOWN").trim().toUpperCase() || "UNKNOWN";
const toNumber = (value) => Number(value || 0);
const idString = (value) => String(value || "");

const STOCK_CONFIG = {
  Tape: {
    stockModel: TapeStock,
    logModel: TapeStockLog,
    itemField: "tape",
    itemLabel: "Tape",
    onModel: "Tape",
  },
  "POS Roll": {
    stockModel: PosRollStock,
    logModel: PosRollStockLog,
    itemField: "posRoll",
    itemLabel: "POS Roll",
    onModel: "PosRoll",
  },
  Tafeta: {
    stockModel: TafetaStock,
    logModel: TafetaStockLog,
    itemField: "tafeta",
    itemLabel: "Tafeta",
    onModel: "Tafeta",
  },
  TTR: {
    stockModel: TtrStock,
    logModel: TtrStockLog,
    itemField: "ttr",
    itemLabel: "TTR",
    onModel: "Ttr",
  },
};

function getStockConfig(itemType) {
  return STOCK_CONFIG[itemType] || null;
}

async function getStockSnapshot({ stockModel, itemField, itemId, location, onModel }) {
  const tapeObjectId = new mongoose.Types.ObjectId(itemId);
  const normalizedLocation = toUpperLocation(location);
  const [stockAgg, bookedAgg] = await Promise.all([
    stockModel.aggregate([
      { $match: { [itemField]: tapeObjectId } },
      {
        $group: {
          _id: { location: { $toUpper: { $ifNull: ["$location", "UNKNOWN"] } } },
          qty: { $sum: "$quantity" },
        },
      },
    ]),
    TapeSalesOrder.aggregate([
      {
        $match: {
          onModel,
          tapeId: tapeObjectId,
          status: { $nin: ["CANCELLED"] },
        },
      },
      {
        $group: {
          _id: { location: { $toUpper: { $ifNull: ["$sourceLocation", "UNKNOWN"] } } },
          bookedQty: {
            $sum: { $max: [0, { $subtract: ["$quantity", { $ifNull: ["$dispatchedQuantity", 0] }] }] },
          },
        },
      },
    ]),
  ]);

  const stockMap = new Map(
    stockAgg.map((row) => [toUpperLocation(row._id?.location), toNumber(row.qty)]),
  );
  const bookedMap = new Map(
    bookedAgg.map((row) => [toUpperLocation(row._id?.location), toNumber(row.bookedQty)]),
  );

  const currentStock = toNumber(stockMap.get(normalizedLocation));
  const booked = toNumber(bookedMap.get(normalizedLocation));
  return {
    location: normalizedLocation,
    currentStock,
    booked,
    balance: currentStock - booked,
  };
}

async function applyStockDelta({ stockModel, logModel, itemField, itemId, location, delta, remarks, createdBy }) {
  const itemObjectId = new mongoose.Types.ObjectId(itemId);
  const normalizedLocation = toUpperLocation(location);
  const [bal] = await stockModel.aggregate([
    { $match: { [itemField]: itemObjectId, location: normalizedLocation } },
    { $group: { _id: null, qty: { $sum: "$quantity" } } },
  ]);
  const openingStock = toNumber(bal?.qty);
  const closingStock = openingStock + delta;

  if (delta === 0) return { openingStock, closingStock, changed: false };

  await stockModel.create({
    [itemField]: itemObjectId,
    location: normalizedLocation,
    quantity: delta,
    remarks,
  });

  await logModel.create({
    [itemField]: itemObjectId,
    location: normalizedLocation,
    openingStock,
    quantity: Math.abs(delta),
    closingStock,
    type: delta > 0 ? "INWARD" : "OUTWARD",
    source: "MANUAL",
    remarks,
    createdBy: createdBy || "SYSTEM",
  });

  return { openingStock, closingStock, changed: true };
}

function formatSpec(parts) {
  return parts
    .map((part) => String(part ?? "").trim())
    .filter(Boolean)
    .join(" | ");
}

async function loadBookedMap(onModel) {
  const bookedRows = await TapeSalesOrder.aggregate([
    {
      $match: {
        onModel,
        status: { $nin: ["CANCELLED"] },
      },
    },
    {
      $group: {
        _id: {
          itemId: "$tapeId",
          location: { $toUpper: { $ifNull: ["$sourceLocation", "UNKNOWN"] } },
        },
        bookedQty: {
          $sum: { $max: [0, { $subtract: ["$quantity", { $ifNull: ["$dispatchedQuantity", 0] }] }] },
        },
      },
    },
  ]);

  return new Map(
    bookedRows.map((row) => [
      `${idString(row._id?.itemId)}__${toUpperLocation(row._id?.location)}`,
      toNumber(row.bookedQty),
    ]),
  );
}

async function loadStockRows({
  stockModel,
  itemField,
  masterModel,
  masterSelect,
  onModel,
  itemType,
  buildProductId,
  buildSpec,
  buildProfileUrl,
}) {
  const [stockRows, bookedMap] = await Promise.all([
    stockModel.aggregate([
      {
        $group: {
          _id: {
            itemId: `$${itemField}`,
            location: { $toUpper: { $ifNull: ["$location", "UNKNOWN"] } },
          },
          quantity: { $sum: "$quantity" },
        },
      },
    ]),
    loadBookedMap(onModel),
  ]);

  const stockMap = new Map(
    stockRows.map((row) => [
      `${idString(row._id?.itemId)}__${toUpperLocation(row._id?.location)}`,
      toNumber(row.quantity),
    ]),
  );

  const rowKeys = Array.from(new Set([...stockMap.keys(), ...bookedMap.keys()])).filter(Boolean);
  const itemIds = Array.from(new Set(rowKeys.map((key) => key.split("__")[0]).filter(Boolean)));
  if (!itemIds.length) return [];

  const masters = await masterModel.find({ _id: { $in: itemIds } }).select(masterSelect).lean();
  const masterMap = new Map(masters.map((master) => [idString(master._id), master]));

  return rowKeys
    .map((key) => {
      const [itemId, location = "UNKNOWN"] = key.split("__");
      const master = masterMap.get(itemId);
      if (!master) return null;

      const quantity = toNumber(stockMap.get(key));
      const booked = toNumber(bookedMap.get(key));
      const balance = quantity - booked;

      if (quantity === 0 && booked === 0) return null;

      return {
        itemType,
        itemId,
        productId: buildProductId(master),
        location,
        quantity,
        booked,
        balance,
        specification: buildSpec(master),
        profileUrl: buildProfileUrl(itemId),
      };
    })
    .filter(Boolean);
}

router.get("/view", async (req, res) => {
  try {
    const groupedRows = await Promise.all([
      loadStockRows({
        stockModel: TapeStock,
        itemField: "tape",
        masterModel: Tape,
        masterSelect:
          "tapeProductId tapePaperCode tapeGsm tapePaperType tapeWidth tapeMtrs tapeCoreId tapeFinish",
        onModel: "Tape",
        itemType: "Tape",
        buildProductId: (master) => master.tapeProductId,
        buildSpec: (master) =>
          `${master.tapePaperCode || ""} ${master.tapeGsm ? master.tapeGsm + "gsm" : ""}`.trim() || master.tapeProductId,
        buildProfileUrl: (itemId) => `/fairdesk/tape/profile/${itemId}`,
      }),
      loadStockRows({
        stockModel: PosRollStock,
        itemField: "posRoll",
        masterModel: PosRoll,
        masterSelect: "posProductId posPaperCode posPaperType posColor posGsm posWidth posMtrs posCoreId",
        onModel: "PosRoll",
        itemType: "POS Roll",
        buildProductId: (master) => master.posProductId,
        buildSpec: (master) =>
          `${master.posPaperCode || ""} ${master.posGsm ? master.posGsm + "gsm" : ""}`.trim() || master.posProductId,
        buildProfileUrl: (itemId) => `/fairdesk/pos-roll/profile/${itemId}`,
      }),
      loadStockRows({
        stockModel: TafetaStock,
        itemField: "tafeta",
        masterModel: Tafeta,
        masterSelect:
          "tafetaProductId tafetaMaterialCode tafetaMaterialType tafetaColor tafetaGsm tafetaWidth tafetaMtrs tafetaCoreId",
        onModel: "Tafeta",
        itemType: "Tafeta",
        buildProductId: (master) => master.tafetaProductId,
        buildSpec: (master) =>
          `${master.tafetaMaterialCode || ""} ${master.tafetaGsm ? master.tafetaGsm + "gsm" : ""}`.trim() || master.tafetaProductId,
        buildProfileUrl: (itemId) => `/fairdesk/tafeta/profile/${itemId}`,
      }),
      loadStockRows({
        stockModel: TtrStock,
        itemField: "ttr",
        masterModel: Ttr,
        masterSelect:
          "ttrProductId ttrType ttrColor ttrMaterialCode ttrWidth ttrMtrs ttrCoreId ttrCoreLength ttrWinding",
        onModel: "Ttr",
        itemType: "TTR",
        buildProductId: (master) => master.ttrProductId,
        buildSpec: (master) =>
          `${master.ttrType || ""} ${master.ttrWidth || ""}mm x ${master.ttrMtrs || ""}m`.replace(/\s+/g, " ").trim() || master.ttrProductId,
        buildProfileUrl: (itemId) => `/fairdesk/ttr/profile/${itemId}`,
      }),
    ]);

    const rows = groupedRows
      .flat()
      .sort(
        (a, b) =>
          a.itemType.localeCompare(b.itemType) ||
          a.productId.localeCompare(b.productId) ||
          a.location.localeCompare(b.location),
      );

    const summary = {
      totalLines: rows.length,
      totalQuantity: rows.reduce((sum, row) => sum + toNumber(row.quantity), 0),
      posQty: rows.filter(r => r.itemType === "POS Roll").reduce((sum, row) => sum + toNumber(row.quantity), 0),
      tafetaQty: rows.filter(r => r.itemType === "Tafeta").reduce((sum, row) => sum + toNumber(row.quantity), 0),
      tapeQty: rows.filter(r => r.itemType === "Tape").reduce((sum, row) => sum + toNumber(row.quantity), 0),
      ttrQty: rows.filter(r => r.itemType === "TTR").reduce((sum, row) => sum + toNumber(row.quantity), 0),
      totalBooked: rows.reduce((sum, row) => sum + toNumber(row.booked), 0),
      totalBalance: rows.reduce((sum, row) => sum + toNumber(row.balance), 0),
      totalLocations: new Set(rows.map((row) => row.location)).size,
      totalItems: new Set(rows.map((row) => row.itemId)).size,
    };

    res.render("stock/stockView.ejs", {
      title: "Stock View",
      CSS: "tableDisp.css",
      JS: false,
      notification: req.flash("notification"),
      jsonData: rows,
      summary,
    });
  } catch (err) {
    console.error("Failed to load stock summary", err);
    req.flash("notification", "Failed to load stock summary");
    res.redirect("/fairdesk");
  }
});

router.post("/edit/:itemType/:itemId/:location", requireAuth, updateLimiter, async (req, res) => {
  try {
    const { itemType, itemId, location } = req.params;
    const { quantity } = req.body;
    const cfg = getStockConfig(itemType);
    if (!cfg) {
      req.flash("notification", "Invalid stock item type");
      return res.redirect("/fairdesk/stocks/view");
    }

    const newQuantity = Number(quantity);
    if (!Number.isFinite(newQuantity) || newQuantity < 0) {
      req.flash("notification", "Enter a valid stock quantity");
      return res.redirect("/fairdesk/stocks/view");
    }

    const snapshot = await getStockSnapshot({
      stockModel: cfg.stockModel,
      itemField: cfg.itemField,
      itemId,
      location,
      onModel: cfg.onModel,
    });

    if (newQuantity < snapshot.booked) {
      req.flash("notification", `Cannot reduce below booked quantity (${snapshot.booked}).`);
      return res.redirect("/fairdesk/stocks/view");
    }

    const delta = newQuantity - snapshot.currentStock;
    if (delta === 0) {
      req.flash("notification", "Stock quantity is already up to date.");
      return res.redirect("/fairdesk/stocks/view");
    }

    await applyStockDelta({
      stockModel: cfg.stockModel,
      logModel: cfg.logModel,
      itemField: cfg.itemField,
      itemId,
      location,
      delta,
      remarks: `Stock adjusted to ${newQuantity} via stock view`,
      createdBy: req.user?.username || "SYSTEM",
    });

    req.flash("notification", `${cfg.itemLabel} stock updated successfully.`);
    return res.redirect("/fairdesk/stocks/view");
  } catch (err) {
    console.error("STOCK EDIT ERROR:", err);
    req.flash("notification", "Failed to update stock");
    return res.redirect("/fairdesk/stocks/view");
  }
});

router.post("/delete/:itemType/:itemId/:location", requireAuth, deleteLimiter, async (req, res) => {
  try {
    const { itemType, itemId, location } = req.params;
    const cfg = getStockConfig(itemType);
    if (!cfg) {
      req.flash("notification", "Invalid stock item type");
      return res.redirect("/fairdesk/stocks/view");
    }

    const snapshot = await getStockSnapshot({
      stockModel: cfg.stockModel,
      itemField: cfg.itemField,
      itemId,
      location,
      onModel: cfg.onModel,
    });

    if (snapshot.booked > 0) {
      req.flash("notification", `Cannot delete stock with booked quantity (${snapshot.booked}).`);
      return res.redirect("/fairdesk/stocks/view");
    }

    if (snapshot.currentStock === 0) {
      req.flash("notification", "Stock entry is already empty.");
      return res.redirect("/fairdesk/stocks/view");
    }

    await applyStockDelta({
      stockModel: cfg.stockModel,
      logModel: cfg.logModel,
      itemField: cfg.itemField,
      itemId,
      location,
      delta: -snapshot.currentStock,
      remarks: "Stock deleted via stock view",
      createdBy: req.user?.username || "SYSTEM",
    });

    req.flash("notification", `${cfg.itemLabel} stock deleted successfully.`);
    return res.redirect("/fairdesk/stocks/view");
  } catch (err) {
    console.error("STOCK DELETE ERROR:", err);
    req.flash("notification", "Failed to delete stock");
    return res.redirect("/fairdesk/stocks/view");
  }
});

export default router;
