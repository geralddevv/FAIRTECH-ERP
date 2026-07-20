import express from "express";
import mongoose from "mongoose";
import Machine from "../../models/system/machine.js";
import MachineBinding from "../../models/system/machineBinding.js";
import Location from "../../models/system/location.js";
import Die from "../../models/utilities/die_model.js";
import Paper from "../../models/inventory/paper.js";
import Block from "../../models/utilities/block_model.js";
import ProductionBinding from "../../models/utilities/productionBinding.js";
import PendingProduction from "../../models/inventory/PendingProduction.js";
import JobCard from "../../models/inventory/JobCard.js";
import Counter from "../../models/system/counter.js";
import { requireAuth } from "../../middleware/auth.js";
import { createLimiter, updateLimiter, deleteLimiter } from "../../utils/limiters.js";

const router = express.Router();

// Generate a sequential id of the form `FS | <CODE> | 000001`.
async function generateId(key, code) {
  const counter = await Counter.findOneAndUpdate(
    { key },
    { $inc: { seq: 1 } },
    { new: true, upsert: true, setDefaultsOnInsert: true },
  ).lean();
  return `FS | ${code} | ${String(counter.seq).padStart(6, "0")}`;
}

// Preview the next id without consuming a sequence number.
async function previewId(key, code) {
  const counter = await Counter.findOne({ key }).select("seq").lean();
  const nextSeq = Number(counter?.seq || 0) + 1;
  return `FS | ${code} | ${String(nextSeq).padStart(6, "0")}`;
}

const numOrUndef = (value) => {
  if (value === undefined || value === null || String(value).trim() === "") return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
};

const trim = (value) => String(value ?? "").trim();

const formatDieLabel = (die) => [
  die?.dieWidth != null && die?.dieHeight != null ? `${die.dieWidth} x ${die.dieHeight}` : "",
  die?.dieTotalUps != null ? `${die.dieTotalUps}ups` : "",
  die?.dieType || "",
].filter(Boolean).join(" - ");

const formatRunningMeters = (quantity, die) => {
  const balanceQty = Number(quantity) || 0;
  const across = Number(die?.dieFlatAcross);
  const repGap = Number(die?.dieFlatrepGap);
  if (!balanceQty || !across || !repGap) return "";
  const meters = (Math.ceil(balanceQty / across) * repGap) / 1000;
  return `${meters.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} m`;
};

// Normalize repeated form fields into an array (single value -> [value]).
const toArray = (value) => {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
};

// ----------------------------------Machine Master---------------------------------->

router.get("/form/machine", async (req, res) => {
  const [locations, machines] = await Promise.all([
    Location.find().sort({ locationName: 1 }).lean(),
    Machine.find().populate("location").sort({ machineName: 1 }).lean(),
  ]);
  res.render("inventory/masters/machineMaster.ejs", {
    JS: false,
    CSS: "tableDisp.css",
    title: "Machine Master",
    locations,
    machines,
    notification: req.flash("notification"),
  });
});

const VALID_MACHINE_TYPES = ["Flatbed", "Rotary", "Flexo", "Slitting", "Micro Slitter", "Sheet Cutter", "Coating"];

router.post("/form/machine", requireAuth, createLimiter, async (req, res) => {
  try {
    const machineName = String(req.body.machineName || "").trim().toUpperCase();
    const locationId = req.body.locationId;
    const machineType = String(req.body.machineType || "").trim();

    if (!machineName || !locationId) {
      return res.status(400).json({ success: false, message: "Machine name and location are required" });
    }
    if (!VALID_MACHINE_TYPES.includes(machineType)) {
      return res.status(400).json({ success: false, message: "Please select a machine type" });
    }

    const locationDoc = await Location.findById(locationId).lean();
    if (!locationDoc) {
      return res.status(400).json({ success: false, message: "Invalid location" });
    }

    const alreadyExists = await Machine.exists({ machineName, location: locationId });
    if (alreadyExists) {
      return res.status(400).json({ success: false, message: "Machine already exists at this location" });
    }

    await Machine.create({ machineName, location: locationId, machineType });
    res.locals.auditDescription = `Created machine "${machineName}" (${machineType}) at "${locationDoc.locationName}"`;
    req.flash("notification", "Machine created successfully!");
    res.json({ success: true, redirect: "/fairtech/form/machine" });
  } catch (err) {
    console.error(err);
    const msg = err.code === 11000 ? "Machine already exists at this location" : err.message;
    res.status(400).json({ success: false, message: msg });
  }
});

// ----------------------------------Machine Binding---------------------------------->

router.get("/form/machine-binding/view", async (req, res) => {
  const bindings = await MachineBinding.find()
    .populate({ path: "machine", populate: { path: "location" } })
    .populate("die")
    .populate("block")
    .sort({ createdAt: -1 })
    .lean();

  const jsonData = bindings.map((b) => ({
    _id: String(b._id),
    machineName: b.machine?.machineName || "—",
    machineLocation: b.machine?.location?.locationName || "—",
    machineGroup: b.machine
      ? `${b.machine.machineName} — ${b.machine.location?.locationName || "?"}`
      : "Unknown Machine",
    dieDieNo: b.die?.dieDieNo || "—",
    dieType: b.die?.dieType || "—",
    dieMachineNo: b.die?.dieMachineNo || "—",
    dieSize: b.die ? `${b.die.dieWidth} × ${b.die.dieHeight}` : "—",
    dieTotalUps: b.die?.dieTotalUps || "—",
    blockNo: b.block?.blockNo || "—",
    blockArtworkNo: b.block?.blockArtworkNo || "—",
    blockMachineNo: b.block?.blockMachineNo || "—",
    blockSize: b.block ? `${b.block.blockWidth} × ${b.block.blockHeight}` : "—",
  }));

  res.render("inventory/masters/machineBindingDisp.ejs", {
    JS: false,
    CSS: "tableDisp.css",
    title: "Machine Bindings",
    jsonData,
    notification: req.flash("notification"),
  });
});

router.get("/form/machine-binding", async (req, res) => {
  const [machines, dies, blocks] = await Promise.all([
    Machine.find().populate("location").sort({ machineName: 1 }).lean(),
    Die.find().sort({ dieDieNo: 1 }).lean(),
    Block.find().sort({ blockNo: 1 }).lean(),
  ]);

  res.render("inventory/masters/machineBinding.ejs", {
    JS: false,
    CSS: false,
    title: "Machine Binding",
    machines,
    dies,
    blocks,
    notification: req.flash("notification"),
  });
});

router.post("/form/machine-binding", requireAuth, createLimiter, async (req, res) => {
  try {
    const { machineId, dieId, blockId } = req.body;

    if (!machineId) {
      return res.status(400).json({ success: false, message: "Machine is required" });
    }
    if (!dieId && !blockId) {
      return res.status(400).json({ success: false, message: "Select at least a Die or a Block" });
    }

    const doc = { machine: machineId };
    if (dieId) doc.die = dieId;
    if (blockId) doc.block = blockId;

    const alreadyExists = await MachineBinding.exists(doc);
    if (alreadyExists) {
      return res.status(400).json({ success: false, message: "This binding already exists" });
    }

    await MachineBinding.create(doc);

    const [machine, die, block] = await Promise.all([
      Machine.findById(machineId).select("machineName").lean(),
      dieId ? Die.findById(dieId).select("dieDieNo").lean() : null,
      blockId ? Block.findById(blockId).select("blockNo").lean() : null,
    ]);
    const target = [die?.dieDieNo, block?.blockNo].filter(Boolean).join(" / ");
    res.locals.auditDescription = `Created machine binding "${machine?.machineName || machineId}" ↔ "${target}"`;
    req.flash("notification", "Machine binding saved!");
    res.json({ success: true, redirect: "/fairtech/form/machine-binding" });
  } catch (err) {
    console.error(err);
    const msg = err.code === 11000 ? "This binding already exists" : err.message;
    res.status(400).json({ success: false, message: msg });
  }
});

router.post("/machine-binding/delete/:id", requireAuth, deleteLimiter, async (req, res) => {
  try {
    const existing = await MachineBinding.findById(req.params.id)
      .populate("machine", "machineName")
      .populate("die", "dieDieNo")
      .populate("block", "blockNo")
      .lean();
    await MachineBinding.findByIdAndDelete(req.params.id);
    if (existing) {
      const target = [existing.die?.dieDieNo, existing.block?.blockNo].filter(Boolean).join(" / ");
      res.locals.auditDescription = `Deleted machine binding "${existing.machine?.machineName || req.params.id}" ↔ "${target}"`;
    }
    const wantsJson = req.xhr || req.headers.accept?.includes("application/json");
    if (wantsJson) return res.json({ success: true });
    req.flash("notification", "Binding removed.");
    res.redirect("/fairtech/form/machine-binding/view");
  } catch (err) {
    console.error("DELETE MACHINE BINDING ERROR:", err);
    res.status(500).json({ success: false, message: "Failed to remove binding." });
  }
});

// ----------------------------------Machine Production Queue---------------------------------->
// Overview of every machine with a pending-order count, linking through to
// each machine's own queue detail page below.
router.get("/machine/queue", async (req, res) => {
  const machines = await Machine.find().populate("location").sort({ machineName: 1 }).lean();

  const counts = await PendingProduction.aggregate([
    { $match: { assignedMachineId: { $ne: null } } },
    { $group: { _id: "$assignedMachineId", count: { $sum: 1 } } },
  ]);
  const countMap = new Map(counts.map((c) => [String(c._id), c.count]));

  const rows = machines.map((m) => ({
    _id: String(m._id),
    machineName: m.machineName,
    machineType: m.machineType || "—",
    locationName: m.location?.locationName || "—",
    pendingCount: countMap.get(String(m._id)) || 0,
  }));

  res.render("inventory/masters/machineQueueList.ejs", {
    title: "Machine Queues",
    CSS: "tableDisp.css",
    JS: false,
    rows,
    notification: req.flash("notification"),
  });
});

// Shared by the per-machine queue page and the job card form's prefill lookup
// (both need the same PendingProduction -> ProductionBinding -> Die join).
async function buildQueueRows(machineId) {
  const pending = await PendingProduction.find({ assignedMachineId: machineId })
    .populate({ path: "itemId", select: "productId labelWidth labelHeight perRollQty paperType labelFamily jobType jobName" })
    .populate({ path: "operatorId", select: "empName" })
    .populate({ path: "helperId", select: "empName" })
    .sort({ assignedAt: 1 })
    .lean();

  const bindingIds = pending.map((p) => p.productionBindingId).filter(Boolean);
  const bindings = bindingIds.length
    ? await ProductionBinding.find({ _id: { $in: bindingIds } }).lean()
    : [];
  const bindingMap = new Map(bindings.map((b) => [String(b._id), b]));

  const dieIds = bindings.map((b) => b.dieId).filter((d) => d && mongoose.isValidObjectId(String(d)));
  const dies = dieIds.length
    ? await Die.find({ _id: { $in: dieIds } })
        .select("dieDieNo dieWidth dieHeight dieTotalUps dieType dieFlatAcross dieFlatrepGap")
        .lean()
    : [];
  const dieMap = new Map(dies.map((d) => [String(d._id), d]));

  return pending.map((p, i) => {
    const item = p.itemId || {};
    const binding = p.productionBindingId ? bindingMap.get(String(p.productionBindingId)) : null;
    const die = binding?.dieId ? dieMap.get(String(binding.dieId)) : null;
    const perRoll = Number(item.perRollQty) || 0;
    const qty = Number(p.quantity) || 0;
    const rolls = perRoll > 0 ? Math.ceil(qty / perRoll) : null;
    const family = binding?.prodPaperFamily || binding?.prodPaperType || item.labelFamily || item.paperType || "";

    return {
      _id: String(p._id),
      lotNo: `LOT-${String(i + 1).padStart(4, "0")}`,
      productId: item.productId || "—",
      labelWidth: item.labelWidth || "—",
      labelHeight: item.labelHeight || "—",
      dieNo: die ? (formatDieLabel(die) || die.dieDieNo || "—") : "—",
      paperSize: binding?.prodPaperSize || "—",
      paperType: family || "—",
      paperCode: binding?.prodPaperCode || "—",
      rolls: rolls != null ? String(rolls) : "—",
      quantity: qty,
      operatorName: p.operatorId?.empName || "—",
      helperName: p.helperId?.empName || "—",
      productionReference: {
        die: die ? (formatDieLabel(die) || die.dieDieNo || "") : "",
        runningMeters: formatRunningMeters(Math.max(qty - (Number(p.dispatchedQuantity) || 0), 0), die),
        paperCode: binding?.prodPaperCode || "",
        paperType: family,
        gsm: binding?.prodPaperGsm || "",
        paperSize: binding?.prodPaperSize || "",
      },
    };
  });
}

// Shows every order currently assigned to a machine (via Assign Production)
// that hasn't been confirmed/dispatched yet — PendingProduction.assignedMachineId
// is only ever set for the short PENDING window before confirm, so this is
// effectively "what's queued on this machine right now."
router.get("/machine/:id/queue", async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) {
    req.flash("notification", "Invalid machine");
    return res.redirect("/fairtech/form/machine");
  }

  const machine = await Machine.findById(req.params.id).populate("location").lean();
  if (!machine) {
    req.flash("notification", "Machine not found");
    return res.redirect("/fairtech/form/machine");
  }

  const rows = await buildQueueRows(machine._id);

  res.render("inventory/masters/machineQueue.ejs", {
    title: `${machine.machineName} Queue`,
    CSS: "tableDisp.css",
    JS: false,
    machine,
    rows,
    notification: req.flash("notification"),
  });
});

// ----------------------------------Job Card---------------------------------->

// "Initiate Production" on the machine queue lands here with ?pendingId=<PendingProduction _id>,
// prefilling lot no / product / die / paper / operator / helper from that queue row so the
// operator only has to fill in materials, job setting and the production log by hand.
router.get("/machine/jobcard/form", async (req, res) => {
  const pendingId = req.query.pendingId;
  let machine = null;
  let prefill = null;

  if (pendingId && mongoose.isValidObjectId(pendingId)) {
    const pendingDoc = await PendingProduction.findById(pendingId).select("assignedMachineId").lean();
    if (pendingDoc?.assignedMachineId) {
      machine = await Machine.findById(pendingDoc.assignedMachineId).lean();
      const rows = await buildQueueRows(pendingDoc.assignedMachineId);
      prefill = rows.find((r) => r._id === String(pendingId)) || null;
    }
  }

  const [previewJobCardId, previewLotNo] = await Promise.all([
    previewId("jobCardId", "JC"),
    Counter.findOne({ key: "lotNo" }).select("seq").lean().then((counter) => {
      const nextSeq = Number(counter?.seq || 0) + 1;
      return `FS | LOT | ${String(nextSeq).padStart(4, "0")}`;
    }),
  ]);

  const [dies, papers] = await Promise.all([
    Die.find({ dieStatus: "ACTIVE" }).select("dieDieNo").sort({ dieDieNo: 1 }).lean(),
    Paper.find({ status: "ACTIVE" }).select("prodCode family").sort({ prodCode: 1 }).lean(),
  ]);

  res.render("inventory/masters/jobCardForm.ejs", {
    title: "Job Card Form",
    CSS: false,
    JS: false,
    pendingId: pendingId && mongoose.isValidObjectId(pendingId) ? String(pendingId) : "",
    machine,
    prefill: prefill ? { ...prefill, lotNo: previewLotNo } : null,
    previewJobCardId,
    dies,
    papers,
    notification: req.flash("notification"),
  });
});

router.post("/machine/jobcard/form", requireAuth, createLimiter, async (req, res) => {
  try {
    const b = req.body;
    const jobCardId = await generateId("jobCardId", "JC");

    // Job Setting rows
    const jsMtrs1 = toArray(b.jsMtrs1);
    const jsStart = toArray(b.jsStart);
    const jsMtrs2 = toArray(b.jsMtrs2);
    const jsStop = toArray(b.jsStop);
    const jobSetting = jsMtrs1
      .map((_, i) => ({
        mtrs1: numOrUndef(jsMtrs1[i]),
        startTime: trim(jsStart[i]),
        mtrs2: numOrUndef(jsMtrs2[i]),
        stopTime: trim(jsStop[i]),
      }))
      .filter((row) => row.mtrs1 != null || row.mtrs2 != null || row.startTime || row.stopTime);

    // Production Log rows
    const deckleId = toArray(b.deckleId);
    const logMeters = toArray(b.logMeters);
    const faceJoint = toArray(b.faceJoint);
    const faceMtr = toArray(b.faceMtr);
    const releaseJoint = toArray(b.releaseJoint);
    const releaseMtr = toArray(b.releaseMtr);
    const startTime = toArray(b.startTime);
    const endTime = toArray(b.endTime);
    const productionLog = deckleId
      .map((_, i) => ({
        deckleId: trim(deckleId[i]),
        meters: numOrUndef(logMeters[i]),
        face: { joint: trim(faceJoint[i]), mtr: numOrUndef(faceMtr[i]) },
        release: { joint: trim(releaseJoint[i]), mtr: numOrUndef(releaseMtr[i]) },
        time: { startTime: trim(startTime[i]), endTime: trim(endTime[i]) },
      }))
      .filter((row) => row.deckleId || row.meters != null || row.face.mtr != null || row.release.mtr != null);

    await JobCard.create({
      jobCardId,
      date: b.date ? new Date(b.date) : new Date(),
      pendingProductionId: mongoose.isValidObjectId(b.pendingId) ? b.pendingId : undefined,
      machineId: mongoose.isValidObjectId(b.machineId) ? b.machineId : undefined,
      machineName: trim(b.machineNo),
      lotNo: trim(b.lotNo),
      productId: trim(b.productId),
      labelWidth: trim(b.labelWidth),
      labelHeight: trim(b.labelHeight),
      dieNo: trim(b.dieNo),
      paperSize: trim(b.paperSize),
      paperType: trim(b.paperType),
      paperCode: trim(b.paperCode),
      rolls: trim(b.rolls),
      quantity: numOrUndef(b.quantity),
      operatorName: trim(b.operatorName),
      helperName: trim(b.helperName),
      faceStock: {
        rollDrumNo: trim(b.fsRollDrumNo),
        code: trim(b.fsCode),
        gsmMic: trim(b.fsGsmMic),
        size: trim(b.fsSize),
      },
      adhesive: {
        rollDrumNo: trim(b.adRollDrumNo),
        code: trim(b.adCode),
        gsmMic: trim(b.adGsmMic),
        size: trim(b.adSize),
      },
      releaseLiner: {
        rollDrumNo: trim(b.rlRollDrumNo),
        code: trim(b.rlCode),
        gsmMic: trim(b.rlGsmMic),
        size: trim(b.rlSize),
      },
      jobSetting,
      productionLog,
      totalMeter: trim(b.totalMeter),
      sqMtr: trim(b.sqMtr),
    });

    req.flash("notification", "Job card created successfully!");
    res.redirect("/fairtech/machine/jobcard/view");
  } catch (err) {
    console.error("JOB CARD CREATE ERROR:", err);
    req.flash("notification", "Failed to create job card");
    res.redirect("back");
  }
});

router.get("/machine/jobcard/view", async (req, res) => {
  const jsonData = await JobCard.find().sort({ createdAt: -1 }).lean();
  res.render("inventory/masters/jobCardView.ejs", {
    title: "Job Card View",
    CSS: "tableDisp.css",
    JS: false,
    jsonData,
    notification: req.flash("notification"),
  });
});

// ----------------------------------Machine API---------------------------------->

// PUT: Update a machine
router.put("/api/machines/:id", requireAuth, updateLimiter, async (req, res) => {
  try {
    const machineName = String(req.body.machineName || "").trim().toUpperCase();
    const locationId = req.body.locationId;
    const machineType = String(req.body.machineType || "").trim();

    if (!machineName || !locationId) {
      return res.status(400).json({ success: false, message: "Machine name and location are required." });
    }
    if (!VALID_MACHINE_TYPES.includes(machineType)) {
      return res.status(400).json({ success: false, message: "Please select a machine type." });
    }

    const locationDoc = await Location.findById(locationId).lean();
    if (!locationDoc) {
      return res.status(400).json({ success: false, message: "Invalid location." });
    }

    const alreadyExists = await Machine.exists({
      machineName,
      location: locationId,
      _id: { $ne: req.params.id },
    });
    if (alreadyExists) {
      return res.status(400).json({ success: false, message: "Machine already exists at this location." });
    }

    const updated = await Machine.findByIdAndUpdate(
      req.params.id,
      { machineName, location: locationId, machineType },
      { new: true, runValidators: true },
    );

    if (!updated) {
      return res.status(404).json({ success: false, message: "Machine not found." });
    }

    res.locals.auditDescription = `Updated machine "${machineName}" (${machineType}) at "${locationDoc.locationName}"`;
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    const msg = err.code === 11000 ? "Machine already exists at this location." : err.message;
    res.status(400).json({ success: false, message: msg });
  }
});

// DELETE: Remove a machine
router.delete("/api/machines/:id", requireAuth, deleteLimiter, async (req, res) => {
  try {
    const existing = await Machine.findById(req.params.id).select("machineName").lean();
    await Machine.findByIdAndDelete(req.params.id);
    res.locals.auditDescription = `Deleted machine "${existing?.machineName || req.params.id}"`;
    res.json({ success: true });
  } catch (err) {
    console.error("DELETE MACHINE ERROR:", err);
    res.status(500).json({ success: false, message: "Failed to delete machine." });
  }
});

export default router;
