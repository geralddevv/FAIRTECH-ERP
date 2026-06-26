import express from "express";
import Machine from "../../models/system/machine.js";
import MachineBinding from "../../models/system/machineBinding.js";
import Location from "../../models/system/location.js";
import Die from "../../models/utilities/die_model.js";
import Block from "../../models/utilities/block_model.js";
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
    await MachineBinding.findByIdAndDelete(req.params.id);
    const wantsJson = req.xhr || req.headers.accept?.includes("application/json");
    if (wantsJson) return res.json({ success: true });
    req.flash("notification", "Binding removed.");
    res.redirect("/fairtech/form/machine-binding/view");
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: err.message });
  }
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
    await Machine.findByIdAndDelete(req.params.id);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: err.message });
  }
});

export default router;
