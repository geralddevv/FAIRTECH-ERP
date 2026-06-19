import express, { json } from "express";
import crypto from "crypto";
import mongoose from "mongoose";
// import asyncHandler from "express-async-handler";
import Client from "../models/users/client.js";
import Username from "../models/users/username.js";
import Vendor from "../models/users/vendor.js";
import VendorUser from "../models/users/vendorUser.js";
import Employee from "../models/hr/employee_model.js";
import Label from "../models/inventory/labels.js";
import Ttr from "../models/inventory/ttr.js";
import Tape from "../models/inventory/tape.js";
import TapeBinding from "../models/inventory/tapeBinding.js";
import TapeSalesOrder from "../models/inventory/TapeSalesOrder.js";
import PurchaseOrder from "../models/inventory/PurchaseOrder.js";
import SystemId from "../models/system/systemId.js";
import Carelead from "../models/carelead.js";
import Calculator from "../models/utilities/calculator.js";
import Block from "../models/utilities/block_model.js";
import Die from "../models/utilities/die_model.js";
import TapeStock from "../models/inventory/TapeStock.js";
import TapeStockLog from "../models/inventory/TapeStockLog.js";
import SalesOrderLog from "../models/inventory/SalesOrderLog.js";
import PurchaseOrderLog from "../models/inventory/PurchaseOrderLog.js";
import PosRoll from "../models/inventory/posRoll.js";
import Tafeta from "../models/inventory/tafeta.js";
import PosRollBinding from "../models/inventory/posRollBinding.js";
import TafetaBinding from "../models/inventory/tafetaBinding.js";
import PosRollStock from "../models/inventory/PosRollStock.js";
import TafetaStock from "../models/inventory/TafetaStock.js";
import TtrBinding from "../models/inventory/ttrBinding.js";
import VendorTtrBinding from "../models/inventory/vendorTtrBinding.js";
import VendorTapeBinding from "../models/inventory/vendorTapeBinding.js";
import VendorPosRollBinding from "../models/inventory/vendorPosRollBinding.js";
import VendorTafetaBinding from "../models/inventory/vendorTafetaBinding.js";
import TtrStock from "../models/inventory/TtrStock.js";
import PosRollStockLog from "../models/inventory/PosRollStockLog.js";
import TafetaStockLog from "../models/inventory/TafetaStockLog.js";
import TtrStockLog from "../models/inventory/TtrStockLog.js";
import Location from "../models/system/location.js";
import Counter from "../models/system/counter.js";
import Sample from "../models/inventory/sample.js";
import { escapeRegex } from "../utils/security.js";
import { requireAuth } from "../middleware/auth.js";
import { createLimiter, updateLimiter, deleteLimiter } from "../utils/limiters.js";

const router = express.Router();

function hashSignature(rawSignature) {
  return `sha256:${crypto.createHash("sha256").update(String(rawSignature ?? "")).digest("hex")}`;
}

function duplicateMasterMessage(item, productId) {
  return `${item} already exist with id: ${productId || "unknown"}`;
}

function canonicalizeLocationName(value) {
  return String(value || "")
    .trim()
    .toUpperCase()
    .replace(/\s+/g, " ")
    .replace(/^[.,]+|[.,]+$/g, "");
}

function toNumber(value) {
  return Number(value || 0);
}

async function getTtrStockSummary(ttrId, excludeOrderId = null) {
  const ttrObjectId = new mongoose.Types.ObjectId(ttrId);
  const bookedMatch = {
    tapeId: ttrObjectId,
    onModel: "Ttr",
    status: "PENDING",
  };
  if (excludeOrderId) {
    bookedMatch._id = { $ne: new mongoose.Types.ObjectId(excludeOrderId) };
  }

  const [stockAggregation, bookedAggregation] = await Promise.all([
    TtrStock.aggregate([
      { $match: { ttr: ttrObjectId } },
      {
        $group: {
          _id: {
            location: { $toUpper: { $ifNull: ["$location", "UNKNOWN"] } },
          },
          qty: { $sum: "$quantity" },
        },
      },
      { $sort: { "_id.location": 1 } },
    ]),
    TapeSalesOrder.aggregate([
      { $match: bookedMatch },
      {
        $group: {
          _id: {
            location: { $toUpper: { $ifNull: ["$sourceLocation", "UNKNOWN"] } },
          },
          bookedQty: {
            $sum: { $max: [0, { $subtract: ["$quantity", { $ifNull: ["$dispatchedQuantity", 0] }] }] },
          },
        },
      },
    ]),
  ]);

  const stockMap = new Map(
    stockAggregation.map((row) => [canonicalizeLocationName(row._id?.location), toNumber(row.qty)]),
  );
  const bookedMap = new Map(
    bookedAggregation.map((row) => [canonicalizeLocationName(row._id?.location), toNumber(row.bookedQty)]),
  );

  const locations = Array.from(new Set([...stockMap.keys(), ...bookedMap.keys()]))
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b))
    .map((location) => {
      const qty = toNumber(stockMap.get(location));
      const booked = toNumber(bookedMap.get(location));
      return {
        location,
        qty,
        booked,
        balance: qty - booked,
      };
    })
    .filter((entry) => entry.qty !== 0 || entry.booked !== 0);

  const totalStock = locations.reduce((sum, entry) => sum + toNumber(entry.qty), 0);
  const totalBooked = locations.reduce((sum, entry) => sum + toNumber(entry.booked), 0);
  const totalBalance = totalStock - totalBooked;

  return {
    locations,
    totalStock,
    totalBooked,
    totalBalance,
    booked: totalBooked, // for compatibility
    balance: totalBalance, // for compatibility
  };
}

async function applyTtrStockDelta({ ttrId, location, delta, remarks, createdBy }) {
  const normalizedLocation = canonicalizeLocationName(location) || "UNKNOWN";
  const ttrObjectId = new mongoose.Types.ObjectId(ttrId);
  const [balanceRow] = await TtrStock.aggregate([
    { $match: { ttr: ttrObjectId, location: normalizedLocation } },
    { $group: { _id: null, qty: { $sum: "$quantity" } } },
  ]);
  const openingStock = toNumber(balanceRow?.qty);
  const closingStock = openingStock + delta;

  if (delta === 0) {
    return { openingStock, closingStock, changed: false };
  }

  await TtrStock.create({
    ttr: ttrObjectId,
    location: normalizedLocation,
    quantity: delta,
    remarks,
  });

  await TtrStockLog.create({
    ttr: ttrObjectId,
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

function getProfileStockConfig(itemType) {
  const map = {
    Tape: {
      itemLabel: "Tape",
      stockModel: TapeStock,
      logModel: TapeStockLog,
      itemField: "tape",
      onModel: "Tape",
    },
    "POS Roll": {
      itemLabel: "POS Roll",
      stockModel: PosRollStock,
      logModel: PosRollStockLog,
      itemField: "posRoll",
      onModel: "PosRoll",
    },
    PosRoll: {
      itemLabel: "POS Roll",
      stockModel: PosRollStock,
      logModel: PosRollStockLog,
      itemField: "posRoll",
      onModel: "PosRoll",
    },
    Tafeta: {
      itemLabel: "Tafeta",
      stockModel: TafetaStock,
      logModel: TafetaStockLog,
      itemField: "tafeta",
      onModel: "Tafeta",
    },
    TTR: {
      itemLabel: "TTR",
      stockModel: TtrStock,
      logModel: TtrStockLog,
      itemField: "ttr",
      onModel: "Ttr",
    },
    Ttr: {
      itemLabel: "TTR",
      stockModel: TtrStock,
      logModel: TtrStockLog,
      itemField: "ttr",
      onModel: "Ttr",
    },
  };
  return map[itemType] || null;
}

async function getItemStockSummary(itemType, itemId, excludeOrderId = null) {
  const config = getProfileStockConfig(itemType);
  if (!config) throw new Error(`Unsupported stock item type: ${itemType}`);
  const itemObjectId = new mongoose.Types.ObjectId(itemId);

  const bookedMatch = {
    tapeId: itemObjectId,
    onModel: config.onModel,
    status: { $in: ["PENDING", "CONFIRMED"] },
  };
  if (excludeOrderId) {
    bookedMatch._id = { $ne: new mongoose.Types.ObjectId(excludeOrderId) };
  }

  const [stockAggregation, bookedAggregation] = await Promise.all([
    config.stockModel.aggregate([
      { $match: { [config.itemField]: itemObjectId } },
      {
        $group: {
          _id: {
            location: { $toUpper: { $ifNull: ["$location", "UNKNOWN"] } },
          },
          qty: { $sum: "$quantity" },
        },
      },
      { $sort: { "_id.location": 1 } },
    ]),
    TapeSalesOrder.aggregate([
      { $match: bookedMatch },
      {
        $group: {
          _id: {
            location: { $toUpper: { $ifNull: ["$sourceLocation", "UNKNOWN"] } },
          },
          bookedQty: {
            $sum: { $max: [0, { $subtract: ["$quantity", { $ifNull: ["$dispatchedQuantity", 0] }] }] },
          },
        },
      },
    ]),
  ]);

  const stockMap = new Map(
    stockAggregation.map((row) => [canonicalizeLocationName(row._id?.location), toNumber(row.qty)]),
  );
  const bookedMap = new Map(
    bookedAggregation.map((row) => [canonicalizeLocationName(row._id?.location), toNumber(row.bookedQty)]),
  );

  const locations = Array.from(new Set([...stockMap.keys(), ...bookedMap.keys()]))
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b))
    .map((location) => {
      const qty = toNumber(stockMap.get(location));
      const booked = toNumber(bookedMap.get(location));
      return {
        location,
        qty,
        booked,
        balance: qty - booked,
      };
    })
    .filter((entry) => entry.qty !== 0 || entry.booked !== 0);

  const totalStock = locations.reduce((sum, entry) => sum + toNumber(entry.qty), 0);
  const totalBooked = locations.reduce((sum, entry) => sum + toNumber(entry.booked), 0);
  const totalBalance = totalStock - totalBooked;

  return {
    locations,
    totalStock,
    totalBooked,
    totalBalance,
    booked: totalBooked, // for compatibility
    balance: totalBalance, // for compatibility
  };
}

async function applyItemStockDelta({ itemType, itemId, location, delta, remarks, createdBy, extraFields = {} }) {
  const config = getProfileStockConfig(itemType);
  if (!config) throw new Error(`Unsupported stock item type: ${itemType}`);
  const normalizedLocation = canonicalizeLocationName(location) || "UNKNOWN";
  const itemObjectId = new mongoose.Types.ObjectId(itemId);

  const matchQuery = { [config.itemField]: itemObjectId, location: normalizedLocation };
  if (extraFields.tapeFinish) {
    matchQuery.tapeFinish = extraFields.tapeFinish;
  }

  const [balanceRow] = await config.stockModel.aggregate([
    { $match: matchQuery },
    { $group: { _id: null, qty: { $sum: "$quantity" } } },
  ]);
  const openingStock = toNumber(balanceRow?.qty);
  const closingStock = openingStock + delta;

  if (delta === 0) {
    return { openingStock, closingStock, changed: false };
  }

  await config.stockModel.create({
    [config.itemField]: itemObjectId,
    location: normalizedLocation,
    quantity: delta,
    remarks,
    ...extraFields,
  });

  await config.logModel.create({
    [config.itemField]: itemObjectId,
    location: normalizedLocation,
    openingStock,
    quantity: Math.abs(delta),
    closingStock,
    type: delta > 0 ? "INWARD" : "OUTWARD",
    source: "MANUAL",
    remarks,
    createdBy: createdBy || "SYSTEM",
    ...extraFields,
  });

  return { openingStock, closingStock, changed: true };
}

async function handleProfileStockEdit(req, res, { itemType, model, redirectPath }) {
  try {
    const selectFields = ["_id"];
    if (itemType === "Tape") selectFields.push("tapeFinish");
    const item = await model.findById(req.params.id).select(selectFields.join(" ")).lean();
    if (!item) {
      req.flash("notification", `${itemType} not found`);
      return res.redirect(redirectPath);
    }

    const fromLocation = canonicalizeLocationName(req.body.fromLocation) || "UNKNOWN";
    const toLocation = canonicalizeLocationName(req.body.toLocation) || "UNKNOWN";
    const requestedQuantity = Number(req.body.quantity);
    const itemProfileUrl = `${redirectPath}/${item._id}`;

    if (!Number.isFinite(requestedQuantity) || requestedQuantity < 0) {
      req.flash("notification", "Enter a valid stock quantity");
      return res.redirect(itemProfileUrl);
    }

    const stockSummary = await getItemStockSummary(itemType, item._id);
    const sourceEntry = stockSummary.locations.find((entry) => entry.location === fromLocation);
    const currentQuantity = toNumber(sourceEntry?.qty);
    const sourceBooked = toNumber(sourceEntry?.booked);
    const createdBy = req.user?.username || req.session?.authUser?.username || "SYSTEM";

    console.log(`[STOCK_EDIT] ${itemType} ${item._id} | From: ${fromLocation} To: ${toLocation} | ReqQty: ${requestedQuantity} | CurrQty: ${currentQuantity} | Booked: ${sourceBooked}`);

    if (!sourceEntry && currentQuantity === 0 && sourceBooked === 0) {
      req.flash("notification", "Stock location not found");
      return res.redirect(itemProfileUrl);
    }

    const extraFields = itemType === "Tape" ? { tapeFinish: item.tapeFinish } : {};

    if (fromLocation === toLocation) {
      const delta = requestedQuantity - currentQuantity;
      if (delta === 0) {
        req.flash("notification", "Stock is already up to date");
        return res.redirect(itemProfileUrl);
      }

      await applyItemStockDelta({
        itemType,
        itemId: item._id,
        location: fromLocation,
        delta,
        remarks: `${itemType} stock adjusted to ${requestedQuantity} from profile`,
        createdBy,
        extraFields,
      });
      req.flash("notification", `${itemType} stock updated successfully.`);
      return res.redirect(itemProfileUrl);
    }

    if (sourceBooked > 0) {
      req.flash("notification", `Cannot move stock from ${fromLocation} while booked quantity (${sourceBooked}) exists.`);
      return res.redirect(itemProfileUrl);
    }

    if (currentQuantity !== 0) {
      await applyItemStockDelta({
        itemType,
        itemId: item._id,
        location: fromLocation,
        delta: -currentQuantity,
        remarks: `${itemType} stock moved from ${fromLocation} to ${toLocation} via profile`,
        createdBy,
        extraFields,
      });
    }

    if (requestedQuantity !== 0) {
      await applyItemStockDelta({
        itemType,
        itemId: item._id,
        location: toLocation,
        delta: requestedQuantity,
        remarks: `${itemType} stock moved from ${fromLocation} to ${toLocation} via profile`,
        createdBy,
        extraFields,
      });
    }

    req.flash("notification", `${itemType} stock location updated successfully.`);
    return res.redirect(itemProfileUrl);
  } catch (err) {
    console.error(`${itemType.toUpperCase()} PROFILE STOCK EDIT ERROR:`, err);
    req.flash("notification", `Failed to update ${itemType} stock`);
    return res.redirect(`${redirectPath}/${req.params.id}`);
  }
}

function buildSalesOrderSignature({
  itemType,
  itemId,
  userId,
  quantity,
  estimatedDate,
  poNumber,
  sourceLocation,
  orderRate,
  createdBy,
}) {
  return hashSignature(
    [
      itemType || "",
      itemId || "",
      userId || "",
      String(quantity ?? ""),
      String(estimatedDate || ""),
      canonicalizeLocationName(sourceLocation || ""),
      String(poNumber || "").trim(),
      String(orderRate ?? ""),
      String(createdBy || ""),
    ].join("|"),
  );
}

function isTemplateOnlyInvoice(invoiceNumber) {
  const value = String(invoiceNumber || "").trim();
  if (!value) return true;
  return /^TECH\|\d{2}-\d{2}\|[A-Z_]+\|$/i.test(value);
}

router.use((req, res, next) => {
  const authUser = req.session?.authUser;
  const role = String(authUser?.role || "").toLowerCase();
  const permissions = authUser?.permissions || {};
  const hasSalesAccess = role === "sales" || Boolean(permissions.sales);
  const hasHrAccess = role === "hr" || Boolean(permissions.hr);

  if (!role) return res.redirect("/login");

  if (role === "admin" || role === "hod") return next();

  if (req.path === "/api/motivational") return next();

  if (hasSalesAccess) {
    const path = req.path || "";

    if (path.startsWith("/sales/")) return next();
    if (path === "/stocks/view" || path === "/pettycash/view" || path === "/pettycash/create") return next();

    // Explicitly allowed GET routes for Sales
    const allowedGetRoutes = [
      "/welcome",
      "/master/view",
      "/client/view",
      "/form/client",
      "/tape/view",
      "/pos-roll/view",
      "/tafeta/view",
      "/ttr/view",
      "/form/tape-binding",
      "/form/pos-roll-binding",
      "/form/tafeta-binding",
      "/form/ttr-binding",
      "/stocks/view",
      "/pettycash/view",
    ];

    const allowedGetPatterns = [
      /^\/form\/client\/[^/]+$/,
      /^\/client\/details\/[^/]+$/,
      /^\/tape\/profile\/[^/]+$/,
      /^\/pos-roll\/profile\/[^/]+$/,
      /^\/tafeta\/profile\/[^/]+$/,
      /^\/ttr\/profile\/[^/]+$/,
      /^\/tape\/edit\/[^/]+$/,
      /^\/pos-roll\/edit\/[^/]+$/,
      /^\/tafeta\/edit\/[^/]+$/,
      /^\/ttr\/edit\/[^/]+$/,
      /^\/form\/tape-binding(?:\/.*)?$/,
      /^\/form\/pos-roll-binding(?:\/.*)?$/,
      /^\/form\/tafeta-binding(?:\/.*)?$/,
      /^\/form\/ttr-binding(?:\/.*)?$/,
      /^\/api\/motivational$/,
      /^\/form\/labels\/.*$/,
      /^\/api\/locations$/,
    ];

    const allowedPostRoutes = [
      /^\/form\/client$/,
      /^\/form\/user$/,
      /^\/form\/tape-binding$/,
      /^\/form\/pos-roll-binding$/,
      /^\/form\/tafeta-binding$/,
      /^\/form\/ttr-binding$/,
      /^\/tape\/edit\/[^/]+$/,
      /^\/pos-roll\/edit\/[^/]+$/,
      /^\/tafeta\/edit\/[^/]+$/,
      /^\/ttr\/edit\/[^/]+$/,
      /^\/pettycash\/create$/,
    ];

    if (req.method === "GET") {
      const normalizedPath = path.toLowerCase().replace(/\/$/, "");
      
      // Explicit keyword matches for resilience
      const keywords = ["master/view", "compare", "binding", "welcome", "api/motivational", "tape/view", "pos-roll/view", "tafeta/view", "ttr/view", "client", "vendor", "user", "stocks", "pettycash"];
      if (keywords.some(k => normalizedPath.includes(k))) return next();

      if (allowedGetRoutes.includes(normalizedPath) || allowedGetPatterns.some((re) => re.test(path))) {
        return next();
      }
    }

    if (req.method === "POST" && (path.includes("binding") || path.includes("user") || allowedPostRoutes.some((re) => re.test(path)))) {
      return next();
    }

    return res.status(403).send(`Forbidden (FR-Sales): ${path} | Role: ${role}`);
  }

  if (hasHrAccess) {
    const path = req.path || "";
    if (path === "/welcome" || path === "/api/motivational") return next();
    return res.status(403).send(`Forbidden (FR-HR): ${path} | Role: ${role}`);
  }

  return res.status(403).send(`Forbidden (FR-Final): ${req.path} | Role: ${role}`);
});

router.get("/form/ratecalculator", async (req, res) => {
  let clients = await Username.distinct("clientName");
  res.render("utilities/rateCalculator.ejs", {
    clients,
    title: "Rate Calculator",
    JS: "rateCalculator.js",
    CSS: false,
    notification: req.flash("notification"),
  });
});

// Route to handle rate calculator form submission
router.post("/form/ratecalculator", requireAuth, createLimiter, async (req, res) => {
  let formData = req.body;

  await Order.create(formData);
  res.send("Order created successfully!");
});

// ----------------------------------Client---------------------------------->
// route for client form.
router.get("/form/client", async (req, res) => {
  const getNextClientIdPreview = async () => {
    const counterDoc = await Counter.findOne({ key: "clientId" }).select("seq").lean();
    let nextSeq = Number(counterDoc?.seq || 0) + 1;

    // Skip any legacy collisions so preview stays aligned with generator behavior.
    while (await Client.exists({ clientId: `FS | CLIENT | ${nextSeq}` })) {
      nextSeq += 1;
    }
    return `FS | CLIENT | ${nextSeq}`;
  };

  let clients = await Client.distinct("clientName");
  const employees = await Employee.find({}, "empName").sort({ empName: 1 }).lean();
  let userCount = await Username.countDocuments();
  const previewClientId = await getNextClientIdPreview();
  res.render("users/clientForm.ejs", {
    JS: "clientForm.js",
    CSS: "tabOpt.css",
    title: "Client Form",
    userCount,
    previewClientId,
    clients,
    employees,
    notification: req.flash("notification"),
  });
});

function normalizeClientPart(value) {
  if (value === undefined || value === null) return "";
  return String(value).trim();
}

function duplicateClientMessage(clientId) {
  return `client already exist: "${clientId || "unknown"}"`;
}

function duplicateUserMessage(userName, clientName) {
  return `"${userName || "unknown"}" already exist for this "${clientName || "unknown"}"`;
}

function buildClientSignature(source) {
  return [
    normalizeClientPart(source.clientName),
    normalizeClientPart(source.clientType),
    normalizeClientPart(source.clientStatus),
    normalizeClientPart(source.hoLocation),
    normalizeClientPart(source.accountHead),
    normalizeClientPart(source.clientGst),
    normalizeClientPart(source.clientMsme),
    normalizeClientPart(source.clientGumasta),
    normalizeClientPart(source.clientPan),
  ].join("||");
}

function normalizeUserPart(value) {
  return String(value ?? "").trim();
}

function normalizeUserName(value) {
  return normalizeUserPart(value).toUpperCase();
}

function normalizeUserEmail(value) {
  return normalizeUserPart(value).toLowerCase();
}

function normalizeUserContact(value) {
  return normalizeUserPart(value).replace(/\D/g, "");
}

function normalizeLocationDetails(rawLocationDetails, fallbackLocation, fallbackAddress) {
  const source = Array.isArray(rawLocationDetails)
    ? rawLocationDetails
    : rawLocationDetails && typeof rawLocationDetails === "object"
      ? Object.values(rawLocationDetails)
      : [];

  const locations = source
    .map((entry) => {
      const userLocation = String(entry?.userLocation ?? entry?.location ?? "").trim();
      const dispatchAddress = String(entry?.dispatchAddress ?? entry?.address ?? "").trim();

      if (!userLocation && !dispatchAddress) return null;

      return { userLocation, dispatchAddress };
    })
    .filter(Boolean);

  if (!locations.length) {
    const userLocation = String(fallbackLocation || "").trim();
    const dispatchAddress = String(fallbackAddress || "").trim();
    if (userLocation || dispatchAddress) {
      locations.push({ userLocation, dispatchAddress });
    }
  }

  return locations;
}

function buildUserSignature(source, userId) {
  return [
    normalizeClientPart(userId),
    normalizeUserName(source.userName),
    normalizeUserEmail(source.userEmail),
    normalizeUserContact(source.userContact),
  ].join("||");
}

// Route to handle CLIENT form submission
router.post("/form/client", requireAuth, createLimiter, async (req, res) => {
  try {
    const generateClientId = async () => {
      const maxAttempts = 10000;
      for (let i = 0; i < maxAttempts; i++) {
        const counter = await Counter.findOneAndUpdate(
          { key: "clientId" },
          { $inc: { seq: 1 } },
          { new: true, upsert: true, setDefaultsOnInsert: true },
        ).lean();

        const candidateId = `FS | CLIENT | ${counter.seq}`;
        const exists = await Client.exists({ clientId: candidateId });
        if (!exists) return candidateId;
      }
      throw new Error("Unable to generate unique client id");
    };

    const clientName = String(req.body.clientName || "").trim();
    const clientType = String(req.body.clientType || "").trim();
    const clientStatus = String(req.body.clientStatus || "").trim();
    const hoLocation = String(req.body.hoLocation || "").trim();
    const accountHead = String(req.body.accountHead || "").trim();
    const clientGst = String(req.body.clientGst || "").trim().toUpperCase();
    const clientMsme = String(req.body.clientMsme || "").trim();
    const clientGumasta = String(req.body.clientGumasta || "").trim();
    const clientPan = String(req.body.clientPan || "").trim().toUpperCase();

    // GST and PAN Validation
    const gstRegex = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/;
    const panRegex = /^[A-Z]{5}[0-9]{4}[A-Z]{1}$/;

    if (clientGst && !gstRegex.test(clientGst)) {
      return res.status(400).json({ success: false, message: "Invalid GST number format" });
    }
    if (clientPan && !panRegex.test(clientPan)) {
      return res.status(400).json({ success: false, message: "Invalid PAN number format" });
    }
    if (clientGst && clientPan && clientGst.substring(2, 12) !== clientPan) {
      return res.status(400).json({ success: false, message: "PAN does not match GST number" });
    }

    const clientSignature = hashSignature(buildClientSignature(req.body));

    // Prevent duplicates only when the full logical client entity matches.
    // clientId is auto-generated, so it is intentionally excluded from this match.
    const existingSameEntity = await Client.findOne({
      $or: [
        { clientSignature },
        {
          clientName: new RegExp(`^${escapeRegex(clientName)}$`, "i"),
          clientType: new RegExp(`^${escapeRegex(clientType)}$`, "i"),
          clientStatus: new RegExp(`^${escapeRegex(clientStatus)}$`, "i"),
          hoLocation: new RegExp(`^${escapeRegex(hoLocation)}$`, "i"),
          accountHead: new RegExp(`^${escapeRegex(accountHead)}$`, "i"),
          clientGst: new RegExp(`^${escapeRegex(clientGst)}$`, "i"),
          clientMsme: new RegExp(`^${escapeRegex(clientMsme)}$`, "i"),
          clientGumasta: new RegExp(`^${escapeRegex(clientGumasta)}$`, "i"),
          clientPan: new RegExp(`^${escapeRegex(clientPan)}$`, "i"),
        },
      ],
    })
      .select("clientId")
      .lean();

    if (existingSameEntity) {
      return res.status(400).json({
        success: false,
        message: duplicateClientMessage(existingSameEntity.clientId),
      });
    }

    const formData = {
      clientId: await generateClientId(),
      clientName,
      clientType,
      clientStatus,
      hoLocation,
      accountHead,
      clientGst,
      clientMsme,
      clientGumasta,
      clientPan,
      clientSignature,
    };

    await Client.create(formData);
    req.flash("notification", "Client created successfully!");
    res.json({ success: true, redirect: "/fairdesk/client/view" });
  } catch (err) {
    console.error(err);
    if (err?.code === 11000) {
      const existingClient = await Client.findOne({ clientSignature })
        .select("clientId")
        .lean();
      return res.status(409).json({
        success: false,
        message: duplicateClientMessage(existingClient?.clientId),
      });
    }
    res.status(400).json({ success: false, message: err.message });
  }
});

router.get("/form/client/:name", async (req, res) => {
  let clientData = await Client.findOne({ clientName: req.params.name });
  let clientName = clientData;
  res.status(200).json(clientName);
});

// ----------------------------------Username---------------------------------->
// Route to handle USER form submission
router.post("/form/user", requireAuth, createLimiter, async (req, res) => {
  try {
    const { objectId } = req.body;
    let client = null;
    if (objectId) {
      client = await Client.findOne({ _id: objectId });
    }
    if (!client) {
      const clientIdFallback = String(req.body.clientId || "").trim();
      const clientNameFallback = String(req.body.clientName || "").trim();
      if (clientIdFallback) {
        client = await Client.findOne({ clientId: clientIdFallback });
      }
      if (!client && clientNameFallback) {
        client = await Client.findOne({ clientName: new RegExp(`^${escapeRegex(clientNameFallback)}$`, "i") });
      }
    }
    if (!client) {
      return res.status(400).json({ success: false, message: "Invalid client selected" });
    }

    const clientId = String(client.clientId || "").trim();
    const userName = String(req.body.userName || "").trim();
    const userContact = String(req.body.userContact || "").trim();
    const userEmail = String(req.body.userEmail || "")
      .trim()
      .toLowerCase();
    const locationDetails = normalizeLocationDetails(
      req.body.locationDetails,
      req.body.userLocation,
      req.body.dispatchAddress,
    );

    if (!locationDetails.length) {
      return res.status(400).json({
        success: false,
        message: "Please add at least one location and address",
      });
    }

    const primaryLocation = locationDetails[0];
    const userSignature = hashSignature(buildUserSignature(req.body, clientId));

    // Prevent duplicates only on full identity tuple within the same client.
    const duplicateUser = await Username.findOne({
      $or: [
        { userSignature },
        {
          clientId,
          userName: new RegExp(`^${escapeRegex(userName)}$`, "i"),
          userEmail: new RegExp(`^${escapeRegex(userEmail)}$`, "i"),
          userContact: new RegExp(`^${escapeRegex(userContact)}$`, "i"),
        },
      ],
    })
      .select("userName clientName")
      .lean();

    if (duplicateUser) {
      return res.status(400).json({
        success: false,
        message: duplicateUserMessage(duplicateUser.userName, duplicateUser.clientName || client.clientName),
      });
    }

    const newUser = await Username.create({
      ...req.body,
      clientId,
      clientName: client.clientName,
      clientType: client.clientType,
      hoLocation: client.hoLocation,
      accountHead: client.accountHead,
      userLocation: primaryLocation.userLocation,
      dispatchAddress: primaryLocation.dispatchAddress,
      locationsCount: locationDetails.length,
      locationDetails,
      userName,
      userContact,
      userEmail,
      userSignature,
    });

    client.users.push(newUser);
    await client.save();

    req.flash("notification", "User created successfully!");
    res.json({ success: true, redirect: "/fairdesk/master/view" });
  } catch (err) {
    console.error(err);
    if (err?.code === 11000) {
      const clientId = String(req.body.clientId || "").trim();
      const userName = String(req.body.userName || "").trim();
      const userEmail = String(req.body.userEmail || "")
        .trim()
        .toLowerCase();
      const userContact = String(req.body.userContact || "").trim();
      const fallbackUserSignature = hashSignature(buildUserSignature(req.body, clientId));
      const existingUser = await Username.findOne({
        $or: [
          { userSignature: fallbackUserSignature },
          {
            clientId,
            userName: new RegExp(`^${escapeRegex(userName)}$`, "i"),
            userEmail: new RegExp(`^${escapeRegex(userEmail)}$`, "i"),
            userContact: new RegExp(`^${escapeRegex(userContact)}$`, "i"),
          },
        ],
      })
        .select("userName clientName")
        .lean();
      return res.status(409).json({
        success: false,
        message: duplicateUserMessage(existingUser?.userName || userName, existingUser?.clientName),
      });
    }
    res.status(400).json({ success: false, message: err.message });
  }
});

// ----------------------------------Labels---------------------------------->
// route for datasheet form.
router.get("/form/labels", async (req, res) => {
  let clients = await Client.distinct("clientName");
  let labelsCount = (await Label.countDocuments()) + 1;
  console.log(clients);

  res.render("inventory/labels.ejs", {
    title: "Labels",
    JS: "labels.js",
    CSS: false,
    clients,
    labelsCount,
    notification: req.flash("notification"),
  });
});

// Route to handle datasheet form submission.
router.post("/form/labels", requireAuth, createLimiter, async (req, res) => {
  try {
    let { userObjId } = req.body;
    let savedLabel = await Label.create(req.body);
    let user = await Username.findOne({ _id: userObjId });
    user.label.push(savedLabel);
    await user.save();

    req.flash("notification", "Label created successfully!");
    res.json({ success: true, redirect: "/fairdesk/form/labels" });
  } catch (err) {
    console.error(err);
    res.status(400).json({ success: false, message: err.message });
  }
});

router.get("/form/labels/:name", async (req, res) => {
  try {
    const rawName = String(req.params.name || "");
    const normalizedName = rawName.trim().replace(/\s+/g, " ");
    
    // 1. Find the Client document
    const clientData = await Client.findOne({
      clientName: new RegExp(`^${escapeRegex(normalizedName)}$`, "i"),
    }).lean();

    if (!clientData) {
      return res.status(404).json({ success: false, message: "Client not found" });
    }

    // 2. Fetch all usernames associated with this client name directly from Username model
    // This is more robust than relying on the Client.users array being perfectly in sync.
    const users = await Username.find({
      clientName: new RegExp(`^${escapeRegex(normalizedName)}$`, "i")
    }).lean();

    // 3. Attach users to clientData and return
    clientData.users = users;

    res.status(200).json(clientData);
  } catch (err) {
    console.error("FORM LABELS LOOKUP ERROR:", err);
    res.status(500).json({ success: false, message: "Failed to load client data" });
  }
});

// ----------------------------------Samples---------------------------------->
// Helper: build the counter key and format the sample code
function getMaterialAbbreviation(material) {
  const mat = String(material || "UNKNOWN").trim().toUpperCase();
  if (mat === "FACE PAPER") return "FP";
  if (mat === "ADHESIVE") return "ADH";
  if (mat === "RELEASE PAPER") return "RP";
  if (mat === "SL (PAPER)") return "SL";
  if (mat === "POS ROLL") return "POS";
  return mat.replace(/\s+/g, "-");
}

function formatSampleCode(material, category, seq) {
  const mat = getMaterialAbbreviation(material);
  const cat = category === "client" ? "CSMP" : "VSMP";
  return `FS | ${mat} | ${cat} | ${String(seq).padStart(6, "0")}`;
}

function sampleCounterKey(material, category) {
  const mat = getMaterialAbbreviation(material);
  const cat = category === "client" ? "CSMP" : "VSMP";
  return `sampleCode_${mat}_${cat}`;
}

// GET: preview next sample code (called by client-side JS on radio change)
router.get("/form/samples/next-code", async (req, res) => {
  try {
    const material = String(req.query.material || "").trim();
    const category = String(req.query.category || "vendor").trim().toLowerCase();
    if (!material) return res.json({ code: "" });

    const key = sampleCounterKey(material, category);
    const counterDoc = await Counter.findOne({ key }).select("seq").lean();
    let nextSeq = Number(counterDoc?.seq || 0) + 1;

    while (await Sample.exists({ sampleCode: formatSampleCode(material, category, nextSeq) })) {
      nextSeq += 1;
    }

    return res.json({ code: formatSampleCode(material, category, nextSeq) });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ code: "" });
  }
});

router.get("/form/samples", async (req, res) => {
  res.render("inventory/samples.ejs", {
    title: "Samples",
    CSS: false,
    JS: false,
    notification: req.flash("notification"),
  });
});

router.post("/form/samples", requireAuth, createLimiter, async (req, res) => {
  try {
    const activeTab = String(req.body.sampleCategory || "").trim().toLowerCase() === "client" ? "client" : "vendor";

    const material = String(req.body.sampleMaterial || "").trim();
    const key = sampleCounterKey(material, activeTab);

    const generateSampleCode = async () => {
      const maxAttempts = 10000;
      for (let i = 0; i < maxAttempts; i++) {
        const counter = await Counter.findOneAndUpdate(
          { key },
          { $inc: { seq: 1 } },
          { new: true, upsert: true, setDefaultsOnInsert: true },
        ).lean();

        const candidateCode = formatSampleCode(material, activeTab, counter.seq);
        const exists = await Sample.exists({ sampleCode: candidateCode });
        if (!exists) return candidateCode;
      }
      throw new Error("Unable to generate unique sample code");
    };

    const sampleCode = material ? await generateSampleCode() : String(req.body.sampleCode || "").trim();

    await Sample.create({ ...req.body, sampleCode, sampleCategory: activeTab, sampleMaterial: material });

    req.flash("notification", `${activeTab === "client" ? "Client" : "Vendor"} sample submitted successfully!`);
    res.json({ success: true, redirect: `/fairdesk/form/samples?tab=${activeTab}` });
  } catch (err) {
    console.error(err);
    res.status(400).json({ success: false, message: err.message });
  }
});

// ----------------------------------CareLead---------------------------------->
// route for carelead form.
router.get("/form/carelead", (req, res) => {
  res.render("care/carelead.ejs", {
    title: "Care Lead",
    JS: false,
    CSS: false,
    notification: req.flash("notification"),
  });
});

// Route to handle carelead form submission.
router.post("/form/carelead", requireAuth, createLimiter, async (req, res) => {
  let formData = req.body;

  await Carelead.create(formData);
  res.send("care lead created successfully!");
});

// ----------------------------------CareCallReport---------------------------------->
// route for carecallreport form.
router.get("/form/carecallreport", (req, res) => {
  res.render("care/careCallReport.ejs", {
    title: "Care Call Report",
    JS: false,
    CSS: false,
    notification: req.flash("notification"),
  });
});

// Route to handle carecallreport form submission.
router.post("/form/carecallreport", requireAuth, createLimiter, async (req, res) => {
  let formData = req.body;

  await Carelead.create(formData);
  res.send("care call report created successfully!");
});

// ----------------------------------SystemId---------------------------------->
// route for systemid form.
router.get("/form/systemid", async (req, res) => {
  let systemIdCount = await SystemId.countDocuments();
  res.render("care/systemId.ejs", {
    systemIdCount,
    title: "System ID",
    JS: false,
    CSS: false,
    notification: req.flash("notification"),
  });
});

// Route to handle systemid form submission.
router.post("/form/systemid", requireAuth, createLimiter, async (req, res) => {
  let formData = req.body;

  await SystemId.create(formData);
  res.send("care call report created successfully!");
});

// ----------------------------------WorkshopReport---------------------------------->
// route for careworkshopreport form.
router.get("/form/careworkshopreport", (req, res) => {
  res.render("care/careWokshopReport.ejs", {
    title: "Care Workshop Report",
    JS: false,
    CSS: false,
    notification: req.flash("notification"),
  });
});

// Route to handle careworkshopreport form submission.
router.post("/form/careworkshopreport", requireAuth, createLimiter, async (req, res) => {
  let formData = req.body;

  await Carelead.create(formData);
  res.send("care call report created successfully!");
});

// ----------------------------------CareQuote---------------------------------->
// route for carequote form.
router.get("/form/carequote", (req, res) => {
  res.render("care/careQuote.ejs", {
    title: "Care Quote",
    JS: false,
    CSS: false,
    notification: req.flash("notification"),
  });
});

// Route to handle carequote form submission.
router.post("/form/carequote", requireAuth, createLimiter, async (req, res) => {
  let formData = req.body;

  await Carelead.create(formData);
  res.send("care quote created successfully!");
});

// ----------------------------------TTR---------------------------------->
function normalizeTtrPart(value) {
  if (value === undefined || value === null) return "";
  return String(value).trim();
}

function normalizeTtrCoreId(value) {
  const raw = normalizeTtrPart(value);
  if (!raw) return "";
  const numeric = Number(raw);
  return Number.isFinite(numeric) ? String(numeric) : raw;
}

function buildTtrSignature(source) {
  return [
    normalizeTtrPart(source.ttrType),
    normalizeTtrPart(source.ttrColor),
    normalizeTtrPart(source.ttrMaterialCode),
    normalizeTtrPart(source.ttrWidth),
    normalizeTtrPart(source.ttrMtrs),
    normalizeTtrPart(source.ttrInkFace),
    normalizeTtrCoreId(source.ttrCoreId),
    normalizeTtrPart(source.ttrCoreLength),
    normalizeTtrPart(source.ttrNotch),
    normalizeTtrPart(source.ttrWinding),
  ].join("||");
}

const DEFAULT_TTR_SPECS = {
  ttrWidth: 0,
  ttrMtrs: 0,
  ttrInkFace: "OUT",
  ttrCoreId: "1",
  ttrCoreLength: 0,
  ttrNotch: "NO",
  ttrWinding: "NORMAL",
};

const DEFAULT_VENDOR_TTR_OVERRIDES = {
  ttrMtrsDel: "0",
  ttrRatePerRoll: 0,
  ttrSaleCost: 0,
  ttrOdrQty: 1,
  ttrOdrFreq: "N/A",
  ttrCreditTerm: "N/A",
  vendorTapePaperCode: "N/A",
  vendorTapeGsm: 0,
  tapeMtrsDel: 0,
  tapeRatePerRoll: 0,
  tapeSaleCost: 0,
  tapeMinQty: 1,
  tapeOdrQty: 1,
  tapeOdrFreq: "N/A",
  tapeCreditTerm: "N/A",
};

const trimOr = (value, fallback = "") => {
  if (value === undefined || value === null) return fallback;
  const out = String(value).trim();
  return out === "" ? fallback : out;
};

const numOr = (value, fallback = 0) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};

function flexTtrValue(val) {
  if (val === undefined || val === null) return val;
  const arr = [val];
  if (typeof val === "string") {
    const t = val.trim();
    if (t !== val) arr.push(t);
    const n = Number(t);
    if (t !== "" && !Number.isNaN(n)) arr.push(n);
  } else {
    arr.push(String(val));
  }
  return { $in: arr };
}

// GET: TTR Master form
router.get("/form/ttr", async (req, res) => {
  const formatTtrProductId = (n) => `FS | TTR | ${String(n).padStart(6, "0")}`;
  const parseTtrSeq = (productId) => {
    const match = String(productId || "").match(/(\d{6})$/);
    return match ? Number(match[1]) : 0;
  };
  const getNextTtrProductIdPreview = async () => {
    const latestTtr = await Ttr.findOne().sort({ ttrProductId: -1 }).select("ttrProductId").lean();
    let nextSeq = parseTtrSeq(latestTtr?.ttrProductId) + 1;

    while (await Ttr.exists({ ttrProductId: formatTtrProductId(nextSeq) })) {
      nextSeq += 1;
    }
    return formatTtrProductId(nextSeq);
  };

  const previewTtrProductId = await getNextTtrProductIdPreview();

  res.render("inventory/ttr.ejs", {
    JS: false,
    CSS: false,
    title: "TTR",
    previewTtrProductId,
    notification: req.flash("notification"),
  });
});

// GET: Check if TTR already exists (used by client-side precheck)
router.get("/form/ttr/exists", async (req, res) => {
  try {
    const normalized = {
      ...DEFAULT_TTR_SPECS,
      ...req.query,
      ttrType: trimOr(req.query.ttrType),
      ttrColor: trimOr(req.query.ttrColor, "BLACK"),
      ttrMaterialCode: trimOr(req.query.ttrMaterialCode),
      ttrInkFace: "OUT",
    };

    if ([normalized.ttrType, normalized.ttrColor, normalized.ttrMaterialCode].some((v) => trimOr(v) === "")) {
      return res.json({ exists: false });
    }

    const signatureSource = { ...DEFAULT_TTR_SPECS, ...normalized };
    if (buildTtrSignature(signatureSource).split("||").some((part) => part === "")) {
      return res.json({ exists: false });
    }

    const ttrSignature = hashSignature(buildTtrSignature(signatureSource));
    const legacyMatch = {
      ttrType: flexTtrValue(normalized.ttrType),
      ttrColor: flexTtrValue(normalized.ttrColor),
      ttrMaterialCode: flexTtrValue(normalized.ttrMaterialCode),
      ttrWidth: flexTtrValue(signatureSource.ttrWidth),
      ttrMtrs: numOr(signatureSource.ttrMtrs),
      ttrInkFace: flexTtrValue(signatureSource.ttrInkFace),
      ttrCoreId: flexTtrValue(signatureSource.ttrCoreId),
      ttrCoreLength: numOr(signatureSource.ttrCoreLength),
      ttrNotch: flexTtrValue(signatureSource.ttrNotch),
      ttrWinding: flexTtrValue(signatureSource.ttrWinding),
    };

    const existingTtr = await Ttr.findOne({
      $or: [{ ttrSignature }, legacyMatch],
    })
      .select("ttrProductId")
      .lean();

    return res.json({
      exists: !!existingTtr,
      id: existingTtr?.ttrProductId || "",
      ttrId: existingTtr?._id || "",
      message: existingTtr ? duplicateMasterMessage("TTR", existingTtr.ttrProductId) : "",
    });
  } catch (err) {
    console.error("TTR EXISTS CHECK ERROR:", err);
    return res.status(500).json({ exists: false });
  }
});

// POST: TTR Master submission
router.post("/form/ttr", requireAuth, createLimiter, async (req, res) => {
  try {
    const formatTtrProductId = (n) => `FS | TTR | ${String(n).padStart(6, "0")}`;
    const parseTtrSeq = (productId) => {
      const match = String(productId || "").match(/(\d{6})$/);
      return match ? Number(match[1]) : 0;
    };
    const generateTtrProductId = async () => {
      let nextSeq = parseTtrSeq(
        (await Ttr.findOne().sort({ ttrProductId: -1 }).select("ttrProductId").lean())?.ttrProductId,
      ) + 1;

      const maxAttempts = 10000;
      for (let i = 0; i < maxAttempts; i++) {
        const candidateId = formatTtrProductId(nextSeq);
        const exists = await Ttr.exists({ ttrProductId: candidateId });
        if (!exists) return candidateId;
        nextSeq += 1;
      }
      throw new Error("Unable to generate unique TTR product id");
    };

    // Prevent duplicates based on TTR specs (productId is always unique).
    const ttrSignature = hashSignature(buildTtrSignature(req.body));
    const widthRaw = req.body.ttrWidth;
    const widthTrim = typeof widthRaw === "string" ? widthRaw.trim() : widthRaw;
    const widthNum = typeof widthTrim === "string" ? Number(widthTrim) : Number(widthTrim);
    const widthVal =
      typeof widthTrim === "string" && widthTrim !== "" && !Number.isNaN(widthNum) ? widthNum : widthTrim;
    const ttrCoreId = normalizeTtrCoreId(req.body.ttrCoreId);
    const coreLengthNum = Number(req.body.ttrCoreLength);
    if (!Number.isFinite(coreLengthNum)) {
      return res.status(400).json({
        success: false,
        message: "Core Length must be a valid number.",
      });
    }

    const duplicateTtrQuery = {
      $or: [
        { ttrSignature },
        {
          ttrType: flexTtrValue(req.body.ttrType),
          ttrColor: flexTtrValue(req.body.ttrColor),
          ttrMaterialCode: flexTtrValue(req.body.ttrMaterialCode),
          ttrWidth: flexTtrValue(widthVal),
          ttrMtrs: Number(req.body.ttrMtrs),
          ttrInkFace: flexTtrValue(req.body.ttrInkFace),
          ttrCoreId: flexTtrValue(ttrCoreId),
          ttrCoreLength: Number(req.body.ttrCoreLength),
          ttrNotch: flexTtrValue(req.body.ttrNotch),
          ttrWinding: flexTtrValue(req.body.ttrWinding),
        },
      ],
    };
    const alreadyExists = await Ttr.findOne(duplicateTtrQuery).select("ttrProductId").lean();
    if (alreadyExists) {
      return res.status(400).json({
        success: false,
        message: duplicateMasterMessage("TTR", alreadyExists.ttrProductId),
      });
    }

    const data = {
      ttrProductId: await generateTtrProductId(),
      ttrType: String(req.body.ttrType).trim(),
      ttrColor: String(req.body.ttrColor).trim(),
      ttrMaterialCode: String(req.body.ttrMaterialCode).trim(),
      ttrWidth: widthVal,
      ttrMtrs: Number(req.body.ttrMtrs),
      ttrInkFace: "OUT",
      ttrCoreId,
      ttrCoreLength: coreLengthNum,
      ttrNotch: String(req.body.ttrNotch).trim(),
      ttrWinding: String(req.body.ttrWinding).trim(),
      ttrSignature,
      createdBy: req.user?.username || "SYSTEM",
    };

    const createdTtr = await Ttr.create(data);

    req.flash("notification", "TTR created successfully!");
    res.json({ success: true, redirect: "/fairdesk/ttr/view", id: createdTtr._id, ttrProductId: createdTtr.ttrProductId });
  } catch (err) {
    console.error(err);
    if (err?.code === 11000) {
      const duplicateTtr = await Ttr.findOne({ ttrSignature: hashSignature(buildTtrSignature(req.body)) })
        .select("ttrProductId")
        .lean();
      return res.status(409).json({
        success: false,
        message: duplicateMasterMessage("TTR", duplicateTtr?.ttrProductId),
      });
    }
    res.status(400).json({ success: false, message: err.message });
  }
});

// ----------------------------------Tape---------------------------------->
// route for tape form.
// router.get("/form/tape", async (req, res) => {
//   let clients = await Client.distinct("clientName");
//   let tapeCount = await Tape.countDocuments();

//   res.render("forms/tape.ejs", {
//     JS: "ttr.js",
//     CSS: false,
//     title: "Tape",
//     clients,
//     tapeCount,
//     notification: req.flash("notification"),
//   });
// });

// Route to handle tape form submission.
// router.post("/form/tape", async (req, res) => {
//   let { userId } = req.body;
//   let tapeData = await Tape.create(req.body);

//   let user = await Username.findOne({ _id: userId });
//   user.tape.push(tapeData);
//   await user.save();

//   req.flash("notification", "Tape created successfully!");
//   res.redirect("/fairdesk/form/tape");
// });

// ----------------------------------Tape Master---------------------------------->

// GET: Tape Master form
router.get("/form/tape-master", async (req, res) => {
  const formatTapeId = (n) => `FS | Tape | ${String(n).padStart(6, "0")}`;
  const parseTapeSeq = (productId) => {
    const match = String(productId || "").match(/(\d{6})$/);
    return match ? Number(match[1]) : 0;
  };
  const getNextTapeIdPreview = async () => {
    const latestTape = await Tape.findOne().sort({ tapeProductId: -1 }).select("tapeProductId").lean();
    let nextSeq = parseTapeSeq(latestTape?.tapeProductId) + 1;

    while (await Tape.exists({ tapeProductId: formatTapeId(nextSeq) })) {
      nextSeq += 1;
    }
    return formatTapeId(nextSeq);
  };

  const previewTapeProductId = await getNextTapeIdPreview();

  res.render("inventory/tape.ejs", {
    JS: false,
    CSS: false,
    title: "Tape Master",
    previewTapeProductId,
    notification: req.flash("notification"),
  });
});

// POST: Tape Master submission
router.post("/form/tape", requireAuth, createLimiter, async (req, res) => {
  try {
    const formatTapeId = (n) => `FS | Tape | ${String(n).padStart(6, "0")}`;
    const parseTapeSeq = (productId) => {
      const match = String(productId || "").match(/(\d{6})$/);
      return match ? Number(match[1]) : 0;
    };
    const generateTapeProductId = async () => {
      let nextSeq = parseTapeSeq(
        (await Tape.findOne().sort({ tapeProductId: -1 }).select("tapeProductId").lean())?.tapeProductId,
      ) + 1;

      const maxAttempts = 10000;
      for (let i = 0; i < maxAttempts; i++) {
        const candidateId = formatTapeId(nextSeq);
        const exists = await Tape.exists({ tapeProductId: candidateId });
        if (!exists) return candidateId;
        nextSeq += 1;
      }
      throw new Error("Unable to generate unique tape product id");
    };

    // Prevent duplicates based on tape specs (productId is always unique).
    const tapeSignature = hashSignature(buildTapeSignature(req.body));
    const widthRaw = req.body.tapeWidth;
    const widthTrim = typeof widthRaw === "string" ? widthRaw.trim() : widthRaw;
    const widthNum = typeof widthTrim === "string" ? Number(widthTrim) : Number(widthTrim);
    const widthVal =
      typeof widthTrim === "string" && widthTrim !== "" && !Number.isNaN(widthNum) ? widthNum : widthTrim;
    const tapeCoreId = normalizeTapeCoreId(req.body.tapeCoreId);

    const duplicateTapeQuery = {
      $or: [
        { tapeSignature },
        {
          tapePaperCode: flexTapeValue(req.body.tapePaperCode),
          tapeGsm: flexTapeValue(Number(req.body.tapeGsm)),
          tapePaperType: flexTapeValue(req.body.tapePaperType),
          tapeWidth: flexTapeValue(widthVal),
          tapeMtrs: flexTapeValue(Number(req.body.tapeMtrs)),
          tapeCoreId: flexTapeValue(Number(tapeCoreId)),
          tapeAdhesiveGsm: flexTapeValue(req.body.tapeAdhesiveGsm),
          tapeFinish: flexTapeValue(req.body.tapeFinish),
        },
      ],
    };
    const alreadyExists = await Tape.findOne(duplicateTapeQuery).select("tapeProductId").lean();
    if (alreadyExists) {
      return res.status(400).json({
        success: false,
        message: duplicateMasterMessage("Tape", alreadyExists.tapeProductId),
      });
    }

    const data = {
      tapeProductId: await generateTapeProductId(),
      tapePaperCode: String(req.body.tapePaperCode).trim(),
      tapeGsm: Number(req.body.tapeGsm),
      tapePaperType: String(req.body.tapePaperType).trim(),
      tapeWidth: widthVal,
      tapeMtrs: Number(req.body.tapeMtrs),
      tapeCoreId: Number(tapeCoreId),
      tapeAdhesiveGsm: String(req.body.tapeAdhesiveGsm).trim(),
      tapeFinish: String(req.body.tapeFinish).trim(),
      tapeSignature,
      createdBy: req.user?.username || "SYSTEM",
    };

    await Tape.create(data);

    req.flash("notification", "Tape Master created successfully!");
    res.json({ success: true, redirect: "/fairdesk/tape/view" });
  } catch (err) {
    console.error(err);
    if (err?.code === 11000) {
      const duplicateTape = await Tape.findOne({ tapeSignature: hashSignature(buildTapeSignature(req.body)) })
        .select("tapeProductId")
        .lean();
      return res.status(409).json({
        success: false,
        message: duplicateMasterMessage("Tape", duplicateTape?.tapeProductId),
      });
    }
    res.status(400).json({ success: false, message: err.message });
  }
});

// Route to render Edit USER form
router.get("/form/edit/user/:userId", async (req, res) => {
  try {
    let { userId } = req.params;
    let user = await Username.findById(userId);

    if (!user) {
      req.flash("error", "User not found.");
      return res.redirect("/fairdesk/users/master");
    }

    res.render("users/editUser", {
      CSS: "tabOpt.css",
      title: "Edit User",
      JS: false,
      user,
      initialLocationDetails: Array.isArray(user.locationDetails) && user.locationDetails.length
        ? user.locationDetails
        : [{ userLocation: user.userLocation || "", dispatchAddress: user.dispatchAddress || "" }],
      notification: req.flash("notification"),
      error: req.flash("error"),
    });
  } catch (err) {
    console.error(err);
    req.flash("error", "Error loading user data.");
    res.redirect("back");
  }
});

// Route to handle Edit USER submission
router.post("/form/edit/user/:userId", requireAuth, updateLimiter, async (req, res) => {
  try {
    let { userId } = req.params;
    const currentUser = await Username.findById(userId);
    if (!currentUser) {
      req.flash("error", "User not found.");
      return res.redirect("/fairdesk/users/master");
    }

    const updateData = {
      userName: String(req.body.userName || "").trim(),
      userDepartment: String(req.body.userDepartment || "").trim(),
      userContact: String(req.body.userContact || "").trim(),
      userEmail: String(req.body.userEmail || "")
        .trim()
        .toLowerCase(),
      transportName: String(req.body.transportName || "").trim(),
      transportContact: String(req.body.transportContact || "").trim(),
      dropLocation: String(req.body.dropLocation || "").trim(),
      deliveryMode: String(req.body.deliveryMode || "").trim(),
      deliveryLocation: String(req.body.deliveryLocation || "").trim(),
      clientPayment: String(req.body.clientPayment || "").trim(),
      SelfDispatch: String(req.body.SelfDispatch || "").trim(),
    };

    const locationDetails = normalizeLocationDetails(
      req.body.locationDetails,
      req.body.userLocation,
      req.body.dispatchAddress,
    ).map((entry) => ({
      userLocation: String(entry.userLocation || "").trim().toUpperCase(),
      dispatchAddress: String(entry.dispatchAddress || "").trim().toUpperCase(),
    }));

    if (!locationDetails.length) {
      return res.status(400).json({ success: false, message: "Please add at least one location and address" });
    }

    const primaryLocation = locationDetails[0];
    updateData.userLocation = primaryLocation.userLocation;
    updateData.dispatchAddress = primaryLocation.dispatchAddress;
    updateData.locationsCount = locationDetails.length;
    updateData.locationDetails = locationDetails;

    updateData.userSignature = hashSignature(buildUserSignature(updateData, currentUser.clientId));

    // Cleanup if self dispatch is enabled, ensure transport fields are empty
    if (updateData.SelfDispatch) {
      updateData.transportName = "";
      updateData.transportContact = "";
      updateData.dropLocation = "";
      updateData.deliveryMode = "";
      updateData.deliveryLocation = "";
      updateData.clientPayment = "";
    } else {
      updateData.SelfDispatch = "";
    }

    // Prevent duplicate full-entity user data within the same client.
    const duplicateUser = await Username.findOne({
      _id: { $ne: userId },
      clientId: currentUser.clientId,
      userName: new RegExp(`^${escapeRegex(updateData.userName)}$`, "i"),
      userLocation: new RegExp(`^${escapeRegex(updateData.userLocation)}$`, "i"),
      userDepartment: new RegExp(`^${escapeRegex(updateData.userDepartment)}$`, "i"),
      userContact: new RegExp(`^${escapeRegex(updateData.userContact)}$`, "i"),
      userEmail: new RegExp(`^${escapeRegex(updateData.userEmail)}$`, "i"),
      dispatchAddress: new RegExp(`^${escapeRegex(updateData.dispatchAddress)}$`, "i"),
      locationDetails: {
        $elemMatch: {
          userLocation: new RegExp(`^${escapeRegex(primaryLocation.userLocation)}$`, "i"),
          dispatchAddress: new RegExp(`^${escapeRegex(primaryLocation.dispatchAddress)}$`, "i"),
        },
      },
      transportName: new RegExp(`^${escapeRegex(updateData.transportName)}$`, "i"),
      transportContact: new RegExp(`^${escapeRegex(updateData.transportContact)}$`, "i"),
      dropLocation: new RegExp(`^${escapeRegex(updateData.dropLocation)}$`, "i"),
      deliveryMode: new RegExp(`^${escapeRegex(updateData.deliveryMode)}$`, "i"),
      deliveryLocation: new RegExp(`^${escapeRegex(updateData.deliveryLocation)}$`, "i"),
      clientPayment: new RegExp(`^${escapeRegex(updateData.clientPayment)}$`, "i"),
      SelfDispatch: new RegExp(`^${escapeRegex(updateData.SelfDispatch)}$`, "i"),
    }).lean();

    if (duplicateUser) {
      req.flash("error", "User already exists (same full details).");
      return res.redirect("back");
    }

    await Username.findByIdAndUpdate(userId, updateData, { new: true, runValidators: true });

    req.flash("notification", "User details updated successfully!");
    res.redirect(`/fairdesk/client/details/${userId}`);
  } catch (err) {
    console.error(err);
    req.flash("error", "Error updating user details.");
    res.redirect("back");
  }
});

// ----------------------------------POS Roll Master---------------------------------->

// GET: POS Roll Master form
router.get("/form/pos-roll-master", async (req, res) => {
  const formatPosProductId = (n) => `FS | POS Roll | ${String(n).padStart(6, "0")}`;
  const parsePosSeq = (productId) => {
    const match = String(productId || "").match(/(\d{6})$/);
    return match ? Number(match[1]) : 0;
  };
  const getNextPosProductIdPreview = async () => {
    const latestPos = await PosRoll.findOne().sort({ posProductId: -1 }).select("posProductId").lean();
    let nextSeq = parsePosSeq(latestPos?.posProductId) + 1;

    while (await PosRoll.exists({ posProductId: formatPosProductId(nextSeq) })) {
      nextSeq += 1;
    }
    return formatPosProductId(nextSeq);
  };

  const previewPosProductId = await getNextPosProductIdPreview();

  res.render("inventory/posRoll.ejs", {
    JS: false,
    CSS: false,
    title: "POS Roll Master",
    previewPosProductId,
    notification: req.flash("notification"),
  });
});

// POST: POS Roll Master submission
router.post("/form/pos-roll-master", requireAuth, createLimiter, async (req, res) => {
  console.log("POS ROLL MASTER BODY", req.body);
  try {
    const formatPosProductId = (n) => `FS | POS Roll | ${String(n).padStart(6, "0")}`;
    const parsePosSeq = (productId) => {
      const match = String(productId || "").match(/(\d{6})$/);
      return match ? Number(match[1]) : 0;
    };
    const generatePosProductId = async () => {
      let nextSeq = parsePosSeq(
        (await PosRoll.findOne().sort({ posProductId: -1 }).select("posProductId").lean())?.posProductId,
      ) + 1;

      const maxAttempts = 10000;
      for (let i = 0; i < maxAttempts; i++) {
        const candidateId = formatPosProductId(nextSeq);
        const exists = await PosRoll.exists({ posProductId: candidateId });
        if (!exists) return candidateId;
        nextSeq += 1;
      }
      throw new Error("Unable to generate unique POS Roll product id");
    };

    // Prevent duplicates based on POS Roll specs (productId is always unique).
    const posSignature = hashSignature(buildPosSignature(req.body));
    const widthRaw = req.body.posWidth;
    const widthTrim = typeof widthRaw === "string" ? widthRaw.trim() : widthRaw;
    const widthNum = typeof widthTrim === "string" ? Number(widthTrim) : Number(widthTrim);
    const widthVal =
      typeof widthTrim === "string" && widthTrim !== "" && !Number.isNaN(widthNum) ? widthNum : widthTrim;
    const posCoreId = normalizePosCoreId(req.body.posCoreId);

    const duplicatePosQuery = {
      $or: [
        { posSignature },
        {
          posPaperCode: flexPosValue(req.body.posPaperCode),
          posPaperType: flexPosValue(req.body.posPaperType),
          posColor: flexPosValue(req.body.posColor),
          posGsm: flexPosValue(Number(req.body.posGsm)),
          posWidth: flexPosValue(widthVal),
          posMtrs: flexPosValue(Number(req.body.posMtrs)),
          posCoreId: flexPosValue(Number(posCoreId)),
        },
      ],
    };
    const alreadyExists = await PosRoll.findOne(duplicatePosQuery).select("posProductId").lean();
    if (alreadyExists) {
      return res.status(400).json({
        success: false,
        message: duplicateMasterMessage("POS Roll", alreadyExists.posProductId),
      });
    }

    const data = {
      posProductId: await generatePosProductId(),
      posPaperCode: String(req.body.posPaperCode).trim(),
      posPaperType: String(req.body.posPaperType).trim(),
      posColor: String(req.body.posColor).trim(),
      posGsm: Number(req.body.posGsm),
      posWidth: widthVal,
      posMtrs: Number(req.body.posMtrs),
      posCoreId: Number(posCoreId),
      posSignature,
    };

    await PosRoll.create(data);

    req.flash("notification", "POS Roll Master created successfully!");
    res.json({ success: true, redirect: "/fairdesk/pos-roll/view" });
  } catch (err) {
    console.error(err);
    if (err?.code === 11000) {
      const duplicatePosRoll = await PosRoll.findOne({ posSignature: hashSignature(buildPosSignature(req.body)) })
        .select("posProductId")
        .lean();
      return res.status(409).json({
        success: false,
        message: duplicateMasterMessage("POS Roll", duplicatePosRoll?.posProductId),
      });
    }
    res.status(400).json({ success: false, message: err.message });
  }
});

// ----------------------------------Tafeta Master---------------------------------->

// GET: Tafeta Master form
router.get("/form/tafeta-master", async (req, res) => {
  const formatTafetaProductId = (n) => `FS | Tafeta | ${String(n).padStart(6, "0")}`;
  const parseTafetaSeq = (productId) => {
    const match = String(productId || "").match(/(\d{6})$/);
    return match ? Number(match[1]) : 0;
  };
  const getNextTafetaProductIdPreview = async () => {
    const latestTafeta = await Tafeta.findOne().sort({ tafetaProductId: -1 }).select("tafetaProductId").lean();
    let nextSeq = parseTafetaSeq(latestTafeta?.tafetaProductId) + 1;

    while (await Tafeta.exists({ tafetaProductId: formatTafetaProductId(nextSeq) })) {
      nextSeq += 1;
    }
    return formatTafetaProductId(nextSeq);
  };

  const previewTafetaProductId = await getNextTafetaProductIdPreview();

  res.render("inventory/tafeta.ejs", {
    JS: false,
    CSS: false,
    title: "Tafeta Master",
    previewTafetaProductId,
    notification: req.flash("notification"),
  });
});

// POST: Tafeta Master submission
router.post("/form/tafeta-master", requireAuth, createLimiter, async (req, res) => {
  console.log("TAFETA MASTER BODY", req.body);
  try {
    const formatTafetaProductId = (n) => `FS | Tafeta | ${String(n).padStart(6, "0")}`;
    const parseTafetaSeq = (productId) => {
      const match = String(productId || "").match(/(\d{6})$/);
      return match ? Number(match[1]) : 0;
    };
    const generateTafetaProductId = async () => {
      let nextSeq = parseTafetaSeq(
        (await Tafeta.findOne().sort({ tafetaProductId: -1 }).select("tafetaProductId").lean())?.tafetaProductId,
      ) + 1;

      const maxAttempts = 10000;
      for (let i = 0; i < maxAttempts; i++) {
        const candidateId = formatTafetaProductId(nextSeq);
        const exists = await Tafeta.exists({ tafetaProductId: candidateId });
        if (!exists) return candidateId;
        nextSeq += 1;
      }
      throw new Error("Unable to generate unique Tafeta product id");
    };

    // Prevent duplicates based on Tafeta specs (productId is always unique).
    const tafetaSignature = hashSignature(buildTafetaSignature(req.body));
    const widthRaw = req.body.tafetaWidth;
    const widthTrim = typeof widthRaw === "string" ? widthRaw.trim() : widthRaw;
    const widthNum = typeof widthTrim === "string" ? Number(widthTrim) : Number(widthTrim);
    const widthVal =
      typeof widthTrim === "string" && widthTrim !== "" && !Number.isNaN(widthNum) ? widthNum : widthTrim;
    const tafetaCoreId = normalizeTafetaCoreId(req.body.tafetaCoreId);

    const duplicateTafetaQuery = {
      $or: [
        { tafetaSignature },
        {
          tafetaMaterialCode: flexTafetaValue(req.body.tafetaMaterialCode),
          tafetaMaterialType: flexTafetaValue(req.body.tafetaMaterialType),
          tafetaColor: flexTafetaValue(req.body.tafetaColor),
          tafetaGsm: flexTafetaValue(req.body.tafetaGsm),
          tafetaWidth: flexTafetaValue(widthVal),
          tafetaMtrs: flexTafetaValue(req.body.tafetaMtrs),
          tafetaCoreLen: flexTafetaValue(req.body.tafetaCoreLen),
          tafetaNotch: flexTafetaValue(req.body.tafetaNotch),
          tafetaCoreId: flexTafetaValue(tafetaCoreId),
        },
      ],
    };
    const alreadyExists = await Tafeta.findOne(duplicateTafetaQuery).select("tafetaProductId").lean();
    if (alreadyExists) {
      return res.status(400).json({
        success: false,
        message: duplicateMasterMessage("Tafeta", alreadyExists.tafetaProductId),
      });
    }

    const data = {
      tafetaProductId: await generateTafetaProductId(),
      tafetaMaterialCode: String(req.body.tafetaMaterialCode).trim(),
      tafetaMaterialType: String(req.body.tafetaMaterialType).trim(),
      tafetaColor: String(req.body.tafetaColor).trim(),
      tafetaGsm: String(req.body.tafetaGsm).trim(),
      tafetaWidth: widthVal,
      tafetaMtrs: String(req.body.tafetaMtrs).trim(),
      tafetaCoreLen: String(req.body.tafetaCoreLen).trim(),
      tafetaNotch: String(req.body.tafetaNotch).trim(),
      tafetaCoreId,
      tafetaSignature,
    };

    await Tafeta.create(data);

    req.flash("notification", "Tafeta Master created successfully!");
    res.json({ success: true, redirect: "/fairdesk/tafeta/view" });
  } catch (err) {
    console.error(err);
    if (err?.code === 11000) {
      const duplicateTafeta = await Tafeta.findOne({ tafetaSignature: hashSignature(buildTafetaSignature(req.body)) })
        .select("tafetaProductId")
        .lean();
      return res.status(409).json({
        success: false,
        message: duplicateMasterMessage("Tafeta", duplicateTafeta?.tafetaProductId),
      });
    }
    res.status(400).json({ success: false, message: err.message });
  }
});

// ----------------------------------Location Master---------------------------------->

// GET: Location Master form
router.get("/form/location", async (req, res) => {
  const locations = await Location.find().sort({ locationName: 1 }).lean();

  res.render("inventory/locationMaster.ejs", {
    JS: false,
    CSS: false,
    title: "Location Master",
    locations,
    notification: req.flash("notification"),
  });
});

// POST: Location Master submission
router.post("/form/location", requireAuth, createLimiter, async (req, res) => {
  try {
    const locationName = String(req.body.locationName || "")
      .trim()
      .toUpperCase();

    const alreadyExists = await Location.exists({ locationName });
    if (alreadyExists) {
      return res.status(400).json({ success: false, message: "location already exist" });
    }

    await Location.create({ locationName });
    req.flash("notification", "Location created successfully!");
    res.json({ success: true, redirect: "/fairdesk/form/location" });
  } catch (err) {
    console.error(err);
    const msg = err.code === 11000 ? "location already exist" : err.message;
    res.status(400).json({ success: false, message: msg });
  }
});

// API: Get all locations as JSON
router.get("/api/locations", async (req, res) => {
  const locations = await Location.distinct("locationName");
  const normalizedLocations = [...new Set(
    locations
      .map((location) => canonicalizeLocationName(location))
      .filter(Boolean)
  )].sort();
  res.json(normalizedLocations);
});

// DELETE: Remove a location
router.delete("/api/locations/:id", requireAuth, deleteLimiter, async (req, res) => {
  try {
    await Location.findByIdAndDelete(req.params.id);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(400).json({ success: false, message: err.message });
  }
});

// ================= TAPE MASTER LIST VIEW =================
router.get("/tape/view", async (req, res) => {
  const tapes = await Tape.find().sort({ tapeProductId: 1 }).lean();
  const tapeIds = tapes.map((t) => t._id).filter(Boolean);

  const [stockAgg, bindingAgg, vendorBindingAgg] = await Promise.all([
    tapeIds.length
      ? TapeStock.aggregate([
          { $match: { tape: { $in: tapeIds } } },
          {
            $group: {
              _id: "$tape",
              qty: { $sum: "$quantity" },
            },
          },
        ])
      : [],
    tapeIds.length
      ? TapeBinding.aggregate([
          { $match: { tapeId: { $in: tapeIds } } },
          {
            $group: {
              _id: "$tapeId",
              count: { $sum: 1 },
            },
          },
        ])
      : [],
    tapeIds.length
      ? VendorTapeBinding.aggregate([
          { $match: { tapeId: { $in: tapeIds } } },
          {
            $group: {
              _id: "$tapeId",
              count: { $sum: 1 },
            },
          },
        ])
      : []
  ]);

  const stockByItem = {};
  stockAgg.forEach((row) => {
    const itemId = String(row._id || "");
    stockByItem[itemId] = Number(row.qty || 0);
  });

  const bindingsByItem = {};
  bindingAgg.forEach((row) => {
    const itemId = String(row._id || "");
    bindingsByItem[itemId] = Number(row.count || 0);
  });

  const vendorBindingsByItem = {};
  vendorBindingAgg.forEach((row) => {
    const itemId = String(row._id || "");
    vendorBindingsByItem[itemId] = Number(row.count || 0);
  });

  tapes.forEach((t) => {
    const itemId = String(t._id);
    t.stock = stockByItem[itemId] ?? 0;
    t.bindingCount = bindingsByItem[itemId] ?? 0;
    t.vendorBindingCount = vendorBindingsByItem[itemId] ?? 0;
  });

  res.render("inventory/tapeMasterDisp.ejs", {
    jsonData: tapes,
    CSS: "tableDisp.css",
    JS: false,
    title: "Tape View",
    notification: req.flash("notification"),
  });
});

// ================= TAFETA MASTER LIST VIEW =================
router.get("/tafeta/view", async (req, res) => {
  const tafetas = await Tafeta.find().sort({ tafetaProductId: 1 }).lean();
  const tafetaIds = tafetas.map((t) => t._id).filter(Boolean);

  const [stockAgg, bindingAgg, vendorBindingAgg] = await Promise.all([
    tafetaIds.length
      ? TafetaStock.aggregate([
          { $match: { tafeta: { $in: tafetaIds } } },
          {
            $group: {
              _id: "$tafeta",
              qty: { $sum: "$quantity" },
            },
          },
        ])
      : [],
    tafetaIds.length
      ? TafetaBinding.aggregate([
          { $match: { tafetaId: { $in: tafetaIds } } },
          {
            $group: {
              _id: "$tafetaId",
              count: { $sum: 1 },
            },
          },
        ])
      : [],
    tafetaIds.length
      ? VendorTafetaBinding.aggregate([
          { $match: { tafetaId: { $in: tafetaIds } } },
          {
            $group: {
              _id: "$tafetaId",
              count: { $sum: 1 },
            },
          },
        ])
      : []
  ]);

  const stockByItem = {};
  stockAgg.forEach((row) => {
    const itemId = String(row._id || "");
    stockByItem[itemId] = Number(row.qty || 0);
  });

  const bindingsByItem = {};
  bindingAgg.forEach((row) => {
    const itemId = String(row._id || "");
    bindingsByItem[itemId] = Number(row.count || 0);
  });

  const vendorBindingsByItem = {};
  vendorBindingAgg.forEach((row) => {
    const itemId = String(row._id || "");
    vendorBindingsByItem[itemId] = Number(row.count || 0);
  });

  tafetas.forEach((t) => {
    const itemId = String(t._id);
    t.stock = stockByItem[itemId] ?? 0;
    t.bindingCount = bindingsByItem[itemId] ?? 0;
    t.vendorBindingCount = vendorBindingsByItem[itemId] ?? 0;
  });

  res.render("inventory/tafetaMasterDisp.ejs", {
    jsonData: tafetas,
    CSS: "tableDisp.css",
    JS: false,
    title: "Tafeta View",
    notification: req.flash("notification"),
  });
});

function normalizeTafetaPart(value) {
  if (value === undefined || value === null) return "";
  return String(value).trim();
}

function normalizeTafetaCoreId(value) {
  const raw = normalizeTafetaPart(value);
  if (!raw) return "";
  const numeric = Number(raw);
  return Number.isFinite(numeric) ? String(numeric) : raw;
}

function buildTafetaSignature(source) {
  return [
    normalizeTafetaPart(source.tafetaMaterialCode),
    normalizeTafetaPart(source.tafetaMaterialType),
    normalizeTafetaPart(source.tafetaColor),
    normalizeTafetaPart(source.tafetaGsm),
    normalizeTafetaPart(source.tafetaWidth),
    normalizeTafetaPart(source.tafetaMtrs),
    normalizeTafetaPart(source.tafetaCoreLen),
    normalizeTafetaPart(source.tafetaNotch),
    normalizeTafetaCoreId(source.tafetaCoreId),
  ].join("||");
}

function flexTafetaValue(val) {
  if (val === undefined || value === null) return val;
  const arr = [val];
  if (typeof val === "string") {
    const t = val.trim();
    if (t !== val) arr.push(t);
    const n = Number(t);
    if (t !== "" && !Number.isNaN(n)) arr.push(n);
  } else {
    arr.push(String(val));
  }
  return { $in: arr };
}

// ================= POS ROLL MASTER LIST VIEW =================
router.get("/pos-roll/view", async (req, res) => {
  const posRolls = await PosRoll.find().sort({ posProductId: 1 }).lean();
  const posRollIds = posRolls.map((p) => p._id).filter(Boolean);

  const [stockAgg, bindingAgg, vendorBindingAgg] = await Promise.all([
    posRollIds.length
      ? PosRollStock.aggregate([
          { $match: { posRoll: { $in: posRollIds } } },
          {
            $group: {
              _id: "$posRoll",
              qty: { $sum: "$quantity" },
            },
          },
        ])
      : [],
    posRollIds.length
      ? PosRollBinding.aggregate([
          { $match: { posRollId: { $in: posRollIds } } },
          {
            $group: {
              _id: "$posRollId",
              count: { $sum: 1 },
            },
          },
        ])
      : [],
    posRollIds.length
      ? VendorPosRollBinding.aggregate([
          { $match: { posRollId: { $in: posRollIds } } },
          {
            $group: {
              _id: "$posRollId",
              count: { $sum: 1 },
            },
          },
        ])
      : []
  ]);

  const stockByItem = {};
  stockAgg.forEach((row) => {
    const itemId = String(row._id || "");
    stockByItem[itemId] = Number(row.qty || 0);
  });

  const bindingsByItem = {};
  bindingAgg.forEach((row) => {
    const itemId = String(row._id || "");
    bindingsByItem[itemId] = Number(row.count || 0);
  });

  const vendorBindingsByItem = {};
  vendorBindingAgg.forEach((row) => {
    const itemId = String(row._id || "");
    vendorBindingsByItem[itemId] = Number(row.count || 0);
  });

  posRolls.forEach((p) => {
    const itemId = String(p._id);
    p.stock = stockByItem[itemId] ?? 0;
    p.bindingCount = bindingsByItem[itemId] ?? 0;
    p.vendorBindingCount = vendorBindingsByItem[itemId] ?? 0;
  });

  res.render("inventory/posRollMasterDisp.ejs", {
    jsonData: posRolls,
    CSS: "tableDisp.css",
    JS: false,
    title: "POS Roll View",
    notification: req.flash("notification"),
  });
});

// ================= TTR MASTER LIST VIEW =================
router.get("/ttr/view", async (req, res) => {
  const ttrs = await Ttr.find().sort({ ttrProductId: 1 }).lean();
  const ttrIds = ttrs.map((t) => t._id).filter(Boolean);
  
  const [stockAgg, bindingAgg, vendorBindingAgg] = await Promise.all([
    ttrIds.length
      ? TtrStock.aggregate([
          { $match: { ttr: { $in: ttrIds } } },
          {
            $group: {
              _id: "$ttr",
              qty: { $sum: "$quantity" },
            },
          },
        ])
      : [],
    ttrIds.length
      ? TtrBinding.aggregate([
          { $match: { ttrId: { $in: ttrIds } } },
          {
            $group: {
              _id: "$ttrId",
              count: { $sum: 1 },
            },
          },
        ])
      : [],
    ttrIds.length
      ? VendorTtrBinding.aggregate([
          { $match: { ttrId: { $in: ttrIds } } },
          {
            $group: {
              _id: "$ttrId",
              count: { $sum: 1 },
            },
          },
        ])
      : []
  ]);

  const stockByTtr = {};
  stockAgg.forEach((row) => {
    const ttrId = String(row._id || "");
    stockByTtr[ttrId] = Number(row.qty || 0);
  });

  const bindingsByTtr = {};
  bindingAgg.forEach((row) => {
    const ttrId = String(row._id || "");
    bindingsByTtr[ttrId] = Number(row.count || 0);
  });

  const vendorBindingsByTtr = {};
  vendorBindingAgg.forEach((row) => {
    const ttrId = String(row._id || "");
    vendorBindingsByTtr[ttrId] = Number(row.count || 0);
  });

  ttrs.forEach((t) => {
    const ttrId = String(t._id);
    t.stock = stockByTtr[ttrId] ?? 0;
    t.bindingCount = bindingsByTtr[ttrId] ?? 0;
    t.vendorBindingCount = vendorBindingsByTtr[ttrId] ?? 0;
  });

  res.render("inventory/ttrMasterDisp.ejs", {
    jsonData: ttrs,
    CSS: "tableDisp.css",
    JS: false,
    title: "TTR View",
    notification: req.flash("notification"),
  });
});

// ================= TAPE PROFILE VIEW =================
router.get("/tape/profile/:id", async (req, res) => {
  const tape = await Tape.findById(req.params.id).lean();

  if (!tape) {
    req.flash("notification", "Tape not found");
    return res.redirect("back");
  }

  const tapeBindings = await TapeBinding.find({ tapeId: req.params.id })
    .populate({ path: "userId", select: "userName clientName hoLocation" })
    .sort({ createdAt: -1 })
    .lean();

  const primaryBinding = tapeBindings[0] || null;
  const backUrl = primaryBinding?.userId?._id
    ? `/fairdesk/client/details/${primaryBinding.userId._id}`
    : "/fairdesk/tape/view";
  const stockSummary = await getItemStockSummary("Tape", tape._id);
  const locationOptions = await Location.find().sort({ locationName: 1 }).lean();

  const rows = [
    { label: "Product ID", value: tape.tapeProductId || "N/A" },
    { label: "Paper Code", value: tape.tapePaperCode || "N/A" },
    { label: "GSM", value: tape.tapeGsm ?? "N/A" },
    { label: "Paper Type", value: tape.tapePaperType || "N/A" },
    { label: "Adhesive GSM", value: tape.tapeAdhesiveGsm ?? "N/A" },
    { label: "Width", value: tape.tapeWidth ?? "N/A" },
    { label: "Meters", value: tape.tapeMtrs ?? "N/A" },
    { label: "Core ID", value: tape.tapeCoreId ?? "N/A" },
    { label: "Finish", value: tape.tapeFinish || "N/A" },
    { label: "Min Stock Qty", value: tape.tapeMinQty ?? "N/A" },
  ];

  res.render("inventory/itemView.ejs", {
    pageTitle: "Tape Details",
    sectionTitle: "Tape Details",
    valueHeader: "Value",
    editUrl: `/fairdesk/tape/edit/${tape._id}`,
    editLabel: "Edit Tape",
    rows,
    tape,
    tapeBindings,
    primaryBinding,
    backUrl,
    stockInfo: {
      totalStock: stockSummary.totalStock,
      locations: stockSummary.locations,
      booked: stockSummary.totalBooked,
      balance: stockSummary.totalBalance,
    },
    stockEditConfig: {
      enabled: true,
      itemType: "Tape",
      editAction: `/fairdesk/tape/profile/${tape._id}/stock/edit`,
      locationOptions: locationOptions.map((entry) => canonicalizeLocationName(entry.locationName)).filter(Boolean),
    },
    title: "Tape Details",
    CSS: false,
    JS: false,
    notification: req.flash("notification"),
  });
});

router.post("/tape/profile/:id/stock/edit", requireAuth, updateLimiter, async (req, res) =>
  handleProfileStockEdit(req, res, {
    itemType: "Tape",
    model: Tape,
    redirectPath: "/fairdesk/tape/profile",
  }));

function normalizePosPart(value) {
  if (value === undefined || value === null) return "";
  return String(value).trim();
}

function normalizePosCoreId(value) {
  const raw = normalizePosPart(value);
  if (!raw) return "";
  const numeric = Number(raw);
  return Number.isFinite(numeric) ? String(numeric) : raw;
}

function buildPosSignature(source) {
  return [
    normalizePosPart(source.posPaperCode),
    normalizePosPart(source.posPaperType),
    normalizePosPart(source.posColor),
    normalizePosPart(source.posGsm),
    normalizePosPart(source.posWidth),
    normalizePosPart(source.posMtrs),
    normalizePosCoreId(source.posCoreId),
  ].join("||");
}

function flexPosValue(val) {
  if (val === undefined || val === null) return val;
  const arr = [val];
  if (typeof val === "string") {
    const t = val.trim();
    if (t !== val) arr.push(t);
    const n = Number(t);
    if (t !== "" && !Number.isNaN(n)) arr.push(n);
  } else {
    arr.push(String(val));
  }
  return { $in: arr };
}

function normalizeTapePart(value) {
  if (value === undefined || value === null) return "";
  return String(value).trim();
}

function normalizeTapeCoreId(value) {
  const raw = normalizeTapePart(value);
  if (!raw) return "";
  const numeric = Number(raw);
  return Number.isFinite(numeric) ? String(numeric) : raw;
}

function buildTapeSignature(source) {
  return [
    normalizeTapePart(source.tapePaperCode),
    normalizeTapePart(source.tapePaperType),
    normalizeTapePart(source.tapeGsm),
    normalizeTapePart(source.tapeWidth),
    normalizeTapePart(source.tapeMtrs),
    normalizeTapeCoreId(source.tapeCoreId),
    normalizeTapePart(source.tapeAdhesiveGsm),
    normalizeTapePart(source.tapeFinish),
  ].join("||");
}

function flexTapeValue(val) {
  if (val === undefined || val === null) return val;
  const arr = [val];
  if (typeof val === "string") {
    const t = val.trim();
    if (t !== val) arr.push(t);
    const n = Number(t);
    if (t !== "" && !Number.isNaN(n)) arr.push(n);
  } else {
    arr.push(String(val));
  }
  return { $in: arr };
}

// ================= TAPE EDIT =================
router.get("/tape/edit/:id", async (req, res) => {
  const tape = await Tape.findById(req.params.id).lean();
  if (!tape) return res.redirect("back");

  res.render("inventory/tapeEdit.ejs", {
    title: "Edit Tape",
    CSS: false,
    JS: false,
    tape,
  });
});

router.post("/tape/edit/:id", requireAuth, updateLimiter, async (req, res) => {
  try {
    const widthRaw = req.body.tapeWidth;
    const widthTrim = typeof widthRaw === "string" ? widthRaw.trim() : widthRaw;
    const widthNum = typeof widthTrim === "string" ? Number(widthTrim) : Number(widthTrim);
    const widthVal =
      typeof widthTrim === "string" && widthTrim !== "" && !Number.isNaN(widthNum) ? widthNum : widthTrim;
    const tapeCoreId = normalizeTapeCoreId(req.body.tapeCoreId);

    const updateData = {
      tapePaperCode: String(req.body.tapePaperCode || "").trim(),
      tapeGsm: Number(req.body.tapeGsm),
      tapePaperType: String(req.body.tapePaperType || "").trim(),
      tapeWidth: widthVal,
      tapeMtrs: Number(req.body.tapeMtrs),
      tapeCoreId: Number(tapeCoreId),
      tapeAdhesiveGsm: String(req.body.tapeAdhesiveGsm || "").trim(),
      tapeFinish: String(req.body.tapeFinish || "").trim(),
    };
    updateData.tapeSignature = hashSignature(buildTapeSignature(updateData));

    const duplicateTapeQuery = {
      _id: { $ne: req.params.id },
      $or: [
        { tapeSignature: updateData.tapeSignature },
        {
          tapePaperCode: flexTapeValue(updateData.tapePaperCode),
          tapeGsm: flexTapeValue(updateData.tapeGsm),
          tapePaperType: flexTapeValue(updateData.tapePaperType),
          tapeWidth: flexTapeValue(updateData.tapeWidth),
          tapeMtrs: flexTapeValue(updateData.tapeMtrs),
          tapeCoreId: flexTapeValue(updateData.tapeCoreId),
          tapeAdhesiveGsm: flexTapeValue(updateData.tapeAdhesiveGsm),
          tapeFinish: flexTapeValue(updateData.tapeFinish),
        },
      ],
    };

    const duplicateTape = await Tape.findOne(duplicateTapeQuery).select("tapeProductId").lean();
    if (duplicateTape) {
      return res.status(400).json({
        success: false,
        message: duplicateMasterMessage("Tape", duplicateTape.tapeProductId),
      });
    }

    await Tape.findByIdAndUpdate(req.params.id, updateData, { new: true, runValidators: true });
    req.flash("notification", "Tape updated successfully!");
    res.json({ success: true, redirect: `/fairdesk/tape/view` });
  } catch (err) {
    console.error(err);
    if (err?.code === 11000) {
      const duplicateTape = await Tape.findOne({
        _id: { $ne: req.params.id },
        tapeSignature: hashSignature(buildTapeSignature(req.body)),
      })
        .select("tapeProductId")
        .lean();
      return res.status(409).json({
        success: false,
        message: duplicateMasterMessage("Tape", duplicateTape?.tapeProductId),
      });
    }
    res.status(400).json({ success: false, message: err.message });
  }
});

// ================= POS ROLL PROFILE VIEW =================
router.get("/pos-roll/profile/:id", async (req, res) => {
  const posRoll = await PosRoll.findById(req.params.id).lean();

  if (!posRoll) {
    req.flash("notification", "POS Roll not found");
    return res.redirect("back");
  }

  const posRollBindings = await PosRollBinding.find({ posRollId: req.params.id })
    .populate({ path: "userId", select: "userName clientName hoLocation" })
    .sort({ createdAt: -1 })
    .lean();

  const primaryBinding = posRollBindings[0] || null;
  const backUrl = primaryBinding?.userId?._id
    ? `/fairdesk/client/details/${primaryBinding.userId._id}`
    : "/fairdesk/pos-roll/view";
  const stockSummary = await getItemStockSummary("POS Roll", posRoll._id);
  const locationOptions = await Location.find().sort({ locationName: 1 }).lean();

  const rows = [
    { label: "Product ID", value: posRoll.posProductId || "N/A" },
    { label: "Paper Code", value: posRoll.posPaperCode || "N/A" },
    { label: "GSM", value: posRoll.posGsm ?? "N/A" },
    { label: "Paper Type", value: posRoll.posPaperType || "N/A" },
    { label: "Color", value: posRoll.posColor || "N/A" },
    { label: "Width", value: posRoll.posWidth ?? "N/A" },
    { label: "Meters", value: posRoll.posMtrs ?? "N/A" },
    { label: "Core ID", value: posRoll.posCoreId ?? "N/A" },
    { label: "Min Stock Qty", value: posRoll.posMinQty ?? "N/A" },
  ];

  res.render("inventory/itemView.ejs", {
    pageTitle: "POS Roll Details",
    sectionTitle: "POS Roll Details",
    valueHeader: "Value",
    editUrl: `/fairdesk/pos-roll/edit/${posRoll._id}`,
    editLabel: "Edit POS Roll",
    rows,
    posRoll,
    posRollBindings,
    primaryBinding,
    backUrl,
    stockInfo: {
      totalStock: stockSummary.totalStock,
      locations: stockSummary.locations,
      booked: stockSummary.totalBooked,
      balance: stockSummary.totalBalance,
    },
    stockEditConfig: {
      enabled: true,
      itemType: "POS Roll",
      editAction: `/fairdesk/pos-roll/profile/${posRoll._id}/stock/edit`,
      locationOptions: locationOptions.map((entry) => canonicalizeLocationName(entry.locationName)).filter(Boolean),
    },
    title: "POS Roll Details",
    CSS: false,
    JS: false,
    notification: req.flash("notification"),
  });
});

router.post("/pos-roll/profile/:id/stock/edit", requireAuth, updateLimiter, async (req, res) =>
  handleProfileStockEdit(req, res, {
    itemType: "POS Roll",
    model: PosRoll,
    redirectPath: "/fairdesk/pos-roll/profile",
  }));

// ================= POS ROLL EDIT =================
router.get("/pos-roll/edit/:id", async (req, res) => {
  const posRoll = await PosRoll.findById(req.params.id).lean();
  if (!posRoll) return res.redirect("back");

  res.render("inventory/posRollEdit.ejs", {
    title: "Edit POS Roll",
    CSS: false,
    JS: false,
    posRoll,
  });
});

router.post("/pos-roll/edit/:id", requireAuth, updateLimiter, async (req, res) => {
  try {
    const widthRaw = req.body.posWidth;
    const widthTrim = typeof widthRaw === "string" ? widthRaw.trim() : widthRaw;
    const widthNum = typeof widthTrim === "string" ? Number(widthTrim) : Number(widthTrim);
    const widthVal =
      typeof widthTrim === "string" && widthTrim !== "" && !Number.isNaN(widthNum) ? widthNum : widthTrim;
    const posCoreId = normalizePosCoreId(req.body.posCoreId);

    const updateData = {
      posPaperCode: String(req.body.posPaperCode || "").trim(),
      posPaperType: String(req.body.posPaperType || "").trim(),
      posColor: String(req.body.posColor || "").trim(),
      posGsm: Number(req.body.posGsm),
      posWidth: widthVal,
      posMtrs: Number(req.body.posMtrs),
      posCoreId: Number(posCoreId),
    };
    updateData.posSignature = hashSignature(buildPosSignature(updateData));

    const duplicatePosQuery = {
      _id: { $ne: req.params.id },
      $or: [
        { posSignature: updateData.posSignature },
        {
          posPaperCode: flexPosValue(updateData.posPaperCode),
          posPaperType: flexPosValue(updateData.posPaperType),
          posColor: flexPosValue(updateData.posColor),
          posGsm: flexPosValue(updateData.posGsm),
          posWidth: flexPosValue(updateData.posWidth),
          posMtrs: flexPosValue(updateData.posMtrs),
          posCoreId: flexPosValue(updateData.posCoreId),
        },
      ],
    };

    const duplicatePosRoll = await PosRoll.findOne(duplicatePosQuery).select("posProductId").lean();
    if (duplicatePosRoll) {
      return res.status(400).json({
        success: false,
        message: duplicateMasterMessage("POS Roll", duplicatePosRoll.posProductId),
      });
    }

    await PosRoll.findByIdAndUpdate(req.params.id, updateData, { new: true, runValidators: true });
    req.flash("notification", "POS Roll updated successfully!");
    res.json({ success: true, redirect: `/fairdesk/pos-roll/view` });
  } catch (err) {
    console.error(err);
    if (err?.code === 11000) {
      const duplicatePosRoll = await PosRoll.findOne({
        _id: { $ne: req.params.id },
        posSignature: hashSignature(buildPosSignature(req.body)),
      })
        .select("posProductId")
        .lean();
      return res.status(409).json({
        success: false,
        message: duplicateMasterMessage("POS Roll", duplicatePosRoll?.posProductId),
      });
    }
    res.status(400).json({ success: false, message: err.message });
  }
});

// ================= TAFETA PROFILE VIEW =================
router.get("/tafeta/profile/:id", async (req, res) => {
  const tafeta = await Tafeta.findById(req.params.id).lean();

  if (!tafeta) {
    req.flash("notification", "Tafeta not found");
    return res.redirect("back");
  }

  const tafetaBindings = await TafetaBinding.find({ tafetaId: req.params.id })
    .populate({ path: "userId", select: "userName clientName hoLocation" })
    .sort({ createdAt: -1 })
    .lean();

  const primaryBinding = tafetaBindings[0] || null;
  const backUrl = primaryBinding?.userId?._id
    ? `/fairdesk/client/details/${primaryBinding.userId._id}`
    : "/fairdesk/tafeta/view";
  const stockSummary = await getItemStockSummary("Tafeta", tafeta._id);
  const locationOptions = await Location.find().sort({ locationName: 1 }).lean();

  const rows = [
    { label: "Product ID", value: tafeta.tafetaProductId || "N/A" },
    { label: "Material Code", value: tafeta.tafetaMaterialCode || "N/A" },
    { label: "GSM", value: tafeta.tafetaGsm ?? "N/A" },
    { label: "Material Type", value: tafeta.tafetaMaterialType || "N/A" },
    { label: "Color", value: tafeta.tafetaColor || "N/A" },
    { label: "Width", value: tafeta.tafetaWidth ?? "N/A" },
    { label: "Meters", value: tafeta.tafetaMtrs ?? "N/A" },
    { label: "Core Length", value: tafeta.tafetaCoreLen ?? "N/A" },
    { label: "Notch", value: tafeta.tafetaNotch || "N/A" },
    { label: "Core ID", value: tafeta.tafetaCoreId ?? "N/A" },
    { label: "Min Stock Qty", value: tafeta.tafetaMinQty ?? "N/A" },
  ];

  res.render("inventory/itemView.ejs", {
    pageTitle: "Tafeta Details",
    sectionTitle: "Tafeta Details",
    valueHeader: "Value",
    editUrl: `/fairdesk/tafeta/edit/${tafeta._id}`,
    editLabel: "Edit Tafeta",
    rows,
    tafeta,
    tafetaBindings,
    primaryBinding,
    backUrl,
    stockInfo: {
      totalStock: stockSummary.totalStock,
      locations: stockSummary.locations,
      booked: stockSummary.totalBooked,
      balance: stockSummary.totalBalance,
    },
    stockEditConfig: {
      enabled: true,
      itemType: "Tafeta",
      editAction: `/fairdesk/tafeta/profile/${tafeta._id}/stock/edit`,
      locationOptions: locationOptions.map((entry) => canonicalizeLocationName(entry.locationName)).filter(Boolean),
    },
    title: "Tafeta Details",
    CSS: false,
    JS: false,
    notification: req.flash("notification"),
  });
});

router.post("/tafeta/profile/:id/stock/edit", requireAuth, updateLimiter, async (req, res) =>
  handleProfileStockEdit(req, res, {
    itemType: "Tafeta",
    model: Tafeta,
    redirectPath: "/fairdesk/tafeta/profile",
  }));

// ================= TAFETA EDIT =================
router.get("/tafeta/edit/:id", async (req, res) => {
  const tafeta = await Tafeta.findById(req.params.id).lean();
  if (!tafeta) return res.redirect("back");

  res.render("inventory/tafetaEdit.ejs", {
    title: "Edit Tafeta",
    CSS: false,
    JS: false,
    tafeta,
  });
});

router.post("/tafeta/edit/:id", requireAuth, updateLimiter, async (req, res) => {
  try {
    const widthRaw = req.body.tafetaWidth;
    const widthTrim = typeof widthRaw === "string" ? widthRaw.trim() : widthRaw;
    const widthNum = typeof widthTrim === "string" ? Number(widthTrim) : Number(widthTrim);
    const widthVal =
      typeof widthTrim === "string" && widthTrim !== "" && !Number.isNaN(widthNum) ? widthNum : widthTrim;
    const tafetaCoreId = normalizeTafetaCoreId(req.body.tafetaCoreId);

    const updateData = {
      tafetaMaterialCode: String(req.body.tafetaMaterialCode || "").trim(),
      tafetaMaterialType: String(req.body.tafetaMaterialType || "").trim(),
      tafetaColor: String(req.body.tafetaColor || "").trim(),
      tafetaGsm: String(req.body.tafetaGsm || "").trim(),
      tafetaWidth: widthVal,
      tafetaMtrs: String(req.body.tafetaMtrs || "").trim(),
      tafetaCoreLen: String(req.body.tafetaCoreLen || "").trim(),
      tafetaNotch: String(req.body.tafetaNotch || "").trim(),
      tafetaCoreId,
    };
    updateData.tafetaSignature = hashSignature(buildTafetaSignature(updateData));

    const duplicateTafetaQuery = {
      _id: { $ne: req.params.id },
      $or: [
        { tafetaSignature: updateData.tafetaSignature },
        {
          tafetaMaterialCode: flexTafetaValue(updateData.tafetaMaterialCode),
          tafetaMaterialType: flexTafetaValue(updateData.tafetaMaterialType),
          tafetaColor: flexTafetaValue(updateData.tafetaColor),
          tafetaGsm: flexTafetaValue(updateData.tafetaGsm),
          tafetaWidth: flexTafetaValue(updateData.tafetaWidth),
          tafetaMtrs: flexTafetaValue(updateData.tafetaMtrs),
          tafetaCoreLen: flexTafetaValue(updateData.tafetaCoreLen),
          tafetaNotch: flexTafetaValue(updateData.tafetaNotch),
          tafetaCoreId: flexTafetaValue(updateData.tafetaCoreId),
        },
      ],
    };

    const duplicateTafeta = await Tafeta.findOne(duplicateTafetaQuery).select("tafetaProductId").lean();
    if (duplicateTafeta) {
      return res.status(400).json({
        success: false,
        message: duplicateMasterMessage("Tafeta", duplicateTafeta.tafetaProductId),
      });
    }

    await Tafeta.findByIdAndUpdate(req.params.id, updateData, { new: true, runValidators: true });
    req.flash("notification", "Tafeta updated successfully!");
    res.json({ success: true, redirect: `/fairdesk/tafeta/view` });
  } catch (err) {
    console.error(err);
    if (err?.code === 11000) {
      const duplicateTafeta = await Tafeta.findOne({
        _id: { $ne: req.params.id },
        tafetaSignature: hashSignature(buildTafetaSignature(req.body)),
      })
        .select("tafetaProductId")
        .lean();
      return res.status(409).json({
        success: false,
        message: duplicateMasterMessage("Tafeta", duplicateTafeta?.tafetaProductId),
      });
    }
    res.status(400).json({ success: false, message: err.message });
  }
});

// ================= TTR PROFILE VIEW =================
router.get("/ttr/profile/:id", async (req, res) => {
  const ttr = await Ttr.findById(req.params.id).lean();

  if (!ttr) {
    req.flash("notification", "TTR not found");
    return res.redirect("back");
  }

  const ttrBindings = await TtrBinding.find({ ttrId: req.params.id })
    .populate({ path: "userId", select: "userName clientName hoLocation" })
    .sort({ createdAt: -1 })
    .lean();

  const primaryBinding = ttrBindings[0] || null;
  const backUrl = primaryBinding?.userId?._id
    ? `/fairdesk/client/details/${primaryBinding.userId._id}`
    : "/fairdesk/ttr/view";
  const stockSummary = await getTtrStockSummary(ttr._id);
  const locationOptions = await Location.find().sort({ locationName: 1 }).lean();
  const ttrHeading = `${primaryBinding?.clientTtrType || ttr.ttrType || "TTR"} ${ttr.ttrCoreLength ?? ""}`
    .replace(/\s+/g, " ")
    .trim();

  const rows = [
    { label: "Product ID", value: ttr.ttrProductId || "N/A" },
    { label: "Client Material Code", value: primaryBinding?.ttrClientMaterialCode || "N/A" },
    { label: "Client Type", value: primaryBinding?.clientTtrType || "N/A" },
    { label: "Color", value: ttr.ttrColor || "N/A" },
    { label: "Ink Face", value: ttr.ttrInkFace || "N/A" },
    { label: "Width", value: ttr.ttrWidth ?? "N/A" },
    { label: "Core ID", value: ttr.ttrCoreId ?? "N/A" },
    { label: "Core Length", value: ttr.ttrCoreLength ?? "N/A" },
    { label: "Notch", value: ttr.ttrNotch || "N/A" },
    { label: "Winding", value: ttr.ttrWinding || "N/A" },
    { label: "Min Stock Qty", value: ttr.ttrMinQty ?? "N/A" },
  ];

  res.render("inventory/itemView.ejs", {
    pageTitle: ttrHeading || "TTR Details",
    sectionTitle: "TTR Details",
    editUrl: `/fairdesk/ttr/edit/${ttr._id}`,
    editLabel: "Edit TTR",
    rows,
    valueHeader: "Fairtech",
    ttr,
    ttrBindings,
    primaryBinding,
    backUrl,
    stockInfo: {
      totalStock: stockSummary.totalStock,
      locations: stockSummary.locations,
      booked: stockSummary.totalBooked,
      balance: stockSummary.totalBalance,
    },
    stockEditConfig: {
      enabled: true,
      itemType: "TTR",
      editAction: `/fairdesk/ttr/profile/${ttr._id}/stock/edit`,
      locationOptions: locationOptions.map((entry) => canonicalizeLocationName(entry.locationName)).filter(Boolean),
    },
    title: ttrHeading || "TTR Details",
    CSS: false,
    JS: false,
    notification: req.flash("notification"),
  });
});

router.post("/ttr/profile/:id/stock/edit", requireAuth, updateLimiter, async (req, res) =>
  handleProfileStockEdit(req, res, {
    itemType: "TTR",
    model: Ttr,
    redirectPath: "/fairdesk/ttr/profile",
  }));

// route for vendor form.
router.get("/form/vendor", async (req, res) => {
  const { tab, vendorName } = req.query;
  let vendors = await Vendor.distinct("vendorName");
  let userCount = await VendorUser.countDocuments();
  let vendorCount = vendors.length;
  res.render("users/vendorForm.ejs", {
    JS: "vendorForm.js?v=5",
    CSS: "tabOpt.css",
    title: "Vendor Form",
    vendorCount,
    userCount,
    vendors,
    tab,
    vendorName,
    notification: req.flash("notification"),
  });
});

function normalizeVendorPart(value) {
  if (value === undefined || value === null) return "";
  return String(value).trim();
}

function buildVendorSignature(source) {
  return [
    normalizeVendorPart(source.vendorName),
    normalizeVendorPart(source.vendorStatus),
    normalizeVendorPart(source.hoLocation),
    normalizeVendorPart(source.warehouseLocation),
    normalizeVendorPart(source.vendorGst),
    normalizeVendorPart(source.vendorMsme),
    normalizeVendorPart(source.vendorGumasta),
    normalizeVendorPart(source.vendorPan),
    Array.isArray(source.commodities)
      ? source.commodities.map((c) => normalizeVendorPart(c)).filter(Boolean).join(",")
      : normalizeVendorPart(source.commodities),
  ].join("||");
}

function normalizeVendorUserPart(value) {
  return String(value ?? "").trim();
}

function normalizeVendorUserName(value) {
  return normalizeVendorUserPart(value).toUpperCase();
}

function normalizeVendorUserEmail(value) {
  return normalizeVendorUserPart(value).toLowerCase();
}

function normalizeVendorUserContact(value) {
  return normalizeVendorUserPart(value).replace(/\D/g, "");
}

function buildVendorUserSignature(source, vendorId) {
  const locationDetails = normalizeLocationDetails(
    source.locationDetails,
    source.userLocation,
    source.dispatchAddress,
  );

  return [
    normalizeVendorPart(vendorId),
    normalizeVendorUserName(source.userName),
    normalizeVendorUserEmail(source.userEmail),
    normalizeVendorUserContact(source.userContact),
    locationDetails
      .map(
        (entry) =>
          `${normalizeVendorPart(entry.userLocation)}::${normalizeVendorPart(entry.dispatchAddress)}`,
      )
      .join("||"),
    normalizeVendorPart(source.transportName),
    normalizeVendorPart(source.transportContact),
    normalizeVendorPart(source.dropLocation),
    normalizeVendorPart(source.dropLocation1),
    normalizeVendorPart(source.deliveryMode),
    normalizeVendorPart(source.deliveryLocation),
    normalizeVendorPart(source.deliveryLocation1),
    normalizeVendorPart(source.vendorPayment),
    normalizeVendorPart(source.SelfDispatch),
  ].join("||");
}

function getVendorSnapshot(vendor, fallback = {}) {
  return {
    vendorId: String(vendor?.vendorId ?? fallback.vendorId ?? "").trim(),
    vendorName: String(vendor?.vendorName ?? fallback.vendorName ?? "").trim(),
    vendorStatus: String(vendor?.vendorStatus ?? fallback.vendorStatus ?? "").trim(),
    hoLocation: String(vendor?.hoLocation ?? fallback.hoLocation ?? "").trim(),
    warehouseLocation: String(vendor?.warehouseLocation ?? fallback.warehouseLocation ?? "").trim(),
    vendorGst: String(vendor?.vendorGst ?? fallback.vendorGst ?? "").trim(),
    vendorMsme: String(vendor?.vendorMsme ?? fallback.vendorMsme ?? "").trim(),
    commodities: vendor?.commodities || fallback.commodities || [],
  };
}

// Route to handle VENDOR form submission
router.post("/form/vendor", requireAuth, createLimiter, async (req, res) => {
  try {
    const vendorId = String(req.body.vendorId || "").trim();
    const vendorName = String(req.body.vendorName || "").trim();
    const vendorGst = String(req.body.vendorGst || "").trim().toUpperCase();
    const vendorPan = String(req.body.vendorPan || "").trim().toUpperCase();

    // GST and PAN Validation
    const gstRegex = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/;
    const panRegex = /^[A-Z]{5}[0-9]{4}[A-Z]{1}$/;

    if (vendorGst && !gstRegex.test(vendorGst)) {
      return res.status(400).json({ success: false, message: "Invalid GST number format" });
    }
    if (vendorPan && !panRegex.test(vendorPan)) {
      return res.status(400).json({ success: false, message: "Invalid PAN number format" });
    }
    if (vendorGst && vendorPan && vendorGst.substring(2, 12) !== vendorPan) {
      return res.status(400).json({ success: false, message: "PAN does not match GST number" });
    }

    const vendorSignature = hashSignature(buildVendorSignature(req.body));

    // Prevent duplicates only by full vendor signature.
    const alreadyExists = await Vendor.exists({
      vendorSignature,
    });
    if (alreadyExists) {
      return res.status(400).json({ success: false, message: "vendor already exist" });
    }

    const formData = {
      vendorId,
      vendorName,
      vendorStatus: req.body.vendorStatus === "OTHERS" && req.body.otherStatus
        ? `OTHERS - ${String(req.body.otherStatus).trim().toUpperCase().replace(/^(OTHERS - )+/, "")}`
        : String(req.body.vendorStatus || "").trim(),
      hoLocation: String(req.body.hoLocation || "").trim(),
      warehouseLocation: String(req.body.warehouseLocation || "").trim(),
      commodities: (() => {
        let comms = Array.isArray(req.body.commodities)
          ? req.body.commodities.map((c) => String(c).trim().toUpperCase()).filter(Boolean)
          : req.body.commodities
            ? [String(req.body.commodities).trim().toUpperCase()].filter(Boolean)
            : [];
        
        const othersIndex = comms.indexOf("OTHERS");
        if (othersIndex !== -1) {
          const predefined = ["FACE PAPER", "ADHESIVE", "RELEASE PAPER", "SL (PAPER)", "PACKAGING", "TTR", "TAPE", "POS ROLL", "TAFFETA", "PRINTERS", "SCANNERS", "SPARES", "CORE", "FOIL", "IT", "DIE", "BLOCK", "COLOR", "OTHERS"];
          const otherVal = comms.find(c => c !== "OTHERS" && !predefined.includes(c));
          if (otherVal) {
            comms = comms.filter(c => c !== "OTHERS" && c !== otherVal);
            const cleanOtherVal = otherVal.replace(/^(OTHERS - )+/, "");
            comms.push(`OTHERS - ${cleanOtherVal}`);
          }
        }
        return comms;
      })(),
      vendorGst,
      vendorMsme: String(req.body.vendorMsme || "").trim(),
      vendorGumasta: String(req.body.vendorGumasta || "").trim(),
      vendorPan,
      vendorSignature,
    };

    await Vendor.create(formData);
    req.flash("notification", "Vendor created successfully!");
    res.json({ success: true, redirect: "/fairdesk/form/vendor" });
  } catch (err) {
    console.error(err);
    if (err?.code === 11000) {
      return res.status(409).json({
        success: false,
        message: "vendor already exist",
      });
    }
    res.status(400).json({ success: false, message: err.message });
  }
});

router.get("/form/vendor/:name", async (req, res) => {
  const vendorData = await Vendor.findOne({ vendorName: req.params.name }).lean();
  if (!vendorData) {
    return res.status(404).json({ message: "Vendor not found" });
  }

  vendorData.userCount = await VendorUser.countDocuments({ vendorId: vendorData.vendorId });
  res.status(200).json(vendorData);
});

router.get("/vendor/edit/:id", async (req, res) => {
  try {
    const vendor = await Vendor.findById(req.params.id).lean();
    if (!vendor) {
      req.flash("notification", "Vendor not found");
      return res.redirect("/fairdesk/vendor/view");
    }

    res.render("users/vendorEditForm.ejs", {
      title: "Edit Vendor",
      CSS: "tabOpt.css",
      JS: false,
      vendor,
      notification: req.flash("notification"),
    });
  } catch (err) {
    console.error("VENDOR EDIT GET ERROR:", err);
    req.flash("notification", "Failed to load vendor edit page");
    res.redirect("/fairdesk/vendor/view");
  }
});

router.post("/vendor/edit/:id", requireAuth, updateLimiter, async (req, res) => {
  try {
    const vendor = await Vendor.findById(req.params.id);
    if (!vendor) {
      return res.status(404).json({ success: false, message: "Vendor not found" });
    }

    const linkedVendorUsers = await VendorUser.find({ vendorId: vendor.vendorId })
      .select("_id userName userEmail userContact")
      .lean();

    const vendorGst = String(req.body.vendorGst || "").trim().toUpperCase();
    const vendorPan = String(req.body.vendorPan || "").trim().toUpperCase();

    // GST and PAN Validation
    const gstRegex = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/;
    const panRegex = /^[A-Z]{5}[0-9]{4}[A-Z]{1}$/;

    if (vendorGst && !gstRegex.test(vendorGst)) {
      return res.status(400).json({ success: false, message: "Invalid GST number format" });
    }
    if (vendorPan && !panRegex.test(vendorPan)) {
      return res.status(400).json({ success: false, message: "Invalid PAN number format" });
    }
    if (vendorGst && vendorPan && vendorGst.substring(2, 12) !== vendorPan) {
      return res.status(400).json({ success: false, message: "PAN does not match GST number" });
    }

    const updatedData = {
      vendorId: String(req.body.vendorId || "").trim(),
      vendorName: String(req.body.vendorName || "").trim(),
      vendorStatus: req.body.vendorStatus === "OTHERS" && req.body.otherStatus
        ? `OTHERS - ${String(req.body.otherStatus).trim().toUpperCase().replace(/^(OTHERS - )+/, "")}`
        : String(req.body.vendorStatus || "").trim(),
      hoLocation: String(req.body.hoLocation || "").trim(),
      warehouseLocation: String(req.body.warehouseLocation || "").trim(),
      commodities: (() => {
        let comms = Array.isArray(req.body.commodities)
          ? req.body.commodities.map((c) => String(c).trim().toUpperCase()).filter(Boolean)
          : req.body.commodities
            ? [String(req.body.commodities).trim().toUpperCase()].filter(Boolean)
            : [];
        
        const othersIndex = comms.indexOf("OTHERS");
        if (othersIndex !== -1) {
          const predefined = ["FACE PAPER", "ADHESIVE", "RELEASE PAPER", "SL (PAPER)", "PACKAGING", "TTR", "TAPE", "POS ROLL", "TAFFETA", "PRINTERS", "SCANNERS", "SPARES", "CORE", "FOIL", "IT", "DIE", "BLOCK", "COLOR", "OTHERS"];
          const otherVal = comms.find(c => c !== "OTHERS" && !predefined.includes(c));
          if (otherVal) {
            comms = comms.filter(c => c !== "OTHERS" && c !== otherVal);
            const cleanOtherVal = otherVal.replace(/^(OTHERS - )+/, "");
            comms.push(`OTHERS - ${cleanOtherVal}`);
          }
        }
        return comms;
      })(),
      vendorGst,
      vendorMsme: String(req.body.vendorMsme || "").trim(),
      vendorGumasta: String(req.body.vendorGumasta || "").trim(),
      vendorPan,
    };

    updatedData.vendorSignature = hashSignature(buildVendorSignature(updatedData));

    const duplicate = await Vendor.findOne({
      _id: { $ne: req.params.id },
      vendorSignature: updatedData.vendorSignature,
    }).lean();

    if (duplicate) {
      return res.status(400).json({ success: false, message: "vendor already exist" });
    }

    await Vendor.findByIdAndUpdate(req.params.id, updatedData, { runValidators: true });

    const vendorSnapshot = getVendorSnapshot(updatedData, updatedData);
    if (linkedVendorUsers.length) {
      const bulkOps = linkedVendorUsers.map((vendorUser) => ({
        updateOne: {
          filter: { _id: vendorUser._id },
          update: {
            $set: {
              ...vendorSnapshot,
              vendorUserSignature: hashSignature(buildVendorUserSignature(vendorUser, vendorSnapshot.vendorId)),
            },
          },
        },
      }));

      await VendorUser.bulkWrite(bulkOps);
    }

    req.flash("notification", "Vendor updated successfully!");
    res.json({ success: true, redirect: "/fairdesk/vendor/view" });
  } catch (err) {
    console.error("VENDOR EDIT POST ERROR:", err);
    if (err?.code === 11000) {
      return res.status(409).json({ success: false, message: "vendor already exist" });
    }
    res.status(400).json({ success: false, message: err.message });
  }
});

// Route to handle VENDOR USER form submission
router.post("/form/vendor-user", requireAuth, createLimiter, async (req, res) => {
  try {
    const { objectId } = req.body;
    const vendor = await Vendor.findOne({ _id: objectId }).lean();
    if (!vendor) {
      return res.status(400).json({ success: false, message: "Invalid vendor selected" });
    }

    const vendorSnapshot = getVendorSnapshot(vendor);
    const vendorId = vendorSnapshot.vendorId;
    const userName = String(req.body.userName || "").trim();
    const userContact = String(req.body.userContact || "").trim();
    const userEmail = String(req.body.userEmail || "")
      .trim()
      .toLowerCase();
    const locationDetails = normalizeLocationDetails(
      req.body.locationDetails,
      req.body.userLocation,
      req.body.dispatchAddress,
    ).map((entry) => ({
      userLocation: String(entry.userLocation || "").toUpperCase(),
      dispatchAddress: String(entry.dispatchAddress || "").toUpperCase(),
    }));
    if (!locationDetails.length) {
      return res.status(400).json({
        success: false,
        message: "Please add at least one location and address",
      });
    }
    const primaryLocation = locationDetails[0];
    const vendorUserSignature = hashSignature(buildVendorUserSignature(req.body, vendorId));

    // Prevent duplicates only on full identity tuple within the same vendor.
    const duplicateVendorUser = await VendorUser.findOne({
      $or: [
        { vendorUserSignature },
        {
          vendorId,
          userName: new RegExp(`^${escapeRegex(userName)}$`, "i"),
          userEmail: new RegExp(`^${escapeRegex(userEmail)}$`, "i"),
          userContact: new RegExp(`^${escapeRegex(userContact)}$`, "i"),
        },
      ],
    }).lean();

    if (duplicateVendorUser) {
      return res.status(400).json({
        success: false,
        message: "vendor user already exist (same vendor + name + email + contact)",
      });
    }

    const newUser = await VendorUser.create({
      ...req.body,
      ...vendorSnapshot,
      vendorId,
      userName,
      userContact,
      userEmail,
      locationsCount: locationDetails.length,
      locationDetails,
      userLocation: primaryLocation.userLocation,
      dispatchAddress: primaryLocation.dispatchAddress,
      dropLocation: String(req.body.dropLocation || "").trim(),
      dropLocation1: String(req.body.dropLocation1 || "").trim(),
      deliveryLocation: String(req.body.deliveryLocation || "").trim(),
      deliveryLocation1: String(req.body.deliveryLocation1 || "").trim(),
      vendorUserSignature,
    });

    await Vendor.updateOne({ _id: vendor._id }, { $push: { users: newUser._id } });

    req.flash("notification", "Vendor user created successfully!");
    res.json({ success: true, redirect: "/fairdesk/form/vendor?tab=user" });
  } catch (err) {
    console.error(err);
    if (err?.code === 11000) {
      return res.status(409).json({
        success: false,
        message: "vendor user already exist (same vendor + name + email + contact)",
      });
    }
    res.status(400).json({ success: false, message: err.message });
  }
});

// ================= TTR EDIT =================
router.get("/ttr/edit/:id", async (req, res) => {
  const ttr = await Ttr.findById(req.params.id).lean();
  if (!ttr) return res.redirect("back");

  res.render("inventory/ttrEdit.ejs", {
    title: "Edit TTR",
    CSS: false,
    JS: false,
    ttr,
  });
});

router.post("/ttr/edit/:id", requireAuth, updateLimiter, async (req, res) => {
  try {
    const widthRaw = req.body.ttrWidth;
    const widthTrim = typeof widthRaw === "string" ? widthRaw.trim() : widthRaw;
    const widthNum = typeof widthTrim === "string" ? Number(widthTrim) : Number(widthTrim);
    const widthVal =
      typeof widthTrim === "string" && widthTrim !== "" && !Number.isNaN(widthNum) ? widthNum : widthTrim;
    const ttrCoreId = normalizeTtrCoreId(req.body.ttrCoreId);

    const updateData = {
      ttrType: String(req.body.ttrType || "").trim(),
      ttrColor: String(req.body.ttrColor || "").trim(),
      ttrMaterialCode: String(req.body.ttrMaterialCode || "").trim(),
      ttrWidth: widthVal,
      ttrMtrs: Number(req.body.ttrMtrs),
      ttrInkFace: "OUT",
      ttrCoreId,
      ttrCoreLength: Number(req.body.ttrCoreLength),
      ttrNotch: String(req.body.ttrNotch || "").trim(),
      ttrWinding: String(req.body.ttrWinding || "").trim(),
    };
    updateData.ttrSignature = hashSignature(buildTtrSignature(updateData));

    const duplicateTtrQuery = {
      _id: { $ne: req.params.id },
      $or: [
        { ttrSignature: updateData.ttrSignature },
        {
          ttrType: flexTtrValue(updateData.ttrType),
          ttrColor: flexTtrValue(updateData.ttrColor),
          ttrMaterialCode: flexTtrValue(updateData.ttrMaterialCode),
          ttrWidth: flexTtrValue(updateData.ttrWidth),
          ttrMtrs: updateData.ttrMtrs,
          ttrInkFace: flexTtrValue(updateData.ttrInkFace),
          ttrCoreId: flexTtrValue(updateData.ttrCoreId),
          ttrCoreLength: updateData.ttrCoreLength,
          ttrNotch: flexTtrValue(updateData.ttrNotch),
          ttrWinding: flexTtrValue(updateData.ttrWinding),
        },
      ],
    };

    const duplicateTtr = await Ttr.findOne(duplicateTtrQuery).select("ttrProductId").lean();
    if (duplicateTtr) {
      return res.status(400).json({
        success: false,
        message: duplicateMasterMessage("TTR", duplicateTtr.ttrProductId),
      });
    }

    await Ttr.findByIdAndUpdate(req.params.id, updateData, { new: true, runValidators: true });
    req.flash("notification", "TTR updated successfully!");
    res.json({ success: true, redirect: `/fairdesk/ttr/view` });
  } catch (err) {
    console.error(err);
    if (err?.code === 11000) {
      const duplicateTtr = await Ttr.findOne({
        _id: { $ne: req.params.id },
        ttrSignature: hashSignature(buildTtrSignature(req.body)),
      })
        .select("ttrProductId")
        .lean();
      return res.status(409).json({
        success: false,
        message: duplicateMasterMessage("TTR", duplicateTtr?.ttrProductId),
      });
    }
    res.status(400).json({ success: false, message: err.message });
  }
});

// ----------------------------------Sales Order---------------------------------->
// Centralized Sales Order Form
router.get("/sales/order", async (req, res) => {
  const { orderId } = req.query;
  const clientsPromise = Client.distinct("clientName");
  const locationsPromise = Location.distinct("locationName");
  const submissionToken = crypto.randomUUID();

  const orderPromise = orderId
    ? TapeSalesOrder.findById(orderId)
        .populate("userId")
        .populate("tapeId")
        .populate("tapeBinding")
        .lean()
    : Promise.resolve(null);

  const logsPromise = orderId
    ? SalesOrderLog.find({ orderId, action: "DELIVERED" }).sort({ performedAt: -1 }).lean()
    : Promise.resolve([]);

  const [clients, locations, orderToEdit, logs] = await Promise.all([
    clientsPromise,
    locationsPromise,
    orderPromise,
    logsPromise,
  ]);

  let stockInfo = null;
  if (orderToEdit?.tapeId?._id) {
    try {
      stockInfo = await getItemStockSummary(orderToEdit.onModel, orderToEdit.tapeId._id, orderToEdit._id);
    } catch (err) {
      console.error("EDIT ORDER STOCK SUMMARY ERROR:", err);
    }
  }

  res.render("inventory/salesOrderForm.ejs", {
    clients,
    locations: (locations || []).filter(Boolean).sort(),
    orderToEdit,
    stockInfo,
    logs,
    submissionToken,
    CSS: false,
    JS: false,
    title: orderToEdit ? "Edit Sales Order" : "Sales Order",
    notification: req.flash("notification"),
  });
});

// API: Get items by type and user
// API: Get clients filtered by item type (for smart filter)
router.get("/sales/clients/:itemType", async (req, res) => {
  try {
    const { itemType } = req.params;
    let bindingModel;
    if (itemType === "TAPE") bindingModel = TapeBinding;
    else if (itemType === "POS_ROLL") bindingModel = PosRollBinding;
    else if (itemType === "TAFETA") bindingModel = TafetaBinding;
    else if (itemType === "TTR") bindingModel = TtrBinding;
    else {
      const clients = await Client.distinct("clientName");
      return res.json(clients.sort());
    }
    const userIds = await bindingModel.distinct("userId");
    const users = await Username.find({ _id: { $in: userIds } })
      .select("clientName")
      .lean();
    const clientNames = [...new Set(users.map((u) => u.clientName).filter(Boolean))].sort();
    res.json(clientNames);
  } catch (err) {
    console.error("Sales clients filter error:", err);
    res.status(500).json([]);
  }
});

router.get("/sales/items/:type/:userId", async (req, res) => {
  try {
    const { type, userId } = req.params;
    let items = [];

    const user = await Username.findById(userId)
      .populate({
        path: "tape",
        populate: { path: "tapeId" },
      })
      .populate({
        path: "posRoll",
        populate: { path: "posRollId" },
      })
      .populate({
        path: "tafeta",
        populate: { path: "tafetaId" },
      })
      .populate({
        path: "ttr",
        populate: { path: "ttrId" },
      })
      .populate({
        path: 'label',

      })
      .lean();

    if (!user) return res.json([]);

    if (type === "TAPE") {
      const bindings = user.tape || [];
      items = await Promise.all(
        bindings.map(async (binding) => {
          if (!binding.tapeId) return null;
          const stockInfo = await getItemStockSummary("Tape", binding.tapeId._id);
          const t = binding.tapeId;
          return {
            _id: binding._id,
            displayName: `${t.tapeProductId || "N/A"} - ${t.tapePaperCode || ""} ${t.tapeGsm || ""}gsm`,
            minOrderQty: binding.tapeMinQty || 0,
            rate: binding.tapeRatePerRoll || 0,
            stock: stockInfo,
            details: {
              type: "TAPE",
              productId: t.tapeProductId || "",
              paperCode: t.tapePaperCode || "",
              gsm: t.tapeGsm || "",
              paperType: t.tapePaperType || "",
              adhesiveGsm: t.tapeAdhesiveGsm || "",
              finish: t.tapeFinish || "",
              color: t.tapeColor || "",
              width: t.tapeWidth || "",
              mtrs: t.tapeMtrs || "",
              coreId: t.tapeCoreId || "",
              coreLength: t.tapeCoreLength || "",
              notch: t.tapeNotch || "",
              winding: t.tapeWinding || "",
              clientPaperCode: binding.tapeClientPaperCode || "",
              clientGsm: binding.clientTapeGsm || "",
              deliveredMtrs: binding.tapeMtrsDel || "",
              saleCost: binding.tapeSaleCost || 0,
              minQty: t.tapeMinQty || 0,
              orderQty: binding.tapeOdrQty || 0,
              orderFreq: binding.tapeOdrFreq || "",
              creditTerm: binding.tapeCreditTerm || "",
            },
          };
        }),
      );
    } else if (type === "POS_ROLL") {
      const bindings = user.posRoll || [];
      items = await Promise.all(
        bindings.map(async (binding) => {
          if (!binding.posRollId) return null;
          const stockInfo = await getItemStockSummary("POS Roll", binding.posRollId._id);
          const t = binding.posRollId;
          return {
            _id: binding._id,
            displayName: `${t.posProductId || "N/A"} - ${t.posPaperCode || ""} ${t.posGsm || ""}gsm`,
            minOrderQty: binding.posMinQty || 0,
            rate: binding.posRatePerRoll || 0,
            stock: stockInfo,
            details: {
              type: "POS_ROLL",
              productId: t.posProductId || "",
              paperCode: t.posPaperCode || "",
              gsm: t.posGsm || "",
              paperType: t.posPaperType || "",
              color: t.posColor || "",
              width: t.posWidth || "",
              mtrs: t.posMtrs || "",
              coreId: t.posCoreId || "",
              coreLength: t.posCoreLength || "",
              notch: t.posNotch || "",
              winding: t.posWinding || "",
              clientPaperCode: binding.posClientPaperCode || "",
              clientGsm: binding.clientPosGsm || "",
              deliveredMtrs: binding.posMtrsDel || "",
              saleCost: binding.posSaleCost || 0,
              minQty: t.posMinQty || 0,
              orderQty: binding.posOdrQty || 0,
              orderFreq: binding.posOdrFreq || "",
              creditTerm: binding.posCreditTerm || "",
            },
          };
        }),
      );
    } else if (type === "TAFETA") {
      const bindings = user.tafeta || [];
      items = await Promise.all(
        bindings.map(async (binding) => {
          if (!binding.tafetaId) return null;
          const stockInfo = await getItemStockSummary("Tafeta", binding.tafetaId._id);
          const t = binding.tafetaId;
          return {
            _id: binding._id,
            displayName: `${t.tafetaProductId || "N/A"} - ${t.tafetaMaterialCode || ""} ${t.tafetaGsm || ""}gsm`,
            minOrderQty: binding.tafetaMinQty || 0,
            rate: binding.tafetaRatePerRoll || 0,
            stock: stockInfo,
            details: {
              type: "TAFETA",
              productId: t.tafetaProductId || "",
              materialCode: t.tafetaMaterialCode || "",
              materialType: t.tafetaMaterialType || "",
              gsm: t.tafetaGsm || "",
              color: t.tafetaColor || "",
              width: t.tafetaWidth || "",
              mtrs: t.tafetaMtrs || "",
              coreLength: t.tafetaCoreLen || "",
              coreId: t.tafetaCoreId || "",
              notch: t.tafetaNotch || "",
              clientMaterialCode: binding.tafetaClientMaterialCode || "",
              clientMaterialType: binding.tafetaClientMaterialType || "",
              clientGsm: binding.clientTafetaGsm || "",
              deliveredMtrs: binding.tafetaMtrsDel || "",
              saleCost: binding.tafetaSaleCost || 0,
              minQty: t.tafetaMinQty || 0,
              orderQty: binding.tafetaOdrQty || 0,
              orderFreq: binding.tafetaOdrFreq || "",
              creditTerm: binding.tafetaCreditTerm || "",
            },
          };
        }),
      );
    } else if (type === "TTR") {
      const bindings = user.ttr || [];
      items = await Promise.all(
        bindings.map(async (binding) => {
          if (!binding.ttrId) return null;
          const stockInfo = await getItemStockSummary("TTR", binding.ttrId._id);
          const t = binding.ttrId;
          return {
            _id: binding._id,
            displayName: `${t.ttrType || ""} ${t.ttrWidth || ""}mm x ${t.ttrMtrs || ""}m`,
            minOrderQty: binding.ttrMinQty || 0,
            rate: binding.ttrRatePerRoll || 0,
            stock: stockInfo,
            details: {
              type: "TTR",
              productId: t.ttrProductId || "",
              ttrType: t.ttrType || "",
              color: t.ttrColor || "",
              materialCode: t.ttrMaterialCode || "",
              width: t.ttrWidth || "",
              mtrs: t.ttrMtrs || "",
              inkFace: t.ttrInkFace || "",
              coreId: t.ttrCoreId || "",
              coreLength: t.ttrCoreLength || "",
              notch: t.ttrNotch || "",
              winding: t.ttrWinding || "",
              clientMaterialCode: binding.ttrClientMaterialCode || "",
              clientType: binding.clientTtrType || "",
              deliveredMtrs: binding.ttrMtrsDel || "",
              saleCost: binding.ttrSaleCost || 0,
              minQty: t.ttrMinQty || 0,
              orderQty: binding.ttrOdrQty || 0,
              orderFreq: binding.ttrOdrFreq || "",
              creditTerm: binding.ttrCreditTerm || "",
            },
          };
        }),
      );
    } else if (type === "LABEL") {
      items = (user.label || []).map((lbl) => ({
        _id: lbl._id,
        displayName: `${lbl.labelWidth || ""}x${lbl.labelHeight || ""}`,
        minOrderQty: lbl.minOrderQty || 0,
        rate: parseFloat(lbl.ratePerLabel) || 0,
        stock: { locations: [], totalStock: 0, booked: 0, balance: 0 },
        details: {
          type: "LABEL",
          width: lbl.labelWidth || "",
          height: lbl.labelHeight || "",
          minQty: lbl.minOrderQty || 0,
          rate: parseFloat(lbl.ratePerLabel) || 0,
        },
      }));
    }

    res.json(items.filter(Boolean));
  } catch (err) {
    console.error("ITEMS API ERROR:", err);
    res.json([]);
  }
});

// Submit Sales Order (Create or Update)
router.post("/sales/order", async (req, res) => {
  try {
    const { orderId, itemType, userId, itemId, quantity, estimatedDate, remarks, sourceLocation, locationRadio, userLocation, poNumber, orderRate, submissionToken } = req.body;
    const createdByUser = req.user?.username || "SYSTEM";

    if (["TAPE", "POS_ROLL", "TAFETA", "TTR"].includes(itemType) && canonicalizeLocationName(locationRadio) === "ALL") {
      return res.status(400).json({ success: false, message: "Location cannot be ALL. Please select a specific location." });
    }
    let normalizedSourceLocation = canonicalizeLocationName(sourceLocation || locationRadio || userLocation);
    const isStockBasedType = ["TAPE", "POS_ROLL", "TAFETA", "TTR"].includes(itemType);

    // "ALL" is not a valid storage location for stock-based orders.
    if (normalizedSourceLocation === "ALL") normalizedSourceLocation = "";

    // Fallback 1: derive from selected user.
    if (!normalizedSourceLocation && userId) {
      const userDoc = await Username.findById(userId).select("userLocation").lean();
      normalizedSourceLocation = canonicalizeLocationName(userDoc?.userLocation);
    }

    // Fallback 2: derive from binding -> user -> location.
    if (!normalizedSourceLocation && isStockBasedType && itemId) {
      let bindingUserId = null;

      if (itemType === "TAPE") {
        const binding = await TapeBinding.findById(itemId).select("userId").lean();
        bindingUserId = binding?.userId || null;
      } else if (itemType === "POS_ROLL") {
        const binding = await PosRollBinding.findById(itemId).select("userId").lean();
        bindingUserId = binding?.userId || null;
      } else if (itemType === "TAFETA") {
        const binding = await TafetaBinding.findById(itemId).select("userId").lean();
        bindingUserId = binding?.userId || null;
      } else if (itemType === "TTR") {
        const binding = await TtrBinding.findById(itemId).select("userId").lean();
        bindingUserId = binding?.userId || null;
      }

      if (bindingUserId) {
        const userDoc = await Username.findById(bindingUserId).select("userLocation").lean();
        normalizedSourceLocation = canonicalizeLocationName(userDoc?.userLocation);
      }
    }

    if (isStockBasedType && (!normalizedSourceLocation || normalizedSourceLocation === "ALL")) {
      return res.status(400).json({ success: false, message: "no location is selected" });
    }

    const sourceLocationForSave = normalizedSourceLocation || undefined;

    if (itemType === "TAPE") {
      const binding = await TapeBinding.findById(itemId);
      if (!binding) {
        return res.status(400).json({ success: false, message: "Invalid item selected" });
      }
      const parsedOrderRate = Number(orderRate);
      const finalOrderRate = Number.isFinite(parsedOrderRate) ? parsedOrderRate : Number(binding.tapeRatePerRoll) || 0;

      const data = {
        tapeBinding: itemId,
        userId: binding.userId,
        tapeId: binding.tapeId,
        sourceLocation: sourceLocationForSave, // Allow updating location if needed
        poNumber,
        orderRate: finalOrderRate,
        quantity: Number(quantity),
        estimatedDate: new Date(estimatedDate),
        remarks,
        status: "PENDING",
        onModel: "Tape",
        onBindingModel: "TapeBinding",
      };

      if (orderId) {
        // UPDATE existing order
        await TapeSalesOrder.findByIdAndUpdate(orderId, data);
        req.flash("notification", "Sales order updated successfully!");
        res.json({ success: true, redirect: "/fairdesk/sales/pending" });
      } else {
        // CREATE new order
        data.createdBy = createdByUser;
        data.orderSignature = buildSalesOrderSignature({
          itemType,
          itemId,
          userId: binding.userId,
          quantity: data.quantity,
          estimatedDate,
          poNumber,
          sourceLocation: sourceLocationForSave,
          orderRate: finalOrderRate,
          createdBy: createdByUser,
        });
        data.submissionToken = String(submissionToken || "").trim() || undefined;
        const existingOrder = await TapeSalesOrder.findOne({ orderSignature: data.orderSignature }).select("_id").lean();
        if (existingOrder) {
          return res.json({ success: true, redirect: "/fairdesk/sales/pending", duplicate: true });
        }
        const newOrder = await TapeSalesOrder.create(data);

        // Action Log entry for creation
        await SalesOrderLog.create({
          orderId: newOrder._id,
          action: "CREATED",
          quantity: Number(quantity),
          performedBy: createdByUser,
        });

        req.flash("notification", "Sales order created successfully!");

        // Redirect to pending orders
        res.json({ success: true, redirect: "/fairdesk/sales/pending" });
      }
    } else if (itemType === "POS_ROLL") {
      const binding = await PosRollBinding.findById(itemId);
      if (!binding) {
        return res.status(400).json({ success: false, message: "Invalid POS Roll item selected" });
      }
      const parsedOrderRate = Number(orderRate);
      const finalOrderRate = Number.isFinite(parsedOrderRate) ? parsedOrderRate : Number(binding.posRatePerRoll) || 0;

      const data = {
        tapeBinding: itemId,
        onBindingModel: "PosRollBinding",
        userId: binding.userId,
        tapeId: binding.posRollId,
        onModel: "PosRoll",
        sourceLocation: sourceLocationForSave,
        poNumber,
        orderRate: finalOrderRate,
        quantity: Number(quantity),
        estimatedDate: new Date(estimatedDate),
        remarks,
        status: "PENDING",
      };

      if (orderId) {
        await TapeSalesOrder.findByIdAndUpdate(orderId, data);
        req.flash("notification", "POS Roll order updated successfully!");
        res.json({ success: true, redirect: "/fairdesk/sales/pending" });
      } else {
        data.createdBy = createdByUser;
        data.orderSignature = buildSalesOrderSignature({
          itemType,
          itemId,
          userId: binding.userId,
          quantity: data.quantity,
          estimatedDate,
          poNumber,
          sourceLocation: sourceLocationForSave,
          orderRate: finalOrderRate,
          createdBy: createdByUser,
        });
        data.submissionToken = String(submissionToken || "").trim() || undefined;
        const existingOrder = await TapeSalesOrder.findOne({ orderSignature: data.orderSignature }).select("_id").lean();
        if (existingOrder) {
          return res.json({ success: true, redirect: "/fairdesk/sales/pending", duplicate: true });
        }
        const newOrder = await TapeSalesOrder.create(data);
        await SalesOrderLog.create({
          orderId: newOrder._id,
          action: "CREATED",
          quantity: Number(quantity),
          performedBy: createdByUser,
        });
        req.flash("notification", "POS Roll order created successfully!");
        res.json({ success: true, redirect: "/fairdesk/sales/pending" });
      }
    } else if (itemType === "TAFETA") {
      const binding = await TafetaBinding.findById(itemId);
      if (!binding) {
        return res.status(400).json({ success: false, message: "Invalid Tafeta item selected" });
      }
      const parsedOrderRate = Number(orderRate);
      const finalOrderRate = Number.isFinite(parsedOrderRate) ? parsedOrderRate : Number(binding.tafetaRatePerRoll) || 0;

      const data = {
        tapeBinding: itemId,
        onBindingModel: "TafetaBinding",
        userId: binding.userId,
        tapeId: binding.tafetaId,
        onModel: "Tafeta",
        sourceLocation: sourceLocationForSave,
        poNumber,
        orderRate: finalOrderRate,
        quantity: Number(quantity),
        estimatedDate: new Date(estimatedDate),
        remarks,
        status: "PENDING",
      };

      if (orderId) {
        await TapeSalesOrder.findByIdAndUpdate(orderId, data);
        req.flash("notification", "Tafeta order updated successfully!");
        res.json({ success: true, redirect: "/fairdesk/sales/pending" });
      } else {
        data.createdBy = createdByUser;
        data.orderSignature = buildSalesOrderSignature({
          itemType,
          itemId,
          userId: binding.userId,
          quantity: data.quantity,
          estimatedDate,
          poNumber,
          sourceLocation: sourceLocationForSave,
          orderRate: finalOrderRate,
          createdBy: createdByUser,
        });
        data.submissionToken = String(submissionToken || "").trim() || undefined;
        const existingOrder = await TapeSalesOrder.findOne({ orderSignature: data.orderSignature }).select("_id").lean();
        if (existingOrder) {
          return res.json({ success: true, redirect: "/fairdesk/sales/pending", duplicate: true });
        }
        const newOrder = await TapeSalesOrder.create(data);
        await SalesOrderLog.create({
          orderId: newOrder._id,
          action: "CREATED",
          quantity: Number(quantity),
          performedBy: createdByUser,
        });
        req.flash("notification", "Tafeta order created successfully!");
        res.json({ success: true, redirect: "/fairdesk/sales/pending" });
      }
    } else if (itemType === "TTR") {
      const binding = await TtrBinding.findById(itemId);
      if (!binding) {
        return res.status(400).json({ success: false, message: "Invalid TTR item selected" });
      }
      const parsedOrderRate = Number(orderRate);
      const finalOrderRate = Number.isFinite(parsedOrderRate) ? parsedOrderRate : Number(binding.ttrRatePerRoll) || 0;

      const data = {
        tapeBinding: itemId,
        onBindingModel: "TtrBinding",
        userId: binding.userId,
        tapeId: binding.ttrId,
        onModel: "Ttr",
        sourceLocation: sourceLocationForSave,
        poNumber,
        orderRate: finalOrderRate,
        quantity: Number(quantity),
        estimatedDate: new Date(estimatedDate),
        remarks,
        status: "PENDING",
      };

      if (orderId) {
        await TapeSalesOrder.findByIdAndUpdate(orderId, data);
        req.flash("notification", "TTR order updated successfully!");
        res.json({ success: true, redirect: "/fairdesk/sales/pending" });
      } else {
        data.createdBy = createdByUser;
        data.orderSignature = buildSalesOrderSignature({
          itemType,
          itemId,
          userId: binding.userId,
          quantity: data.quantity,
          estimatedDate,
          poNumber,
          sourceLocation: sourceLocationForSave,
          orderRate: finalOrderRate,
          createdBy: createdByUser,
        });
        data.submissionToken = String(submissionToken || "").trim() || undefined;
        const existingOrder = await TapeSalesOrder.findOne({ orderSignature: data.orderSignature }).select("_id").lean();
        if (existingOrder) {
          return res.json({ success: true, redirect: "/fairdesk/sales/pending", duplicate: true });
        }
        const newOrder = await TapeSalesOrder.create(data);
        await SalesOrderLog.create({
          orderId: newOrder._id,
          action: "CREATED",
          quantity: Number(quantity),
          performedBy: createdByUser,
        });
        req.flash("notification", "TTR order created successfully!");
        res.json({ success: true, redirect: "/fairdesk/sales/pending" });
      }
    } else {
      return res.status(400).json({ success: false, message: "Unsupported item type" });
    }
  } catch (err) {
    console.error("ORDER SUBMIT ERROR:", err);
    const duplicateSubmissionToken =
      err?.code === 11000 &&
      ((err?.keyPattern &&
        (Object.prototype.hasOwnProperty.call(err.keyPattern, "submissionToken") ||
          Object.prototype.hasOwnProperty.call(err.keyPattern, "orderSignature"))) ||
        (err?.keyValue &&
          (Object.prototype.hasOwnProperty.call(err.keyValue, "submissionToken") ||
            Object.prototype.hasOwnProperty.call(err.keyValue, "orderSignature"))) ||
        String(err?.message || "").includes("submissionToken") ||
        String(err?.message || "").includes("orderSignature"));

    if (duplicateSubmissionToken) {
      return res.json({ success: true, redirect: "/fairdesk/sales/pending", duplicate: true });
    }
    const sourceLocError = err?.errors?.sourceLocation;
    if (sourceLocError) {
      return res.status(400).json({ success: false, message: "no location is selected" });
    }
    res.status(400).json({ success: false, message: "Failed to submit order" });
  }
});

// View Pending Orders
router.get("/sales/pending", async (req, res) => {
  try {
    const pendingOrders = await TapeSalesOrder.find({ status: "PENDING" })
      .select(
        "tapeId tapeBinding userId quantity dispatchedQuantity estimatedDate createdAt sourceLocation poNumber orderRate remarks status onModel onBindingModel",
      )
      .populate({ path: "userId", select: "clientName userName" })
      .populate({
        path: "tapeId",
        select:
          "tapeProductId tapePaperCode tapeGsm tapeFinish posProductId posPaperCode posGsm tafetaProductId tafetaMaterialCode tafetaGsm ttrProductId ttrType ttrWidth ttrMtrs labelWidth labelHeight",
      })
      .populate({
        path: "tapeBinding",
        select:
          "tapeRatePerRoll tapeOdrQty tapeMinQty posRatePerRoll posOdrQty posMinQty tafetaRatePerRoll tafetaOdrQty tafetaMinQty ttrRatePerRoll ttrOdrQty ttrMinQty",
      })
      .sort({ createdAt: -1 })
      .lean();

    // Group pending orders by model type and itemId to fetch total stock
    const itemIdsByModel = {
      Tape: new Set(),
      PosRoll: new Set(),
      Tafeta: new Set(),
      Ttr: new Set(),
      Label: new Set()
    };

    pendingOrders.forEach(o => {
      if (o.onModel && o.tapeId) {
        itemIdsByModel[o.onModel].add(o.tapeId?._id?.toString());
      }
    });

    const stockMap = {}; // mapping: "onModel:itemId" -> totalStock

    // Fetch stocks in parallel
    const stockPromises = [
      TapeStock.aggregate([
        { $match: { tape: { $in: Array.from(itemIdsByModel.Tape).map(id => new mongoose.Types.ObjectId(id)) } } },
        { $group: { _id: "$tape", total: { $sum: "$quantity" } } }
      ]),
      PosRollStock.aggregate([
        { $match: { posRoll: { $in: Array.from(itemIdsByModel.PosRoll).map(id => new mongoose.Types.ObjectId(id)) } } },
        { $group: { _id: "$posRoll", total: { $sum: "$quantity" } } }
      ]),
      TafetaStock.aggregate([
        { $match: { tafeta: { $in: Array.from(itemIdsByModel.Tafeta).map(id => new mongoose.Types.ObjectId(id)) } } },
        { $group: { _id: "$tafeta", total: { $sum: "$quantity" } } }
      ]),
      TtrStock.aggregate([
        { $match: { ttr: { $in: Array.from(itemIdsByModel.Ttr).map(id => new mongoose.Types.ObjectId(id)) } } },
        { $group: { _id: "$ttr", total: { $sum: "$quantity" } } }
      ])
    ];

    const [tapeStocks, posStocks, tafetaStocks, ttrStocks] = await Promise.all(stockPromises);

    tapeStocks.forEach(s => stockMap[`Tape:${s._id}`] = s.total);
    posStocks.forEach(s => stockMap[`PosRoll:${s._id}`] = s.total);
    tafetaStocks.forEach(s => stockMap[`Tafeta:${s._id}`] = s.total);
    ttrStocks.forEach(s => stockMap[`Ttr:${s._id}`] = s.total);

    // Fetch active Purchase Orders for these items
    const allItemIds = Object.values(itemIdsByModel).flatMap(set => Array.from(set)).map(id => new mongoose.Types.ObjectId(id));
    const activePOs = await PurchaseOrder.find({
      status: { $in: ["PENDING", "CONFIRMED", "PARTIALLY_RECEIVED"] },
      itemId: { $in: allItemIds }
    }).select("itemId onModel").lean();

    const poItemSet = new Set();
    activePOs.forEach(po => poItemSet.add(`${po.onModel}:${po.itemId}`));

    // Attach totalStock to each order
    pendingOrders.forEach(o => {
      const key = `${o.onModel}:${o.tapeId?._id}`;
      o.totalStock = stockMap[key] || 0;
      o.hasPendingPo = poItemSet.has(key);
    });

    res.render("inventory/pendingOrders.ejs", {
      orders: pendingOrders,
      title: "Pending Orders",
      CSS: "tableDisp.css",
      JS: false,
      notification: req.flash("notification"),
    });
  } catch (err) {
    console.error("PENDING ORDERS ERROR:", err);
    res.redirect("back");
  }
});

// View Pending Purchase Orders
router.get("/purchase/pending", async (req, res) => {
  try {
    const pendingPOs = await PurchaseOrder.find({
      status: { $in: ["PENDING", "CONFIRMED", "PARTIALLY_RECEIVED"] },
      vendorUserId: { $ne: null },
      vendorBinding: { $ne: null },
    })
      .populate("vendorUserId", "vendorName userName")
      .populate({
        path: "itemId",
        select:
          "tapeProductId tapePaperCode tapeGsm posProductId posPaperCode posGsm tafetaProductId tafetaMaterialCode tafetaGsm ttrProductId ttrType ttrWidth ttrMtrs",
      })
      .sort({ createdAt: -1 })
      .lean();

    const orders = pendingPOs.map((order) => ({
      ...order,
      vendorDisplayName: order.vendorUserId?.vendorName || order.vendorName || "Vendor not binded",
      coordinatorDisplayName: order.vendorUserId?.userName || order.coordinatorName || "Coordinator not binded",
    }));

    res.render("inventory/pendingPurchaseOrders.ejs", {
      title: "Pending Purchase Orders",
      orders,
      notification: req.flash("notification"),
      CSS: "tableDisp.css",
      JS: false,
    });
  } catch (err) {
    console.error("PENDING PO ERROR:", err);
    res.status(500).send("Internal Server Error");
  }
});

function getItemName(item, type) {
  if (!item) return "N/A";
  if (type === "Tape") return `${item.tapePaperCode || ""} ${item.tapeGsm || ""}gsm`.trim() || item.tapeProductId;
  if (type === "PosRoll" || type === "Pos-Roll") return `${item.posPaperCode || ""} ${item.posGsm || ""}gsm`.trim() || item.posProductId;
  if (type === "Tafeta") return `${item.tafetaMaterialCode || ""} ${item.tafetaGsm || ""}gsm`.trim() || item.tafetaProductId;
  if (type === "Ttr") return `${item.ttrType || ""} ${item.ttrWidth || ""}x${item.ttrMtrs || ""}`.trim() || item.ttrProductId;
  return "N/A";
}

router.get("/purchase/receive", async (req, res) => {
  try {
    const { orderId } = req.query;
    if (!orderId) {
      req.flash("notification", "No order ID provided.");
      return res.redirect("/fairdesk/purchase/pending");
    }

    const order = await PurchaseOrder.findById(orderId)
      .populate("vendorUserId")
      .populate("itemId")
      .lean();

    if (!order) {
      req.flash("notification", "Purchase Order not found.");
      return res.redirect("/fairdesk/purchase/pending");
    }

    const [logs, locations] = await Promise.all([
      PurchaseOrderLog.find({ orderId: orderId, action: { $ne: "CREATED" } })
        .sort({ createdAt: -1 })
        .lean(),
      Location.distinct("locationName")
    ]);

    res.render("inventory/receivePO.ejs", {
      title: "Receive Purchase Order",
      order,
      logs: logs || [],
      locations: (locations || []).filter(Boolean).sort(),
      itemName: getItemName(order.itemId, order.onModel),
      notification: req.flash("notification"),
      CSS: false,
      JS: false
    });
  } catch (err) {
    console.error("RECEIVE PO GET ERROR:", err);
    res.status(500).send("Internal Server Error");
  }
});

router.post("/purchase/receive", async (req, res) => {
  try {
    const { orderId, location, receivedQuantity, remarks } = req.body;
    
    const po = await PurchaseOrder.findById(orderId).populate("itemId");
    if (!po) {
      req.flash("notification", "Purchase Order not found.");
      return res.redirect("/fairdesk/purchase/pending");
    }

    if (po.status === "RECEIVED") {
      req.flash("notification", "This order has already been received.");
      return res.redirect("/fairdesk/purchase/pending");
    }

    const qty = Number(receivedQuantity) || po.quantity;

    // Create Stock Entry based on item type
    if (po.onModel === "Tape") {
      await TapeStock.create({
        tape: po.itemId._id,
        location,
        quantity: qty,
        remarks: remarks || `From PO: ${po.poNumber}`,
        tapeFinish: po.itemId.tapeFinish || "MATTE"
      });
    } else if (po.onModel === "PosRoll" || po.onModel === "Pos-Roll") {
      await PosRollStock.create({
        posRoll: po.itemId._id,
        location,
        quantity: qty,
        remarks: remarks || `From PO: ${po.poNumber}`
      });
    } else if (po.onModel === "Tafeta") {
      await TafetaStock.create({
        tafeta: po.itemId._id,
        location,
        quantity: qty,
        remarks: remarks || `From PO: ${po.poNumber}`
      });
    } else if (po.onModel === "Ttr") {
      await TtrStock.create({
        ttr: po.itemId._id,
        location,
        quantity: qty,
        remarks: remarks || `From PO: ${po.poNumber}`
      });
    }

    // Update PO Status & Quantities
    const newlyReceived = qty;
    po.receivedQuantity = (po.receivedQuantity || 0) + newlyReceived;
    
    if (po.receivedQuantity >= po.quantity) {
      po.status = "RECEIVED";
    } else {
      po.status = "PARTIALLY_RECEIVED";
    }

    po.remarks = (po.remarks ? po.remarks + " | " : "") + (remarks || `Received ${newlyReceived}`);
    await po.save();

    // Log Action
    await PurchaseOrderLog.create({
      orderId: po._id,
      action: po.status === "RECEIVED" ? "RECEIVED" : "PARTIALLY_RECEIVED",
      poNumber: po.poNumber,
      quantity: newlyReceived,
      location: location,
      remarks: `Inward to ${location}. ` + (remarks || ""),
      performedBy: req.session?.authUser?.username || "SYSTEM"
    });

    req.flash("notification", "Purchase Order received and stock updated successfully.");
    res.redirect("/fairdesk/purchase/pending");
  } catch (err) {
    console.error("RECEIVE PO POST ERROR:", err);
    req.flash("notification", "Error processing receipt: " + err.message);
    res.redirect("back");
  }
});

// GET: Confirm Order Page (prefilled sales order form + extra fields)
router.get("/sales/order/confirm", async (req, res) => {
  try {
    const { orderId } = req.query;
    if (!orderId) {
      req.flash("notification", "No order specified");
      return res.redirect("/fairdesk/sales/pending");
    }

    const order = await TapeSalesOrder.findById(orderId)
      .populate({ path: "userId", select: "clientName userName userLocation" })
      .populate({
        path: "tapeId",
        select:
          "tapeProductId tapePaperCode tapeGsm tapeFinish tapePaperType tapeAdhesiveGsm tapeWidth tapeMtrs tapeCoreId posProductId posPaperCode posGsm posPaperType posColor posWidth posCoreId posMtrs tafetaProductId tafetaMaterialCode tafetaGsm tafetaMaterialType tafetaColor tafetaWidth tafetaMtrs tafetaCoreLen tafetaCoreId tafetaNotch ttrProductId ttrType ttrColor ttrMaterialCode ttrWidth ttrMtrs ttrInkFace ttrCoreId ttrCoreLength ttrNotch ttrWinding labelWidth labelHeight",
      })
      .populate({
        path: "tapeBinding",
        select:
          "tapeRatePerRoll tapeOdrQty tapeMinQty tapeClientMaterialCode clientTapeGsm posRatePerRoll posOdrQty posMinQty posClientMaterialCode clientPosGsm tafetaRatePerRoll tafetaOdrQty tafetaMinQty tafetaClientMaterialCode clientTafetaGsm ttrRatePerRoll ttrOdrQty ttrMinQty ttrClientMaterialCode clientTtrType",
      })
      .lean();

    if (!order) {
      req.flash("notification", "Order not found");
      return res.redirect("/fairdesk/sales/pending");
    }

    const logs = await SalesOrderLog.find({ orderId, action: "DELIVERED" }).sort({ performedAt: -1 }).lean();
    const locations = await Location.distinct("locationName");

    // ========== STOCK PRE-CALCULATION FOR CONFIRM PAGE ==========
    let stockInfo = { totalStock: 0, locations: [], booked: 0, balance: 0 };
    if (order.tapeId) {
      try {
        stockInfo = await getItemStockSummary(order.onModel, order.tapeId._id);
      } catch (err) {
        console.error("CONFIRM STOCK SUMMARY ERROR:", err);
      }
    }

    const clients = await Client.distinct("clientName");

    res.render("inventory/salesOrderForm.ejs", {
      clients,
      locations: (locations || []).filter(Boolean).sort(),
      orderToEdit: order,
      stockInfo, // Pass pre-calculated stock
      logs,
      confirmMode: true,
      CSS: false,
      JS: false,
      title: "Confirm & Create Order",
      notification: req.flash("notification"),
    });
  } catch (err) {
    console.error("CONFIRM ORDER PAGE ERROR:", err);
    req.flash("notification", "Failed to load confirm page");
    res.redirect("/fairdesk/sales/pending");
  }
});

// GET: Order Logs
router.get("/sales/order/logs", async (req, res) => {
  try {
    const logs = await SalesOrderLog.find()
      .populate({
        path: "orderId",
        populate: [
          { path: "userId", select: "clientName userName" },
          {
            path: "tapeId",
            select:
              "tapeProductId tapePaperCode tapeGsm tapeFinish posProductId posPaperCode posGsm tafetaProductId tafetaMaterialCode tafetaGsm ttrProductId ttrColor ttrType ttrWidth ttrMtrs labelWidth labelHeight",
          },
        ],
      })
      .sort({ performedAt: -1 })
      .lean();

    res.render("inventory/orderLogs.ejs", {
      logs,
      title: "Order Action Logs",
      CSS: "tableDisp.css",
      JS: false,
      notification: req.flash("notification"),
    });
  } catch (err) {
    console.error("ORDER LOGS ERROR:", err);
    req.flash("notification", "Failed to load logs");
    res.redirect("/fairdesk/sales/pending");
  }
});

// ========== EDIT a Purchase Receipt Log (JSON API) ==========
router.put("/purchase/log/:logId", requireAuth, updateLimiter, async (req, res) => {
  try {
    const { logId } = req.params;
    const { quantity: newQty, remarks: newRemarks } = req.body;

    const log = await PurchaseOrderLog.findById(logId);
    if (!log) return res.json({ success: false, message: "Receipt log not found" });

    const po = await PurchaseOrder.findById(log.orderId).populate("itemId");
    if (!po) return res.json({ success: false, message: "Purchase Order not found" });

    const oldQty = log.quantity || 0;
    const qtyDiff = Number(newQty) - oldQty;
    const location = log.location;

    // Item-specific stock models
    let StockModel = TapeStock;
    let StockLogModel = TapeStockLog;
    let matchField = "tape";

    if (po.onModel === "PosRoll") {
      StockModel = PosRollStock;
      StockLogModel = PosRollStockLog;
      matchField = "posRoll";
    } else if (po.onModel === "Tafeta") {
      StockModel = TafetaStock;
      StockLogModel = TafetaStockLog;
      matchField = "tafeta";
    } else if (po.onModel === "Ttr") {
      StockModel = TtrStock;
      StockLogModel = TtrStockLog;
      matchField = "ttr";
    }

    if (location && po.itemId && qtyDiff !== 0) {
      // Get current stock at location
      const bal = await StockModel.aggregate([
        { $match: { [matchField]: po.itemId._id, location: location } },
        { $group: { _id: null, qty: { $sum: "$quantity" } } },
      ]);
      const currentStock = bal[0]?.qty || 0;

      if (qtyDiff < 0) {
        // Need to reverse (outward) some stock because new quantity is lower
        const deduction = Math.abs(qtyDiff);
        if (currentStock < deduction) {
          return res.json({ success: false, message: `Insufficient stock at ${location} to reduce receipt. Available: ${currentStock}, adjustment needed: ${deduction}` });
        }

        const stockData = {
          [matchField]: po.itemId._id,
          location,
          quantity: -deduction,
          remarks: `Receipt Log Edited (reduced): ${po.poNumber}`,
        };
        if (po.onModel === "Tape") stockData.tapeFinish = po.itemId.tapeFinish;
        await StockModel.create(stockData);

        await StockLogModel.create({
          [matchField]: po.itemId._id,
          location,
          openingStock: currentStock,
          quantity: deduction,
          closingStock: currentStock - deduction,
          type: "OUTWARD",
          source: "SYSTEM",
          remarks: `Receipt Log Edited: ${po.poNumber}`,
          createdBy: req.session?.authUser?.username || "SYSTEM"
        });
      } else {
        // Need to inward MORE stock because new quantity is higher
        const addition = qtyDiff;
        const stockData = {
          [matchField]: po.itemId._id,
          location,
          quantity: addition,
          remarks: `Receipt Log Edited (increased): ${po.poNumber}`,
        };
        if (po.onModel === "Tape") stockData.tapeFinish = po.itemId.tapeFinish;
        await StockModel.create(stockData);

        await StockLogModel.create({
          [matchField]: po.itemId._id,
          location,
          openingStock: currentStock,
          quantity: addition,
          closingStock: currentStock + addition,
          type: "INWARD",
          source: "SYSTEM",
          remarks: `Receipt Log Edited: ${po.poNumber}`,
          createdBy: req.session?.authUser?.username || "SYSTEM"
        });
      }
    }

    // Update PO totals
    po.receivedQuantity = (po.receivedQuantity || 0) + qtyDiff;
    if (po.receivedQuantity >= po.quantity) {
      po.status = "RECEIVED";
    } else if (po.receivedQuantity > 0) {
      po.status = "PARTIALLY_RECEIVED";
    } else {
      po.status = "CONFIRMED"; 
    }
    await po.save();

    // Update Log Record
    log.quantity = Number(newQty);
    if (newRemarks) log.remarks = newRemarks;
    await log.save();

    res.json({ success: true, message: "Receipt log updated successfully" });
  } catch (err) {
    console.error("EDIT PURCHASE LOG ERROR:", err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ========== DELETE a Purchase Receipt Log (JSON API) ==========
router.delete("/purchase/log/:logId", requireAuth, deleteLimiter, async (req, res) => {
  try {
    const { logId } = req.params;
    const log = await PurchaseOrderLog.findById(logId);
    if (!log) return res.json({ success: false, message: "Log not found" });

    const po = await PurchaseOrder.findById(log.orderId).populate("itemId");
    if (!po) return res.json({ success: false, message: "Order not found" });

    const qtyToRemove = log.quantity || 0;
    const location = log.location;

    // Item-specific stock models
    let StockModel = TapeStock;
    let StockLogModel = TapeStockLog;
    let matchField = "tape";

    if (po.onModel === "PosRoll") {
      StockModel = PosRollStock;
      StockLogModel = PosRollStockLog;
      matchField = "posRoll";
    } else if (po.onModel === "Tafeta") {
      StockModel = TafetaStock;
      StockLogModel = TafetaStockLog;
      matchField = "tafeta";
    } else if (po.onModel === "Ttr") {
      StockModel = TtrStock;
      StockLogModel = TtrStockLog;
      matchField = "ttr";
    }

    if (location && po.itemId && qtyToRemove > 0) {
      // Reverse stock (outward)
      const bal = await StockModel.aggregate([
        { $match: { [matchField]: po.itemId._id, location: location } },
        { $group: { _id: null, qty: { $sum: "$quantity" } } },
      ]);
      const currentStock = bal[0]?.qty || 0;

      if (currentStock < qtyToRemove) {
          return res.json({ success: false, message: `Insufficient stock at ${location} to reverse receipt. Available: ${currentStock}` });
      }

      const stockData = {
        [matchField]: po.itemId._id,
        location,
        quantity: -qtyToRemove,
        remarks: `Receipt Log Deleted (reversed): ${po.poNumber}`,
      };
      if (po.onModel === "Tape") stockData.tapeFinish = po.itemId.tapeFinish;
      await StockModel.create(stockData);

      await StockLogModel.create({
        [matchField]: po.itemId._id,
        location,
        openingStock: currentStock,
        quantity: qtyToRemove,
        closingStock: currentStock - qtyToRemove,
        type: "OUTWARD",
        source: "SYSTEM",
        remarks: `Receipt Log Deleted: ${po.poNumber}`,
        createdBy: req.session?.authUser?.username || "SYSTEM"
      });
    }

    // Update PO totals
    po.receivedQuantity = Math.max((po.receivedQuantity || 0) - qtyToRemove, 0);
    if (po.receivedQuantity === 0) {
      po.status = "CONFIRMED";
    } else if (po.receivedQuantity < po.quantity) {
      po.status = "PARTIALLY_RECEIVED";
    }
    await po.save();

    // Remove the Log Entry
    await PurchaseOrderLog.findByIdAndDelete(logId);

    res.json({ success: true, message: "Receipt deleted successfully and stock reversed" });
  } catch (err) {
    console.error("DELETE PURCHASE LOG ERROR:", err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET: Purchase Order Logs
router.get("/purchase/order/logs", async (req, res) => {
  try {
    const logs = await PurchaseOrderLog.find()
      .populate({
        path: "orderId",
        populate: [
          { path: "vendorUserId", select: "vendorName userName" },
          {
            path: "itemId",
            select:
              "tapeProductId tapePaperCode tapeGsm posProductId posPaperCode posGsm tafetaProductId tafetaMaterialCode tafetaGsm ttrProductId ttrType ttrWidth ttrMtrs",
          },
        ],
      })
      .sort({ performedAt: -1 })
      .lean();

    res.render("inventory/purchaseLogs.ejs", {
      logs,
      title: "Purchase Action Logs",
      CSS: "tableDisp.css",
      JS: false,
      notification: req.flash("notification"),
    });
  } catch (err) {
    console.error("PURCHASE LOGS ERROR:", err);
    req.flash("notification", "Failed to load purchase logs");
    res.redirect("/fairdesk/purchase/pending");
  }
});

// Update Order Status (with stock deduction / reversal + action logging)
router.post("/sales/order/status", requireAuth, updateLimiter, async (req, res) => {
  try {
    const accepts = req.headers.accept || "";
    const wantsJson = req.xhr || accepts.includes("application/json") || accepts.includes("text/json");
    const { orderId, status, cancelReason, invoiceNumber, confirmDate, confirmQuantity, poNumber, sourceLocation } = req.body;
    const confirmRedirectUrl = orderId ? `/fairdesk/sales/order/confirm?orderId=${encodeURIComponent(orderId)}` : "/fairdesk/sales/pending";
    const order = await TapeSalesOrder.findById(orderId)
      .populate({ path: "tapeId", select: "tapeFinish tapePaperCode tapeGsm" })
      .lean();

    if (!order) {
      const message = "Order not found";
      if (wantsJson) return res.status(404).json({ success: false, message });
      req.flash("notification", message);
      return res.redirect(confirmRedirectUrl);
    }

    const previousStatus = order.status;
    console.log(`[DEBUG] Order ${orderId}: Status change ${previousStatus} -> ${status}`);

    if (status === "CONFIRMED") {
      const incomingPo = String(poNumber || "").trim();
      const existingPo = String(order.poNumber || "").trim();
      if (!incomingPo && !existingPo) {
        const message = "PO Number is required before confirming this order.";
        if (wantsJson) return res.status(400).json({ success: false, message });
        req.flash("notification", message);
        return res.redirect(confirmRedirectUrl);
      }

      const incomingInvoice = String(invoiceNumber || "").trim();
      if (isTemplateOnlyInvoice(incomingInvoice)) {
        const message = "Please enter Invoice Number before submitting the form.";
        if (wantsJson) return res.status(400).json({ success: false, message });
        req.flash("notification", message);
        return res.redirect(confirmRedirectUrl);
      }
    }

    // ========== CONFIRM: Deduct stock ==========
    let finalStatus = status;

    if (status === "CONFIRMED" && previousStatus === "PENDING") {
      const tapeObjectId = new mongoose.Types.ObjectId(order.tapeId._id);
      const location = canonicalizeLocationName(sourceLocation || order.sourceLocation);

      let StockModel = TapeStock;
      let StockLogModel = TapeStockLog;
      let matchField = "tape";

      if (order.onModel === "PosRoll") {
        StockModel = PosRollStock;
        StockLogModel = PosRollStockLog;
        matchField = "posRoll";
      } else if (order.onModel === "Tafeta") {
        StockModel = TafetaStock;
        StockLogModel = TafetaStockLog;
        matchField = "tafeta";
      } else if (order.onModel === "Ttr") {
        StockModel = TtrStock;
        StockLogModel = TtrStockLog;
        matchField = "ttr";
      }

      if (!location) {
        const message = "Cannot confirm: Source location missing on order";
        if (wantsJson) {
          return res.status(400).json({ success: false, message });
        }
        req.flash("notification", message);
        return res.redirect(confirmRedirectUrl);
      }

      const tape = order.tapeId;
      const qty = Number(confirmQuantity) || order.quantity;
      const dispatchedSoFar = order.dispatchedQuantity || 0;
      const remaining = order.quantity - dispatchedSoFar;

      if (qty > remaining) {
        const message = `Cannot dispatch ${qty}. Only ${remaining} remaining.`;
        if (wantsJson) {
          return res.status(400).json({ success: false, message });
        }
        req.flash("notification", message);
        return res.redirect(confirmRedirectUrl);
      }

      // Match the confirm-page balance: physical stock minus other pending bookings at this location.
      const [bal, bookedAgg] = await Promise.all([
        StockModel.aggregate([
          { $match: { [matchField]: tapeObjectId, location } },
          { $group: { _id: null, qty: { $sum: "$quantity" } } },
        ]),
        TapeSalesOrder.aggregate([
          {
            $match: {
              tapeId: tapeObjectId,
              status: "PENDING",
              sourceLocation: location,
              _id: { $ne: new mongoose.Types.ObjectId(orderId) },
            },
          },
          {
            $group: {
              _id: null,
              bookedQty: {
                $sum: { $subtract: ["$quantity", { $ifNull: ["$dispatchedQuantity", 0] }] },
              },
            },
          },
        ]),
      ]);
      const currentStock = bal[0]?.qty || 0;
      const bookedQty = bookedAgg[0]?.bookedQty || 0;

      // Validate sufficient stock against physical quantity
      if (currentStock < qty) {
        const message = currentStock <= 0
          ? "cannot dispatch, not enough stocks"
          : `Cannot dispatch ${qty}. Only ${currentStock} available at ${location}.`;
        if (wantsJson) {
          return res.status(400).json({ success: false, message });
        }
        req.flash("notification", message);
        return res.redirect(confirmRedirectUrl);
      }

      // Insert negative stock entry (outward)
      const stockData = {
        [matchField]: tapeObjectId,
        location,
        quantity: -qty,
        remarks: `Sales Order Confirmed: ${orderId}`,
      };
      if (order.onModel === "Tape") stockData.tapeFinish = tape.tapeFinish;
      if (order.onModel === "Tafeta") stockData.tafetaType = tape.tafetaType;

      await StockModel.create(stockData);

      // Stock Log entry
      const logData = {
        [matchField]: tapeObjectId,
        location,
        openingStock: currentStock,
        quantity: qty,
        closingStock: currentStock - qty,
        type: "OUTWARD",
        source: "SYSTEM",
        remarks: `Sales Order Confirmed: ${orderId}`,
        createdBy: req.user?.username || "SYSTEM",
      };
      await StockLogModel.create(logData);

      // Calculate action time: Use Confirm Date (for date) + Current Time (for time)
      const now = new Date();
      let actionTime = now;
      if (confirmDate) {
        const [y, m, d] = confirmDate.split("-").map(Number);
        actionTime = new Date(y, m - 1, d, now.getHours(), now.getMinutes(), now.getSeconds());
      }

      // Action Log entry
      await SalesOrderLog.create({
        orderId,
        action: "DELIVERED",
        invoiceNumber: invoiceNumber || "",
        quantity: qty,
        performedBy: req.user?.username || "SYSTEM",
        performedAt: actionTime,
      });

      // Calculate new dispatched quantity
      const newDispatched = dispatchedSoFar + qty;

      // Determine if fully dispatched
      if (newDispatched >= order.quantity) {
        finalStatus = "CONFIRMED";
      } else {
        finalStatus = "PENDING";
      }

      // Update dispatched quantity immediately to be safe, status will be updated below
      await TapeSalesOrder.findByIdAndUpdate(orderId, { dispatchedQuantity: newDispatched });

      console.log(
        `[DEBUG] Stock deduction + action log successful. Dispatched: ${qty}, Total: ${newDispatched}/${order.quantity}, New Status: ${finalStatus}`,
      );
    } else if (status === "CONFIRMED") {
      console.log(`[DEBUG] Skipping deduction. Status: ${status}, Previous: ${previousStatus}`);
    }

    // ========== CANCEL: Log with reason ==========
    if (status === "CANCELLED" && previousStatus === "PENDING") {
      // Action Log entry for cancel from PENDING
      await SalesOrderLog.create({
        orderId,
        action: "CANCELLED",
        cancelReason: cancelReason || "No reason provided",
        quantity: order.quantity,
        performedBy: req.user?.username || "SYSTEM",
      });
    }

    // ========== CANCEL a CONFIRMED order: Reverse stock ==========
    if (status === "CANCELLED" && previousStatus === "CONFIRMED") {
      const tapeObjectId = new mongoose.Types.ObjectId(order.tapeId._id);
      const location = order.sourceLocation;
      const tape = order.tapeId;

      let StockModel = TapeStock;
      let StockLogModel = TapeStockLog;
      let matchField = "tape";

      if (order.onModel === "PosRoll") {
        StockModel = PosRollStock;
        StockLogModel = PosRollStockLog;
        matchField = "posRoll";
      } else if (order.onModel === "Tafeta") {
        StockModel = TafetaStock;
        StockLogModel = TafetaStockLog;
        matchField = "tafeta";
      } else if (order.onModel === "Ttr") {
        StockModel = TtrStock;
        StockLogModel = TtrStockLog;
        matchField = "ttr";
      }

      const qty = order.quantity; // TODO: Should this be dispatchedQuantity? For now assume cancelling full order if it was fully confirmed. Or partial?
      // If partial dispatch was supported, we really need to know *what* to reverse.
      // But assuming CONFIRMED means *fully* dispatched for now (or at least that's the only state we reverse from).
      // If it's PENDING but partially dispatched, and we cancel... we should reverse dispatchedQuantity.

      // Logic refinement for CANCEL:
      // If PENDING and dispatchedQuantity > 0, we should reverse that amount?
      // The current request didn't ask for generic cancel improvements, but I should probably handle it.
      // However, sticking to the requested scope: "click dispatch order... select less qty... should not be removed from pending"

      // Let's leave Cancel logic mostly as is, but maybe use dispatchedQuantity if available?
      // If previousStatus == CONFIRMED, it means it was fully dispatched (by my new logic).
      // So order.quantity is correct (or order.dispatchedQuantity which should be >= quantity).

      const qtyToReverse = order.dispatchedQuantity > 0 ? order.dispatchedQuantity : order.quantity;

      // Get current stock at this location
      const bal = await StockModel.aggregate([
        { $match: { [matchField]: tapeObjectId, location } },
        { $group: { _id: null, qty: { $sum: "$quantity" } } },
      ]);
      const currentStock = bal[0]?.qty || 0;

      // Re-add stock (positive entry)
      const stockData = {
        [matchField]: tapeObjectId,
        location,
        quantity: qtyToReverse,
        remarks: `Sales Order Cancelled (reversed): ${orderId}`,
      };
      if (order.onModel === "Tape") stockData.tapeFinish = tape.tapeFinish;
      if (order.onModel === "Tafeta") stockData.tafetaType = tape.tafetaType;

      await StockModel.create(stockData);

      // Stock Log entry
      const logData = {
        [matchField]: tapeObjectId,
        location,
        openingStock: currentStock,
        quantity: qtyToReverse,
        closingStock: currentStock + qtyToReverse,
        type: "INWARD",
        source: "SYSTEM",
        remarks: `Sales Order Cancelled (reversed): ${orderId}`,
        createdBy: req.user?.username || "SYSTEM",
      };
      await StockLogModel.create(logData);

      // Action Log entry for cancel from CONFIRMED
      await SalesOrderLog.create({
        orderId,
        action: "CANCELLED",
        cancelReason: cancelReason || "No reason provided",
        quantity: qtyToReverse,
        performedBy: req.user?.username || "SYSTEM",
      });

      // Reset dispatched qty
      await TapeSalesOrder.findByIdAndUpdate(orderId, { dispatchedQuantity: 0 });
    }

    // Update order status and PO number (if submitted on confirm page)
    const updateData = { status: finalStatus };
    if (typeof poNumber !== "undefined") {
      const incomingPo = String(poNumber || "").trim();
      if (incomingPo) updateData.poNumber = incomingPo;
    }
    await TapeSalesOrder.findByIdAndUpdate(orderId, updateData);

    if (finalStatus === "PENDING" && status === "CONFIRMED") {
      req.flash("notification", `Partially dispatched. remaining is pending.`);
    } else if (status === "CANCELLED") {
      req.flash("notification", "order deleted");
    } else {
      req.flash("notification", `Order status updated to ${finalStatus}`);
    }
    if (wantsJson) {
      res.json({ success: true, redirect: "/fairdesk/sales/pending" });
    } else {
      res.redirect("/fairdesk/sales/pending");
    }
  } catch (err) {
    console.error("STATUS UPDATE ERROR:", err);
    const accepts = req.headers.accept || "";
    const wantsJson = req.xhr || accepts.includes("application/json") || accepts.includes("text/json");
    if (wantsJson) {
      res.status(400).json({ success: false, message: "Failed to update status" });
    } else {
      req.flash("notification", "Failed to update status");
      res.redirect("back");
    }
  }
});

// ========== EDIT a Dispatch Log (JSON API) ==========
router.put("/sales/order/log/:logId", requireAuth, updateLimiter, async (req, res) => {
  try {
    const { logId } = req.params;
    const { quantity: newQty, invoiceNumber, date } = req.body;

    const log = await SalesOrderLog.findById(logId).lean();
    if (!log) return res.json({ success: false, message: "Log not found" });

    const order = await TapeSalesOrder.findById(log.orderId).populate({ path: "tapeId", select: "tapeFinish" }).lean();
    if (!order) return res.json({ success: false, message: "Order not found" });

    const oldQty = log.quantity;
    const qtyDiff = Number(newQty) - oldQty;
    const tapeObjectId = new mongoose.Types.ObjectId(order.tapeId._id);
    const location = order.sourceLocation;
    const tape = order.tapeId;

    let StockModel = TapeStock;
    let StockLogModel = TapeStockLog;
    let matchField = "tape";

    if (order.onModel === "PosRoll") {
      StockModel = PosRollStock;
      StockLogModel = PosRollStockLog;
      matchField = "posRoll";
    } else if (order.onModel === "Tafeta") {
      StockModel = TafetaStock;
      StockLogModel = TafetaStockLog;
      matchField = "tafeta";
    } else if (order.onModel === "Ttr") {
      StockModel = TtrStock;
      StockLogModel = TtrStockLog;
      matchField = "ttr";
    }

    if (location && tape && qtyDiff !== 0) {
      // Get current stock at location
      const bal = await StockModel.aggregate([
        { $match: { [matchField]: tapeObjectId, location } },
        { $group: { _id: null, qty: { $sum: "$quantity" } } },
      ]);
      const currentStock = bal[0]?.qty || 0;

      if (qtyDiff > 0) {
        // Need to deduct MORE stock
        if (currentStock < qtyDiff) {
          return res.json({
            success: false,
            message: `Insufficient stock at ${location}. Available: ${currentStock}, Additional needed: ${qtyDiff}`,
          });
        }

        const stockData = {
          [matchField]: tapeObjectId,
          location,
          quantity: -qtyDiff,
          remarks: `Log Edit (additional deduction): ${log.orderId}`,
        };
        if (order.onModel === "Tape") stockData.tapeFinish = tape.tapeFinish;
        if (order.onModel === "Tafeta") stockData.tafetaType = tape.tafetaType;

        await StockModel.create(stockData);

        const logData = {
          [matchField]: tapeObjectId,
          location,
          openingStock: currentStock,
          quantity: qtyDiff,
          closingStock: currentStock - qtyDiff,
          type: "OUTWARD",
          source: "SYSTEM",
          remarks: `Log Edit (additional deduction): ${log.orderId}`,
          createdBy: req.user?.username || "SYSTEM",
        };
        await StockLogModel.create(logData);
      } else {
        // Reverse some stock (qtyDiff is negative, so -qtyDiff is positive)
        const reverseQty = -qtyDiff;

        const stockData = {
          [matchField]: tapeObjectId,
          location,
          quantity: reverseQty,
          remarks: `Log Edit (partial reversal): ${log.orderId}`,
        };
        if (order.onModel === "Tape") stockData.tapeFinish = tape.tapeFinish;
        if (order.onModel === "Tafeta") stockData.tafetaType = tape.tafetaType;

        await StockModel.create(stockData);

        const logData = {
          [matchField]: tapeObjectId,
          location,
          openingStock: currentStock,
          quantity: reverseQty,
          closingStock: currentStock + reverseQty,
          type: "INWARD",
          source: "SYSTEM",
          remarks: `Log Edit (partial reversal): ${log.orderId}`,
          createdBy: req.user?.username || "SYSTEM",
        };
        await StockLogModel.create(logData);
      }
    }

    // Update dispatched quantity on the order
    const newDispatched = (order.dispatchedQuantity || 0) + qtyDiff;
    const newStatus = newDispatched >= order.quantity ? "CONFIRMED" : "PENDING";

    await TapeSalesOrder.findByIdAndUpdate(order._id, {
      dispatchedQuantity: newDispatched,
      status: newStatus,
    });

    // Calculate action time using the provided date + current time
    const now = new Date();
    let actionTime = now;
    if (date) {
      const [y, m, d] = date.split("-").map(Number);
      actionTime = new Date(y, m - 1, d, now.getHours(), now.getMinutes(), now.getSeconds());
    }

    // Update the log entry
    await SalesOrderLog.findByIdAndUpdate(logId, {
      quantity: Number(newQty),
      invoiceNumber: invoiceNumber || "",
      performedAt: actionTime,
    });

    return res.json({ success: true });
  } catch (err) {
    console.error("EDIT LOG ERROR:", err);
    return res.json({ success: false, message: "Server error" });
  }
});

// ========== DELETE a Dispatch Log (JSON API) ==========
router.delete("/sales/order/log/:logId", requireAuth, deleteLimiter, async (req, res) => {
  try {
    const { logId } = req.params;

    const log = await SalesOrderLog.findById(logId).lean();
    if (!log) return res.json({ success: false, message: "Log not found" });

    const order = await TapeSalesOrder.findById(log.orderId).populate({ path: "tapeId", select: "tapeFinish" }).lean();
    if (!order) return res.json({ success: false, message: "Order not found" });

    const tapeObjectId = new mongoose.Types.ObjectId(order.tapeId._id);
    const location = order.sourceLocation;
    const tape = order.tapeId;
    const qty = log.quantity;

    let StockModel = TapeStock;
    let StockLogModel = TapeStockLog;
    let matchField = "tape";

    if (order.onModel === "PosRoll") {
      StockModel = PosRollStock;
      StockLogModel = PosRollStockLog;
      matchField = "posRoll";
    } else if (order.onModel === "Tafeta") {
      StockModel = TafetaStock;
      StockLogModel = TafetaStockLog;
      matchField = "tafeta";
    } else if (order.onModel === "Ttr") {
      StockModel = TtrStock;
      StockLogModel = TtrStockLog;
      matchField = "ttr";
    }

    // Reverse stock deduction (add stock back)
    if (location && tape && qty > 0) {
      const bal = await StockModel.aggregate([
        { $match: { [matchField]: tapeObjectId, location } },
        { $group: { _id: null, qty: { $sum: "$quantity" } } },
      ]);
      const currentStock = bal[0]?.qty || 0;

      const stockData = {
        [matchField]: tapeObjectId,
        location,
        quantity: qty,
        remarks: `Log Deleted (reversed): ${log.orderId}`,
      };
      if (order.onModel === "Tape") stockData.tapeFinish = tape.tapeFinish;
      if (order.onModel === "Tafeta") stockData.tafetaType = tape.tafetaType;

      await StockModel.create(stockData);

      const logData = {
        [matchField]: tapeObjectId,
        location,
        openingStock: currentStock,
        quantity: qty,
        closingStock: currentStock + qty,
        type: "INWARD",
        source: "SYSTEM",
        remarks: `Log Deleted (reversed): ${log.orderId}`,
        createdBy: req.user?.username || "SYSTEM",
      };
      await StockLogModel.create(logData);
    }

    // Update dispatched quantity on the order
    const newDispatched = Math.max(0, (order.dispatchedQuantity || 0) - qty);
    const newStatus = newDispatched >= order.quantity ? "CONFIRMED" : "PENDING";

    await TapeSalesOrder.findByIdAndUpdate(order._id, {
      dispatchedQuantity: newDispatched,
      status: newStatus,
    });

    // Delete the log entry
    await SalesOrderLog.findByIdAndDelete(logId);

    return res.json({ success: true });
  } catch (err) {
    console.error("DELETE LOG ERROR:", err);
    return res.json({ success: false, message: "Server error" });
  }
});

// Legacy route redirect
router.get("/form/salesorder", (req, res) => {
  res.redirect("/fairdesk/sales/order");
});

// ----------------------------------Sales Calculator---------------------------------->
// route for salescalc form.
router.get("/form/salescalc", async (req, res) => {
  let clients = await Client.distinct("clientName");
  res.render("utilities/salesCalc.ejs", {
    clients,
    title: "Sales Calculator",
    JS: "salesCalc.js",
    CSS: false,
    notification: req.flash("notification"),
  });
});

// Route to handle salescalc form submission.
router.post("/form/salescalc", requireAuth, createLimiter, async (req, res) => {
  let formData = req.body;

  await Calculator.create(formData);
  res.send("Sales Calculation created successfully!");
});

// ----------------------------------Production Calculator---------------------------------->
// route for prodcalc form.
router.get("/form/prodcalc", async (req, res) => {
  let clients = await Client.distinct("clientName");
  res.render("utilities/prodCalc.ejs", {
    title: "Production Calculator",
    CSS: false,
    JS: "prodCalc.js",
    clients,
    notification: req.flash("notification"),
  });
});

// Route to handle prodcalc form submission.
router.get("/form/prodcalc/data", async (req, res) => {
  let { w, h, client } = req.query;
  console.log(w, h, client);
  let clients = await Calculator.findOne({ companyName: client, labelWidth: w, labelHeight: h });
  console.log(clients);
  res.status(200).json(clients);
});

// Route to handle systemid form submission.
router.post("/form/prodcalc", requireAuth, createLimiter, async (req, res) => {
  let formData = req.body;

  await Calculator.create(formData);
  res.send("Production Calculation created successfully!");
});

// ----------------------------------Block Master---------------------------------->
// route for systemid form.
router.get("/form/block", async (req, res) => {
  let clients = await Client.distinct("clientName");
  console.log(clients);
  res.render("utilities/blockMaster.ejs", {
    CSS: false,
    title: "Block",
    JS: false,
    clients,
    notification: req.flash("notification"),
  });
});

// Route to handle systemid form submission.
router.post("/form/block", requireAuth, createLimiter, async (req, res) => {
  try {
    let formData = req.body;
    await Block.create(formData);
    req.flash("notification", "Block created successfully!");
    res.json({ success: true, redirect: "/fairdesk/form/block" });
  } catch (err) {
    console.error(err);
    res.status(400).json({ success: false, message: err.message });
  }
});

// ----------------------------------Die Master---------------------------------->
// route for systemid form.
router.get("/form/die", async (req, res) => {
  let clients = await Client.distinct("clientName");
  console.log(clients);
  res.render("utilities/dieMaster.ejs", {
    CSS: "tabOpt.css",
    title: "Die",
    JS: "clientForm.js",
    clients,
    notification: req.flash("notification"),
  });
});

// Route to handle systemid form submission.
router.post("/form/die", requireAuth, createLimiter, async (req, res) => {
  try {
    await Die.create(req.body);
    req.flash("notification", "Die created successfully!");
    res.json({ success: true, redirect: "/fairdesk/form/die" });
  } catch (err) {
    console.error(err);
    res.status(400).json({ success: false, message: err.message });
  }
});

// ---------------------------------------------------------------------------------------------------->>>>>

// ----------------------------------client display---------------------------------->
// route for client display page.
router.get("/edit/client", async (req, res) => {
  let clients = await Client.find();
  res.render("edit/clientDisp.ejs", {
    CSS: false,
    title: "Client Display",
    JS: false,
    clients,
    notification: req.flash("notification"),
  });
});

// ----------------------------------user display---------------------------------->
// route for user display page.
router.get("/edit/user/:id", async (req, res) => {
  let { id } = req.params;
  let clientData = await Client.findOne({ _id: id }).populate("users");
  let users = clientData.users;
  console.log(users);
  // res.send(users);
  res.render("edit/userDisp.ejs", {
    CSS: false,
    title: "Username Display",
    JS: false,
    users,
    notification: req.flash("notification"),
  });
});


// ----------------------------------Master display---------------------------------->
// route for details page.
router.get("/master/view", async (req, res) => {
  let jsonData = await Username.find()
    .select("clientName clientType accountHead userName userLocation label ttr tape posRoll tafeta")
    .sort({ clientName: 1, userName: 1 });

  // console.log(jsonData);
  res.render("users/masterDisp.ejs", {
    jsonData,
    CSS: "tableDisp.css",
    JS: false,
    title: "Client Details",
    notification: req.flash("notification"),
  });
});

// ----------------------------------Vendor display----------------------------------
router.get("/vendor/view", async (req, res) => {
  try {
    const [jsonData, userCounts] = await Promise.all([
      Vendor.find()
        .select("vendorId vendorName vendorStatus hoLocation warehouseLocation commodities vendorGst vendorMsme vendorGumasta vendorPan users")
        .populate({ path: "users", select: "_id" })
        .sort({ vendorName: 1 })
        .lean(),
      VendorUser.aggregate([{ $group: { _id: "$vendorId", count: { $sum: 1 } } }]),
    ]);

    const userCountByVendorId = new Map(
      userCounts.map((entry) => [String(entry._id || ""), Number(entry.count || 0)]),
    );

    jsonData.forEach((vendor) => {
      vendor.userCount = userCountByVendorId.get(String(vendor.vendorId || "")) || 0;
    });

    res.render("users/vendorsView.ejs", {
      jsonData,
      CSS: "tableDisp.css",
      JS: false,
      title: "Vendor Details",
      notification: req.flash("notification"),
    });
  } catch (err) {
    console.error("VENDOR VIEW ERROR:", err);
    req.flash("notification", "Failed to load vendor details");
    res.redirect("/fairdesk/form/vendor");
  }
});

router.get("/vendor/profile/:id", async (req, res) => {
  try {
    const vendor = await Vendor.findById(req.params.id).populate({
      path: "users",
      populate: [
        { path: "label" },
        { path: "ttr", populate: { path: "ttrId" } },
        { path: "tape", populate: { path: "tapeId" } },
        { path: "posRoll", populate: { path: "posRollId" } },
        { path: "tafeta", populate: { path: "tafetaId" } },
      ],
    });

    if (!vendor) {
      req.flash("notification", "Vendor not found");
      return res.redirect("/fairdesk/vendor/view");
    }

    res.render("users/vendorProfile.ejs", {
      title: "Vendor Profile",
      vendor,
      CSS: false,
      JS: false,
      notification: req.flash("notification"),
    });
  } catch (err) {
    console.error("VENDOR PROFILE ERROR:", err);
    req.flash("notification", "Invalid vendor link");
    res.redirect("/fairdesk/vendor/view");
  }
});

// Backward-compatible redirect for the old vendor coordinator URL.
router.get("/vendor/user/view", async (req, res) => {
  return res.redirect("/fairdesk/vendor/coordinator/view");
});

// ----------------------------------Vendor coordinator display----------------------------------
router.get("/vendor/coordinator/view", async (req, res) => {
  try {
    const jsonData = await VendorUser.aggregate([
      {
        $lookup: {
          from: "vendors",
          localField: "vendorId",
          foreignField: "vendorId",
          as: "vendorInfo",
        },
      },
      {
        $addFields: {
          commodities: { $ifNull: [{ $arrayElemAt: ["$vendorInfo.commodities", 0] }, []] },
        },
      },
      {
        $project: {
          vendorInfo: 0, // Remove the lookup array
        },
      },
      { $sort: { vendorName: 1, userName: 1 } },
    ]);

    jsonData.forEach((row) => {
      row.dispatchType = row.SelfDispatch ? "Self Dispatch" : "Transport";
      row.ttrCount = row.ttr?.length || 0;
      row.tapeCount = row.tape?.length || 0;
      row.posRollCount = row.posRoll?.length || 0;
      row.tafetaCount = row.tafeta?.length || 0;
    });

    res.render("users/vendorUserView.ejs", {
      jsonData,
      CSS: "tableDisp.css",
      JS: false,
      title: "Vendor Coordinator View",
      notification: req.flash("notification"),
    });
  } catch (err) {
    console.error("VENDOR COORDINATOR VIEW ERROR:", err);
    req.flash("notification", "Failed to load vendor coordinator view");
    res.redirect("/fairdesk/form/vendor");
  }
});

// ----------------------------------Vendor coordinator details----------------------------------
router.get("/vendor/coordinator/details/:userId", async (req, res) => {
  try {
    const vendorUser = await VendorUser.findById(req.params.userId)
      .populate("label")
      .populate({
        path: "ttr",
        populate: { path: "ttrId" },
      })
      .populate({
        path: "tape",
        populate: { path: "tapeId" },
      })
      .populate({
        path: "posRoll",
        populate: { path: "posRollId" },
      })
      .populate({
        path: "tafeta",
        populate: { path: "tafetaId" },
      })
      .lean();

    if (!vendorUser) {
      req.flash("notification", "Vendor coordinator not found");
      return res.redirect("/fairdesk/vendor/coordinator/view");
    }

    const vendor = await Vendor.findOne({ vendorId: vendorUser.vendorId }).lean();

    const stats = {
      labels: (vendorUser.label || []).length,
      ttrs: (vendorUser.ttr || []).length,
      tapes: (vendorUser.tape || []).length,
      posRolls: (vendorUser.posRoll || []).length,
      tafetas: (vendorUser.tafeta || []).length,
    };

    res.render("users/vendorUserDetails.ejs", {
      title: "Vendor Coordinator Details",
      CSS: false,
      JS: false,
      vendorUser,
      vendor,
      labels: vendorUser.label || [],
      ttrs: vendorUser.ttr || [],
      tapes: vendorUser.tape || [],
      posRolls: vendorUser.posRoll || [],
      tafetas: vendorUser.tafeta || [],
      stats,
      notification: req.flash("notification"),
    });
  } catch (err) {
    console.error("VENDOR COORDINATOR DETAILS ERROR:", err);
    req.flash("notification", "Failed to load vendor coordinator details");
    res.redirect("/fairdesk/vendor/coordinator/view");
  }
});

router.post("/vendor/coordinator/details/:userId/delete", requireAuth, deleteLimiter, async (req, res) => {
  try {
    const { userId } = req.params;
    const vendorUser = await VendorUser.findById(userId).lean();

    if (!vendorUser) {
      req.flash("notification", "Vendor coordinator not found");
      return res.redirect("/fairdesk/vendor/coordinator/view");
    }

    await Vendor.updateOne(
      { vendorId: vendorUser.vendorId },
      { $pull: { users: vendorUser._id } },
    );

    await VendorUser.deleteOne({ _id: vendorUser._id });

    req.flash("notification", `Coordinator ${vendorUser.userName} removed successfully`);
    return res.redirect("/fairdesk/vendor/coordinator/view");
  } catch (err) {
    console.error("VENDOR COORDINATOR DELETE ERROR:", err);
    req.flash("notification", "Failed to remove coordinator");
    return res.redirect("/fairdesk/vendor/coordinator/details/" + req.params.userId);
  }
});

// ----------------------------------Vendor coordinator edit----------------------------------
router.get("/form/edit/vendor-user/:userId", async (req, res) => {
  try {
    const user = await VendorUser.findById(req.params.userId).lean();
    if (!user) {
      req.flash("notification", "Vendor coordinator not found");
      return res.redirect("/fairdesk/vendor/coordinator/view");
    }

    const vendor = await Vendor.findOne({ vendorId: user.vendorId }).lean();

    res.render("users/editVendorUser.ejs", {
      title: "Edit Vendor Coordinator",
      CSS: "tabOpt.css",
      JS: false,
      user,
      vendor,
      notification: req.flash("notification"),
    });
  } catch (err) {
    console.error("VENDOR COORDINATOR EDIT GET ERROR:", err);
    req.flash("notification", "Failed to load vendor coordinator edit page");
    res.redirect("/fairdesk/vendor/coordinator/view");
  }
});

router.post("/form/edit/vendor-user/:userId", requireAuth, updateLimiter, async (req, res) => {
  try {
    const userId = req.params.userId;
    const user = await VendorUser.findById(userId);
    if (!user) {
      return res.status(404).json({ success: false, message: "Vendor coordinator not found" });
    }

    const vendorId = String(user.vendorId || "").trim();
    const userName = String(req.body.userName || "").trim();
    const userContact = String(req.body.userContact || "").trim();
    const userEmail = String(req.body.userEmail || "")
      .trim()
      .toLowerCase();
    const locationDetails = normalizeLocationDetails(
      req.body.locationDetails,
      req.body.userLocation,
      req.body.dispatchAddress,
    ).map((entry) => ({
      userLocation: String(entry.userLocation || "").toUpperCase(),
      dispatchAddress: String(entry.dispatchAddress || "").toUpperCase(),
    }));
    if (!locationDetails.length) {
      return res.status(400).json({ success: false, message: "Please add at least one location and address" });
    }
    const primaryLocation = locationDetails[0];

    const vendor = await Vendor.findOne({ vendorId: user.vendorId }).lean();
    const vendorSnapshot = getVendorSnapshot(vendor, user);

    const updatedData = {
      ...vendorSnapshot,
      vendorId,
      vendorName: vendorSnapshot.vendorName,
      vendorStatus: vendorSnapshot.vendorStatus,
      hoLocation: vendorSnapshot.hoLocation,
      warehouseLocation: vendorSnapshot.warehouseLocation,
      userName,
      userDepartment: String(req.body.userDepartment || "").trim(),
      userContact,
      userEmail,
      locationsCount: locationDetails.length,
      locationDetails,
      userLocation: primaryLocation.userLocation,
      dispatchAddress: primaryLocation.dispatchAddress,
      transportName: String(req.body.transportName || "").trim(),
      transportContact: String(req.body.transportContact || "").trim(),
      dropLocation: String(req.body.dropLocation || "").trim(),
      dropLocation1: String(req.body.dropLocation1 || "").trim(),
      deliveryMode: String(req.body.deliveryMode || "").trim(),
      deliveryLocation: String(req.body.deliveryLocation || "").trim(),
      deliveryLocation1: String(req.body.deliveryLocation1 || "").trim(),
      vendorPayment: String(req.body.vendorPayment || "").trim(),
      SelfDispatch: String(req.body.SelfDispatch || "").trim(),
      vendorStatus: vendorSnapshot.vendorStatus,
      ownerName: String(req.body.ownerName || "").trim(),
      ownerMobNo: String(req.body.ownerMobNo || "").trim(),
      ownerEmail: String(req.body.ownerEmail || "").trim(),
      vendorGst: vendorSnapshot.vendorGst,
      vendorMsme: vendorSnapshot.vendorMsme,
    };

    updatedData.vendorUserSignature = hashSignature(buildVendorUserSignature(updatedData, vendorId));

    const duplicateVendorUser = await VendorUser.findOne({
      _id: { $ne: userId },
      $or: [
        { vendorUserSignature: updatedData.vendorUserSignature },
        {
          vendorId,
          userName: new RegExp(`^${escapeRegex(userName)}$`, "i"),
          userEmail: new RegExp(`^${escapeRegex(userEmail)}$`, "i"),
          userContact: new RegExp(`^${escapeRegex(userContact)}$`, "i"),
        },
      ],
    }).lean();

    if (duplicateVendorUser) {
      return res.status(400).json({
        success: false,
        message: "vendor user already exist (same vendor + name + email + contact)",
      });
    }

    await VendorUser.findByIdAndUpdate(userId, updatedData, { runValidators: true });
    req.flash("notification", "Vendor coordinator updated successfully!");
    return res.json({ success: true, redirect: `/fairdesk/vendor/coordinator/details/${userId}` });
  } catch (err) {
    console.error("VENDOR COORDINATOR EDIT POST ERROR:", err);
    if (err?.code === 11000) {
      return res.status(409).json({
        success: false,
        message: "vendor user already exist (same vendor + name + email + contact)",
      });
    }
    return res.status(400).json({ success: false, message: err.message });
  }
});

// ----------------------------------Labels display (individual)---------------------------------->
// route for details page.
router.get("/disp/labels", async (req, res) => {
  let jsonData = await Label.find();

  res.render("inventory/labelsDisp.ejs", {
    jsonData,
    CSS: "tableDisp.css",
    JS: false,
    title: "Labels Display",
    notification: req.flash("notification"),
  });
});

// route for details page.
router.get("/labels/view/:id", async (req, res) => {
  console.log(req.params.id);
  let userData = await Username.findById(req.params.id).populate("label");
  let jsonData = userData.label;

  console.log(jsonData);
  // res.send("hello");
  res.render("inventory/labelsDisp.ejs", {
    jsonData,
    CSS: "tableDisp.css",
    JS: false,
    title: "Labels Display",
    notification: req.flash("notification"),
  });
});

// ----------------------------------Welcome---------------------------------->
const MOTIVATIONAL_QUOTES = [
  { q: "The only way to do great work is to love what you do.", a: "Steve Jobs" },
  { q: "Success is not final; failure is not fatal: it is the courage to continue that counts.", a: "Winston Churchill" },
  { q: "Believe you can and you're halfway there.", a: "Theodore Roosevelt" },
  { q: "The best way to predict the future is to create it.", a: "Peter Drucker" },
  { q: "Everything you’ve ever wanted is on the other side of fear.", a: "George Addair" },
  { q: "The only limit to our realization of tomorrow will be our doubts of today.", a: "Franklin D. Roosevelt" },
  { q: "Hardships often prepare ordinary people for an extraordinary destiny.", a: "C.S. Lewis" },
  { q: "Your time is limited, so don't waste it living someone else's life.", a: "Steve Jobs" },
  { q: "Success is walking from failure to failure with no loss of enthusiasm.", a: "Winston Churchill" },
  { q: "Whether you think you can or you think you can't, you're right.", a: "Henry Ford" },
  { q: "The future belongs to those who believe in the beauty of their dreams.", a: "Eleanor Roosevelt" },
  { q: "Don't watch the clock; do what it does. Keep going.", a: "Sam Levenson" },
  { q: "The search for excellence is a journey, not a destination.", a: "Unknown" },
  { q: "What you get by achieving your goals is not as important as what you become by achieving your goals.", a: "Zig Ziglar" },
  { q: "It always seems impossible until it's done.", a: "Nelson Mandela" },
  { q: "Quality is not an act, it is a habit.", a: "Aristotle" },
  { q: "The only person you are destined to become is the person you decide to be.", a: "Ralph Waldo Emerson" },
  { q: "Be so good they can't ignore you.", a: "Steve Martin" },
  { q: "Integrity is doing the right thing, even when no one is watching.", a: "C.S. Lewis" },
  { q: "The secret of getting ahead is getting started.", a: "Mark Twain" }
];

router.get("/api/motivational", (req, res) => {
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, private");
  const quote = MOTIVATIONAL_QUOTES[Math.floor(Math.random() * MOTIVATIONAL_QUOTES.length)];
  res.json(quote);
});

router.get("/welcome", (req, res) => {
  res.render("miscellaneous/welcome.ejs", {
    title: "Welcome",
    CSS: false,
    JS: false,
    notification: req.flash("notification"),
  });
});

export default router;
