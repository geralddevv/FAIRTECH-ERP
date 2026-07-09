import express from "express";
import mongoose from "mongoose";
import Machine from "../../models/system/machine.js";
import MachineBinding from "../../models/system/machineBinding.js";
import Location from "../../models/system/location.js";
import Die from "../../models/utilities/die_model.js";
import Block from "../../models/utilities/block_model.js";
import ProductionBinding from "../../models/utilities/productionBinding.js";
import PendingProduction from "../../models/inventory/PendingProduction.js";
import { requireAuth } from "../../middleware/auth.js";
import { createLimiter, updateLimiter, deleteLimiter } from "../../utils/limiters.js";

const router = express.Router();

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
    console.error(err);
    res.status(500).json({ success: false, message: err.message });
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

  const pending = await PendingProduction.find({ assignedMachineId: machine._id })
    .populate({ path: "itemId", select: "productId labelWidth labelHeight perRollQty paperType jobType jobName" })
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
  const dies = dieIds.length ? await Die.find({ _id: { $in: dieIds } }).select("dieDieNo").lean() : [];
  const dieMap = new Map(dies.map((d) => [String(d._id), d.dieDieNo]));

  const rows = pending.map((p, i) => {
    const item = p.itemId || {};
    const binding = p.productionBindingId ? bindingMap.get(String(p.productionBindingId)) : null;
    const dieNo = binding?.dieId ? dieMap.get(String(binding.dieId)) : null;
    const perRoll = Number(item.perRollQty) || 0;
    const qty = Number(p.quantity) || 0;
    const rolls = perRoll > 0 ? Math.ceil(qty / perRoll) : null;

    return {
      _id: String(p._id),
      lotNo: `LOT-${String(i + 1).padStart(4, "0")}`,
      productId: item.productId || "—",
      labelWidth: item.labelWidth || "—",
      labelHeight: item.labelHeight || "—",
      dieNo: dieNo || "—",
      paperSize: binding?.prodPaperSize || "—",
      paperType: item.paperType || "—",
      paperCode: binding?.prodPaperCode || "—",
      rolls: rolls != null ? String(rolls) : "—",
      operatorName: p.operatorId?.empName || "—",
      helperName: p.helperId?.empName || "—",
    };
  });

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
    console.error(err);
    res.status(500).json({ success: false, message: err.message });
  }
});

export default router;
