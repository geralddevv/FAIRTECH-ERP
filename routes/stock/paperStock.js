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
import { generateRollId, previewRollIds } from "../../utils/rollId.js";
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

const toArray = (value) => {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
};

function buildPaperSignature(source) {
  return [
    normalizePaperPart(source.vendorName).toUpperCase(),
    normalizePaperPart(source.prodCode).toUpperCase(),
    normalizePaperPart(source.family).toUpperCase(),
  ].join("||");
}

function bumpPaperRate(existingRate, existingMinRate, existingMaxRate, incomingRate) {
  if (!Number.isFinite(incomingRate) || !(incomingRate > existingRate)) return null;
  return {
    previousRate: existingRate,
    rate: incomingRate,
    minRate: Math.min(existingMinRate ?? existingRate, incomingRate),
    maxRate: Math.max(existingMaxRate ?? existingRate, incomingRate),
  };
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

router.get("/preview-roll-ids", async (req, res) => {
  try {
    const rollIds = await previewRollIds(req.query.prodCode, req.query.count);
    res.json({ rollIds });
  } catch (err) {
    console.error("PREVIEW ROLL IDS ERROR:", err);
    res.status(500).json({ rollIds: [] });
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
    const trimmedFamily = family?.trim();

    const query = { vendorName: vendorName?.trim(), prodCode: prodCode?.trim() };
    if (trimmedFamily) query.family = trimmedFamily;

    const paper = await Paper.findOne(query).lean();

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
    const { vendorName, invoiceNo, location } = req.body;

    const families = toArray(req.body.family).map((v) => String(v ?? "").trim());
    const prodCodes = toArray(req.body.prodCode).map((v) => String(v ?? "").trim());
    const rates = toArray(req.body.rate);
    const paperSizes = toArray(req.body.paperSize).map((v) => Number(v));
    const paperIds = toArray(req.body.paperId).map((v) => String(v ?? "").trim());
    const blockCount = families.length;

    if (!location) {
      return res.status(400).json({ success: false, message: "Select a stock location" });
    }
    if (!invoiceNo?.trim()) {
      return res.status(400).json({ success: false, message: "Enter the invoice no" });
    }
    if (!blockCount) {
      return res.status(400).json({ success: false, message: "Add at least one paper" });
    }
    if ([prodCodes, rates, paperSizes, paperIds].some((arr) => arr.length !== blockCount)) {
      return res.status(400).json({ success: false, message: "Paper details are incomplete" });
    }
    for (let b = 0; b < blockCount; b++) {
      if (!prodCodes[b]) {
        return res.status(400).json({ success: false, message: `Select a Prod Code for paper ${b + 1}` });
      }
      if (!paperSizes[b] || paperSizes[b] <= 0) {
        return res.status(400).json({ success: false, message: `Enter a valid paper size for paper ${b + 1}` });
      }
      if (!rates[b] || !Number.isFinite(Number(rates[b])) || Number(rates[b]) <= 0) {
        return res.status(400).json({ success: false, message: `Enter a valid rate for paper ${b + 1}` });
      }
    }

    const vendorRollIds = toArray(req.body.vendorRollId).map((v) => String(v ?? "").trim());
    const paperMtrsList = toArray(req.body.paperMtrs).map((v) => Number(v));
    const rollBlockIndexes = toArray(req.body.rollBlockIndex).map((v) => Number(v));

    if (
      !vendorRollIds.length ||
      vendorRollIds.length !== paperMtrsList.length ||
      vendorRollIds.length !== rollBlockIndexes.length
    ) {
      return res.status(400).json({ success: false, message: "Enter at least one roll" });
    }
    if (vendorRollIds.some((v) => !v)) {
      return res.status(400).json({ success: false, message: "Enter a vendor roll id for every roll" });
    }
    if (paperMtrsList.some((m) => !m || m <= 0)) {
      return res.status(400).json({ success: false, message: "Enter valid running mtrs for every roll" });
    }

    // Group rolls by which paper block they belong to.
    const rollsByBlock = Array.from({ length: blockCount }, () => []);
    for (let i = 0; i < vendorRollIds.length; i++) {
      const blockIndex = rollBlockIndexes[i];
      if (!Number.isInteger(blockIndex) || !rollsByBlock[blockIndex]) {
        return res.status(400).json({ success: false, message: "Malformed roll data" });
      }
      rollsByBlock[blockIndex].push({
        vendorRollId: vendorRollIds[i],
        paperMtrs: paperMtrsList[i],
      });
    }
    if (rollsByBlock.some((rolls) => !rolls.length)) {
      return res.status(400).json({ success: false, message: "Every paper needs at least one roll" });
    }

    const invoice = invoiceNo.trim();
    const createdBy = req.user?.username || "SYSTEM";
    const createdIds = [];
    const createdRollIds = [];
    const runningStockByPaper = new Map();

    for (let b = 0; b < blockCount; b++) {
      const prodCode = prodCodes[b];
      const rate = rates[b];
      const family = families[b];
      const paperId = paperIds[b];
      const size = paperSizes[b];

      let paperObjectId;
      if (paperId && mongoose.isValidObjectId(paperId)) {
        paperObjectId = new mongoose.Types.ObjectId(paperId);
        const incomingRate = Number(rate);
        if (rate) {
          const existing = await Paper.findById(paperObjectId).select("rate minRate maxRate").lean();
          const paperUpdate = existing && bumpPaperRate(existing.rate, existing.minRate, existing.maxRate, incomingRate);
          if (paperUpdate) {
            await Paper.findByIdAndUpdate(paperObjectId, { $set: paperUpdate });
          }
        }
      } else {
        if (!vendorName?.trim() || !prodCode || !rate || !family) {
          return res.status(400).json({ success: false, message: `Enter complete paper specifications for paper ${b + 1} (vendor, prod code, rate, family)` });
        }

        const paperSignature = hashSignature(buildPaperSignature({ vendorName, prodCode, family }));
        let paperDoc = await Paper.findOne({ paperSignature });
        if (!paperDoc) {
          try {
            paperDoc = await Paper.create({
              paperProductId: await generatePaperProductId(),
              vendorName: String(vendorName).trim(),
              prodCode,
              rate: Number(rate),
              minRate: Number(rate),
              maxRate: Number(rate),
              family,
              paperSignature,
              createdBy,
            });
          } catch (createErr) {
            if (createErr?.code === 11000) {
              paperDoc = await Paper.findOne({ paperSignature });
            }
            if (!paperDoc) throw createErr;
          }
        } else {
          const paperUpdate = bumpPaperRate(paperDoc.rate, paperDoc.minRate, paperDoc.maxRate, Number(rate));
          if (paperUpdate) {
            paperDoc = await Paper.findByIdAndUpdate(paperDoc._id, { $set: paperUpdate }, { new: true });
          }
        }
        paperObjectId = paperDoc._id;
      }

      const paperKey = String(paperObjectId);
      let runningStock = runningStockByPaper.get(paperKey);
      if (runningStock === undefined) {
        const bal = await PaperStock.aggregate([
          { $match: { paper: paperObjectId, location } },
          { $group: { _id: null, qty: { $sum: "$quantity" } } },
        ]);
        runningStock = bal[0]?.qty || 0;
      }

      for (const roll of rollsByBlock[b]) {
        const rollId = await generateRollId(prodCode);

        const openingStock = runningStock;
        runningStock += 1;
        const closingStock = runningStock;

        const reel = await PaperStock.create({
          paper: paperObjectId,
          location,
          quantity: 1,
          paperSize: size,
          paperMtrs: roll.paperMtrs,
          rate: Number(rate),
          rollId,
          vendorRollId: roll.vendorRollId,
          invoiceNo: invoice,
        });

        await PaperStockLog.create({
          paper: paperObjectId,
          location,
          openingStock,
          quantity: 1,
          paperSize: size,
          paperMtrs: roll.paperMtrs,
          rate: Number(rate),
          rollId,
          vendorRollId: roll.vendorRollId,
          invoiceNo: invoice,
          closingStock,
          type: "INWARD",
          source: "MANUAL",
          createdBy,
        });

        createdIds.push(String(reel._id));
        createdRollIds.push(rollId);
      }

      runningStockByPaper.set(paperKey, runningStock);
    }

    const rollWord = createdIds.length === 1 ? "roll" : "rolls";
    const paperWord = blockCount === 1 ? "paper" : "papers";
    res.locals.auditDescription = `Added ${createdIds.length} paper ${rollWord} across ${blockCount} ${paperWord} (${createdRollIds.join(", ")}) at "${location}" -- invoice ${invoice}`;
    req.flash("notification", `Paper stock added — ${createdIds.length} ${rollWord} (invoice ${invoice})`);
    res.json({ success: true, redirect: `/fairtech/paperstock/batch?ids=${createdIds.join(",")}` });
  } catch (err) {
    console.error(err);
    res.status(400).json({ success: false, message: "Failed to add paper stock" });
  }
});

router.get("/batch", requireAuth, async (req, res) => {
  try {
    const ids = String(req.query.ids || "")
      .split(",")
      .map((s) => s.trim())
      .filter((s) => mongoose.isValidObjectId(s));

    if (!ids.length) {
      req.flash("notification", "No rolls to show");
      return res.redirect("/fairtech/paperstock");
    }

    const reels = await PaperStock.find({ _id: { $in: ids } })
      .select("rollId vendorRollId paperSize paperMtrs rate invoiceNo location paper")
      .lean();
    const reelById = new Map(reels.map((r) => [String(r._id), r]));
    const ordered = ids.map((id) => reelById.get(id)).filter(Boolean);

    if (!ordered.length) {
      req.flash("notification", "Those rolls could not be found");
      return res.redirect("/fairtech/paperstock");
    }

    const paperIds = [...new Set(ordered.map((r) => String(r.paper)))];
    const papers = await Paper.find({ _id: { $in: paperIds } })
      .select("paperProductId vendorName prodCode family")
      .lean();
    const paperById = new Map(papers.map((p) => [String(p._id), p]));
    const distinctVendors = [...new Set(papers.map((p) => p.vendorName).filter(Boolean))];
    const distinctFamilies = [...new Set(papers.map((p) => p.family).filter(Boolean))];

    const groupByPaperKey = new Map();
    const paperGroups = [];
    for (const r of ordered) {
      const key = String(r.paper);
      let group = groupByPaperKey.get(key);
      if (!group) {
        const paper = paperById.get(key);
        group = {
          paperProductId: paper?.paperProductId || "",
          vendorName: paper?.vendorName || "",
          prodCode: paper?.prodCode || "",
          family: paper?.family || "",
          rolls: [],
        };
        groupByPaperKey.set(key, group);
        paperGroups.push(group);
      }
      group.rolls.push({
        _id: String(r._id),
        rollId: r.rollId,
        vendorRollId: r.vendorRollId,
        paperSize: r.paperSize,
        paperMtrs: r.paperMtrs,
        rate: r.rate,
      });
    }

    res.render("stock/paperStockBatch", {
      title: "Rolls Inwarded",
      CSS: false,
      JS: false,
      invoiceNo: ordered[0].invoiceNo || "",
      vendorName: distinctVendors.join(", "),
      family: distinctFamilies.join(", "),
      location: ordered[0].location || "",
      rollCount: ordered.length,
      paperGroups,
      notification: req.flash("notification"),
    });
  } catch (err) {
    console.error("PAPER BATCH VIEW ERROR:", err);
    req.flash("notification", "Failed to load inward summary");
    res.redirect("/fairtech/paperstock");
  }
});

router.get("/batch/labels/prn", requireAuth, async (req, res) => {
  try {
    const ids = String(req.query.ids || "")
      .split(",")
      .map((s) => s.trim())
      .filter((s) => mongoose.isValidObjectId(s));

    if (!ids.length) {
      req.flash("notification", "No labels selected");
      return res.redirect("/fairtech/paperstock");
    }

    const reels = await PaperStock.find({ _id: { $in: ids } })
      .select("rollId vendorRollId paperSize paperMtrs invoiceNo")
      .lean();
    const reelById = new Map(reels.map((r) => [String(r._id), r]));
    const ordered = ids.map((id) => reelById.get(id)).filter(Boolean);

    if (!ordered.length) {
      req.flash("notification", "Those rolls could not be found");
      return res.redirect("/fairtech/paperstock");
    }

    const prn = ordered
      .map((r) => buildRollLabelPrn({
        rollId: r.rollId,
        vendorRollId: r.vendorRollId,
        paperSize: r.paperSize,
        paperMtrs: r.paperMtrs,
      }))
      .join("\r\n");

    const invoiceLabel = String(ordered[0].invoiceNo || "batch").replace(/[\\/:*?"<>|]+/g, "-");
    res.setHeader("Content-Type", "text/plain");
    res.setHeader("Content-Disposition", `attachment; filename="labels-${invoiceLabel}-${ordered.length}.prn"`);
    res.send(prn);
  } catch (err) {
    console.error("BATCH LABEL PRN ERROR:", err);
    req.flash("notification", "Failed to build print file");
    res.redirect("/fairtech/paperstock");
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
