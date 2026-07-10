import express from "express";
import Employee from "../../models/hr/employee_model.js";
import SimCard from "../../models/hr/simcard_model.js";
import SimCardLog from "../../models/hr/SimCardLog.js";
import { requireAuth } from "../../middleware/auth.js";
import { createLimiter, updateLimiter, deleteLimiter } from "../../utils/limiters.js";

const router = express.Router();

function performedByOf(req) {
  return req.session?.authUser?.empName || req.session?.authUser?.username || "SYSTEM";
}

async function resolveEmployee(employeeId, employeeManualName) {
  if (employeeId === "OTHERS") {
    const employeeName = String(employeeManualName || "").trim();
    if (!employeeName) {
      throw new Error("Please enter the employee name.");
    }
    return { employee: null, isOthers: true, employeeName };
  }

  if (!employeeId) {
    throw new Error("Please select an employee.");
  }

  const emp = await Employee.findById(employeeId).select("empName").lean();
  if (!emp) {
    throw new Error("Employee not found.");
  }

  return { employee: emp._id, isOthers: false, employeeName: emp.empName };
}

/* ================= SIM CARD LIST + ADD/EDIT/DELETE DIALOGS ================= */
router.get("/view", async (req, res) => {
  const [employees, simCards] = await Promise.all([
    Employee.find({ isActive: true }, "empName")
      .collation({ locale: "en", strength: 2 })
      .sort({ empName: 1 })
      .lean(),
    SimCard.find().sort({ createdAt: -1 }).lean(),
  ]);

  const jsonData = simCards.map((s) => ({
    _id: String(s._id),
    employeeId: s.employee ? String(s.employee) : "OTHERS",
    employeeName: s.employeeName,
    isOthers: s.isOthers,
    mobileNumber: s.mobileNumber,
    serviceProvider: s.serviceProvider,
    tracementService: s.tracementService,
  }));

  res.render("hr/simcardMaster.ejs", {
    JS: false,
    CSS: "tableDisp.css",
    title: "SIM Card View",
    employees,
    jsonData,
    notification: req.flash("notification"),
  });
});

/* ================= ASSIGN SIM CARD ================= */
router.post("/create", requireAuth, createLimiter, async (req, res) => {
  try {
    const { employeeId, employeeManualName, mobileNumber, serviceProvider, tracementService } = req.body;

    const { employee, isOthers, employeeName } = await resolveEmployee(employeeId, employeeManualName);

    const mobile = String(mobileNumber || "").trim();
    const provider = String(serviceProvider || "").trim();
    const tracement = String(tracementService || "").trim().toUpperCase();

    if (!mobile) {
      return res.status(400).json({ success: false, message: "Mobile number is required." });
    }
    if (!provider) {
      return res.status(400).json({ success: false, message: "Service provider is required." });
    }
    if (!["YES", "NO"].includes(tracement)) {
      return res.status(400).json({ success: false, message: "Please select tracement service." });
    }

    const simCard = await SimCard.create({
      employee,
      employeeName,
      isOthers,
      mobileNumber: mobile,
      serviceProvider: provider,
      tracementService: tracement,
    });

    await SimCardLog.create({
      simCardId: simCard._id,
      action: "ASSIGNED",
      employeeName,
      mobileNumber: mobile,
      serviceProvider: provider,
      tracementService: tracement,
      performedBy: performedByOf(req),
    });

    res.locals.auditDescription = `Assigned SIM card ${mobile} to "${employeeName}"`;
    req.flash("notification", "SIM card assigned successfully!");
    res.json({ success: true, redirect: "/fairtech/simcard/view" });
  } catch (err) {
    console.error(err);
    res.status(400).json({ success: false, message: err.message || "Failed to assign SIM card." });
  }
});

/* ================= UPDATE SIM CARD ================= */
router.put("/api/:id", requireAuth, updateLimiter, async (req, res) => {
  try {
    const { employeeId, employeeManualName, mobileNumber, serviceProvider, tracementService } = req.body;

    const { employee, isOthers, employeeName } = await resolveEmployee(employeeId, employeeManualName);

    const mobile = String(mobileNumber || "").trim();
    const provider = String(serviceProvider || "").trim();
    const tracement = String(tracementService || "").trim().toUpperCase();

    if (!mobile) {
      return res.status(400).json({ success: false, message: "Mobile number is required." });
    }
    if (!provider) {
      return res.status(400).json({ success: false, message: "Service provider is required." });
    }
    if (!["YES", "NO"].includes(tracement)) {
      return res.status(400).json({ success: false, message: "Please select tracement service." });
    }

    const updated = await SimCard.findByIdAndUpdate(
      req.params.id,
      {
        employee,
        employeeName,
        isOthers,
        mobileNumber: mobile,
        serviceProvider: provider,
        tracementService: tracement,
      },
      { new: true, runValidators: true }
    );

    if (!updated) {
      return res.status(404).json({ success: false, message: "SIM card record not found." });
    }

    await SimCardLog.create({
      simCardId: updated._id,
      action: "UPDATED",
      employeeName,
      mobileNumber: mobile,
      serviceProvider: provider,
      tracementService: tracement,
      performedBy: performedByOf(req),
    });

    res.locals.auditDescription = `Updated SIM card ${mobile} for "${employeeName}"`;
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(400).json({ success: false, message: err.message || "Failed to update SIM card." });
  }
});

/* ================= SIM CARD CHANGE LOG ================= */
router.get("/logs", async (req, res) => {
  const logs = await SimCardLog.find().sort({ performedAt: -1 }).limit(2000).lean();

  res.render("hr/simcardLogs.ejs", {
    title: "SIM Card Logs",
    CSS: "tableDisp.css",
    JS: false,
    jsonData: logs,
    notification: req.flash("notification"),
  });
});

/* ================= DELETE SIM CARD ================= */
router.delete("/api/:id", requireAuth, deleteLimiter, async (req, res) => {
  try {
    const existing = await SimCard.findById(req.params.id).lean();
    await SimCard.findByIdAndDelete(req.params.id);

    if (existing) {
      await SimCardLog.create({
        simCardId: existing._id,
        action: "REMOVED",
        employeeName: existing.employeeName,
        mobileNumber: existing.mobileNumber,
        serviceProvider: existing.serviceProvider,
        tracementService: existing.tracementService,
        performedBy: performedByOf(req),
      });
    }

    res.locals.auditDescription = `Removed SIM card assignment for "${existing?.employeeName || req.params.id}"`;
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: err.message });
  }
});

export default router;
