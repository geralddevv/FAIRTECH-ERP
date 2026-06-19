import express from "express";
import mongoose from "mongoose";
import Ttr from "../../models/inventory/ttr.js";
import TtrBinding from "../../models/inventory/ttrBinding.js";
import Vendor from "../../models/users/vendor.js";
import VendorUser from "../../models/users/vendorUser.js";
import VendorTtrBinding from "../../models/inventory/vendorTtrBinding.js";
import TtrStock from "../../models/inventory/TtrStock.js";
import Username from "../../models/users/username.js";
import Client from "../../models/users/client.js";
import { requireAuth } from "../../middleware/auth.js";
import { createLimiter, updateLimiter, deleteLimiter } from "../../utils/limiters.js";
import { escapeRegex } from "../../utils/security.js";

const router = express.Router();

const formatTtrProductId = (n) => `FS | TTR | ${String(n).padStart(6, "0")}`;

const parseTtrSeq = (productId) => {
  const match = String(productId || "").match(/(\d{6})$/);
  return match ? Number(match[1]) : 0;
};

async function getNextTtrProductIdPreview() {
  const latestTtr = await Ttr.findOne({ ttrProductId: /^FS \| TTR/ })
    .sort({ ttrProductId: -1 })
    .select("ttrProductId")
    .lean();
  let nextSeq = parseTtrSeq(latestTtr?.ttrProductId) + 1;

  while (await Ttr.exists({ ttrProductId: formatTtrProductId(nextSeq) })) {
    nextSeq += 1;
  }
  return formatTtrProductId(nextSeq);
}

const DEFAULT_VENDOR_TTR_OVERRIDES = {
  ttrMtrsDel: "0",
  ttrRatePerRoll: 0,
  ttrSaleCost: 0,
  ttrMinQty: 0,
  minimumOrderQty: 0,
  ttrOdrFreq: "N/A",
  ttrCreditTerm: "N/A",
};

const trimOr = (value, fallback = "") => {
  if (value === undefined || value === null) return fallback;
  const out = String(value).trim();
  return out === "" ? fallback : out;
};

const numOr = (value, fallback = 0) => {
  if (value === "" || value === null || value === undefined) return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};

const normalizeCode = (value) => trimOr(value).toUpperCase();

const TTR_SMART_FILTER_KEYS = [
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

const normalizeSmartFilterValue = (value) => trimOr(value);

async function loadFsTtrRows() {
  const masters = await Ttr.find({})
    .select("ttrProductId ttrType ttrColor ttrMaterialCode ttrWidth ttrMtrs ttrInkFace ttrCoreId ttrCoreLength ttrNotch ttrWinding ttrMinQty")
    .lean();

  return masters
    .map((master) => ({
      ttrId: master._id?.toString() || "",
      ttrType: trimOr(master.ttrType),
      ttrColor: trimOr(master.ttrColor),
      ttrMaterialCode: trimOr(master.ttrMaterialCode),
      ttrWidth: trimOr(master.ttrWidth),
      ttrMtrs: trimOr(master.ttrMtrs),
      ttrInkFace: trimOr(master.ttrInkFace),
      ttrCoreId: trimOr(master.ttrCoreId),
      ttrCoreLength: trimOr(master.ttrCoreLength),
      ttrNotch: trimOr(master.ttrNotch),
      ttrWinding: trimOr(master.ttrWinding),
      ttrMinQty: trimOr(master.ttrMinQty),
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

function rowMatchesSmartFilters(row, selected, excludeKey = "") {
  for (const key of TTR_SMART_FILTER_KEYS) {
    if (key === excludeKey) continue;
    const selectedValue = normalizeSmartFilterValue(selected[key]);
    if (!selectedValue) continue;
    if (normalizeSmartFilterValue(row[key]) !== selectedValue) return false;
  }
  return true;
}

function distinctValues(rows, key) {
  const values = new Set();
  rows.forEach((row) => {
    const value = normalizeSmartFilterValue(row[key]);
    if (value) values.add(value);
  });
  return Array.from(values);
}

/* GET : Load TTR Binding Form */
router.get("/form/ttr-binding", async (req, res) => {
  try {
    const [clients, fsRows] = await Promise.all([
      Client.distinct("clientName"),
      loadFsTtrRows(),
    ]);
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

    res.render("inventory/ttrBinding.ejs", {
      title: "Client TTR",
      clients,
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
    });
  } catch (err) {
    console.error(err);
    req.flash("notification", "Failed to load TTR Binding");
    res.redirect("back");
  }
});

/* GET : Load Vendor TTR Binding Form */
router.get("/form/ttr-vendor-binding", async (req, res) => {
  try {
    const { itemId } = req.query;
    let prefillData = null;
    if (itemId && /^[a-f\d]{24}$/i.test(itemId)) {
      prefillData = await Ttr.findById(itemId).lean();
    }
    const [vendors, fsRows] = await Promise.all([Vendor.distinct("vendorName"), loadFsTtrRows()]);
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

    res.render("inventory/ttrVendorBinding.ejs", {
      title: "Vendor TTR",
      vendors,
      prefillData,
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
      CSS: false,
      JS: false,
      notification: req.flash("notification"),
    });
  } catch (err) {
    console.error("VENDOR TTR BINDING GET ERROR:", err);
    req.flash("notification", "Failed to load Vendor TTR Binding");
    res.redirect("back");
  }
});

/* POST : Save Vendor TTR Binding */
router.post("/form/ttr-vendor-binding", requireAuth, createLimiter, async (req, res) => {
  try {
    const vendorUserId = trimOr(req.body.vendorUserId);
    const ttrId = trimOr(req.body.ttrId);
    const ttrType = trimOr(req.body.ttrType);
    const ttrColor = trimOr(req.body.ttrColor, "BLACK");
    const ttrMaterialCode = trimOr(req.body.ttrMaterialCode);
    const ttrWidth = trimOr(req.body.ttrWidth);
    const ttrMtrs = trimOr(req.body.ttrMtrs);
    const ttrInkFace = trimOr(req.body.ttrInkFace);
    const ttrCoreId = trimOr(req.body.ttrCoreId);
    const ttrCoreLength = trimOr(req.body.ttrCoreLength);
    const ttrNotch = trimOr(req.body.ttrNotch);
    const ttrWinding = trimOr(req.body.ttrWinding);
    const ttrMinQty = numOr(req.body.ttrMinQty, DEFAULT_VENDOR_TTR_OVERRIDES.ttrMinQty);

    if (!vendorUserId) {
      return res.status(400).json({ success: false, message: "Vendor user is required" });
    }
    if (!ttrId) {
      return res.status(400).json({ success: false, message: "TTR master could not be resolved" });
    }

    const vendorUser = await VendorUser.findById(vendorUserId);
    if (!vendorUser) {
      return res.status(400).json({ success: false, message: "Invalid vendor user selected" });
    }

    const ttr = await Ttr.findById(ttrId).select("ttrMaterialCode ttrType ttrColor ttrMinQty").lean();
    if (!ttr) {
      return res.status(400).json({ success: false, message: "Invalid TTR master selected" });
    }

    const vendorMaterialCode = trimOr(req.body.vendorTtrMaterialCode || ttrMaterialCode || ttr.ttrMaterialCode);
    const incomingVendorCode = normalizeCode(vendorMaterialCode);
    const incomingFsCode = normalizeCode(ttr.ttrMaterialCode);
    const incomingFsId = String(ttr._id);

    // Global rule: one vendor code can map to only one FS TTR across the system.
    const existingMappings = await VendorTtrBinding.find({
      vendorTtrMaterialCode: new RegExp(`^${escapeRegex(incomingVendorCode)}$`, "i"),
    })
      .select("vendorTtrMaterialCode ttrId vendorUserId")
      .populate({ path: "ttrId", select: "ttrMaterialCode" })
      .lean();

    const mappingConflict = existingMappings.find((row) => {
      const existingFsCode = normalizeCode(row.ttrId?.ttrMaterialCode);
      const existingFsId = String(row.ttrId?._id || "");
      return existingFsId && existingFsId !== incomingFsId && existingFsCode !== incomingFsCode;
    });
    if (mappingConflict) {
      return res.status(400).json({
        success: false,
        message: `Vendor code ${ttrMaterialCode} is already mapped to FS code ${mappingConflict.ttrId?.ttrMaterialCode || "N/A"}.`,
      });
    }

    const duplicateMappingForUser = existingMappings.find(
      (row) => String(row.ttrId?._id || "") === incomingFsId && String(row.vendorUserId || "") === String(vendorUserId),
    );
    if (duplicateMappingForUser) {
      return res.status(400).json({
        success: false,
        message: `Vendor code ${ttrMaterialCode} is already mapped to FS code ${ttr.ttrMaterialCode} for this user.`,
      });
    }

    if (
      !ttrId ||
      !ttrType ||
      !ttrColor ||
      !ttrMaterialCode ||
      !ttrWidth ||
      !ttrMtrs ||
      !ttrInkFace ||
      !ttrCoreId ||
      !ttrCoreLength ||
      !ttrNotch ||
      !ttrWinding
    ) {
      return res.status(400).json({ success: false, message: "Please complete all required TTR fields" });
    }

    const vendorType = trimOr(req.body.vendorTtrType || ttrType || ttr.ttrType);
    const vendorColor = trimOr(req.body.vendorTtrColor || ttrColor || ttr.ttrColor || "BLACK");
    const ttrMtrsDel = trimOr(req.body.ttrMtrsDel ?? req.body.tapeMtrsDel, DEFAULT_VENDOR_TTR_OVERRIDES.ttrMtrsDel);
    const ttrRatePerRoll = numOr(req.body.ttrRatePerRoll ?? req.body.tapeRatePerRoll, DEFAULT_VENDOR_TTR_OVERRIDES.ttrRatePerRoll);
    const ttrSaleCost = numOr(req.body.ttrSaleCost ?? req.body.tapeSaleCost, DEFAULT_VENDOR_TTR_OVERRIDES.ttrSaleCost);
    const minimumOrderQty = numOr(
      req.body.ttrOdrQty ?? req.body.minimumOrderQty ?? req.body.tapeOdrQty,
      DEFAULT_VENDOR_TTR_OVERRIDES.minimumOrderQty,
    );
    const ttrOdrFreq = trimOr(req.body.ttrOdrFreq ?? req.body.tapeOdrFreq, DEFAULT_VENDOR_TTR_OVERRIDES.ttrOdrFreq);
    const ttrCreditTerm = trimOr(req.body.ttrCreditTerm ?? req.body.tapeCreditTerm, DEFAULT_VENDOR_TTR_OVERRIDES.ttrCreditTerm);
    const vendorBindingData = {
      vendorUserId,
      ttrId: ttr._id,
      vendorTtrMaterialCode: incomingVendorCode,
      vendorTtrType: vendorType,
      vendorTtrColor: vendorColor,
      ttrMtrsDel,
      ttrRatePerRoll,
      ttrSaleCost,
      ttrMinQty: ttrMinQty,
      ttrOdrQty: minimumOrderQty,
      ttrOdrFreq,
      ttrCreditTerm,
    };

    const vendorTtrBinding = await VendorTtrBinding.create(vendorBindingData);

    // Update master with latest MSQ if requested
    await Ttr.updateOne({ _id: ttrId }, { $set: { ttrMinQty: ttrMinQty } });

    vendorUser.ttr.push(vendorTtrBinding._id);
    await vendorUser.save();

    req.flash("notification", "Vendor TTR created successfully!");
    res.json({ success: true, redirect: "/fairdesk/vendor/coordinator/view" });
  } catch (err) {
    console.error("VENDOR TTR BINDING ERROR:", err);
    res.status(400).json({ success: false, message: err.message });
  }
});

/* GET : Fetch Vendor Users by Vendor */
router.get("/form/ttr-vendor-binding/vendor/:name", async (req, res) => {
  try {
    const vendorData = await Vendor.findOne({ vendorName: req.params.name }).populate("users");
    res.status(200).json(vendorData);
  } catch (err) {
    console.error(err);
    res.status(500).json(null);
  }
});

/* GET : Filter Vendor TTR Specs */
router.get("/form/ttr-vendor-binding/filter-specs", async (req, res) => {
  try {
    const {
      ttrType,
      ttrColor,
      ttrMaterialCode,
      ttrWidth,
      ttrMtrs,
      ttrInkFace,
      ttrCoreId,
      ttrCoreLength,
      ttrNotch,
      ttrWinding,
    } = req.query;

    const flex = (val) => {
      if (!val && val !== 0) return val;
      const arr = [val];
      if (typeof val === "string") {
        const t = val.trim();
        if (t !== val) arr.push(t);
        const n = Number(t);
        if (t !== "" && !isNaN(n)) arr.push(n);
      } else {
        arr.push(String(val));
      }
      return { $in: arr };
    };

    const buildFilter = (excludeKey) => {
      const f = {};
      if (ttrType && excludeKey !== "ttrType") f.ttrType = flex(ttrType);
      if (ttrColor && excludeKey !== "ttrColor") f.ttrColor = flex(ttrColor);
      if (ttrMaterialCode && excludeKey !== "ttrMaterialCode") f.ttrMaterialCode = flex(ttrMaterialCode);
      if (ttrWidth && excludeKey !== "ttrWidth") f.ttrWidth = flex(ttrWidth);
      if (ttrMtrs && excludeKey !== "ttrMtrs") f.ttrMtrs = flex(ttrMtrs);
      if (ttrInkFace && excludeKey !== "ttrInkFace") f.ttrInkFace = flex(ttrInkFace);
      if (ttrCoreId && excludeKey !== "ttrCoreId") f.ttrCoreId = flex(ttrCoreId);
      if (ttrCoreLength && excludeKey !== "ttrCoreLength") f.ttrCoreLength = flex(ttrCoreLength);
      if (ttrNotch && excludeKey !== "ttrNotch") f.ttrNotch = flex(ttrNotch);
      if (ttrWinding && excludeKey !== "ttrWinding") f.ttrWinding = flex(ttrWinding);
      return f;
    };

    const [types, colors, materialCodes, widths, mtrsList, inkFaces, coreIds, coreLengths, notches, windings] =
      await Promise.all([
        Ttr.distinct("ttrType", buildFilter("ttrType")),
        Ttr.distinct("ttrColor", buildFilter("ttrColor")),
        Ttr.distinct("ttrMaterialCode", buildFilter("ttrMaterialCode")),
        Ttr.distinct("ttrWidth", buildFilter("ttrWidth")),
        Ttr.distinct("ttrMtrs", buildFilter("ttrMtrs")),
        Ttr.distinct("ttrInkFace", buildFilter("ttrInkFace")),
        Ttr.distinct("ttrCoreId", buildFilter("ttrCoreId")),
        Ttr.distinct("ttrCoreLength", buildFilter("ttrCoreLength")),
        Ttr.distinct("ttrNotch", buildFilter("ttrNotch")),
        Ttr.distinct("ttrWinding", buildFilter("ttrWinding")),
      ]);

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
    console.error("VENDOR TTR FILTER SPECS ERROR:", err);
    res.status(500).json(null);
  }
});

/* GET : Resolve Vendor TTR */
router.get("/form/ttr-vendor-binding/resolve-ttr", async (req, res) => {
  try {
    const {
      ttrType,
      ttrColor,
      ttrMaterialCode,
      ttrWidth,
      ttrMtrs,
      ttrInkFace,
      ttrCoreId,
      ttrCoreLength,
      ttrNotch,
      ttrWinding,
    } = req.query;

    if (
      !ttrType ||
      !ttrColor ||
      !ttrMaterialCode ||
      !ttrWidth ||
      !ttrMtrs ||
      !ttrInkFace ||
      !ttrCoreId ||
      !ttrCoreLength ||
      !ttrNotch ||
      !ttrWinding
    ) {
      return res.status(400).json(null);
    }

    const flex = (val) => {
      if (!val && val !== 0) return val;
      const arr = [val];
      if (typeof val === "string") {
        const t = val.trim();
        if (t !== val) arr.push(t);
        const n = Number(t);
        if (t !== "" && !isNaN(n)) arr.push(n);
      } else {
        arr.push(String(val));
      }
      return { $in: arr };
    };

    const ttr = await Ttr.findOne({
      ttrType: flex(ttrType),
      ttrColor: flex(ttrColor),
      ttrMaterialCode: flex(ttrMaterialCode),
      ttrWidth: flex(ttrWidth),
      ttrMtrs: flex(ttrMtrs),
      ttrInkFace: flex(ttrInkFace),
      ttrCoreId: flex(ttrCoreId),
      ttrCoreLength: flex(ttrCoreLength),
      ttrNotch: flex(ttrNotch),
      ttrWinding: flex(ttrWinding),
    }).lean();

    if (!ttr) {
      return res.status(404).json(null);
    }

    res.status(200).json({
      ttrId: ttr._id,
      ttrProductId: ttr.ttrProductId || "",
      ttrMaterialCode: ttr.ttrMaterialCode,
      ttrType: ttr.ttrType || "",
      ttrColor: ttr.ttrColor || "",
      ttrWidth: ttr.ttrWidth ?? "",
      ttrMtrs: ttr.ttrMtrs ?? "",
      ttrMinQty: ttr.ttrMinQty ?? "",
    });
  } catch (err) {
    console.error("VENDOR TTR RESOLVE ERROR:", err);
    res.status(500).json(null);
  }
});

/* POST : Save TTR Binding */
router.post("/form/ttr-binding", requireAuth, createLimiter, async (req, res) => {
  try {
    const { userId, ttrId } = req.body;

    // Validate user exists
    const user = await Username.findById(userId);
    if (!user) {
      return res.status(400).json({ success: false, message: "Invalid user selected" });
    }

    // Check for duplicate binding
    const existingBinding = await TtrBinding.exists({
      userId,
      ttrId,
    });
    if (existingBinding) {
      return res.status(400).json({ success: false, message: "This TTR binding already exists for this user." });
    }

    // Create TTR binding
    const ttrBinding = await TtrBinding.create({
      ...req.body,
      ttrRatePerRoll: Number(req.body.ttrRatePerRoll),
      ttrSaleCost: Number(req.body.ttrSaleCost),
      ttrMinQty: Number(req.body.ttrMinQty),
      ttrOdrQty: Number(req.body.ttrOdrQty),
      userId,
      ttrId,
    });

    // Attach to user
    user.ttr.push(ttrBinding._id);
    await user.save();

    req.flash("notification", "TTR binding created successfully!");
    res.json({ success: true, redirect: "/fairdesk/client/details/" + userId });
  } catch (err) {
    console.error("TTR BINDING ERROR:", err);
    res.status(400).json({ success: false, message: err.message });
  }
});

/* GET : Fetch Users by Client (AJAX) */
router.get("/form/ttr-binding/client/:name", async (req, res) => {
  try {
    const clientData = await Client.findOne({ clientName: req.params.name }).populate("users");
    res.status(200).json(clientData);
  } catch (err) {
    console.error(err);
    res.status(500).json(null);
  }
});

/* GET : Filter TTR Specs (cascading smart form) */
router.get("/form/ttr-binding/filter-specs", async (req, res) => {
  try {
    const selected = {
      ttrType: normalizeSmartFilterValue(req.query.ttrType),
      ttrColor: normalizeSmartFilterValue(req.query.ttrColor),
      ttrMaterialCode: normalizeSmartFilterValue(req.query.ttrMaterialCode),
      ttrWidth: normalizeSmartFilterValue(req.query.ttrWidth),
      ttrMtrs: normalizeSmartFilterValue(req.query.ttrMtrs),
      ttrInkFace: normalizeSmartFilterValue(req.query.ttrInkFace),
      ttrCoreId: normalizeSmartFilterValue(req.query.ttrCoreId),
      ttrCoreLength: normalizeSmartFilterValue(req.query.ttrCoreLength),
      ttrNotch: normalizeSmartFilterValue(req.query.ttrNotch),
      ttrWinding: normalizeSmartFilterValue(req.query.ttrWinding),
    };

    const fsRows = await loadFsTtrRows();
    const types = distinctValues(
      fsRows.filter((row) => rowMatchesSmartFilters(row, selected, "ttrType")),
      "ttrType",
    );
    const colors = distinctValues(
      fsRows.filter((row) => rowMatchesSmartFilters(row, selected, "ttrColor")),
      "ttrColor",
    );
    const materialCodes = distinctValues(
      fsRows.filter((row) => rowMatchesSmartFilters(row, selected, "ttrMaterialCode")),
      "ttrMaterialCode",
    );
    const widths = distinctValues(
      fsRows.filter((row) => rowMatchesSmartFilters(row, selected, "ttrWidth")),
      "ttrWidth",
    );
    const mtrsList = distinctValues(
      fsRows.filter((row) => rowMatchesSmartFilters(row, selected, "ttrMtrs")),
      "ttrMtrs",
    );
    const inkFaces = distinctValues(
      fsRows.filter((row) => rowMatchesSmartFilters(row, selected, "ttrInkFace")),
      "ttrInkFace",
    );
    const coreIds = distinctValues(
      fsRows.filter((row) => rowMatchesSmartFilters(row, selected, "ttrCoreId")),
      "ttrCoreId",
    );
    const coreLengths = distinctValues(
      fsRows.filter((row) => rowMatchesSmartFilters(row, selected, "ttrCoreLength")),
      "ttrCoreLength",
    );
    const notches = distinctValues(
      fsRows.filter((row) => rowMatchesSmartFilters(row, selected, "ttrNotch")),
      "ttrNotch",
    );
    const windings = distinctValues(
      fsRows.filter((row) => rowMatchesSmartFilters(row, selected, "ttrWinding")),
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
    console.error("FILTER SPECS ERROR:", err);
    res.status(500).json(null);
  }
});

/* GET : Resolve TTR from Specifications */
router.get("/form/ttr-binding/resolve-ttr", async (req, res) => {
  console.log("Resolve TTR query:", req.query);
  try {
    const ttrType = normalizeSmartFilterValue(req.query.ttrType);
    const ttrColor = normalizeSmartFilterValue(req.query.ttrColor);
    const ttrMaterialCode = normalizeSmartFilterValue(req.query.ttrMaterialCode);
    const ttrWidth = normalizeSmartFilterValue(req.query.ttrWidth);
    const ttrMtrs = normalizeSmartFilterValue(req.query.ttrMtrs);
    const ttrInkFace = normalizeSmartFilterValue(req.query.ttrInkFace);
    const ttrCoreId = normalizeSmartFilterValue(req.query.ttrCoreId);
    const ttrCoreLength = normalizeSmartFilterValue(req.query.ttrCoreLength);
    const ttrNotch = normalizeSmartFilterValue(req.query.ttrNotch);
    const ttrWinding = normalizeSmartFilterValue(req.query.ttrWinding);

    if (
      !ttrType ||
      !ttrColor ||
      !ttrMaterialCode ||
      !ttrWidth ||
      !ttrMtrs ||
      !ttrInkFace ||
      !ttrCoreId ||
      !ttrCoreLength ||
      !ttrNotch ||
      !ttrWinding
    ) {
      return res.status(400).json(null);
    }

    const fsRows = await loadFsTtrRows();
    const resolved = fsRows.find(
      (row) =>
        row.ttrType === ttrType &&
        row.ttrColor === ttrColor &&
        row.ttrMaterialCode === ttrMaterialCode &&
        row.ttrWidth === ttrWidth &&
        row.ttrMtrs === ttrMtrs &&
        row.ttrInkFace === ttrInkFace &&
        row.ttrCoreId === ttrCoreId &&
        row.ttrCoreLength === ttrCoreLength &&
        row.ttrNotch === ttrNotch &&
        row.ttrWinding === ttrWinding,
    );

    if (!resolved) {
      return res.status(404).json(null);
    }

    res.status(200).json({
      ttrId: resolved.ttrId,
      ttrMaterialCode: resolved.ttrMaterialCode,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json(null);
  }
});

/* GET : Display bound TTRs */
router.get("/ttr/view/:id", async (req, res) => {
  try {
    const user = await Username.findById(req.params.id)
      .populate({
        path: "ttr",
        populate: [
          { path: "ttrId", model: "Ttr" },
          { path: "userId", model: "Username" },
        ],
      })
      .lean();

    if (!user) {
      req.flash("notification", "User not found");
      return res.redirect("back");
    }

    const ttrDataRaw = user.ttr || [];
    const ttrIds = ttrDataRaw.map((binding) => binding.ttrId?._id).filter(Boolean);

    const stockMap = {};
    if (ttrIds.length) {
      const stockAgg = await TtrStock.aggregate([
        { $match: { ttr: { $in: ttrIds } } },
        { $group: { _id: "$ttr", total: { $sum: "$quantity" } } },
      ]);
      stockAgg.forEach((row) => {
        stockMap[row._id.toString()] = row.total;
      });
    }

    const ttrData = ttrDataRaw.map((binding) => {
      const tid = binding.ttrId?._id?.toString();
      return {
        ...binding,
        stock: stockMap[tid] || 0,
        // Flatten TTR master fields
        productId: binding.ttrId?.ttrProductId || "",
        ttrType: binding.clientTtrType || binding.vendorTtrType || "",
        ttrColor: binding.vendorTtrColor || binding.ttrId?.ttrColor || "",
        ttrMaterialCode: binding.ttrClientMaterialCode || binding.vendorTtrMaterialCode || "",
        ttrWidth: binding.ttrId?.ttrWidth || "",
        ttrMtrs: "", 
        ttrInkFace: binding.ttrId?.ttrInkFace || "",
        ttrCoreId: binding.ttrId?.ttrCoreId || "",
        ttrCoreLength: binding.ttrId?.ttrCoreLength || "",
        ttrNotch: binding.ttrId?.ttrNotch || "",
        ttrWinding: binding.ttrId?.ttrWinding || "",
        // Flatten user fields
        clientName: binding.userId?.clientName || "",
        userName: binding.userId?.userName || "",
        userContact: binding.userId?.userContact || "",
        location: binding.userId?.userLocation || "",
        // Explicit binding overrides
        ttrSinOdrQty: binding.ttrOdrQty ?? 0,
        ttrMinQty: binding.ttrMinQty ?? 0,
        ttrRatePerRoll: binding.ttrRatePerRoll ?? 0,
        ttrSaleCost: binding.ttrSaleCost ?? 0,
        ttrMtrsDel: binding.ttrMtrsDel || "",
        ttrOdrFreq: binding.ttrOdrFreq || "",
        ttrCreditTerm: binding.ttrCreditTerm || "",
        status: binding.status || "ACTIVE",
      };
    });

    res.render("inventory/ttrDisp.ejs", {
      jsonData: ttrData,
      CSS: "tableDisp.css",
      JS: false,
      title: "TTR Display",
      clientName: user.clientName || "",
      userName: user.userName || "",
      notification: req.flash("notification"),
    });
  } catch (err) {
    console.error("TTR VIEW ERROR:", err);
    res.redirect("back");
  }
});

/* GET : Display all Vendor bound TTRs */
router.get("/ttr-vendor/view", async (req, res) => {
  try {
    const userId =
      typeof req.query.userId === "string" && /^[a-f\d]{24}$/i.test(req.query.userId.trim())
        ? req.query.userId.trim()
        : "";
    const bindingFilter = userId ? { vendorUserId: userId } : {};
    const vendorUser = userId ? await VendorUser.findById(userId).select("vendorName userName").lean() : null;

    const vendorTtrBindings = await VendorTtrBinding.find(bindingFilter).populate("vendorUserId").populate("ttrId").lean();

    const ttrIds = vendorTtrBindings.map((b) => b.ttrId?._id).filter(Boolean);
    const stockMap = {};
    if (ttrIds.length) {
      const stockAgg = await TtrStock.aggregate([
        { $match: { ttr: { $in: ttrIds } } },
        { $group: { _id: "$ttr", total: { $sum: "$quantity" } } },
      ]);
      stockAgg.forEach((row) => {
        stockMap[row._id.toString()] = row.total;
      });
    }

    const ttrData = vendorTtrBindings.map((binding) => {
      const tid = binding.ttrId?._id?.toString();
      return {
        ...binding,
        stock: stockMap[tid] || 0,
        // Flatten TTR master fields
        sampleId: binding.ttrId?.ttrProductId || "",
        productId: binding.ttrId?.ttrProductId || "",
        ttrType: binding.ttrId?.ttrType || "",
        ttrColor: binding.ttrId?.ttrColor || "",
        ttrMaterialCode: binding.ttrId?.ttrMaterialCode || "",
        ttrWidth: binding.ttrId?.ttrWidth || "",
        ttrMtrs: binding.ttrId?.ttrMtrs || "",
        // Flatten vendor user fields
        vendorName: binding.vendorUserId?.vendorName || "",
        userName: binding.vendorUserId?.userName || "",
        userContact: binding.vendorUserId?.userContact || "",
        location: binding.vendorUserId?.userLocation || "",
        vendorTtrMaterialCode: binding.vendorTtrMaterialCode || "",
        vendorTtrType: binding.vendorTtrType || "",
        vendorTtrColor: binding.vendorTtrColor || "",
        ttrMinQty: binding.ttrMinQty ?? 0,
        status: binding.status || "N/A",
      };
    });

    res.render("inventory/ttrVendorDisp.ejs", {
      jsonData: ttrData,
      CSS: "tableDisp.css",
      JS: false,
      title: "Vendor TTR Display",
      vendorUser,
      notification: req.flash("notification"),
    });
  } catch (err) {
    console.error("VENDOR TTR VIEW ERROR:", err);
    req.flash("notification", "Failed to load Vendor TTR view");
    res.redirect("back");
  }
});

/* GET : Compare Vendor TTR vs Master */
router.get("/ttr-vendor/compare/:id", async (req, res) => {
  try {
    const binding = await VendorTtrBinding.findById(req.params.id)
      .populate({ path: "ttrId", model: "Ttr" })
      .populate({ path: "vendorUserId", model: "VendorUser" })
      .lean();

    if (!binding) {
      req.flash("notification", "Vendor TTR binding not found");
      return res.redirect("back");
    }

    const ttr = binding.ttrId || {};
    const user = binding.vendorUserId || {};

    const compareRows = [
      { field: "Material Code", orgValue: binding.vendorTtrMaterialCode || "N/A", clientValue: ttr.ttrMaterialCode || "N/A" },
      { field: "Type", orgValue: binding.vendorTtrType || "N/A", clientValue: ttr.ttrType || "N/A" },
      { field: "Color", orgValue: binding.vendorTtrColor || "N/A", clientValue: ttr.ttrColor || "N/A" },
      { field: "Sample ID", orgValue: "-", clientValue: ttr.ttrProductId || "N/A" },
      { field: "Width", orgValue: "-", clientValue: ttr.ttrWidth ?? "N/A" },
      { field: "Meters", orgValue: "-", clientValue: ttr.ttrMtrs ?? "N/A" },
      { field: "Ink Face", orgValue: "-", clientValue: ttr.ttrInkFace || "N/A" },
      { field: "Core ID", orgValue: "-", clientValue: ttr.ttrCoreId ?? "N/A" },
      { field: "Core Length", orgValue: "-", clientValue: ttr.ttrCoreLength ?? "N/A" },
      { field: "Notch", orgValue: "-", clientValue: ttr.ttrNotch || "N/A" },
      { field: "Winding", orgValue: "-", clientValue: ttr.ttrWinding || "N/A" },
      { field: "Minimum Qty", orgValue: "-", clientValue: ttr.ttrMinQty ?? binding.ttrMinQty ?? "N/A" },
      { field: "Status", orgValue: binding.status || "N/A", clientValue: "-" },
    ];

    res.render("inventory/ttrVendorCompare.ejs", {
      title: "Vendor TTR Compare",
      CSS: false,
      JS: false,
      itemTitle: "Fairtech TTR Details",
      sectionTitle: "TTR Details (Vendor - Fairtech)",
      orgLabel: "Vendor",
      clientLabel: "Fairtech",
      editBindingUrl: `/fairdesk/ttr-vendor-binding/edit/${binding._id}?returnTo=${encodeURIComponent(`/fairdesk/ttr-vendor/compare/${binding._id}`)}`,
      clientName: user?.vendorName || "",
      userName: user?.userName || "",
      compareRows,
      notification: req.flash("notification"),
    });
  } catch (err) {
    console.error("VENDOR TTR COMPARE ERROR:", err);
    req.flash("notification", "Failed to load Vendor TTR comparison");
    res.redirect("back");
  }
});

/* GET : Load Vendor TTR Binding Edit Form */
router.get("/ttr-vendor-binding/edit/:id", async (req, res) => {
  try {
    const binding = await VendorTtrBinding.findById(req.params.id).populate("vendorUserId").populate("ttrId");

    if (!binding) {
      req.flash("notification", "Vendor TTR binding not found");
      return res.redirect("back");
    }

    res.render("inventory/ttrVendorBindingEdit.ejs", {
      title: "Edit Vendor TTR Binding",
      binding,
      returnTo: typeof req.query.returnTo === "string" ? req.query.returnTo : "",
      CSS: false,
      JS: false,
      notification: req.flash("notification"),
    });
  } catch (err) {
    console.error("VENDOR TTR EDIT GET ERROR:", err);
    req.flash("notification", "Failed to load Vendor TTR Binding Edit");
    res.redirect("back");
  }
});

/* POST : Update Vendor TTR Binding */
router.post("/ttr-vendor-binding/edit/:id", requireAuth, updateLimiter, async (req, res) => {
  try {
    const { id } = req.params;
    const binding = await VendorTtrBinding.findById(id);
    if (!binding) {
      return res.status(404).json({ success: false, message: "Vendor TTR binding not found" });
    }

    const ttr = await Ttr.findById(binding.ttrId).select("ttrMaterialCode").lean();
    if (!ttr) {
      return res.status(400).json({ success: false, message: "Invalid TTR master selected" });
    }

    const vendorTtrMaterialCode = trimOr(req.body.vendorTtrMaterialCode);
    const vendorTtrType = trimOr(req.body.vendorTtrType);
    const vendorTtrColor = trimOr(req.body.vendorTtrColor, "BLACK");
    const incomingVendorCode = normalizeCode(vendorTtrMaterialCode);
    const incomingFsCode = normalizeCode(ttr.ttrMaterialCode);
    const incomingFsId = String(binding.ttrId);

    const existingMappings = await VendorTtrBinding.find({
      _id: { $ne: binding._id },
      vendorTtrMaterialCode: new RegExp(`^${escapeRegex(incomingVendorCode)}$`, "i"),
    })
      .select("vendorTtrMaterialCode ttrId vendorUserId")
      .populate({ path: "ttrId", select: "ttrMaterialCode" })
      .lean();

    const mappingConflict = existingMappings.find((row) => {
      const existingFsCode = normalizeCode(row.ttrId?.ttrMaterialCode);
      const existingFsId = String(row.ttrId?._id || "");
      return existingFsId && existingFsId !== incomingFsId && existingFsCode !== incomingFsCode;
    });

    if (mappingConflict) {
      return res.status(400).json({
        success: false,
        message: `Vendor code ${vendorTtrMaterialCode} is already mapped to FS code ${mappingConflict.ttrId?.ttrMaterialCode || "N/A"}.`,
      });
    }

    const duplicateMappingForUser = await VendorTtrBinding.findOne({
      _id: { $ne: binding._id },
      vendorUserId: binding.vendorUserId,
      ttrId: binding.ttrId,
    }).lean();

    if (duplicateMappingForUser) {
      return res.status(400).json({
        success: false,
        message: "This vendor binding already exists for this user.",
      });
    }

    binding.vendorTtrMaterialCode = incomingVendorCode;
    binding.vendorTtrType = vendorTtrType;
    binding.vendorTtrColor = vendorTtrColor;
    binding.ttrMinQty = numOr(req.body.ttrMinQty, DEFAULT_VENDOR_TTR_OVERRIDES.ttrMinQty);
    binding.ttrRatePerRoll = numOr(req.body.ttrRatePerRoll, DEFAULT_VENDOR_TTR_OVERRIDES.ttrRatePerRoll);

    await binding.save();

    // Also update the master item's MSQ
    await Ttr.updateOne({ _id: binding.ttrId }, { $set: { ttrMinQty: binding.ttrMinQty } });

    req.flash("notification", "Vendor TTR binding updated successfully!");
    res.json({
      success: true,
      redirect: req.body.returnTo || `/fairdesk/ttr-vendor/compare/${binding._id}`,
    });
  } catch (err) {
    console.error("VENDOR TTR EDIT POST ERROR:", err);
    if (err?.code === 11000) {
      return res.status(409).json({
        success: false,
        message: "A vendor TTR binding with this exact configuration already exists.",
      });
    }
    res.status(400).json({ success: false, message: err.message });
  }
});

router.post("/ttr-vendor-binding/delete/:id", requireAuth, deleteLimiter, async (req, res) => {
  try {
    const { id } = req.params;
    const binding = await VendorTtrBinding.findById(id).select("vendorUserId").lean();

    if (!binding) {
      req.flash("notification", "Vendor TTR binding not found");
      return res.redirect("back");
    }

    await VendorTtrBinding.deleteOne({ _id: id });
    if (binding.vendorUserId) {
      await VendorUser.updateOne({ _id: binding.vendorUserId }, { $pull: { ttr: id } });
    }

    req.flash("notification", "Vendor TTR binding removed successfully!");
    return res.redirect(`/fairdesk/ttr-vendor/view?userId=${encodeURIComponent(binding.vendorUserId || "")}`);
  } catch (err) {
    console.error("VENDOR TTR BINDING DELETE ERROR:", err);
    req.flash("notification", "Failed to remove Vendor TTR binding");
    return res.redirect("back");
  }
});

/* GET : Compare Client TTR vs Master */
router.get("/ttr/compare/:id", async (req, res) => {
  try {
    const binding = await TtrBinding.findById(req.params.id)
      .populate({ path: "ttrId", model: "Ttr" })
      .populate({ path: "userId", model: "Username" })
      .lean();

    if (!binding) {
      req.flash("notification", "TTR binding not found");
      return res.redirect("back");
    }

    const ttr = binding.ttrId || {};
    const user = binding.userId || {};

    const compareRows = [
      {
        field: "Material Code",
        orgValue: ttr.ttrMaterialCode || "N/A",
        clientValue: binding.ttrClientMaterialCode || "N/A",
      },
      { field: "Type", orgValue: ttr.ttrType || "N/A", clientValue: binding.clientTtrType || "N/A" },
      { field: "Color", orgValue: ttr.ttrColor || "N/A", clientValue: ttr.ttrColor || "N/A" },
      { field: "Ink Face", orgValue: ttr.ttrInkFace || "N/A", clientValue: ttr.ttrInkFace || "N/A" },
      { field: "Width", orgValue: ttr.ttrWidth ?? "N/A", clientValue: ttr.ttrWidth ?? "N/A" },
      { field: "Meters", orgValue: ttr.ttrMtrs ?? "N/A", clientValue: ttr.ttrMtrs ?? "N/A" },
      { field: "Core ID", orgValue: ttr.ttrCoreId ?? "N/A", clientValue: ttr.ttrCoreId ?? "N/A" },
      { field: "Core Length", orgValue: ttr.ttrCoreLength ?? "N/A", clientValue: ttr.ttrCoreLength ?? "N/A" },
      { field: "Notch", orgValue: ttr.ttrNotch || "N/A", clientValue: ttr.ttrNotch || "N/A" },
      { field: "Winding", orgValue: ttr.ttrWinding || "N/A", clientValue: ttr.ttrWinding || "N/A" },
      { field: "Minimum Qty", orgValue: "-", clientValue: binding.ttrMinQty ?? "N/A" },
      { field: "Minimum Order Qty", orgValue: "-", clientValue: binding.ttrOdrQty ?? "N/A" },
      { field: "Order Frequency", orgValue: "-", clientValue: binding.ttrOdrFreq || "N/A" },
      { field: "Credit Term", orgValue: "-", clientValue: binding.ttrCreditTerm || "N/A" },
      { field: "Rate Per Roll", orgValue: "-", clientValue: binding.ttrRatePerRoll ?? "N/A" },
      { field: "Sale Cost", orgValue: "-", clientValue: binding.ttrSaleCost ?? "N/A" },
      { field: "Meters Delivered", orgValue: "-", clientValue: binding.ttrMtrsDel ?? 0 },
      { field: "Status", orgValue: "-", clientValue: binding.status || "N/A" },
    ];

    res.render("inventory/itemCompare.ejs", {
      title: "TTR Compare",
      CSS: false,
      JS: false,
      itemTitle: "TTR Details",
      sectionTitle: "TTR Details (Fairtech - Client)",
      orgLabel: "Fairtech",
      clientLabel: "Client",
      editBindingUrl: `/fairdesk/ttr-binding/edit/${binding._id}`,
      clientName: user?.clientName || "",
      userName: user?.userName || "",
      compareRows,
      notification: req.flash("notification"),
    });
  } catch (err) {
    console.error("TTR COMPARE ERROR:", err);
    req.flash("notification", "Failed to load TTR comparison");
    res.redirect("back");
  }
});

/* GET : Load TTR Binding Edit Form */
router.get("/ttr-binding/edit/:id", async (req, res) => {
  try {
    const binding = await TtrBinding.findById(req.params.id).populate("ttrId").populate("userId");

    if (!binding) {
      req.flash("notification", "TTR binding not found");
      return res.redirect("back");
    }

    res.render("inventory/ttrBindingEdit.ejs", {
      title: "Edit TTR Binding",
      binding,
      returnTo: typeof req.query.returnTo === "string" ? req.query.returnTo : "",
      CSS: false,
      JS: false,
      notification: req.flash("notification"),
    });
  } catch (err) {
    console.error("EDIT BINDING GET ERROR:", err);
    req.flash("notification", "Failed to load TTR Binding Edit");
    res.redirect("back");
  }
});

/* POST : Update TTR Binding */
router.post("/ttr-binding/edit/:id", requireAuth, updateLimiter, async (req, res) => {
  try {
    const { id } = req.params;
    const {
      ttrClientMaterialCode,
      clientTtrType,
      ttrMtrsDel,
      ttrRatePerRoll,
      ttrSaleCost,
      ttrMinQty,
      ttrOdrQty,
      ttrOdrFreq,
      ttrCreditTerm,
      status,
      returnTo,
    } = req.body;

    const binding = await TtrBinding.findById(id);
    if (!binding) {
      req.flash("notification", "Binding not found");
      return res.redirect("back");
    }

    binding.ttrClientMaterialCode = ttrClientMaterialCode;
    binding.clientTtrType = clientTtrType;
    binding.ttrMtrsDel = ttrMtrsDel;
    binding.ttrRatePerRoll = Number(ttrRatePerRoll);
    binding.ttrSaleCost = Number(ttrSaleCost);
    binding.ttrMinQty = Number(ttrMinQty);
    binding.ttrOdrQty = Number(ttrOdrQty);
    binding.ttrOdrFreq = ttrOdrFreq;
    binding.ttrCreditTerm = ttrCreditTerm;

    if (status) {
      binding.status = status;
    }

    await binding.save();

    req.flash("notification", "TTR binding updated successfully!");

    if (typeof returnTo === "string" && returnTo.startsWith("/fairdesk/")) {
      return res.redirect(returnTo);
    }

    res.redirect("/fairdesk/ttr/view/" + binding.userId);
  } catch (err) {
    console.error("EDIT BINDING POST ERROR:", err);
    if (err.code === 11000) {
      req.flash("notification", "A TTR binding with this exact configuration already exists.");
    } else {
      req.flash("notification", "Failed to update TTR Binding");
    }
    res.redirect("back");
  }
});

router.post("/ttr-binding/delete/:id", requireAuth, deleteLimiter, async (req, res) => {
  try {
    const { id } = req.params;
    const binding = await TtrBinding.findById(id).select("userId").lean();

    if (!binding) {
      req.flash("notification", "TTR binding not found");
      return res.redirect("back");
    }

    await TtrBinding.deleteOne({ _id: id });
    await Username.updateOne({ _id: binding.userId }, { $pull: { ttr: id } });

    req.flash("notification", "TTR binding removed successfully!");
    return res.redirect(`/fairdesk/ttr/view/${binding.userId}`);
  } catch (err) {
    console.error("TTR BINDING DELETE ERROR:", err);
    req.flash("notification", "Failed to remove TTR binding");
    return res.redirect("back");
  }
});

/* GET : Display all Clients bound to a TTR Master */
router.get("/ttr/master-view/clients/:ttrId", async (req, res) => {
  try {
    const ttrId = req.params.ttrId;
    const ttr = await Ttr.findById(ttrId).lean();
    if (!ttr) {
      req.flash("notification", "TTR Master not found");
      return res.redirect("back");
    }

    const ttrDataRaw = await TtrBinding.find({ ttrId })
      .populate({ path: "ttrId", model: "Ttr" })
      .populate({ path: "userId", model: "Username" })
      .lean();

    const stockMap = {};
    if (mongoose.Types.ObjectId.isValid(ttrId)) {
      const stockAgg = await TtrStock.aggregate([
        { $match: { ttr: new mongoose.Types.ObjectId(ttrId) } },
        { $group: { _id: "$ttr", total: { $sum: "$quantity" } } },
      ]);
      if (stockAgg.length) {
        stockMap[ttrId] = stockAgg[0].total;
      }
    }

    const ttrData = ttrDataRaw.map((binding) => {
      return {
        ...binding,
        stock: stockMap[ttrId] || 0,
        productId: binding.ttrId?.ttrProductId || "",
        ttrType: binding.clientTtrType || "",
        ttrColor: binding.ttrId?.ttrColor || "",
        ttrMaterialCode: binding.ttrClientMaterialCode || "",
        ttrWidth: binding.ttrId?.ttrWidth || "",
        ttrMtrs: "", // Removed per user request
        ttrInkFace: binding.ttrId?.ttrInkFace || "",
        ttrCoreId: binding.ttrId?.ttrCoreId || "",
        ttrCoreLength: binding.ttrId?.ttrCoreLength || "",
        ttrNotch: binding.ttrId?.ttrNotch || "",
        ttrWinding: binding.ttrId?.ttrWinding || "",
        clientName: binding.userId?.clientName || "",
        userName: binding.userId?.userName || "",
        userContact: binding.userId?.userContact || "",
        location: binding.userId?.userLocation || "",
        // Explicit binding overrides
        ttrSinOdrQty: binding.ttrOdrQty ?? 0,
        ttrMinQty: binding.ttrMinQty ?? 0,
        ttrRatePerRoll: binding.ttrRatePerRoll ?? 0,
        ttrSaleCost: binding.ttrSaleCost ?? 0,
        ttrMtrsDel: binding.ttrMtrsDel || "",
        ttrOdrFreq: binding.ttrOdrFreq || "",
        ttrCreditTerm: binding.ttrCreditTerm || "",
        status: binding.status || "ACTIVE",
      };
    });

    res.render("inventory/ttrDisp.ejs", {
      jsonData: ttrData,
      CSS: "tableDisp.css",
      JS: false,
      title: `Clients bound to ${ttr.ttrProductId}`,
      clientName: "TTR Master",
      userName: ttr.ttrProductId,
      notification: req.flash("notification"),
      hideExtraColumns: true,
    });
  } catch (err) {
    console.error("TTR MASTER CLIENTS VIEW ERROR:", err);
    res.redirect("back");
  }
});

/* GET : Display all Vendors bound to a TTR Master */
router.get("/ttr/master-view/vendors/:ttrId", async (req, res) => {
  try {
    const ttrId = req.params.ttrId;
    const ttr = await Ttr.findById(ttrId).lean();
    if (!ttr) {
      req.flash("notification", "TTR Master not found");
      return res.redirect("back");
    }

    const vendorTtrBindings = await VendorTtrBinding.find({ ttrId })
      .populate("vendorUserId")
      .populate("ttrId")
      .lean();

    const stockMap = {};
    if (mongoose.Types.ObjectId.isValid(ttrId)) {
      const stockAgg = await TtrStock.aggregate([
        { $match: { ttr: new mongoose.Types.ObjectId(ttrId) } },
        { $group: { _id: "$ttr", total: { $sum: "$quantity" } } },
      ]);
      if (stockAgg.length) {
        stockMap[ttrId] = stockAgg[0].total;
      }
    }

    const ttrData = vendorTtrBindings.map((binding) => {
      return {
        ...binding,
        stock: stockMap[ttrId] || 0,
        sampleId: binding.ttrId?.ttrProductId || "",
        productId: binding.ttrId?.ttrProductId || "",
        ttrType: binding.clientTtrType || binding.vendorTtrType || "",
        ttrColor: binding.vendorTtrColor || binding.ttrId?.ttrColor || "",
        ttrMaterialCode: binding.ttrClientMaterialCode || binding.vendorTtrMaterialCode || "",
        ttrWidth: binding.ttrId?.ttrWidth || "",
        ttrMtrs: "", // Removed per user request
        ttrInkFace: binding.ttrId?.ttrInkFace || "",
        userName: binding.vendorUserId?.userName || "",
        userContact: binding.vendorUserId?.userContact || "",
        location: binding.vendorUserId?.userLocation || "",
        vendorTtrMaterialCode: binding.vendorTtrMaterialCode || "",
        vendorTtrType: binding.vendorTtrType || "",
        vendorTtrColor: binding.vendorTtrColor || "",
        ttrMinQty: binding.ttrMinQty ?? 0,
        status: binding.status || "N/A",
      };
    });

    res.render("inventory/ttrVendorDisp.ejs", {
      jsonData: ttrData,
      CSS: "tableDisp.css",
      JS: false,
      title: `Vendors bound to ${ttr.ttrProductId}`,
      vendorUser: { vendorName: "TTR Master", userName: ttr.ttrProductId },
      notification: req.flash("notification"),
      hideExtraColumns: true,
    });
  } catch (err) {
    console.error("TTR MASTER VENDORS VIEW ERROR:", err);
    res.redirect("back");
  }
});

export default router;