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
import { generateRollId, previewRollId } from "../../utils/rollId.js";
import { rollLabelDataUrl, rollLabelModuleCount } from "../../utils/rollLabel.js";
import {
  buildRollLabelPrn,
  buildQrPayload,
  rollLabelPrnFilename,
  LABEL_WIDTH_MM,
  LABEL_HEIGHT_MM,
  DOTS_PER_MM,
  TEXT_X_DOTS,
  QR_X_DOTS,
  QR_Y_DOTS,
  QR_CELL_WIDTH_DOTS,
} from "../../utils/rollLabelPrn.js";

const dotsToMm = (dots) => Math.round((dots / DOTS_PER_MM) * 1000) / 1000;

const router = express.Router();

function hashSignature(rawSignature) {
  return `sha256:${crypto.createHash("sha256").update(String(rawSignature ?? "")).digest("hex")}`;
}

function normalizePaperPart(value) {
  if (value === undefined || value === null) return "";
  return String(value).trim();
}

function buildPaperSignature(source) {
  return [
    normalizePaperPart(source.vendorName).toUpperCase(),
    normalizePaperPart(source.prodCode).toUpperCase(),
    normalizePaperPart(source.family).toUpperCase(),
  ].join("||");
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

router.get("/preview-roll-id", async (req, res) => {
  try {
    const rollId = await previewRollId();
    res.json({ rollId });
  } catch (err) {
    console.error("PREVIEW ROLL ID ERROR:", err);
    res.status(500).json({ rollId: "" });
  }
});

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
    const { vendorName, prodCode, family } = req.body;

    const paper = await Paper.findOne({
      vendorName: vendorName?.trim(),
      prodCode: prodCode?.trim(),
      family: family?.trim(),
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

router.post("/create", requireAuth, createLimiter, async (req, res) => {
  try {
    const { paperId, vendorName, prodCode, rate, family, location, paperSize, paperMtrs, vendorRollId, remarks } = req.body;
    const qty = 1;
    const size = Number(paperSize);
    const mtrs = Number(paperMtrs);

    if (!location) {
      return res.status(400).json({ success: false, message: "Select a stock location" });
    }

    if (!size || size <= 0 || !mtrs || mtrs <= 0) {
      return res.status(400).json({ success: false, message: "Enter valid paper size and paper mtrs" });
    }

    if (!prodCode?.trim()) {
      return res.status(400).json({ success: false, message: "Select a Prod Code" });
    }

    if (!vendorRollId?.trim()) {
      return res.status(400).json({ success: false, message: "Enter the vendor's roll id" });
    }

    let paperObjectId;
    if (paperId && mongoose.isValidObjectId(paperId)) {
      paperObjectId = new mongoose.Types.ObjectId(paperId);
      const paperUpdate = {};
      if (rate) paperUpdate.rate = Number(rate);
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

      const paperSignature = hashSignature(buildPaperSignature({ vendorName, prodCode, family }));
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
          if (createErr?.code === 11000) {
            paperDoc = await Paper.findOne({ paperSignature });
          }
          if (!paperDoc) throw createErr;
        }
      } else {
        const paperUpdate = { rate: Number(rate) };
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

    const rollId = await generateRollId();

    const reel = await PaperStock.create({
      paper: paperObjectId,
      location,
      quantity: qty,
      paperSize: size,
      paperMtrs: mtrs,
      rollId,
      vendorRollId: vendorRollId.trim(),
      remarks,
    });

    await PaperStockLog.create({
      paper: paperObjectId,
      location,
      openingStock,
      quantity: qty,
      paperSize: size,
      paperMtrs: mtrs,
      rollId,
      vendorRollId: vendorRollId.trim(),
      closingStock,
      type: "INWARD",
      source: "MANUAL",
      remarks,
      createdBy: req.user?.username || "SYSTEM",
    });

    const paperDoc = await Paper.findById(paperObjectId).select("paperProductId").lean();
    res.locals.auditDescription = `Added paper roll "${rollId}" stock for "${paperDoc?.paperProductId || paperId}" at "${location}"`;
    req.flash("notification", `Paper stock added — roll ${rollId}`);
    res.json({ success: true, redirect: `/fairtech/paperstock/label/${reel._id}` });
  } catch (err) {
    console.error(err);
    res.status(400).json({ success: false, message: "Failed to add paper stock" });
  }
});

router.get("/label/:stockId", requireAuth, async (req, res) => {
  try {
    const { stockId } = req.params;
    if (!mongoose.isValidObjectId(stockId)) {
      req.flash("notification", "Roll not found");
      return res.redirect("/fairtech/paperstock");
    }

    const reel = await PaperStock.findById(stockId)
      .select("rollId vendorRollId paperSize paperMtrs paper")
      .lean();
    if (!reel) {
      req.flash("notification", "Roll not found");
      return res.redirect("/fairtech/paperstock");
    }

    const paper = await Paper.findById(reel.paper).select("_id").lean();

    const qrPayload = buildQrPayload({
      rollId: reel.rollId,
      vendorRollId: reel.vendorRollId,
      paperSize: reel.paperSize,
      paperMtrs: reel.paperMtrs,
    });

    const qrModules = rollLabelModuleCount(qrPayload);
    const qrSize = dotsToMm(qrModules * QR_CELL_WIDTH_DOTS);
    const qrBottom = dotsToMm(LABEL_HEIGHT_MM * DOTS_PER_MM - QR_Y_DOTS);
    const qrRight = dotsToMm(LABEL_WIDTH_MM * DOTS_PER_MM - TEXT_X_DOTS);
    const TEXT_QR_GAP_MM = 8;
    const TEXT_VERTICAL_OFFSET_MM = 0;
    // Width and Running Mtrs each get their own independent left/top --
    // separate wrappers, not one shared block, so either can be moved (or
    // removed) without touching the other. Stacked 5mm apart by default.
    const WIDTH_LEFT_MM = 20;
    const WIDTH_TOP_MM = 43;
    const MTRS_LEFT_MM = 82;
    const MTRS_TOP_MM = 43;

    res.render("stock/paperRollLabel", {
      title: `Roll Label — ${reel.rollId}`,
      CSS: false,
      JS: false,
      reel: {
        _id: String(reel._id),
        rollId: reel.rollId,
        paperSize: reel.paperSize,
        paperMtrs: reel.paperMtrs,
      },
      paperId: paper ? String(paper._id) : "",
      qrDataUrl: await rollLabelDataUrl(qrPayload),
      layoutMm: {
        labelWidth: LABEL_WIDTH_MM,
        labelHeight: LABEL_HEIGHT_MM,
        textRight: qrRight + qrSize + TEXT_QR_GAP_MM,
        textCenterFromTop: LABEL_HEIGHT_MM - qrBottom - qrSize / 2 + TEXT_VERTICAL_OFFSET_MM,
        qrRight,
        qrBottom,
        qrSize,
        widthLeft: WIDTH_LEFT_MM,
        widthTop: WIDTH_TOP_MM,
        mtrsLeft: MTRS_LEFT_MM,
        mtrsTop: MTRS_TOP_MM,
      },
      notification: req.flash("notification"),
    });
  } catch (err) {
    console.error("ROLL LABEL ERROR:", err);
    req.flash("notification", "Failed to load roll label");
    res.redirect("/fairtech/paperstock");
  }
});

router.get("/label/:stockId/prn", requireAuth, async (req, res) => {
  try {
    const { stockId } = req.params;
    if (!mongoose.isValidObjectId(stockId)) {
      req.flash("notification", "Roll not found");
      return res.redirect("/fairtech/paperstock");
    }

    const reel = await PaperStock.findById(stockId)
      .select("rollId vendorRollId paperSize paperMtrs")
      .lean();
    if (!reel) {
      req.flash("notification", "Roll not found");
      return res.redirect("/fairtech/paperstock");
    }

    const prn = buildRollLabelPrn({
      rollId: reel.rollId,
      vendorRollId: reel.vendorRollId,
      paperSize: reel.paperSize,
      paperMtrs: reel.paperMtrs,
    });
    res.setHeader("Content-Type", "text/plain");
    res.setHeader("Content-Disposition", `attachment; filename="${rollLabelPrnFilename(reel.rollId)}"`);
    res.send(prn);
  } catch (err) {
    console.error("ROLL LABEL PRN ERROR:", err);
    req.flash("notification", "Failed to build print file");
    res.redirect("/fairtech/paperstock");
  }
});

export default router;
