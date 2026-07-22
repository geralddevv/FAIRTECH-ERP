import "./config/loadEnv.js";
import express from "express";
import compression from "compression";
import ejsMate from "ejs-mate";
import connectDB from "./config/db.js";
import fairdeskRoute from "./routes/fairdesk_route.js";
import payrollRoute from "./routes/acccounting/payroll.js";
import loanRoute from "./routes/acccounting/loan.js";
import advanceRoute from "./routes/acccounting/advance.js";
import employeeRoute from "./routes/hr/employee.js";
import simCardRoute from "./routes/hr/simcard.js";
import pettycashRoute from "./routes/acccounting/pettycash.js";
import tapeBindingRoutes from "./routes/inventory/tapeBinding.js";
import tapeStockRoutes from "./routes/stock/tapeStock.js";
import posRollStockRoutes from "./routes/stock/posRollStock.js";
import tafetaStockRoutes from "./routes/stock/tafetaStock.js";
import ttrStockRoutes from "./routes/stock/ttrStock.js";
import paperStockRoutes from "./routes/stock/paperStock.js";
import stockViewRoutes from "./routes/stock/stockView.js";
import clientFormRoute from "./routes/users/clients.js";
import posRollBindingRoutes from "./routes/inventory/posRollBinding.js";
import tafetaBindingRoutes from "./routes/inventory/tafetaBinding.js";
import ttrBindingRoutes from "./routes/inventory/ttrBinding.js";
import vendorItemBindingRoutes from "./routes/inventory/vendorItemBinding.js";
import reorderRoutes from "./routes/inventory/reorder.js";
import machineRoutes from "./routes/system/machine.js";
import { requireAuth, requireRole } from "./middleware/auth.js";
import { auditLogger, logAuthEvent } from "./middleware/auditLogger.js";
import { fileURLToPath } from "url";
import path from "path";
import os from "os";
import fs from "fs";
import sharp from "sharp";
import bcrypt from "bcrypt";
import { escapeRegex } from "./utils/security.js";
import Employee from "./models/hr/employee_model.js";
import Location from "./models/system/location.js";
import Machine from "./models/system/machine.js";
import { normalizeLocationName } from "./utils/locations.js";
import crypto from "crypto";

import session from "express-session";
import flash from "connect-flash";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import csrf from "csurf";
import cookieParser from "cookie-parser";
import MongoSessionStore from "./utils/mongoSessionStore.js";
import { safeJson } from "./utils/security.js";
import { loginLimiter, createLimiter, updateLimiter, deleteLimiter } from "./utils/limiters.js";

const app = express();
const port = 3000;

/* DB (env already loaded by the config/loadEnv.js import at the top of this file) */
connectDB();

// Validate required environment variables
const sessionSecret = process.env.SESSION_SECRET;
if (!sessionSecret) {
  console.error("❌ CRITICAL: SESSION_SECRET not set in .env");
  process.exit(1);
}

/* SECURITY MIDDLEWARE (HELMET) */
// Let a per-request CSP header with nonces be applied later so inline scripts can be selectively allowed.
app.use(
  helmet({
    contentSecurityPolicy: false,
    frameguard: { action: "deny" },
    noSniff: true,
    referrerPolicy: { policy: "strict-origin-when-cross-origin" },
    strictTransportSecurity: {
      maxAge: 31536000, // 1 year
      includeSubDomains: true,
      preload: true,
    },
    permissionsPolicy: {
      camera: [],
      microphone: [],
      geolocation: [],
      usb: [],
      magnetometer: [],
      gyroscope: [],
      accelerometer: [],
    },
    crossOriginEmbedderPolicy: false,
    crossOriginOpenerPolicy: { policy: "unsafe-none" },
    originAgentCluster: true,
  }),
);

/* RATE LIMITING */
// Imported from utils/limiters.js: loginLimiter, createLimiter, updateLimiter, deleteLimiter

/* PATH SETUP */
const file_name = fileURLToPath(import.meta.url);
const dir_name = path.dirname(file_name);

/* VIEW ENGINE */
app.engine("ejs", ejsMate);
app.set("view engine", "ejs");
app.set("views", path.join(dir_name, "views"));

/* GZIP COMPRESSION */
app.use(compression());

/* BODY PARSERS */
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true, limit: "1mb" }));
// app.use(cookieParser()); // Redundant and can interfere with express-session

/* STATIC FILES */
app.use(express.static(path.join(dir_name, "public"), { maxAge: "1d" }));
app.use("/bootstrap", express.static(dir_name + "/node_modules/bootstrap/dist", { maxAge: "1d" }));

// Per-request nonce + HTML post-processing middleware to inject nonce on inline scripts
app.use((req, res, next) => {
  const nonce = crypto.randomBytes(16).toString("base64");
  res.locals.cspNonce = nonce;

  // Wrap res.render to inject nonce attributes into inline <script> tags and set CSP header
  const _render = res.render.bind(res);
  res.render = function (view, options = {}, callback) {
    if (typeof options === "function") {
      callback = options;
      options = {};
    }
    options = Object.assign({}, options, { cspNonce: nonce });
    _render(view, options, function (err, html) {
      if (err) {
        if (callback) return callback(err);
        return next(err);
      }
      // Allow inline scripts and existing inline event handlers for compatibility.
      // (Consider refactoring to remove 'unsafe-inline' in future.)
      const csp = [
        `default-src 'self'`,
        `script-src 'self' cdn.jsdelivr.net https://cdnjs.cloudflare.com https://unpkg.com 'unsafe-inline'`,
        `script-src-elem 'self' cdn.jsdelivr.net https://cdnjs.cloudflare.com https://unpkg.com 'unsafe-inline'`,
        // Permit font-awesome, tabulator and other styles
        `style-src 'self' cdn.jsdelivr.net https://cdnjs.cloudflare.com https://unpkg.com 'unsafe-inline'`,
        `style-src-elem 'self' cdn.jsdelivr.net https://cdnjs.cloudflare.com https://unpkg.com 'unsafe-inline'`,
        `img-src 'self' data:`,
        `connect-src 'self' cdn.jsdelivr.net https://cdnjs.cloudflare.com https://unpkg.com`,
        `font-src 'self' cdn.jsdelivr.net https://cdnjs.cloudflare.com`,
        `object-src 'none'`,
      ].join("; ");
      res.setHeader("Content-Security-Policy", csp);

      if (callback) return callback(null, html);
      res.send(html);
    });
  };

  next();
});

/* SESSION */
const SESSION_TTL_MS = 30 * 60 * 1000; // 30 minutes

const sessionStore = new MongoSessionStore({
  ttlMs: SESSION_TTL_MS,
});

app.use(
  session({
    name: "fairdesk.sid",
    secret: sessionSecret,
    resave: false,
    saveUninitialized: false,
    rolling: true,
    store: sessionStore,
    cookie: {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      maxAge: SESSION_TTL_MS,
    },
  }),
);

const getSessionExpiresAt = (req) => {
  const maxAge = Number(req.session?.cookie?.maxAge ?? req.session?.cookie?.originalMaxAge);
  if (Number.isFinite(maxAge) && maxAge > 0) {
    return new Date(Date.now() + maxAge).toISOString();
  }

  const expires = req.session?.cookie?.expires;
  if (expires) {
    const expiresDate = new Date(expires);
    if (!Number.isNaN(expiresDate.getTime())) {
      return expiresDate.toISOString();
    }
  }

  return new Date(Date.now() + SESSION_TTL_MS).toISOString();
};

/* CSRF PROTECTION SETUP */
const csrfProtection = csrf({ cookie: false });

/* FLASH */
app.use(flash());

/* AUTH SESSION EXPIRY HELPERS */
app.use((req, res, next) => {
  if (req.session?.authUser) {
    const sessionExpiresAt = getSessionExpiresAt(req);
    res.locals.sessionExpiresAt = sessionExpiresAt;
    res.setHeader("X-Session-Expires-At", sessionExpiresAt);
  }

  next();
});

/* GLOBAL LOCALS (EARLY) */
app.use((req, res, next) => {
  res.locals.notification = req.session.flash?.notification || [];
  res.locals.error = req.session.flash?.error || [];
  // A session stores the permission snapshot taken at login, so backdoor
  // sessions opened before DEV_PERMISSIONS_BY_ROLE existed still carry the old
  // "everything true" set and render menus their role shouldn't have. Refresh
  // it here so those sessions correct themselves instead of needing a re-login.
  // DB employees (which have an empId) keep the permissions from their record.
  const sessionUser = req.session?.authUser;
  if (sessionUser && !sessionUser.empId && DEV_PERMISSIONS_BY_ROLE[sessionUser.role]) {
    sessionUser.permissions = DEV_PERMISSIONS_BY_ROLE[sessionUser.role];
  }

  res.locals.authUser = req.session?.authUser || null;
  res.locals.sessionExpiresAt = res.locals.sessionExpiresAt || null;
  res.locals.safeJson = safeJson;
  // "Home" isn't the same page for everyone: operators can't open /welcome, so
  // the layout's Dashboard link points wherever landingForUser sends them.
  res.locals.homeUrl = landingForUser(req.session?.authUser);

  next();
});

/* AUDIT LOG — records every mutating request made by a logged-in user */
app.use(auditLogger);

/* Favicon */
app.get("/favicon.ico", (req, res) => res.status(204).end());

/* Session check endpoint – used by client-side polling (exempt from CSRF) */
app.get("/check-session", (req, res) => {
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, private");
  if (req.session?.authUser) {
    req.session.touch();
    const expiresAt = getSessionExpiresAt(req);
    res.setHeader("X-Session-Expires-At", expiresAt);
    return res.json({ authenticated: true, expiresAt });
  }
  return res.status(401).json({ authenticated: false });
});

/* Apply CSRF protection to ALL routes */
app.use(csrfProtection);
app.use((req, res, next) => {
  res.locals.csrfToken = typeof req.csrfToken === "function" ? req.csrfToken() : "";
  next();
});

/* Login portal info: this app authenticates Fairtech only; the Sachiko
   option on the shared login switches the browser to the Sachiko app. */
app.use((req, res, next) => {
  res.locals.selfBrand = "fairdesk";
  res.locals.fairtechLoginUrl = "/fairtech/login";
  res.locals.sachikoLoginUrl = `${process.env.SACHIKO_URL || "http://localhost:3001"}/sachiko/login`;
  next();
});

/* Authenticated Image Serving */
app.get("/debug-image/:folder/:filename", async (req, res) => {
  const { folder, filename } = req.params;
  const filePath = path.join(dir_name, "images", folder, filename);
  if (fs.existsSync(filePath)) {
    return res.sendFile(filePath);
  }

  // Try alternate extension
  if (filename.toLowerCase().endsWith(".jpg") || filename.toLowerCase().endsWith(".jpeg")) {
    const base = filename.substring(0, filename.lastIndexOf("."));
    const altExt = filename.toLowerCase().endsWith(".jpg") ? ".jpeg" : ".jpg";
    const altPath = path.join(dir_name, "images", folder, base + altExt);
    if (fs.existsSync(altPath)) {
      return res.sendFile(altPath);
    }
  }

  res.status(404).send(`Not found on disk. Tried: ${filePath}`);
});

app.get("/images/:folder/:filename", requireAuth, async (req, res) => {
  const { folder, filename } = req.params;

  // Validate folder
  if (!["aadhaar", "pan", "empimg"].includes(folder)) {
    return res.status(400).send("Invalid folder");
  }

  // Validate filename (prevent directory traversal and arbitrary uploads)
  // Loosened to allow different naming conventions while still being safe
  if (!/^[\w\-. ]+\.(jpg|jpeg|png|gif|webp)$/i.test(filename)) {
    return res.status(400).send("Invalid filename");
  }

  // Check ACL - user can only view own images
  const fieldMap = {
    empimg: "empPhoto",
    aadhaar: "empAadhaarImg",
    pan: "empPanImg",
  };

  let employee = await Employee.findOne({
    [fieldMap[folder]]: filename,
  });

  // Handle common extension mismatch (.jpg vs .jpeg)
  if (!employee && (filename.toLowerCase().endsWith(".jpg") || filename.toLowerCase().endsWith(".jpeg"))) {
    const base = filename.substring(0, filename.lastIndexOf("."));
    const altExts = filename.toLowerCase().endsWith(".jpg") ? [".jpeg", ".JPG", ".JPEG"] : [".jpg", ".JPG", ".JPEG"];

    for (const ext of altExts) {
      employee = await Employee.findOne({ [fieldMap[folder]]: base + ext });
      if (employee) break;
    }
  }

  if (!employee) {
    console.warn(`[IMAGE] Not found in DB: ${folder}/${filename}`);
    return res.status(404).send("Not found");
  }

  // ACL - allow admin and HR to see everything.
  // Allow management (HOD, Sales) to see employee photos (empimg).
  // Everyone can see their own data.
  const authUser = req.session.authUser;
  const isAdmin = authUser.role === "admin" || authUser.role === "proprietor";
  const isHR = authUser.role === "hr";
  const isManagement = ["admin", "proprietor", "hr", "hod", "sales"].includes(authUser.role);
  const isOwnData = authUser.empId && authUser.empId === employee.empId;

  let allowed = false;
  if (isAdmin || isHR) {
    allowed = true;
  } else if (folder === "empimg" && isManagement) {
    allowed = true;
  } else if (isOwnData) {
    allowed = true;
  }

  if (!allowed) {
    console.warn(
      `[IMAGE] Access denied: user=${authUser.username} role=${authUser.role} folder=${folder} file=${filename}`,
    );
    return res.status(403).send("Forbidden");
  }

  // Serve with no-cache headers
  let filePath = path.join(dir_name, "images", folder, filename);

  if (!fs.existsSync(filePath)) {
    // Try alternate extension on disk if not found
    if (filename.toLowerCase().endsWith(".jpg") || filename.toLowerCase().endsWith(".jpeg")) {
      const base = filename.substring(0, filename.lastIndexOf("."));
      const altExt = filename.toLowerCase().endsWith(".jpg") ? ".jpeg" : ".jpg";
      const altPath = path.join(dir_name, "images", folder, base + altExt);

      if (fs.existsSync(altPath)) {
        filePath = altPath;
      } else {
        console.warn(`[IMAGE] File not on disk: ${filePath} (also tried ${altPath})`);
        return res.status(404).send("Not found");
      }
    } else {
      console.warn(`[IMAGE] File not on disk: ${filePath}`);
      return res.status(404).send("Not found");
    }
  }

  res.setHeader("Cache-Control", "private, no-cache, no-store");
  res.sendFile(filePath);
});

/* Image Thumbnail Route (Authenticated + Compressed) */
app.get("/images/thumb/:folder/:filename", requireAuth, async (req, res) => {
  const { folder, filename } = req.params;

  // Validate folder
  if (!["aadhaar", "pan", "empimg"].includes(folder)) {
    return res.status(400).send("Invalid folder");
  }

  // Validate filename
  if (!/^[\w\-. ]+\.(jpg|jpeg|png|gif|webp)$/i.test(filename)) {
    return res.status(400).send("Invalid filename");
  }

  // Check ACL
  const fieldMap = {
    empimg: "empPhoto",
    aadhaar: "empAadhaarImg",
    pan: "empPanImg",
  };

  let employee = await Employee.findOne({
    [fieldMap[folder]]: filename,
  });

  // Handle common extension mismatch (.jpg vs .jpeg)
  if (!employee && (filename.toLowerCase().endsWith(".jpg") || filename.toLowerCase().endsWith(".jpeg"))) {
    const base = filename.substring(0, filename.lastIndexOf("."));
    const altExts = filename.toLowerCase().endsWith(".jpg") ? [".jpeg", ".JPG", ".JPEG"] : [".jpg", ".JPG", ".JPEG"];

    for (const ext of altExts) {
      employee = await Employee.findOne({ [fieldMap[folder]]: base + ext });
      if (employee) break;
    }
  }

  if (!employee) return res.status(404).send("Not found");

  const authUser = req.session.authUser;
  const isAdmin = authUser.role === "admin" || authUser.role === "proprietor";
  const isHR = authUser.role === "hr";
  const isManagement = ["admin", "proprietor", "hr", "hod", "sales"].includes(authUser.role);
  const isOwnData = authUser.empId && authUser.empId === employee.empId;

  let allowed = false;
  if (isAdmin || isHR) {
    allowed = true;
  } else if (folder === "empimg" && isManagement) {
    allowed = true;
  } else if (isOwnData) {
    allowed = true;
  }

  if (!allowed) return res.status(403).send("Forbidden");

  const filePath = path.join(dir_name, "images", folder, filename);

  if (!fs.existsSync(filePath)) {
    return res.status(404).send("Not found");
  }

  try {
    const data = await sharp(filePath).resize(100, 100, { fit: "cover" }).jpeg({ quality: 80 }).toBuffer();

    res.set("Content-Type", "image/jpeg");
    res.set("Cache-Control", "private, max-age=3600"); // 1 hour, private cache
    res.send(data);
  } catch (err) {
    console.error("Image processing error:", err);
    res.sendFile(filePath); // Fallback to original
  }
});

/* ROUTES */
const redirectByRole = (role) => {
  if (["proprietor", "admin", "hod", "sales", "hr", "employee"].includes(role)) {
    return "/fairtech/welcome";
  }
  return "/fairtech/login";
};

// Operators sign in through their own portal and land straight on the queue of
// the machine they run (resolved from profile code + location at login), so
// they never have to navigate the main menus.
const landingForUser = (authUser) => {
  if (!authUser) return "/fairtech/login";
  if (authUser.role === "operator") {
    return authUser.machineId ? `/fairtech/machine/${authUser.machineId}/queue` : "/fairtech/machine/queue";
  }
  return redirectByRole(authUser.role);
};

app.get("/", (req, res) => {
  if (req.session?.authUser) {
    return res.redirect(landingForUser(req.session.authUser));
  }
  res.render("auth/login", { title: "Login", CSS: "login.css", csrfToken: req.csrfToken(), brand: "fairdesk" });
});

// Back-compat: old /login path now lives at /fairtech/login
app.get("/login", (req, res) => res.redirect("/fairtech/login"));

app.get("/fairtech/login", (req, res) => {
  if (req.session?.authUser) {
    return res.redirect(landingForUser(req.session.authUser));
  }
  // Ensure session is initialized by storing something minimal if needed
  // req.session.init = true;
  res.render("auth/login", { title: "Login", CSS: "login.css", brand: "fairdesk" });
});

// Permissions for the dev-only backdoor accounts. These used to hand every
// flag to every role, which made the HR account render the SKU, purchase,
// stock and sales-order menus -- so the test logins no longer resembled the
// roles they stand in for. A DB employee brings their own permissions instead.
const DEV_PERMISSIONS_BY_ROLE = {
  proprietor: { sales: true, inventory: true, hr: true, accounting: true, master: true },
  admin: { sales: true, inventory: true, hr: true, accounting: true, master: true },
  hod: { sales: true, inventory: true, hr: false, accounting: false, master: true },
  sales: { sales: true, inventory: true, hr: false, accounting: false, master: true },
  hr: { sales: false, inventory: false, hr: true, accounting: true, master: false },
};

app.post("/fairtech/login", loginLimiter, async (req, res) => {
  const { profileCode, username, password } = req.body;
  const loginCode = String(profileCode || username || "").trim();
  const brand = req.body.brand === "sachiko" ? "sachiko" : "fairdesk";
  const proprietorUser = process.env.PROPRIETOR_USER;
  const proprietorPass = process.env.PROPRIETOR_PASS;
  const adminUser = process.env.ADMIN_USER;
  const adminPass = process.env.ADMIN_PASS;
  const hrUser = process.env.HR_USER;
  const hrPass = process.env.HR_PASS;
  const hodUser = process.env.HOD_USER;
  const hodPass = process.env.HOD_PASS;
  const salesUser = process.env.SALES_USER;
  const salesPass = process.env.SALES_PASS;

  // Prevent hardcoded backdoor credentials in production
  if (process.env.NODE_ENV === "production") {
    const hasProprietorCreds = proprietorUser && proprietorPass;
    const hasAdminCreds = adminUser && adminPass;
    const hasHrCreds = hrUser && hrPass;
    const hasHodCreds = hodUser && hodPass;
    const hasSalesCreds = salesUser && salesPass;

    if (hasProprietorCreds || hasAdminCreds || hasHrCreds || hasHodCreds || hasSalesCreds) {
      console.error("❌ SECURITY ERROR: Hardcoded backdoor credentials detected in production environment!");
      console.error(
        "❌ Remove PROPRIETOR_USER, PROPRIETOR_PASS, ADMIN_USER, ADMIN_PASS, HR_USER, HR_PASS, HOD_USER, HOD_PASS, SALES_USER, SALES_PASS from .env",
      );
      process.exit(1);
    }
  }

  if (!loginCode || !password) {
    return res.status(400).render("auth/login", {
      title: "Login",
      CSS: "login.css",
      profileCode: loginCode,
      password,
      brand,
      error: ["Please enter your credentials."],
    });
  }

  // In production, skip backdoor checks (already validated they don't exist above)
  const envProprietorUser = proprietorUser?.trim();
  const envProprietorPass = proprietorPass?.trim();
  const envAdminUser = adminUser?.trim();
  const envAdminPass = adminPass?.trim();
  const envHrUser = hrUser?.trim();
  const envHrPass = hrPass?.trim();
  const envHodUser = hodUser?.trim();
  const envHodPass = hodPass?.trim();
  const envSalesUser = salesUser?.trim();
  const envSalesPass = salesPass?.trim();

  const isProprietor =
    process.env.NODE_ENV !== "production" &&
    envProprietorUser &&
    envProprietorPass &&
    loginCode === envProprietorUser &&
    password === envProprietorPass;
  const isAdmin =
    process.env.NODE_ENV !== "production" &&
    envAdminUser &&
    envAdminPass &&
    loginCode === envAdminUser &&
    password === envAdminPass;
  const isHr =
    process.env.NODE_ENV !== "production" &&
    envHrUser &&
    envHrPass &&
    loginCode === envHrUser &&
    password === envHrPass;
  const isHod =
    process.env.NODE_ENV !== "production" &&
    envHodUser &&
    envHodPass &&
    loginCode === envHodUser &&
    password === envHodPass;
  const isSales =
    process.env.NODE_ENV !== "production" &&
    envSalesUser &&
    envSalesPass &&
    loginCode === envSalesUser &&
    password === envSalesPass;

  const processLogin = async (authUser) => {
    req.session.authUser = authUser;
    return req.session.save((err) => {
      if (err) {
        console.error("Failed to persist session on login:", err);
        return res.status(500).render("auth/login", {
          title: "Login",
          CSS: "login.css",
          profileCode: loginCode,
          brand,
          error: ["Unable to start session. Please try again."],
        });
      }
      logAuthEvent(authUser, "LOGIN", req);
      return res.redirect(landingForUser(authUser));
    });
  };

  if (isProprietor || isAdmin || isHr || isHod || isSales) {
    const role = isProprietor ? "proprietor" : isAdmin ? "admin" : isHr ? "hr" : isHod ? "hod" : "sales";
    return processLogin({
      username: loginCode,
      role,
      permissions: DEV_PERMISSIONS_BY_ROLE[role],
      profileCode: loginCode,
      empName: loginCode,
    });
  }

  const trimmedUser = loginCode;
  const trimmedPass = String(password || "").trim();

  // Fallback to database check
  try {
    const employee = await Employee.findOne({
      empProfileCode: { $regex: new RegExp(`^${escapeRegex(trimmedUser)}$`, "i") },
      isActive: true,
    });

    if (employee && (await employee.comparePassword(trimmedPass))) {
      if (employee.role === "none") {
        return res.status(403).render("auth/login", {
          title: "Login",
          CSS: "login.css",
          profileCode: loginCode,
          brand,
          error: ["Your account is disabled. Please contact admin."],
        });
      }
      return processLogin({
        username: employee.empName,
        empName: employee.empName,
        profileCode: employee.empProfileCode,
        role: employee.role || "employee",
        permissions: employee.permissions,
        empId: employee.empId,
        empPhoto: employee.empPhoto,
      });
    }
  } catch (err) {
    console.error("Login database error:", err);
  }

  return res.status(401).render("auth/login", {
    title: "Login",
    CSS: "login.css",
    profileCode: loginCode,
    password,
    brand,
    error: ["Invalid username or password."],
  });
});

/* OPERATOR PORTAL
   Shopfloor operators sign in with the three things they know -- their profile
   code (the name of the machine they run), their location and their password --
   and land on that machine's queue. Kept separate from the staff login so the
   terminal on the floor never shows the full portal. */
app.get("/fairtech/operator/login", async (req, res) => {
  if (req.session?.authUser) {
    return res.redirect(landingForUser(req.session.authUser));
  }
  const locations = await Location.find({}).sort({ locationName: 1 }).lean();
  res.render("auth/operatorLogin", { title: "Operator Login", CSS: "login.css", locations });
});

app.post("/fairtech/operator/login", loginLimiter, async (req, res) => {
  const profileCode = String(req.body.profileCode || "").trim();
  const locationName = normalizeLocationName(req.body.location);
  const password = String(req.body.password || "").trim();

  const fail = async (message, status = 401) => {
    const locations = await Location.find({}).sort({ locationName: 1 }).lean();
    return res.status(status).render("auth/operatorLogin", {
      title: "Operator Login",
      CSS: "login.css",
      locations,
      profileCode,
      selectedLocation: locationName,
      error: [message],
    });
  };

  if (!profileCode || !locationName || !password) {
    return fail("Please fill in all three fields.", 400);
  }

  try {
    // Profile code alone isn't unique -- the same machine name can exist at more
    // than one location -- so match on code + location together, the same pairing
    // the machine queue uses to link an operator to a machine.
    const candidates = await Employee.find({
      empProfileCode: { $regex: new RegExp(`^${escapeRegex(profileCode)}$`, "i") },
      isActive: true,
    });
    const employee = candidates.find((emp) => normalizeLocationName(emp.empLoc) === locationName);

    if (!employee || !(await employee.comparePassword(password))) {
      return fail("Invalid profile code, location or password.");
    }
    // The profile itself is the gate here -- operators carry role "none" (no
    // staff-portal access), which is exactly why this portal exists. Whether
    // the account is live is decided by isActive in the query above.
    if (String(employee.empProfile || "").trim().toUpperCase() !== "OPERATOR") {
      return fail("This login is for operators only. Please use the staff login.", 403);
    }

    // Resolve the machine this operator runs so we can drop them on its queue.
    const location = await Location.findOne({ locationName }).select("_id").lean();
    const machine = location
      ? await Machine.findOne({
          machineName: String(employee.empProfileCode).trim().toUpperCase(),
          location: location._id,
        })
          .select("_id")
          .lean()
      : null;

    const authUser = {
      username: employee.empName,
      empName: employee.empName,
      profileCode: employee.empProfileCode,
      role: "operator",
      permissions: employee.permissions,
      empId: employee.empId,
      empPhoto: employee.empPhoto,
      empLoc: employee.empLoc,
      machineId: machine ? String(machine._id) : null,
    };

    req.session.authUser = authUser;
    return req.session.save((err) => {
      if (err) {
        console.error("Failed to persist session on operator login:", err);
        return fail("Unable to start session. Please try again.", 500);
      }
      logAuthEvent(authUser, "LOGIN", req);
      return res.redirect(landingForUser(authUser));
    });
  } catch (err) {
    console.error("Operator login error:", err);
    return fail("Something went wrong. Please try again.", 500);
  }
});

app.get("/logout", (req, res) => {
  const authUser = req.session?.authUser;
  if (authUser) logAuthEvent(authUser, "LOGOUT", req);
  // Send operators back to their own portal, not the staff login.
  const loginUrl = authUser?.role === "operator" ? "/fairtech/operator/login" : "/fairtech/login";
  req.session.destroy(() => {
    res.clearCookie("fairdesk.sid");
    res.redirect(loginUrl);
  });
});
app.use("/fairtech/payroll", requireAuth, requireRole(["proprietor", "admin", "hr"]), payrollRoute);

/* PROFILE / ACCOUNT SECURITY - Accessible to all roles */
app.post("/fairtech/profile/password", requireAuth, async (req, res) => {
  try {
    const { oldPassword, newPassword, confirmPassword } = req.body;
    const authUser = req.session.authUser;

    if (!authUser || !authUser.empId) {
      return res.status(403).json({
        success: false,
        message: "System accounts (managed via configuration) cannot change password via profile modal.",
      });
    }

    const employee = await Employee.findOne({ empId: authUser.empId });
    if (!employee) {
      return res.status(404).json({ success: false, message: "Employee record not found." });
    }

    const isMatch = await employee.comparePassword(String(oldPassword || "").trim());
    if (!isMatch) {
      return res.status(400).json({ success: false, message: "Current password is incorrect." });
    }

    if (confirmPassword !== undefined && newPassword !== confirmPassword) {
      return res.status(400).json({ success: false, message: "New password and confirmation do not match." });
    }

    employee.password = newPassword;
    await employee.save();

    res.json({ success: true, message: "Password updated successfully!" });
  } catch (err) {
    console.error("PASSWORD CHANGE ERROR:", err);
    res.status(500).json({ success: false, message: "Server error during password update." });
  }
});

app.use("/fairtech/loan", requireAuth, requireRole(["proprietor", "admin", "hr"]), loanRoute);
app.use("/fairtech/advance", requireAuth, requireRole(["proprietor", "admin", "hr"]), advanceRoute);
app.use("/fairtech/employee", requireAuth, requireRole(["proprietor", "admin", "hr", "sales"]), employeeRoute);
app.use("/fairtech/simcard", requireAuth, requireRole(["proprietor", "admin", "hr"]), simCardRoute);
app.use("/fairtech/pettycash", requireAuth, requireRole(["proprietor", "admin", "hr", "sales"]), pettycashRoute);

app.use(
  "/fairtech/client",
  requireAuth,
  requireRole(["proprietor", "admin", "hod", "sales", "master"]),
  clientFormRoute,
);

// Mounted ahead of the other "/fairtech" routers so operators reach their
// machine queue before fairdeskRoute's requireRole turns them away. Because a
// path-prefixed app.use runs its middleware for EVERY /fairtech/* request --
// not just the paths this router handles -- there must be no requireRole here:
// it would 403 hr/sales on their own pages before the request ever fell
// through. The roles are enforced per route inside the router instead.
app.use("/fairtech", requireAuth, machineRoutes);

app.use("/fairtech", requireAuth, requireRole(["proprietor", "admin", "hod", "sales", "hr"]), fairdeskRoute);
app.use("/fairtech", requireAuth, requireRole(["proprietor", "admin", "hod", "sales"]), tapeBindingRoutes);
app.use("/fairtech", requireAuth, requireRole(["proprietor", "admin", "hod", "sales"]), posRollBindingRoutes);
app.use("/fairtech", requireAuth, requireRole(["proprietor", "admin", "hod", "sales"]), tafetaBindingRoutes);
app.use("/fairtech", requireAuth, requireRole(["proprietor", "admin", "hod", "sales"]), ttrBindingRoutes);
app.use("/fairtech", requireAuth, requireRole(["proprietor", "admin", "hod", "sales"]), vendorItemBindingRoutes);
app.use("/fairtech/tapestock", requireAuth, requireRole(["proprietor", "admin", "hod", "sales"]), tapeStockRoutes);
app.use(
  "/fairtech/posrollstock",
  requireAuth,
  requireRole(["proprietor", "admin", "hod", "sales"]),
  posRollStockRoutes,
);
app.use("/fairtech/tafetastock", requireAuth, requireRole(["proprietor", "admin", "hod", "sales"]), tafetaStockRoutes);
app.use("/fairtech/ttrstock", requireAuth, requireRole(["proprietor", "admin", "hod", "sales"]), ttrStockRoutes);
app.use(
  "/fairtech/paperstock",
  requireAuth,
  requireRole(["proprietor", "admin", "hod", "sales", "hr"]),
  paperStockRoutes,
);
app.use("/fairtech/stocks", requireAuth, requireRole(["proprietor", "admin", "hod", "sales"]), stockViewRoutes);
app.use("/fairtech/inventory", requireAuth, requireRole(["proprietor", "admin", "hod", "sales"]), reorderRoutes);

/* 404 */
app.all("*", (req, res) => {
  if (req.xhr || req.headers.accept?.includes("application/json")) {
    return res.status(404).json({ error: "Not found" });
  }
  const homeUrl = landingForUser(req.session?.authUser);
  const homeLabel = req.session?.authUser ? "Back to Dashboard" : "Go to Login";
  res.status(404).render("errors/notFound", { title: "Page Not Found", CSS: false, JS: false, homeUrl, homeLabel });
});

/* ERROR HANDLER */
app.use((err, req, res, next) => {
  if (err.code === "EBADCSRFTOKEN") {
    console.warn(`[CSRF] Invalid token on ${req.method} ${req.originalUrl} from ${req.ip}`);
    if (req.xhr || req.headers.accept?.includes("json")) {
      return res.status(403).json({ success: false, message: "Your session ended. Please sign in again." });
    }
    return res.redirect("/fairtech/login?reason=session-ended");
  }
  console.error("[Error Handler]", err);
  const status = err.statusCode || 500;
  const message = status === 500 && process.env.NODE_ENV === "production" ? "Something went wrong" : err.message;
  res.status(status).send(message);
});

/* Get dynamic IP address */
const networkInterfaces = os.networkInterfaces();
const ip =
  Object.values(networkInterfaces)
    .flat()
    .find((info) => info.family === "IPv4" && !info.internal)?.address || "localhost";

app.listen(port, "0.0.0.0", () => {
  console.log(`Server running on http://${ip}:${port}`);
});
