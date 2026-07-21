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
import { requireAuth } from "../../middleware/auth.js";
import { createLimiter, updateLimiter, deleteLimiter } from "../../utils/limiters.js";

const router = express.Router();

const formatDieLabel = (die) => [
  die?.dieWidth != null && die?.dieHeight != null ? `${die.dieWidth} x ${die.dieHeight}` : "",
  die?.dieTotalUps != null ? `${die.dieTotalUps}ups` : "",
  die?.dieType || "",
].filter(Boolean).join(" - ");

// Same as formatDieLabel but without the "W x H" segment -- for the machine
// queue's Die column, which already has its own separate Width/Height columns.
const formatDieLabelNoDims = (die) => [
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

  // Operator <-> Machine link is by profile code, matching the auto-select on
  // the Assign Production form: an employee's empProfileCode is set to the
  // machine's name they operate.
  const operators = await Employee.find(
    { isActive: true, empProfile: "OPERATOR", empProfileCode: { $exists: true, $ne: "" } },
    "empName empProfileCode",
  ).lean();
  const operatorByProfileCode = new Map(
    operators.map((emp) => [String(emp.empProfileCode).trim().toUpperCase(), emp.empName]),
  );

  const rows = machines.map((m) => ({
    _id: String(m._id),
    machineName: m.machineName,
    machineType: m.machineType || "—",
    locationName: m.location?.locationName || "—",
    operatorName: operatorByProfileCode.get(String(m.machineName).trim().toUpperCase()) || "—",
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

  return pending.map((p, i) => {
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

    return {
      _id: String(p._id),
      lotNo: `LOT-${String(i + 1).padStart(4, "0")}`,
      productId: item.productId || "—",
      labelWidth: item.labelWidth || "—",
      labelHeight: item.labelHeight || "—",
      dieNo: die ? (formatDieLabelNoDims(die) || die.dieDieNo || "—") : "—",
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
      productionReference: {
        die: die ? (formatDieLabel(die) || die.dieDieNo || "") : "",
        runningMeters: formatRunningMeters(balanceQty, die),
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
