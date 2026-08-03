import express from "express";
import mongoose from "mongoose";
import { randomUUID } from "crypto";
import Machine from "../../models/system/machine.js";
import Location from "../../models/system/location.js";
import Employee from "../../models/hr/employee_model.js";
import Die from "../../models/utilities/die_model.js";
import Paper from "../../models/inventory/paper.js";
import Block from "../../models/utilities/block_model.js";
import ProductionBinding from "../../models/utilities/productionBinding.js";
import PendingProduction from "../../models/inventory/PendingProduction.js";
import PaperStock from "../../models/inventory/PaperStock.js";
import PaperStockLog from "../../models/inventory/PaperStockLog.js";
import JobCard from "../../models/inventory/JobCard.js";
import MaintenanceRequest from "../../models/system/maintenanceRequest.js";
import Counter from "../../models/system/counter.js";
import { requireAuth, requireRole } from "../../middleware/auth.js";
import { createLimiter, updateLimiter, deleteLimiter } from "../../utils/limiters.js";
import { normalizeLocationName } from "../../utils/locations.js";
import { normalizeRollId, extractScannedRollId } from "../../utils/rollId.js";

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

const STANDARD_ROLL_METERS = 1000;

// Running metres this job needs -- the same "Running Mtrs" figure shown on the
// Assign Production page. Repeat length x = (Label Height + Label Gap, mm) /
// 1000 (metres per repeat down the web); a standard 1000 m roll holds
// (1000 / x) x Across Ups labels, so rolls = balanceQty / that capacity and the
// running length is rolls x 1000, rounded. Driven by the label's height+gap and
// the die's Across ups -- NOT the die repeat gap. STANDARD_ROLL_METERS is only
// a unit of measure here (metres per nominal roll for this arithmetic) -- it
// has nothing to do with how long any physical reel actually is, which is why
// this must never be compared against a roll *count* (see rollsStatus below).
const computeRequiredMeters = (balanceQty, item, die) => {
  const qty = Number(balanceQty) || 0;
  const across = Number(die?.dieFlatAcross);
  const repeatLengthM = ((Number(item?.labelHeight) || 0) + (Number(item?.labelGap) || 0)) / 1000;
  if (!qty || !across || !repeatLengthM) return null;
  const capacityPerRoll = (STANDARD_ROLL_METERS / repeatLengthM) * across;
  return Math.round((qty / capacityPerRoll) * STANDARD_ROLL_METERS);
};
const formatRunningMeters = (balanceQty, item, die) => {
  const meters = computeRequiredMeters(balanceQty, item, die);
  return meters == null ? "" : `${meters.toLocaleString("en-IN")} m`;
};

// Mirrors the "No. of Rolls" calc on the Assign Production form (GET
// /labels/production/assign/:id) exactly, so the machine queue's "required"
// figure and the number an operator sees/allots there never disagree:
// repeat length x = (Label Height + Label Gap, mm) / 1000 (metres per repeat
// down the web); a standard roll holds 1000m of running length, so
// capacity-per-roll = (1000 / x) x Across Ups labels. Required rolls =
// remaining order balance / capacity-per-roll, rounded up.
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

  // Every queued job across every machine in one pass. The card view lists them
  // in place of the bare count, and the count is just their length -- so the
  // number on the table view can't disagree with the jobs on the card.
  // producedAt: null keeps finished jobs off the queue (matches unset too).
  const queuedJobs = await buildQueueRows({ assignedMachineId: { $ne: null }, producedAt: null });
  const jobsByMachine = new Map();
  queuedJobs.forEach((job) => {
    if (!job.machineId) return;
    if (!jobsByMachine.has(job.machineId)) jobsByMachine.set(job.machineId, []);
    // Only what the card line shows: size, label qty, roll qty, roll ids and
    // client. Roll qty is what the job needs (computed from the balance
    // quantity and the die), not what's been ticked -- most jobs have nothing
    // ticked yet, so the ticked count would read "0 rolls" almost everywhere.
    // The ids in brackets are the rolls actually allotted, when there are any.
    jobsByMachine.get(job.machineId).push({
      _id: job._id,
      labelWidth: job.labelWidth,
      labelHeight: job.labelHeight,
      quantity: job.quantity,
      rolls: job.rolls,
      rollIds: job.allottedRollDetails.map((r) => r.rollId).filter(Boolean),
      clientName: job.clientName,
    });
  });

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
    const jobs = jobsByMachine.get(String(m._id)) || [];
    return {
      _id: String(m._id),
      machineName: m.machineName,
      machineType: m.machineType || "—",
      locationName: m.location?.locationName || "—",
      operatorName: operatorByProfileCodeAndLocation.get(key) || "—",
      pendingCount: jobs.length,
      jobs,
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

// ----------------------------------Operator Work Queue---------------------------------->
// An operator's personal worklist: every order assigned to *them* (by
// PendingProduction.operatorId, set at Assign Production), grouped under the
// machine each job sits on. This is where operators land straight after login,
// so it reads their own empObjId off the session rather than a URL param.
router.get("/operator/queue", requireRole(["operator"]), async (req, res) => {
  const authUser = req.session?.authUser;
  const operatorObjId = authUser?.empObjId;

  // Only orders that are both assigned to a machine and to this operator show
  // up -- operatorId is only ever set alongside assignedMachineId, but we ask
  // for both so a job can always be placed under a machine.
  const rows =
    operatorObjId && mongoose.isValidObjectId(operatorObjId)
      ? await buildQueueRows({ operatorId: operatorObjId, assignedMachineId: { $ne: null }, producedAt: null })
      : [];

  // Resolve the machines these jobs sit on so each group carries a name / type /
  // location, then group the rows (buildQueueRows already sorted them by
  // assignedAt, so each group stays in queue order).
  const machineIds = [...new Set(rows.map((r) => r.machineId).filter(Boolean))];
  const machines = machineIds.length
    ? await Machine.find({ _id: { $in: machineIds } }).populate("location").lean()
    : [];
  const machineMap = new Map(machines.map((m) => [String(m._id), m]));

  const groupsMap = new Map();
  rows.forEach((row) => {
    if (!groupsMap.has(row.machineId)) groupsMap.set(row.machineId, []);
    groupsMap.get(row.machineId).push(row);
  });

  const groups = [...groupsMap.entries()]
    .map(([machineId, jobs]) => {
      const m = machineMap.get(machineId);
      return {
        machineId,
        machineName: m?.machineName || "—",
        machineType: m?.machineType || "—",
        locationName: m?.location?.locationName || "—",
        jobs,
      };
    })
    .sort((a, b) => String(a.machineName).localeCompare(String(b.machineName)));

  // Badge on the Maintenance tab: the operator's own tickets still being worked
  // on, so a raised problem stays visible from the queue page too.
  const openMaintenanceCount =
    operatorObjId && mongoose.isValidObjectId(operatorObjId)
      ? await MaintenanceRequest.countDocuments({
          raisedById: operatorObjId,
          status: { $in: ["OPEN", "IN PROGRESS"] },
        })
      : 0;

  res.render("inventory/masters/operatorQueue.ejs", {
    title: "Work Queue",
    CSS: "tableDisp.css",
    JS: false,
    operatorName: authUser?.empName || "",
    operatorLocation: authUser?.empLoc || "",
    groups,
    totalJobs: rows.length,
    openMaintenanceCount,
    notification: req.flash("notification"),
  });
});

// Shared by the per-machine queue page, the queue overview's card view and the
// job card form's prefill lookup (all need the same PendingProduction ->
// ProductionBinding -> Die join). Takes a match filter rather than a single id
// so the overview can build every machine's jobs in one pass instead of one
// round of queries per machine.
async function buildQueueRows(match) {
  const pending = await PendingProduction.find(match)
    .populate({ path: "itemId", select: "productId labelWidth labelHeight labelGap perRollQty paperType labelFamily jobType jobName" })
    .populate({ path: "operatorId", select: "empName" })
    .populate({ path: "helperId", select: "empName" })
    .populate({ path: "userId", select: "clientName userName" })
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
    ? await PaperStock.find({ _id: { $in: rollIds } }).select("rollId paperMtrs paperSize location").lean()
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

    const allottedRollDetails = (Array.isArray(p.allottedRollIds) ? p.allottedRollIds : [])
      .map((rid) => rollMap.get(String(rid)))
      .filter(Boolean)
      .map((r) => ({
        rollId: r.rollId || "",
        paperMtrs: Number(r.paperMtrs) || 0,
        paperSize: r.paperSize != null ? r.paperSize : "",
        location: r.location || "",
      }))
      .sort((a, b) => a.paperMtrs - b.paperMtrs || String(a.rollId).localeCompare(String(b.rollId)));

    // Fully/Short/Over allotted compares actual running metres, not roll
    // counts -- computeRequiredRolls assumes every roll is exactly
    // STANDARD_ROLL_METERS long, so a real reel that's longer or shorter than
    // that (almost all of them) made "allottedRolls === rolls" a false signal:
    // a single oversized reel that already covers the job read as "short"
    // just because it counts as "1 roll" against a nominal "2 rolls" figure.
    // "over" now means at least one allotted roll is provably redundant --
    // pulling out the smallest of them would still cover the requirement --
    // so it's a genuine "you can free a roll back to stock" signal rather
    // than just "you ticked more boxes than the nominal count".
    const requiredMeters = computeRequiredMeters(balanceQty, item, die);
    const allottedMeters = allottedRollDetails.reduce((sum, r) => sum + r.paperMtrs, 0);
    let rollsStatus = null;
    if (requiredMeters != null && allottedRollDetails.length > 0) {
      if (allottedMeters < requiredMeters) {
        rollsStatus = "short";
      } else {
        const withoutSmallest = allottedMeters - allottedRollDetails[0].paperMtrs;
        rollsStatus = withoutSmallest >= requiredMeters ? "over" : "match";
      }
    }
    const balanceMeters = requiredMeters == null ? null : Math.max(requiredMeters - allottedMeters, 0);

    return {
      _id: String(p._id),
      machineId: String(p.assignedMachineId || ""),
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
      // Running-metres figures behind rollsStatus above -- surfaced so the
      // roll details dialog can show *why* a job reads as fully/short
      // allotted even when the roll count looks off against Required Rolls.
      requiredRunningMtrs: requiredMeters != null ? `${requiredMeters.toLocaleString("en-IN")} m` : "—",
      allottedRunningMtrs: allottedRollDetails.length ? `${allottedMeters.toLocaleString("en-IN")} m` : "—",
      balanceRunningMtrs: balanceMeters != null ? `${balanceMeters.toLocaleString("en-IN")} m` : "—",
      quantity: qty,
      // Order qty less what's already dispatched -- the figure the Assign
      // Production page budgets rolls/running metres against (same balanceQty
      // used for runningMeters below).
      balanceQuantity: balanceQty,
      clientName: p.userId?.clientName || p.userId?.userName || "—",
      operatorName: p.operatorId?.empName || "—",
      helperName: p.helperId?.empName || "—",
      allottedRollDetails,
      productionReference: {
        die: die ? (formatDieLabel(die) || die.dieDieNo || "") : "",
        dieNo: die?.dieDieNo || "",
        dieDetails: die ? formatDieDetails(die) : "",
        runningMeters: formatRunningMeters(balanceQty, item, die),
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

  const rows = await buildQueueRows({ assignedMachineId: machine._id, producedAt: null });

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
      const rows = await buildQueueRows({ assignedMachineId: pendingDoc.assignedMachineId });
      prefill = rows.find((r) => r._id === String(pendingId)) || null;
    }
  }

  // No physical reels ticked on Assign Production yet, or what's ticked
  // doesn't cover the job's required running metres (rollsStatus "short") --
  // either way, starting the job card would let the operator scan against
  // paper that isn't really there, so send them back to the queue instead of
  // opening the form.
  if (prefill && (!prefill.allottedRollDetails?.length || prefill.rollsStatus === "short")) {
    req.flash(
      "notification",
      prefill.allottedRollDetails?.length
        ? "This order's allotted rolls fall short of the required running metres -- assign more paper before starting production."
        : "Assign paper rolls to this order before starting production.",
    );
    return res.redirect(
      prefill.machineId ? `/fairtech/machine/${prefill.machineId}/queue` : "/fairtech/machine/queue"
    );
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
    // One-shot token so a double-submit of this page can't save (or deduct) twice.
    submissionToken: randomUUID(),
    notification: req.flash("notification"),
  });
});

// Metres a single production-log row consumed: the counter runs up during a
// job, so it's the stop reading minus the start reading (mirrors recalcLogTotals
// in jobCardForm.ejs). A half-filled or backwards row isn't a length.
const consumedMeters = (row) => {
  const from = Number(row?.mtrs1);
  const to = Number(row?.mtrs2);
  return Number.isFinite(from) && Number.isFinite(to) && to > from ? to - from : 0;
};

const round2 = (n) => Math.round(Number(n) * 100) / 100;

// Draw the running metres recorded on a job card off the paper reels allotted
// to that job. Both the Job Setting rows (setup wastage) and the Production Log
// rows count -- each names a Roll ID and a start/stop reading, and the length it
// consumed is stop - start. The Roll ID is what the operator scanned off the QR
// label pasted on the reel (utils/rollId.js), so it names exactly one of the
// job's allotted reels (PendingProduction.allottedRollIds -> PaperStock.rollId)
// and that length comes off its paperMtrs. A reel taken to 0 metres (or below)
// is emptied -- paperMtrs clamped to 0 and quantity set to 0 -- so it also
// leaves the roll-count balance.
//
// Every deduction writes an OUTWARD PaperStockLog line, the mirror of the
// INWARD one the Paper Stock page writes: without it the ledger would show
// paper arriving and never being used. `quantity` on that line is rolls, so it
// is 1 only when the reel was emptied -- a part-used reel is still a roll on
// the floor -- and the metres drawn are carried in paperMtrs.
//
// Returns { deducted, emptied, meters, unmatched } so the caller can tell the
// operator when a Roll ID didn't match any allotted reel.
async function consumeAllottedRollMeters({ pendingProductionId, logRows, jobCardId, createdBy }) {
  const result = { deducted: 0, emptied: 0, meters: 0, unmatched: [] };
  if (!pendingProductionId || !Array.isArray(logRows) || logRows.length === 0) return result;

  const pending = await PendingProduction.findById(pendingProductionId).select("allottedRollIds").lean();
  const rollIds = Array.isArray(pending?.allottedRollIds) ? pending.allottedRollIds : [];

  const reels = rollIds.length
    ? await PaperStock.find({ _id: { $in: rollIds } })
        .select("rollId paper location paperSize paperMtrs quantity rate")
        .lean()
    : [];
  const reelByRollId = new Map();
  reels.forEach((reel) => {
    const key = normalizeRollId(reel.rollId);
    if (key && !reelByRollId.has(key)) reelByRollId.set(key, reel);
  });

  // Sum the metres consumed per reel first, so a reel named on more than one row
  // (across job setting and the production log) is written back once.
  const usedByReelId = new Map();
  for (const row of logRows) {
    const used = consumedMeters(row);
    if (used <= 0) continue;
    // row.rollId is whatever the operator's box held on save -- normally
    // already cleaned to a bare Roll ID client-side (see jobCardForm.ejs),
    // but the QR itself carries more than that ("rollId vendorRollId
    // paperSize paperMtrs" -- utils/rollLabelPrn.js), so this is robust to
    // the full scanned string arriving here too.
    const key = extractScannedRollId(row.rollId);
    const reel = key ? reelByRollId.get(key) : null;
    if (!reel) {
      if (key) result.unmatched.push(trim(row.rollId));
      continue;
    }
    usedByReelId.set(String(reel._id), (usedByReelId.get(String(reel._id)) || 0) + used);
  }
  if (!usedByReelId.size) return result;

  const reelById = new Map(reels.map((r) => [String(r._id), r]));

  // Roll balance per paper+location as it stood before this job card, so each
  // OUTWARD line carries an opening/closing the way the inward ones do. Read
  // once per location and then carried forward in step with the writes below --
  // two reels of the same paper emptied on one card must not both claim the
  // same opening figure.
  const balanceKey = (reel) => `${String(reel.paper)}||${reel.location}`;
  const balances = new Map();
  for (const reelId of usedByReelId.keys()) {
    const reel = reelById.get(reelId);
    const key = balanceKey(reel);
    if (balances.has(key)) continue;
    const bal = await PaperStock.aggregate([
      { $match: { paper: new mongoose.Types.ObjectId(String(reel.paper)), location: reel.location } },
      { $group: { _id: null, qty: { $sum: "$quantity" } } },
    ]);
    balances.set(key, bal[0]?.qty || 0);
  }

  for (const [reelId, used] of usedByReelId) {
    const reel = reelById.get(reelId);
    const remaining = round2((Number(reel.paperMtrs) || 0) - used);
    const emptied = remaining <= 0;

    await PaperStock.updateOne(
      { _id: reelId },
      emptied ? { $set: { paperMtrs: 0, quantity: 0 } } : { $set: { paperMtrs: remaining } },
    );

    const key = balanceKey(reel);
    const openingStock = balances.get(key) ?? 0;
    const rollsOut = emptied ? Number(reel.quantity) || 0 : 0;
    const closingStock = openingStock - rollsOut;
    balances.set(key, closingStock);

    await PaperStockLog.create({
      paper: reel.paper,
      location: reel.location,
      openingStock,
      quantity: rollsOut,
      paperSize: reel.paperSize,
      paperMtrs: round2(used),
      rate: reel.rate,
      rollId: reel.rollId,
      closingStock,
      type: "OUTWARD",
      source: "SYSTEM",
      remarks: `${jobCardId ? `${jobCardId}: ` : ""}${round2(used)} mtrs consumed${emptied ? " — reel emptied" : ""}`,
      createdBy: createdBy || "SYSTEM",
    });

    result.deducted += 1;
    result.meters = round2(result.meters + used);
    if (emptied) result.emptied += 1;
  }
  return result;
}

router.post("/machine/jobcard/form", requireAuth, requireMachineFloor, createLimiter, async (req, res) => {
  try {
    const b = req.body;

    // Idempotency: a resubmit of the same loaded page carries the same token.
    // If one already saved, don't create a second entry or deduct stock again --
    // just send them on to the records, as if the first save is what they see.
    const submissionToken = trim(b.submissionToken);
    if (submissionToken) {
      const already = await JobCard.findOne({ submissionToken }).select("_id").lean();
      if (already) {
        const savedFor = mongoose.isValidObjectId(b.pendingId) ? String(b.pendingId) : "new";
        return res.redirect(`/fairtech/machine/jobcard/view?saved=${encodeURIComponent(savedFor)}`);
      }
    }

    // Mirror the GET guard -- a direct POST (bypassing the form) still can't
    // start a job with no reels set aside for it, or with rolls that fall
    // short of the required running metres (rollsStatus "short").
    if (mongoose.isValidObjectId(b.pendingId)) {
      const [row] = await buildQueueRows({ _id: new mongoose.Types.ObjectId(String(b.pendingId)) });
      if (!row || !row.allottedRollDetails?.length || row.rollsStatus === "short") {
        req.flash(
          "notification",
          row?.allottedRollDetails?.length
            ? "This order's allotted rolls fall short of the required running metres -- assign more paper before starting production."
            : "Assign paper rolls to this order before starting production.",
        );
        return res.redirect(
          mongoose.isValidObjectId(b.machineId) ? `/fairtech/machine/${b.machineId}/queue` : "/fairtech/machine/queue"
        );
      }
    }

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

    // Server-side guard (mirrors validateReelMeters in jobCardForm.ejs): a reel
    // can't be asked to give up more running metres than it holds. Sum stop-start
    // per allotted reel across both Job Setting and Production Log rows and reject
    // the save if any reel is over-drawn -- a stale or bypassed client must not be
    // able to run a reel below zero. Done before JobCard.create so nothing is
    // written and no stock is touched when it fails.
    if (mongoose.isValidObjectId(b.pendingId)) {
      const pending = await PendingProduction.findById(b.pendingId).select("allottedRollIds").lean();
      const rollIds = Array.isArray(pending?.allottedRollIds) ? pending.allottedRollIds : [];
      const reels = rollIds.length
        ? await PaperStock.find({ _id: { $in: rollIds } }).select("rollId paperMtrs").lean()
        : [];
      const availByRollId = new Map();
      reels.forEach((reel) => {
        const key = normalizeRollId(reel.rollId);
        if (key && !availByRollId.has(key)) availByRollId.set(key, Number(reel.paperMtrs) || 0);
      });

      const usedByRollId = new Map();
      for (const row of [...jobSetting, ...productionLog]) {
        const used = consumedMeters(row);
        if (used <= 0) continue;
        const key = extractScannedRollId(row.rollId);
        if (!key || !availByRollId.has(key)) continue; // unmatched rolls deduct nothing
        usedByRollId.set(key, (usedByRollId.get(key) || 0) + used);
      }

      const over = [...usedByRollId.entries()].find(([key, used]) => used > (availByRollId.get(key) || 0) + 1e-9);
      if (over) {
        const [key, used] = over;
        req.flash(
          "notification",
          `Not available running mtrs — save failed: Roll ID ${key} has only ${round2(availByRollId.get(key) || 0)} mtrs left but ${round2(used)} mtrs were entered.`,
        );
        return res.redirect(`/fairtech/machine/jobcard/form?pendingId=${encodeURIComponent(String(b.pendingId))}`);
      }
    }

    await JobCard.create({
      jobCardId,
      submissionToken: submissionToken || undefined,
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

    // Deduct the production log's running metres from the reels this job was
    // allotted. Isolated from the create above: the job card is already saved,
    // so a hiccup here must not read back as a failed save -- it's logged and
    // surfaced as a note instead.
    let consumption = { deducted: 0, emptied: 0, meters: 0, unmatched: [] };
    try {
      consumption = await consumeAllottedRollMeters({
        pendingProductionId: mongoose.isValidObjectId(b.pendingId) ? b.pendingId : null,
        // Both setup wastage (job setting) and production draw off the reels.
        logRows: [...jobSetting, ...productionLog],
        jobCardId,
        createdBy: req.user?.username || req.session?.authUser?.empName || "SYSTEM",
      });
    } catch (stockErr) {
      console.error("JOB CARD STOCK DEDUCTION ERROR:", stockErr);
    }

    // The job is done: take it off the machine and operator queues by stamping
    // the pending order as produced. The order itself stays for confirm/dispatch.
    if (mongoose.isValidObjectId(b.pendingId)) {
      try {
        await PendingProduction.updateOne(
          { _id: b.pendingId },
          { $set: { producedAt: new Date() } },
        );
      } catch (prodErr) {
        console.error("JOB CARD MARK-PRODUCED ERROR:", prodErr);
      }
    }

    let message = "Production entry saved successfully!";
    if (consumption.deducted) {
      message +=
        ` Stock: ${consumption.meters} mtrs off ${consumption.deducted} reel${consumption.deducted === 1 ? "" : "s"}` +
        `${consumption.emptied ? ` (${consumption.emptied} emptied)` : ""}.`;
    }
    if (consumption.unmatched.length) {
      const uniq = [...new Set(consumption.unmatched)];
      // Wording avoids the toast's error keywords (failed / not found / error) --
      // the entry did save; this is only a stock note.
      message += ` Note: stock not deducted for roll${uniq.length === 1 ? "" : "s"} ${uniq.join(", ")} (not among this job's allotted reels).`;
    }
    req.flash("notification", message);
    // ?saved=<pendingId> tells the view page to drop the form's local draft
    // (see the autosave block in jobCardForm.ejs). Only a save that actually
    // reached here can produce this redirect, so a POST lost to a dead network
    // or an expired session leaves the draft where it is.
    const savedFor = mongoose.isValidObjectId(b.pendingId) ? String(b.pendingId) : "new";
    res.redirect(`/fairtech/machine/jobcard/view?saved=${encodeURIComponent(savedFor)}`);
  } catch (err) {
    // Two submits of the same page racing past the pre-check both reach create;
    // the loser trips the unique submissionToken index. That's a duplicate, not
    // a failure -- the winner already saved and deducted, so just show records.
    if (err?.code === 11000 && err?.keyPattern?.submissionToken) {
      const savedFor = mongoose.isValidObjectId(req.body.pendingId) ? String(req.body.pendingId) : "new";
      return res.redirect(`/fairtech/machine/jobcard/view?saved=${encodeURIComponent(savedFor)}`);
    }
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
