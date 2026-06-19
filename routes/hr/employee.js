import express from "express";
import Employee from "../../models/hr/employee_model.js";
import Client from "../../models/users/client.js";
import Username from "../../models/users/username.js";
import multer from "multer";
import path from "path";
import fs from "fs";
import { randomBytes } from "crypto";
import { requireAuth } from "../../middleware/auth.js";
import { createLimiter, updateLimiter, deleteLimiter } from "../../utils/limiters.js";

const router = express.Router();

/* ================= MULTER STORAGE (MULTIPLE FILE TYPES) ================= */
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    if (file.fieldname === "empPhoto") {
      cb(null, "images/empimg");
    } else if (file.fieldname === "empAadhaarImg") {
      cb(null, "images/aadhaar");
    } else if (file.fieldname === "empPanImg") {
      cb(null, "images/pan");
    } else {
      cb(new Error("Invalid upload field"));
    }
  },
  filename: (req, file, cb) => {
    const randomName = randomBytes(16).toString("hex") + path.extname(file.originalname);
    cb(null, randomName);
  },
});

const fileFilter = (req, file, cb) => {
  // 1. Check MIME type
  if (!file.mimetype.startsWith("image/")) {
    return cb(new Error("Only image files allowed"), false);
  }

  // 2. Check file extension
  const allowedExts = [".jpg", ".jpeg", ".png", ".gif", ".webp"];
  const ext = path.extname(file.originalname).toLowerCase();
  if (!allowedExts.includes(ext)) {
    return cb(new Error("Invalid file extension. Use JPG, PNG, GIF, or WebP."), false);
  }

  cb(null, true);
};

const upload = multer({
  storage,
  fileFilter,
  limits: { fileSize: 2 * 1024 * 1024 }, // 2MB
});

/* ================= MULTER WRAPPER FOR CLEAN ERRORS ================= */
const uploadMiddleware = upload.fields([
  { name: "empPhoto", maxCount: 1 },
  { name: "empAadhaarImg", maxCount: 1 },
  { name: "empPanImg", maxCount: 1 },
]);

const normalizeProfileCode = (value) => String(value || "").trim().toUpperCase();

const getExistingProfileCodes = async (excludeId = null) => {
  const query = {
    empProfileCode: { $exists: true, $ne: "" },
  };
  if (excludeId) query._id = { $ne: excludeId };

  const employees = await Employee.find(query, "empProfileCode").lean();
  return employees
    .map((emp) => normalizeProfileCode(emp.empProfileCode))
    .filter(Boolean);
};

const findEmployeeByProfileCode = async (profileCode, excludeId = null) => {
  const normalizedCode = normalizeProfileCode(profileCode);
  if (!normalizedCode) return null;

  const query = { empProfileCode: { $exists: true, $ne: "" } };
  if (excludeId) query._id = { $ne: excludeId };

  const employees = await Employee.find(query, "_id empProfileCode").lean();
  return employees.find((emp) => normalizeProfileCode(emp.empProfileCode) === normalizedCode) || null;
};

const deleteUploadedEmployeeFiles = (files = {}) => {
  const folderByField = {
    empPhoto: "empimg",
    empAadhaarImg: "aadhaar",
    empPanImg: "pan",
  };

  Object.entries(folderByField).forEach(([field, folder]) => {
    (files[field] || []).forEach((file) => {
      const filePath = path.join("images", folder, file.filename);
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    });
  });
};

const handleUpload = (req, res, next) => {
  uploadMiddleware(req, res, (err) => {
    if (err) {
      if (req.xhr || req.headers.accept?.includes("application/json")) {
        return res.status(400).json({ success: false, message: err.message });
      }
      req.flash("notification", err.message);
      return res.redirect("back");
    }
    next();
  });
};

/* ================= CREATE EMPLOYEE FORM ================= */
router.get("/create", async (req, res) => {
  const employeeCount = (await Employee.countDocuments()) + 1;
  const employees = await Employee.find({}, "empName")
    .collation({ locale: "en", strength: 2 })
    .sort({ empName: 1 })
    .lean();
  const existingProfileCodes = await getExistingProfileCodes();

  res.render("hr/employee.ejs", {
    title: "Employee Details",
    CSS: false,
    JS: false,
    employeeCount,
    employee: null,
    employees,
    existingProfileCodes,
    notification: req.flash("notification"),
  });
});

/* ================= EMPLOYEE LIST ================= */
router.get("/view", async (req, res) => {
  const jsonData = await Employee.find();

  res.render("hr/employeeDisp.ejs", {
    jsonData,
    title: "Employee View",
    CSS: "tableDisp.css",
    JS: false,
    notification: req.flash("notification"),
  });
});

/* ================= CREATE EMPLOYEE ================= */
router.post("/form", requireAuth, createLimiter, handleUpload, async (req, res) => {
  try {
    const existingProfileCode = await findEmployeeByProfileCode(req.body.empProfileCode);
    if (existingProfileCode) {
      deleteUploadedEmployeeFiles(req.files);
      return res.status(409).json({
        success: false,
        message: "Profile Code already exists. Please enter a different code.",
      });
    }

    const employeeData = {
      ...req.body,
      empPhoto: req.files?.empPhoto?.[0]?.filename || null,
      empAadhaarImg: req.files?.empAadhaarImg?.[0]?.filename || null,
      empPanImg: req.files?.empPanImg?.[0]?.filename || null,
    };

    await Employee.create(employeeData);

    req.flash("notification", "Employee created successfully!");
    if (req.xhr || req.headers.accept?.includes("application/json")) {
      res.json({ success: true, redirect: "/fairdesk/employee/create" });
    } else {
      res.redirect("/fairdesk/employee/create");
    }
  } catch (err) {
    console.error(err);
    res.status(400).json({ success: false, message: err.message });
  }
});

/* ================= EMPLOYEE PROFILE VIEW ================= */
router.get("/profile/:id", async (req, res) => {
  const employee = await Employee.findById(req.params.id).lean();
  if (!employee) return res.status(404).send("Employee not found");

  res.render("hr/employeeView.ejs", { employee });
});

/* ================= FETCH EMPLOYEE JSON ================= */
router.get("/:id", async (req, res) => {
  try {
    const emp = await Employee.findById(req.params.id).lean();
    if (!emp) return res.status(404).json(null);
    res.json(emp);
  } catch {
    res.status(500).json(null);
  }
});

/* ================= EDIT FORM ================= */
router.get("/edit/:id", async (req, res) => {
  const employee = await Employee.findById(req.params.id).lean();
  if (!employee) return res.redirect("back");
  const employees = await Employee.find({ _id: { $ne: req.params.id } }, "empName")
    .collation({ locale: "en", strength: 2 })
    .sort({ empName: 1 })
    .lean();
  const existingProfileCodes = await getExistingProfileCodes(req.params.id);

  res.render("hr/employee.ejs", {
    title: "Edit Employee",
    CSS: false,
    JS: false,
    employee,
    employeeCount: null,
    employees,
    existingProfileCodes,
  });
});

/* ================= UPDATE EMPLOYEE ================= */
router.post("/edit/:id", requireAuth, updateLimiter, handleUpload, async (req, res) => {
  try {
    const emp = await Employee.findById(req.params.id);
    if (!emp) return res.status(400).json({ success: false, message: "Employee not found" });

    const existingProfileCode = await findEmployeeByProfileCode(req.body.empProfileCode, req.params.id);
    if (existingProfileCode) {
      deleteUploadedEmployeeFiles(req.files);
      return res.status(409).json({
        success: false,
        message: "Profile Code already exists. Please enter a different code.",
      });
    }

    const oldName = emp.empName;
    const newName = req.body.empName;

    const replaceFile = (field, folder) => {
      if (req.files?.[field]) {
        if (emp[field]) {
          const oldPath = `images/${folder}/${emp[field]}`;
          if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
        }
        emp[field] = req.files[field][0].filename;
      }
    };

    replaceFile("empPhoto", "empimg");
    replaceFile("empAadhaarImg", "aadhaar");
    replaceFile("empPanImg", "pan");

    Object.assign(emp, req.body);
    await emp.save();

    // Propagate Name Change if empName was updated
    if (oldName && newName && oldName !== newName) {
      await Promise.all([
        Client.updateMany({ accountHead: oldName }, { $set: { accountHead: newName } }),
        Username.updateMany({ accountHead: oldName }, { $set: { accountHead: newName } }),
        Employee.updateMany({ empReportingManager: oldName }, { $set: { empReportingManager: newName } }),
      ]);
    }

    req.flash("notification", "Employee updated successfully!");
    const redirectUrl = "/fairdesk/employee/view";
    if (req.xhr || req.headers.accept?.includes("application/json")) {
      res.json({ success: true, redirect: redirectUrl });
    } else {
      res.redirect(redirectUrl);
    }
  } catch (err) {
    console.error(err);
    res.status(400).json({ success: false, message: err.message });
  }
});

/* ================= PERMISSION DASHBOARD ================= */
router.get("/admin/permissions", async (req, res) => {
  try {
    if (req.session.authUser.role !== "admin") {
      return res.redirect("/");
    }

    const employees = await Employee.find({ isActive: true }).sort({ empName: 1 }).lean();
    res.render("hr/permissionsDashboard.ejs", {
      title: "Permission Dashboard",
      employees,
      CSS: "tableDisp.css",
      JS: false,
      notification: req.flash("notification"),
    });
  } catch (err) {
    console.error(err);
    res.status(500).send("Server Error");
  }
});

/* ================= UPDATE PERMISSIONS (AJAX) ================= */
router.post("/admin/permissions/:id", requireAuth, updateLimiter, async (req, res) => {
  try {
    // Role checking is already handled by middleware in server.js
    // ensure the route processes the request.
    const { role, permissions, canRead, canWrite, canDelete } = req.body;
    await Employee.findByIdAndUpdate(req.params.id, {
      $set: { role, permissions, canRead, canWrite, canDelete }
    });

    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: err.message });
  }
});

export default router;
