import express from "express";
import mongoose from "mongoose";
import Machine from "../../models/system/machine.js";
import Location from "../../models/system/location.js";
import Employee from "../../models/hr/employee_model.js";
import Die from "../../models/utilities/die_model.js";
import Paper from "../../models/inventory/paper.js";
import Block from "../../models/utilities/block_model.js";
import ProductionBinding from "../../models/utilities/productionBinding.js";
import PendingProduction from "../../models/inventory/PendingProduction.js";
import PaperStock from "../../models/inventory/PaperStock.js";
import JobCard from "../../models/inventory/JobCard.js";
import Counter from "../../models/system/counter.js";
import { requireAuth, requireRole } from "../../middleware/auth.js";
import { createLimiter, updateLimiter, deleteLimiter } from "../../utils/limiters.js";
import { normalizeLocationName } from "../../utils/locations.js";

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

// What the die is, without which die it is -- the job card lists the die number
// on its own first, then this.
const formatDieDetails = (die) => [
  die?.dieWidth != null && die?.dieHeight != null ? `${die.dieWidth} x ${die.dieHeight}` : "",
  die?.dieTotalUps != null ? `${die.dieTotalUps}ups` : "",
  die?.dieType || "",
].filter(Boolean).join(" - ");

// The die number leads the label -- it's what identifies the die on the floor;
// the dimensions/ups/type that follow just describe it.
const formatDieLabel = (die) => [
  die?.dieDieNo || "",
  formatDieDetails(die),
].filter(Boolean).join(" - ");

// What the die is, minus which die it is: the machine queue carries the die no
// in its own column, and has separate Width/Height columns already, so its Die
// column is left with just the ups/type description.
const formatDieSpec = (die) => [
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

// Mirrors the "No. of Rolls" calc on the Assign Production form (GET
// /labels/production/assign/:id) exactly, so the machine queue's "required"
// figure and the number an operator sees/allots there never disagree:
// repeat length x = (Label Height + Label Gap, mm) / 1000 (metres per repeat
// down the web); a standard roll holds 1000m of running length, so
// capacity-per-roll = (1000 / x) x Across Ups labels. Required rolls =
// remaining order balance / capacity-per-roll, rounded up.
const STANDARD_ROLL_METERS = 1000;
const computeRequiredRolls = (balanceQty, item, die) => {
  const across = Number(die?.dieFlatAcross);
  const repeatLengthM = ((Number(item?.labelHeight) || 0) + (Number(item?.labelGap) || 0)) / 1000;
  if (!balanceQty || !across || !repeatLengthM) return null;
  const capacityPerRoll = (STANDARD_ROLL_METERS / repeatLengthM) * across;
  return Math.ceil(balanceQty / capacityPerRoll);
};

// Normalize repeated form fields into an array (single value -> [value]).
const toArray = (value) => {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
};

// ----------------------------------Machine Master---------------------------------->

// This router is mounted on the bare "/fairtech" prefix with no role gate (see
// server.js for why), so every route below carries its own. The machine master
// -- adding, editing and deleting machines -- stays with management; the queue
// and job card pages additionally admit shopfloor operators.
const requireMachineMaster = requireRole(["proprietor", "admin", "hod"]);
const requireMachineFloor = requireRole(["proprietor", "admin", "hod", "operator"]);

router.get("/form/machine", requireMachineMaster, async (req, res) => {
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

router.post("/form/machine", requireAuth, requireMachineMaster, createLimiter, async (req, res) => {
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

// ----------------------------------Machine Production Queue---------------------------------->
// Overview of every machine with a pending-order count, linking through to
// each machine's own queue detail page below.
router.get("/machine/queue", requireMachineFloor, async (req, res) => {
  const machines = await Machine.find().populate("location").sort({ machineName: 1 }).lean();

  const counts = await PendingProduction.aggregate([
    { $match: { assignedMachineId: { $ne: null } } },
    { $group: { _id: "$assignedMachineId", count: { $sum: 1 } } },
  ]);
  const countMap = new Map(counts.map((c) => [String(c._id), c.count]));

  // Operator <-> Machine link is by profile code, matching the auto-select on
  // the Assign Production form: an employee's empProfileCode is set to the
  // machine's name they operate. Keyed by code + location too, since the same
  // machine name/code can exist at more than one location (Machine's
  // uniqueness is per machineName+location) and an operator only runs the
  // machine at their own location.
  const operators = await Employee.find(
    { isActive: true, empProfile: "OPERATOR", empProfileCode: { $exists: true, $ne: "" } },
    "empName empProfileCode empLoc",
  ).lean();
  const operatorByProfileCodeAndLocation = new Map(
    operators.map((emp) => [
      `${String(emp.empProfileCode).trim().toUpperCase()}||${normalizeLocationName(emp.empLoc)}`,
      emp.empName,
    ]),
  );

  const rows = machines.map((m) => {
    const key = `${String(m.machineName).trim().toUpperCase()}||${normalizeLocationName(m.location?.locationName)}`;
    return {
      _id: String(m._id),
      machineName: m.machineName,
      machineType: m.machineType || "—",
      locationName: m.location?.locationName || "—",
      operatorName: operatorByProfileCodeAndLocation.get(key) || "—",
      pendingCount: countMap.get(String(m._id)) || 0,
    };
  });

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
    .populate({ path: "itemId", select: "productId labelWidth labelHeight labelGap perRollQty paperType labelFamily jobType jobName" })
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

  // The exact rolls ticked on the Assign Production form, so the job card can
  // name the physical rolls rather than just a count. Fetched in one query for
  // every row on the queue and re-ordered per row to match how they were
  // listed there (shortest running mtrs first).
  const rollIds = pending.flatMap((p) => (Array.isArray(p.allottedRollIds) ? p.allottedRollIds : []));
  const rollDocs = rollIds.length
    ? await PaperStock.find({ _id: { $in: rollIds } }).select("rollNo paperMtrs paperSize location").lean()
    : [];
  const rollMap = new Map(rollDocs.map((r) => [String(r._id), r]));

  return pending.map((p) => {
    const item = p.itemId || {};
    const binding = p.productionBindingId ? bindingMap.get(String(p.productionBindingId)) : null;
    const die = binding?.dieId ? dieMap.get(String(binding.dieId)) : null;
    const qty = Number(p.quantity) || 0;
    const balanceQty = Math.max(qty - (Number(p.dispatchedQuantity) || 0), 0);
    const rolls = computeRequiredRolls(balanceQty, item, die);
    const family = binding?.prodPaperFamily || binding?.prodPaperType || item.labelFamily || item.paperType || "";
    const allottedRolls = p.allottedRolls != null ? p.allottedRolls : null;
    const balanceRolls =
      rolls == null ? null : allottedRolls == null ? rolls : Math.max(rolls - allottedRolls, 0);
    const rollsStatus =
      allottedRolls == null || rolls == null
        ? null
        : allottedRolls === rolls
        ? "match"
        : allottedRolls < rolls
        ? "short"
        : "over";

    const allottedRollDetails = (Array.isArray(p.allottedRollIds) ? p.allottedRollIds : [])
      .map((rid) => rollMap.get(String(rid)))
      .filter(Boolean)
      .map((r) => ({
        rollNo: r.rollNo || "",
        paperMtrs: Number(r.paperMtrs) || 0,
        paperSize: r.paperSize != null ? r.paperSize : "",
        location: r.location || "",
      }))
      .sort((a, b) => a.paperMtrs - b.paperMtrs || String(a.rollNo).localeCompare(String(b.rollNo)));

    return {
      _id: String(p._id),
      // Claimed off the lotNo counter when the order was assigned, so it's the
      // order's own number -- not its position in this queue, which shifts as
      // jobs come and go.
      lotNo: p.lotNo || "—",
      productId: item.productId || "—",
      labelWidth: item.labelWidth || "—",
      labelHeight: item.labelHeight || "—",
      dieNo: die?.dieDieNo || "—",
      dieSpec: die ? (formatDieSpec(die) || "—") : "—",
      paperSize: binding?.prodPaperSize || "—",
      paperType: family || "—",
      paperCode: binding?.prodPaperCode || "—",
      rolls: rolls != null ? String(rolls) : "—",
      allottedRolls: allottedRolls != null ? String(allottedRolls) : "—",
      balanceRolls: balanceRolls != null ? String(balanceRolls) : "—",
      rollsStatus,
      quantity: qty,
      operatorName: p.operatorId?.empName || "—",
      helperName: p.helperId?.empName || "—",
      allottedRollDetails,
      productionReference: {
        die: die ? (formatDieLabel(die) || die.dieDieNo || "") : "",
        dieNo: die?.dieDieNo || "",
        dieDetails: die ? formatDieDetails(die) : "",
        runningMeters: formatRunningMeters(balanceQty, die),
        vendorName: binding?.prodVendorName || "",
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
router.get("/machine/:id/queue", requireMachineFloor, async (req, res) => {
  // Operators can't open the machine master, so bounce them to the queue
  // overview instead when the machine in the URL doesn't resolve.
  const fallbackUrl =
    req.session?.authUser?.role === "operator" ? "/fairtech/machine/queue" : "/fairtech/form/machine";

  if (!mongoose.isValidObjectId(req.params.id)) {
    req.flash("notification", "Invalid machine");
    return res.redirect(fallbackUrl);
  }

  const machine = await Machine.findById(req.params.id).populate("location").lean();
  if (!machine) {
    req.flash("notification", "Machine not found");
    return res.redirect(fallbackUrl);
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
router.get("/machine/jobcard/form", requireMachineFloor, async (req, res) => {
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

  const previewJobCardId = await previewId("jobCardId", "JC");

  const [dies, papers] = await Promise.all([
    Die.find({ dieStatus: "ACTIVE" }).select("dieDieNo").sort({ dieDieNo: 1 }).lean(),
    Paper.find({ status: "ACTIVE" }).select("prodCode family").sort({ prodCode: 1 }).lean(),
  ]);

  res.render("inventory/masters/jobCardForm.ejs", {
    title: "Production Entry",
    CSS: false,
    JS: false,
    pendingId: pendingId && mongoose.isValidObjectId(pendingId) ? String(pendingId) : "",
    machine,
    // Lot no comes straight off the order (buildQueueRows reads it from
    // PendingProduction) -- it was claimed when the order was assigned, so
    // previewing the counter here would show a different, unclaimed number.
    prefill,
    previewJobCardId,
    dies,
    papers,
    notification: req.flash("notification"),
  });
});

router.post("/machine/jobcard/form", requireAuth, requireMachineFloor, createLimiter, async (req, res) => {
  try {
    const b = req.body;
    const jobCardId = await generateId("jobCardId", "JC");

    // Job Setting rows
    const jsRollId = toArray(b.jsRollId);
    const jsMtrs1 = toArray(b.jsMtrs1);
    const jsStart = toArray(b.jsStart);
    const jsMtrs2 = toArray(b.jsMtrs2);
    const jsStop = toArray(b.jsStop);
    const jobSetting = jsMtrs1
      .map((_, i) => ({
        rollId: trim(jsRollId[i]),
        mtrs1: numOrUndef(jsMtrs1[i]),
        startTime: trim(jsStart[i]),
        mtrs2: numOrUndef(jsMtrs2[i]),
        stopTime: trim(jsStop[i]),
      }))
      .filter((row) => row.rollId || row.mtrs1 != null || row.mtrs2 != null || row.startTime || row.stopTime);

    // Production Log rows — same shape as Job Setting above
    const rollId = toArray(b.rollId);
    const logMtrs1 = toArray(b.logMtrs1);
    const logStart = toArray(b.logStart);
    const logMtrs2 = toArray(b.logMtrs2);
    const logStop = toArray(b.logStop);
    const productionLog = rollId
      .map((_, i) => ({
        rollId: trim(rollId[i]),
        mtrs1: numOrUndef(logMtrs1[i]),
        startTime: trim(logStart[i]),
        mtrs2: numOrUndef(logMtrs2[i]),
        stopTime: trim(logStop[i]),
      }))
      .filter((row) => row.rollId || row.mtrs1 != null || row.mtrs2 != null || row.startTime || row.stopTime);

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

    req.flash("notification", "Production entry saved successfully!");
    // ?saved=<pendingId> tells the view page to drop the form's local draft
    // (see the autosave block in jobCardForm.ejs). Only a save that actually
    // reached here can produce this redirect, so a POST lost to a dead network
    // or an expired session leaves the draft where it is.
    const savedFor = mongoose.isValidObjectId(b.pendingId) ? String(b.pendingId) : "new";
    res.redirect(`/fairtech/machine/jobcard/view?saved=${encodeURIComponent(savedFor)}`);
  } catch (err) {
    console.error("JOB CARD CREATE ERROR:", err);
    req.flash("notification", "Failed to save production entry");
    res.redirect("back");
  }
});

router.get("/machine/jobcard/view", requireMachineFloor, async (req, res) => {
  const jsonData = await JobCard.find().sort({ createdAt: -1 }).lean();
  res.render("inventory/masters/jobCardView.ejs", {
    title: "Production Records",
    CSS: "tableDisp.css",
    JS: false,
    jsonData,
    notification: req.flash("notification"),
  });
});

// ----------------------------------Machine API---------------------------------->

// PUT: Update a machine
router.put("/api/machines/:id", requireAuth, requireMachineMaster, updateLimiter, async (req, res) => {
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
router.delete("/api/machines/:id", requireAuth, requireMachineMaster, deleteLimiter, async (req, res) => {
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
