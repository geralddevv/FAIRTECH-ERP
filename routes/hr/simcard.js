import express from "express";
import crypto from "crypto";
import Employee from "../../models/hr/employee_model.js";
import SimCard from "../../models/hr/simcard_model.js";
import SimCardLog from "../../models/hr/SimCardLog.js";
import { requireAuth } from "../../middleware/auth.js";
import { createLimiter, updateLimiter, deleteLimiter } from "../../utils/limiters.js";

const router = express.Router();

function performedByOf(req) {
  return req.session?.authUser?.empName || req.session?.authUser?.username || "SYSTEM";
}

function hashSignature(rawSignature) {
  return `sha256:${crypto.createHash("sha256").update(String(rawSignature ?? "")).digest("hex")}`;
}

// A SIM card's real-world identity is its mobile number — normalize to
// digits only so "98765 43210" and "9876543210" are recognized as the same
// number regardless of the space the client-side formatter inserts.
function buildSimCardSignature(mobileNumber) {
  return hashSignature(String(mobileNumber ?? "").replace(/\D/g, ""));
}

async function resolveEmployee(employeeId, employeeManualName) {
  if (employeeId === "UNASSIGNED") {
    return { employee: null, isOthers: false, isUnassigned: true, employeeName: "UNASSIGNED", currentOfficeMobile: null };
  }

  if (employeeId === "OTHERS") {
    const employeeName = String(employeeManualName || "").trim();
    if (!employeeName) {
      throw new Error("Please enter the employee name.");
    }
    return { employee: null, isOthers: true, isUnassigned: false, employeeName, currentOfficeMobile: null };
  }

  if (!employeeId) {
    throw new Error("Please select an employee.");
  }

  const emp = await Employee.findById(employeeId).select("empName empOfficeMob").lean();
  if (!emp) {
    throw new Error("Employee not found.");
  }

  return {
    employee: emp._id,
    isOthers: false,
    isUnassigned: false,
    employeeName: emp.empName,
    currentOfficeMobile: emp.empOfficeMob || "",
  };
}

/* ================= SIM CARD LIST + ADD/EDIT/DELETE DIALOGS ================= */
router.get("/view", async (req, res) => {
  const [employees, departments, simCards] = await Promise.all([
    Employee.find({ isActive: true }, "empName empOfficeMob empDept")
      .collation({ locale: "en", strength: 2 })
      .sort({ empName: 1 })
      .lean(),
    Employee.distinct("empDept", { empDept: { $exists: true, $ne: "" } }),
    SimCard.find().sort({ createdAt: -1 }).lean(),
  ]);

  departments.sort((a, b) => a.localeCompare(b));

  const jsonData = simCards.map((s) => ({
    _id: String(s._id),
    employeeId: s.employee ? String(s.employee) : s.isUnassigned ? "UNASSIGNED" : "OTHERS",
    employeeName: s.employeeName,
    isOthers: s.isOthers,
    isUnassigned: s.isUnassigned,
    department: s.department || "",
    mobileNumber: s.mobileNumber,
    serviceProvider: s.serviceProvider,
    tracementService: s.tracementService,
    ubi: s.ubi,
  }));

  res.render("hr/simcardMaster.ejs", {
    JS: false,
    CSS: "tableDisp.css",
    title: "SIM Card View",
    employees,
    departments,
    jsonData,
    notification: req.flash("notification"),
  });
});

/* ================= ASSIGN SIM CARD ================= */
router.post("/create", requireAuth, createLimiter, async (req, res) => {
  try {
    const { employeeId, employeeManualName, department, mobileNumber, serviceProvider, tracementService, ubi } = req.body;

    const { employee, isOthers, isUnassigned, employeeName, currentOfficeMobile } = await resolveEmployee(employeeId, employeeManualName);

    const dept = String(department || "").trim();
    const mobile = String(mobileNumber || "").trim();
    const provider = String(serviceProvider || "").trim();
    const tracement = String(tracementService || "").trim().toUpperCase();
    const ubiValue = String(ubi || "").trim().toUpperCase();

    if (!mobile) {
      return res.status(400).json({ success: false, message: "Mobile number is required." });
    }
    if (!provider) {
      return res.status(400).json({ success: false, message: "Service provider is required." });
    }
    if (!["YES", "NO"].includes(tracement)) {
      return res.status(400).json({ success: false, message: "Please select tracemate service." });
    }
    if (!["YES", "NO"].includes(ubiValue)) {
      return res.status(400).json({ success: false, message: "Please select UBI." });
    }

    const simCardSignature = buildSimCardSignature(mobile);
    // $or also matches on the raw mobileNumber for records created before this
    // field existed (simCardSignature is sparse, so they won't match by hash).
    const duplicate = await SimCard.findOne({ $or: [{ simCardSignature }, { mobileNumber: mobile }] })
      .select("mobileNumber employeeName")
      .lean();
    if (duplicate) {
      return res.status(400).json({
        success: false,
        message: `SIM card ${duplicate.mobileNumber} already exists (currently with "${duplicate.employeeName}").`,
      });
    }

    const simCard = await SimCard.create({
      employee,
      employeeName,
      isOthers,
      isUnassigned,
      department: dept,
      mobileNumber: mobile,
      serviceProvider: provider,
      tracementService: tracement,
      ubi: ubiValue,
      simCardSignature,
    });

    if (employee && currentOfficeMobile !== mobile) {
      await Employee.findByIdAndUpdate(employee, { empOfficeMob: mobile });
    }

    await SimCardLog.create({
      simCardId: simCard._id,
      action: "ASSIGNED",
      employeeName,
      department: dept,
      mobileNumber: mobile,
      serviceProvider: provider,
      tracementService: tracement,
      ubi: ubiValue,
      performedBy: performedByOf(req),
    });

    res.locals.auditDescription = `Assigned SIM card ${mobile} to "${employeeName}"`;
    req.flash("notification", "SIM card assigned successfully!");
    res.json({ success: true, redirect: "/fairtech/simcard/view" });
  } catch (err) {
    console.error(err);
    if (err?.code === 11000) {
      return res.status(400).json({ success: false, message: "This SIM card number already exists." });
    }
    res.status(400).json({ success: false, message: err.message || "Failed to assign SIM card." });
  }
});

/* ================= UPDATE SIM CARD ================= */
router.put("/api/:id", requireAuth, updateLimiter, async (req, res) => {
  try {
    const { employeeId, employeeManualName, department, mobileNumber, serviceProvider, tracementService, ubi } = req.body;

    const existing = await SimCard.findById(req.params.id).lean();
    if (!existing) {
      return res.status(404).json({ success: false, message: "SIM card record not found." });
    }

    const { employee, isOthers, isUnassigned, employeeName, currentOfficeMobile } = await resolveEmployee(employeeId, employeeManualName);

    const dept = String(department || "").trim();
    const mobile = String(mobileNumber || "").trim();
    const provider = String(serviceProvider || "").trim();
    const tracement = String(tracementService || "").trim().toUpperCase();
    const ubiValue = String(ubi || "").trim().toUpperCase();

    if (!mobile) {
      return res.status(400).json({ success: false, message: "Mobile number is required." });
    }
    if (!provider) {
      return res.status(400).json({ success: false, message: "Service provider is required." });
    }
    if (!["YES", "NO"].includes(tracement)) {
      return res.status(400).json({ success: false, message: "Please select tracemate service." });
    }
    if (!["YES", "NO"].includes(ubiValue)) {
      return res.status(400).json({ success: false, message: "Please select UBI." });
    }

    const hasChanges =
      String(employee || "") !== String(existing.employee || "") ||
      isOthers !== existing.isOthers ||
      isUnassigned !== existing.isUnassigned ||
      employeeName !== existing.employeeName ||
      dept !== (existing.department || "") ||
      mobile !== existing.mobileNumber ||
      provider !== existing.serviceProvider ||
      tracement !== existing.tracementService ||
      ubiValue !== existing.ubi;

    if (!hasChanges) {
      return res.json({ success: true });
    }

    const simCardSignature = buildSimCardSignature(mobile);
    // $or also matches on the raw mobileNumber for records created before this
    // field existed (simCardSignature is sparse, so they won't match by hash).
    const duplicate = await SimCard.findOne({
      $or: [{ simCardSignature }, { mobileNumber: mobile }],
      _id: { $ne: req.params.id },
    })
      .select("mobileNumber employeeName")
      .lean();
    if (duplicate) {
      return res.status(400).json({
        success: false,
        message: `SIM card ${duplicate.mobileNumber} already exists (currently with "${duplicate.employeeName}").`,
      });
    }

    const updated = await SimCard.findByIdAndUpdate(
      req.params.id,
      {
        employee,
        employeeName,
        isOthers,
        isUnassigned,
        department: dept,
        mobileNumber: mobile,
        serviceProvider: provider,
        tracementService: tracement,
        ubi: ubiValue,
        simCardSignature,
      },
      { new: true, runValidators: true }
    );

    if (!updated) {
      return res.status(404).json({ success: false, message: "SIM card record not found." });
    }

    if (employee && currentOfficeMobile !== mobile) {
      await Employee.findByIdAndUpdate(employee, { empOfficeMob: mobile });
    }

    await SimCardLog.create({
      simCardId: updated._id,
      action: "UPDATED",
      employeeName,
      department: dept,
      mobileNumber: mobile,
      serviceProvider: provider,
      tracementService: tracement,
      ubi: ubiValue,
      performedBy: performedByOf(req),
    });

    res.locals.auditDescription = `Updated SIM card ${mobile} for "${employeeName}"`;
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    if (err?.code === 11000) {
      return res.status(400).json({ success: false, message: "This SIM card number already exists." });
    }
    res.status(400).json({ success: false, message: err.message || "Failed to update SIM card." });
  }
});

/* ================= SIM CARD PROFILE (per-number history) ================= */
router.get("/profile/:id", async (req, res) => {
  try {
    const simCard = await SimCard.findById(req.params.id).lean();
    if (!simCard) {
      req.flash("notification", "SIM card record not found");
      return res.redirect("/fairtech/simcard/view");
    }

    const logs = await SimCardLog.find({ simCardId: simCard._id })
      .sort({ performedAt: 1 })
      .lean();

    // Turn the flat change log into date-range "held by" periods: each log
    // entry's holder is valid from that entry's date until the next entry's
    // date, and the most recent entry's holder is valid through today.
    // Built ascending (each period needs the *next* log's date), then
    // reversed so the latest status displays on top.
    const history = logs
      .map((log, i) => ({
        from: log.performedAt,
        to: logs[i + 1] ? logs[i + 1].performedAt : null,
        employeeName: log.employeeName,
        department: log.department,
        serviceProvider: log.serviceProvider,
        tracementService: log.tracementService,
        ubi: log.ubi,
        action: log.action,
      }))
      .reverse();

    res.render("hr/simcardProfile.ejs", {
      title: "SIM Card Profile",
      CSS: false,
      JS: false,
      simCard,
      history,
      notification: req.flash("notification"),
    });
  } catch (err) {
    console.error(err);
    req.flash("notification", "Invalid SIM card link");
    res.redirect("/fairtech/simcard/view");
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
        department: existing.department,
        mobileNumber: existing.mobileNumber,
        serviceProvider: existing.serviceProvider,
        tracementService: existing.tracementService,
        ubi: existing.ubi,
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
