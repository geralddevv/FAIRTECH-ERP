# FairDesk Security — Critical Fixes (TL;DR)

## DO THESE FIRST (This Week)

### 1. Fix NoSQL Injection in Login
**File:** `server.js` line 282  
**Change:**
```javascript
// BEFORE (vulnerable):
empProfileCode: { $regex: new RegExp(`^${trimmedUser}$`, "i") }

// AFTER (fixed):
import { escapeRegex } from "../utils/security.js";
empProfileCode: { $regex: new RegExp(`^${escapeRegex(trimmedUser)}$`, "i") }
```

---

### 2. Implement Password Hashing
**Files:** `server.js` line 282-288, `models/hr/employee_model.js`

**Install:**
```bash
npm install bcrypt
```

**Login endpoint (server.js):**
```javascript
import bcrypt from "bcrypt";

// Instead of:
const employee = await Employee.findOne({
  empProfileCode: { ... },
  password: trimmedPass,  // ← WRONG
});

// Do this:
const employee = await Employee.findOne({
  empProfileCode: { ... },
});
if (employee && await bcrypt.compare(trimmedPass, employee.password)) {
  // Login success
}
```

**On password create/update:**
```javascript
import bcrypt from "bcrypt";

const hashedPassword = await bcrypt.hash(plainPassword, 12);
employee.password = hashedPassword;
await employee.save();
```

---

### 3. Delete cookies.txt & Regenerate Sessions
```bash
# Remove from git immediately
git rm --cached cookies.txt

# Flush all sessions
# In MongoDB:
db.collection('sessions').deleteMany({});

# In code:
sessionStore.clear();
```

---

### 4. Fix Hardcoded SESSION_SECRET Fallback
**File:** `server.js` line 123

```javascript
// BEFORE:
secret: process.env.SESSION_SECRET || "fd_k9#xP2$mR9Qz7wL5vN8uY3hB1jK4_production_fallback"

// AFTER:
secret: process.env.SESSION_SECRET || (() => {
  if (!process.env.SESSION_SECRET) {
    throw new Error("CRITICAL: SESSION_SECRET must be set in .env file");
  }
})()

// Or better:
const sessionSecret = process.env.SESSION_SECRET;
if (!sessionSecret) {
  console.error("❌ CRITICAL: SESSION_SECRET not set in .env");
  process.exit(1);
}
const sessionConfig = { secret: sessionSecret, ... };
```

**In .env:**
```
SESSION_SECRET=generate-at-least-32-random-characters-here-using-crypto
```

---

### 5. Add CSRF Protection to Login
**File:** `server.js` line 196-230  

```javascript
// BEFORE: CSRF skipped for POST /login
if (isLoginPath && req.method === "POST") {
  return next();  // ← SKIPPED
}

// AFTER: Protect login like everything else
// Remove the exemption above. Let csrfProtection apply to all routes.
```

**Update login form (`views/auth/login.ejs`):**
```html
<form method="POST" action="/login">
  <input type="hidden" name="_csrf" value="<%= csrfToken %>">
  <input type="text" name="profileCode" placeholder="Profile Code" required>
  <input type="password" name="password" placeholder="Password" required>
  <button type="submit">Login</button>
</form>
```

**Server login routes:**
```javascript
// GET /login - generate CSRF token
app.get("/login", csrfProtection, (req, res) => {
  res.render("auth/login", { 
    title: "Login", 
    CSS: "login.css",
    csrfToken: req.csrfToken()  // ← Pass to view
  });
});

// POST /login - require CSRF token
app.post("/login", csrfProtection, loginLimiter, async (req, res) => {
  // ... login logic
});
```

---

### 6. Add Authentication Middleware
**Create file:** `middleware/auth.js`

```javascript
export const requireAuth = (req, res, next) => {
  if (!req.session?.authUser) {
    if (req.xhr || req.headers.accept?.includes("application/json")) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    return res.redirect("/login");
  }
  next();
};

export const requireRole = (roles) => (req, res, next) => {
  if (!req.session?.authUser) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  if (!roles.includes(req.session.authUser.role)) {
    return res.status(403).json({ error: "Forbidden" });
  }
  next();
};
```

**Apply to all protected routes** (`server.js`):
```javascript
import { requireAuth, requireRole } from "./middleware/auth.js";

// Protect all data routes
app.use("/fairdesk", requireAuth, fairdeskRoute);
app.use("/accounting", requireAuth, accountingRoute);
app.use("/hr", requireAuth, employeeRoute);
// ... etc
```

---

## DO THESE NEXT (Next 2 Weeks)

### 7. Fix File Upload MIME Type Bypass
**File:** `routes/hr/employee.js` line 31-35

```javascript
import path from "path";

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
```

---

### 8. Protect Image Serving
**File:** `server.js` line 87 (replace `app.use("/images", ...))`)

```javascript
// Remove this line:
// app.use("/images", express.static(...));

// Add authenticated endpoint instead:
app.get("/images/:folder/:filename", requireAuth, async (req, res) => {
  const { folder, filename } = req.params;
  
  // Validate folder
  if (!["aadhaar", "pan", "empimg"].includes(folder)) {
    return res.status(400).send("Invalid folder");
  }
  
  // Validate filename (prevent directory traversal)
  if (!/^[a-f0-9]{32}\.(jpg|jpeg|png|gif|webp)$/.test(filename)) {
    return res.status(400).send("Invalid filename");
  }
  
  // Check ACL - user can only view own images
  const employee = await Employee.findOne({
    [folder === "empimg" ? "empPhoto" : folder === "aadhaar" ? "empAadhaarImg" : "empPanImg"]: filename
  });
  
  if (!employee) return res.status(404).send("Not found");
  
  // Only admin or the employee themselves can view
  const isOwnData = req.session.authUser.empId === employee.empId;
  const isAdmin = req.session.authUser.role === "admin";
  if (!isOwnData && !isAdmin) {
    return res.status(403).send("Forbidden");
  }
  
  // Serve with no-cache headers
  const filePath = path.join(dir_name, "images", folder, filename);
  res.setHeader("Cache-Control", "private, no-cache, no-store");
  res.sendFile(filePath);
});
```

**Also update file storage to use random names:**
```javascript
// In routes/hr/employee.js
import { randomBytes } from "crypto";

const storage = multer.diskStorage({
  destination: ...,
  filename: (req, file, cb) => {
    const randomName = randomBytes(16).toString("hex") + path.extname(file.originalname);
    cb(null, randomName);
  }
});
```

---

### 9. Add Rate Limiting to Data Routes
**File:** `server.js` (after loginLimiter definition)

```javascript
const createLimiter = rateLimit({
  windowMs: 60 * 1000,  // 1 minute
  max: 10,
  message: "Too many create requests from this IP",
  standardHeaders: true,
  legacyHeaders: false,
});

const updateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
});

const deleteLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
});

// Apply to routes:
router.post("/form/tape", requireAuth, createLimiter, ...);
router.post("/edit/tape", requireAuth, updateLimiter, ...);
router.post("/delete/tape", requireAuth, deleteLimiter, ...);
// ... etc
```

---

### 10. Add Input Validation
**Install:**
```bash
npm install joi
```

**Example** (`routes/inventory/tape.js`):
```javascript
import Joi from "joi";

const tapeSchema = Joi.object({
  tapeProductId: Joi.string().max(100).required(),
  tapePaperCode: Joi.string().max(50).required(),
  tapeGsm: Joi.number().integer().min(0).max(500).required(),
  tapeWidth: Joi.number().min(0).max(2000).required(),
  tapeMtrs: Joi.number().min(0).max(100000).required(),
  tapeFinish: Joi.string().valid("MATTE", "GLOSSY", "SEMI-GLOSS").required(),
  // ... more fields
});

router.post("/form/tape", requireAuth, async (req, res) => {
  const { error, value } = tapeSchema.validate(req.body);
  if (error) {
    return res.status(400).json({ error: error.details[0].message });
  }
  
  // Use validated 'value', not req.body
  const tape = new Tape(value);
  await tape.save();
  
  res.json({ success: true, id: tape._id });
});
```

---

## DO THESE IN 2-4 WEEKS (Medium Priority)

### 11. Enable HSTS & Security Headers
**File:** `server.js` (helmet config)

```javascript
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "cdn.jsdelivr.net"],
      styleSrc: ["'self'", "cdnjs.cloudflare.com"],
      imgSrc: ["'self'", "data:"],
    }
  },
  frameguard: { action: "deny" },
  noSniff: true,
  referrerPolicy: { policy: "strict-origin-when-cross-origin" },
  strictTransportSecurity: {
    maxAge: 31536000,  // 1 year
    includeSubDomains: true,
    preload: true,
  },
  permissionsPolicy: {
    camera: [],
    microphone: [],
    geolocation: [],
  },
}));
```

---

### 12. Remove Images from Git
```bash
git rm --cached images/
echo "images/" >> .gitignore
git commit -m "Remove PII from repo"

# (Optional) Rewrite history if already in production:
# npx git-filter-repo --path images/ --invert-paths
```

---

### 13. Disable Hardcoded Admin Backdoor in Production
**File:** `server.js` line 241-248

```javascript
// Check if backdoor should even be enabled
if (process.env.NODE_ENV === "production") {
  const hasAdminCreds = process.env.ADMIN_USER && process.env.ADMIN_PASS;
  if (hasAdminCreds) {
    console.error("❌ SECURITY ERROR: Hardcoded admin credentials must not be set in production!");
    process.exit(1);
  }
  // Skip all isAdmin/isHr/etc checks in prod
}
```

---

### 14. Set Up Dependency Scanning
```bash
npm install --save-dev snyk npm-audit-resolver

# In package.json:
"scripts": {
  "audit": "npm audit --audit-level=moderate && snyk test",
  "audit:fix": "npm audit fix && snyk fix"
}

# Run weekly:
npm run audit
```

---

## Verification Checklist

After fixes, verify:

- [ ] `bcrypt` is installed and passwords hash on create/update
- [ ] Login endpoint uses `escapeRegex()`
- [ ] `cookies.txt` deleted and sessions regenerated
- [ ] `.env` file required; `SESSION_SECRET` validated on startup
- [ ] CSRF token in login form; protected on both GET & POST
- [ ] `requireAuth` middleware applied to all protected routes
- [ ] File uploads validate extension + MIME type
- [ ] Images served through authenticated endpoint with ACL check
- [ ] `randomBytes()` used for filenames (no timestamps)
- [ ] Rate limiters on data-modifying routes
- [ ] Input validation with Joi on all forms
- [ ] HSTS header present
- [ ] Admin backdoor disabled in production
- [ ] `npm audit` runs cleanly
- [ ] `.gitignore` includes `images/`, `cookies.txt`, `.env.local`, `db_dump.json`

---

## Testing

```bash
# Test NoSQL injection is fixed
curl -X POST http://localhost:3000/login \
  -H "Content-Type: application/json" \
  -d '{"profileCode": ".*", "password": "test"}'
# Should NOT login with regex trick

# Test CSRF protection
curl -X POST http://localhost:3000/login \
  -H "Content-Type: application/json" \
  -d '{"profileCode": "admin", "password": "pass"}'
# Should fail with CSRF error

# Test auth middleware
curl -X GET http://localhost:3000/fairdesk/clients
# Should redirect to /login

# Test rate limiting
for i in {1..15}; do curl http://localhost:3000/fairdesk/create-tape; done
# Request 15 should be rate-limited

# Test file upload
curl -F "empPhoto=@/etc/passwd" http://localhost:3000/upload
# Should reject non-image file
```

---

## Support & References

**OWASP Top 10:** https://owasp.org/www-project-top-ten/  
**CWE-912 (Plaintext Passwords):** https://cwe.mitre.org/data/definitions/912.html  
**CWE-943 (NoSQL Injection):** https://cwe.mitre.org/data/definitions/943.html  
**Bcrypt Guide:** https://stackoverflow.com/questions/14621209/how-to-securely-hash-passwords  
**Helmet.js:** https://helmetjs.github.io/  

---

**Questions?** Review the full `SECURITY_ANALYSIS.md` for detailed explanations.