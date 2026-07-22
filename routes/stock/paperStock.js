import express from "express";
import mongoose from "mongoose";
import crypto from "crypto";
import Paper from "../../models/inventory/paper.js";
import PaperStock from "../../models/inventory/PaperStock.js";
import PaperStockLog from "../../models/inventory/PaperStockLog.js";
import Location from "../../models/system/location.js";
import Vendor from "../../models/users/vendor.js";
import { requireAuth } from "../../middleware/auth.js";
import { createLimiter } from "../../utils/limiters.js";

const router = express.Router();

// Mirrors the Paper Master signature/id-generation logic previously in
// fairdesk_route.js (kept local here so this page can create a new Paper
// master on the fly when the typed Vendor/Prod Code combination doesn't
// already exist).
function hashSignature(rawSignature) {
  return `sha256:${crypto.createHash("sha256").update(String(rawSignature ?? "")).digest("hex")}`;
}

function normalizePaperPart(value) {
  if (value === undefined || value === null) return "";
  return String(value).trim();
}

// Identity of a paper spec = vendor + their product code -- rate/family are
// attributes of that identity, not part of it (a rate change shouldn't spawn
// a duplicate paper master, it should update the existing one).
function buildPaperSignature(source) {
  return [normalizePaperPart(source.vendorName).toUpperCase(), normalizePaperPart(source.prodCode).toUpperCase()].join("||");
}

function formatPaperId(n) {
  return `FS | Paper | ${String(n).padStart(6, "0")}`;
}

function parsePaperSeq(productId) {
  const match = String(productId || "").match(/(\d{6})$/);
  return match ? Number(match[1]) : 0;
}

async function generatePaperProductId() {
  let nextSeq =
    parsePaperSeq((await Paper.findOne().sort({ paperProductId: -1 }).select("paperProductId").lean())?.paperProductId) + 1;

  const maxAttempts = 10000;
  for (let i = 0; i < maxAttempts; i++) {
    const candidateId = formatPaperId(nextSeq);
    if (!(await Paper.exists({ paperProductId: candidateId }))) return candidateId;
    nextSeq += 1;
  }
  throw new Error("Unable to generate unique paper product id");
}

// Only vendors who supply the SL (PAPER) commodity -- matches the scoping
// already used by the Production Binding form (/form/prodcalc).
async function getPaperVendorNames() {
  return Vendor.distinct("vendorName", { commodities: /^SL \(PAPER\)$/i });
}

/* RENDER */
router.get("/", async (req, res) => {
  try {
    const [vendors, prodCodes, families] = await Promise.all([
      getPaperVendorNames(),
      Paper.distinct("prodCode"),
      Paper.distinct("family"),
    ]);

    const locations = await Location.distinct("locationName");

    res.render("stock/paperStock", {
      title: "Paper Stock",
      CSS: false,
      JS: false,
      notification: req.flash("notification"),
      vendors,
      prodCodes,
      families,
      locations,
    });
  } catch (err) {
    console.error(err);
    res.redirect("/fairtech");
  }
});

/* FILTER SPECS -- narrows Vendor / Prod Code / Family suggestions once any
   one of them is picked, same cascade in both directions (e.g. picking a
   Prod Code narrows -- and can auto-select -- its Vendor, not just the
   other way around). */
router.get("/filter-specs", async (req, res) => {
  try {
    const { vendorName, prodCode, family } = req.query;

    const buildFilter = (excludeKey) => {
      const f = {};
      if (vendorName && excludeKey !== "vendorName") f.vendorName = vendorName;
      if (prodCode && excludeKey !== "prodCode") f.prodCode = prodCode;
      if (family && excludeKey !== "family") f.family = family;
      return f;
    };

    const [vendors, prodCodes, families] = await Promise.all([
      Paper.distinct("vendorName", buildFilter("vendorName")),
      Paper.distinct("prodCode", buildFilter("prodCode")),
      Paper.distinct("family", buildFilter("family")),
    ]);

    res.json({ vendors, prodCodes, families });
  } catch (err) {
    console.error("FILTER ERROR:", err);
    res.status(500).json({ error: "Failed to load filter options." });
  }
});

/* PREVIEW NEXT AUTO-GENERATED PAPER ID (no side effects) */
router.get("/preview-id", async (req, res) => {
  try {
    const paperProductId = await generatePaperProductId();
    res.json({ paperProductId });
  } catch (err) {
    console.error("PREVIEW ID ERROR:", err);
    res.status(500).json({ paperProductId: "" });
  }
});

/* RESOLVE PAPER */
router.post("/resolve", requireAuth, async (req, res) => {
  try {
    const { vendorName, prodCode } = req.body;

    const paper = await Paper.findOne({
      vendorName: vendorName?.trim(),
      prodCode: prodCode?.trim(),
    }).lean();

    if (!paper) {
      return res.json({ found: false });
    }

    return res.json({
      found: true,
      paperId: paper._id.toString(),
      paperProductId: paper.paperProductId,
      rate: paper.rate,
      family: paper.family,
    });
  } catch (err) {
    console.error("Resolve error ❌", err);
    return res.json({ found: false });
  }
});

/* BALANCE */
router.get("/balance/:paperId/:location", async (req, res) => {
  try {
    const { paperId, location } = req.params;

    if (!mongoose.isValidObjectId(paperId)) {
      return res.status(400).json({ error: "Invalid paper ID." });
    }

    const bal = await PaperStock.aggregate([
      { $match: { paper: new mongoose.Types.ObjectId(paperId), location } },
      { $group: { _id: null, qty: { $sum: "$quantity" } } },
    ]);

    res.json({ stock: bal[0]?.qty || 0 });
  } catch (err) {
    console.error("BALANCE ERROR:", err);
    res.status(500).json({ error: "Failed to fetch stock balance." });
  }
});

router.get("/stock-info/:paperId", async (req, res) => {
  try {
    const { paperId } = req.params;
    const paperObjectId = new mongoose.Types.ObjectId(paperId);

    const stockAggregation = await PaperStock.aggregate([
      { $match: { paper: paperObjectId } },
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
      return { location, qty, balance: qty };
    });

    return res.json({
      totalStock,
      balance: totalStock,
      locations: stockInfoLocations,
    });
  } catch (err) {
    console.error("Stock info error", err);
    return res.json({ totalStock: 0, balance: 0, locations: [] });
  }
});

/* CREATE (INWARD ONLY) — resolves an existing paper by vendor+prod code, or
   creates a new Paper master when that combination doesn't exist yet. If it
   already exists but the typed rate/family differ, syncs them onto it. */
router.post("/create", requireAuth, createLimiter, async (req, res) => {
  try {
    const { paperId, vendorName, prodCode, rate, family, location, paperSize, paperMtrs, rollNo, remarks } = req.body;
    // Each stock entry represents exactly one roll.
    const qty = 1;
    const size = Number(paperSize);
    const mtrs = Number(paperMtrs);

    if (!location) {
      return res.status(400).json({ success: false, message: "Select a stock location" });
    }

    if (!size || size <= 0 || !mtrs || mtrs <= 0) {
      return res.status(400).json({ success: false, message: "Enter valid paper size and paper mtrs" });
    }

    if (!rollNo?.trim()) {
      return res.status(400).json({ success: false, message: "Enter a roll no" });
    }

    let paperObjectId;
    if (paperId && mongoose.isValidObjectId(paperId)) {
      paperObjectId = new mongoose.Types.ObjectId(paperId);
      const paperUpdate = {};
      if (rate) paperUpdate.rate = Number(rate);
      if (family?.trim()) paperUpdate.family = String(family).trim();
      if (Object.keys(paperUpdate).length) {
        const existing = await Paper.findById(paperObjectId).lean();
        const hasChanges = Object.keys(paperUpdate).some((k) => String(existing?.[k] ?? "") !== String(paperUpdate[k] ?? ""));
        if (hasChanges) {
          await Paper.findByIdAndUpdate(paperObjectId, { $set: paperUpdate });
        }
      }
    } else {
      if (!vendorName?.trim() || !prodCode?.trim() || !rate || !family?.trim()) {
        return res.status(400).json({ success: false, message: "Enter complete paper specifications (vendor, prod code, rate, family)" });
      }

      const paperSignature = hashSignature(buildPaperSignature({ vendorName, prodCode }));
      let paperDoc = await Paper.findOne({ paperSignature });
      if (!paperDoc) {
        try {
          paperDoc = await Paper.create({
            paperProductId: await generatePaperProductId(),
            vendorName: String(vendorName).trim(),
            prodCode: String(prodCode).trim(),
            rate: Number(rate),
            family: String(family).trim(),
            paperSignature,
            createdBy: req.user?.username || "SYSTEM",
          });
        } catch (createErr) {
          // Race with another request creating the same spec concurrently.
          if (createErr?.code === 11000) {
            paperDoc = await Paper.findOne({ paperSignature });
          }
          if (!paperDoc) throw createErr;
        }
      } else {
        const paperUpdate = { rate: Number(rate), family: String(family).trim() };
        const hasChanges = Object.keys(paperUpdate).some((k) => String(paperDoc[k] ?? "") !== String(paperUpdate[k] ?? ""));
        if (hasChanges) {
          paperDoc = await Paper.findByIdAndUpdate(paperDoc._id, { $set: paperUpdate }, { new: true });
        }
      }
      paperObjectId = paperDoc._id;
    }

    const bal = await PaperStock.aggregate([
      { $match: { paper: paperObjectId, location } },
      { $group: { _id: null, qty: { $sum: "$quantity" } } },
    ]);

    const openingStock = bal[0]?.qty || 0;
    const closingStock = openingStock + qty;

    await PaperStock.create({
      paper: paperObjectId,
      location,
      quantity: qty,
      paperSize: size,
      paperMtrs: mtrs,
      rollNo: rollNo.trim(),
      remarks,
    });

    await PaperStockLog.create({
      paper: paperObjectId,
      location,
      openingStock,
      quantity: qty,
      paperSize: size,
      paperMtrs: mtrs,
      rollNo: rollNo.trim(),
      closingStock,
      type: "INWARD",
      source: "MANUAL",
      remarks,
      createdBy: req.user?.username || "SYSTEM",
    });

    const paperDoc = await Paper.findById(paperObjectId).select("paperProductId").lean();
    res.locals.auditDescription = `Added paper roll "${rollNo.trim()}" stock for "${paperDoc?.paperProductId || paperId}" at "${location}"`;
    req.flash("notification", "Paper stock added successfully");
    res.json({ success: true, redirect: "/fairtech/paperstock" });
  } catch (err) {
    console.error(err);
    res.status(400).json({ success: false, message: "Failed to add paper stock" });
  }
});

export default router;
