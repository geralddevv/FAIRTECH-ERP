import rateLimit, { ipKeyGenerator } from "express-rate-limit";

// Shared by the per-user limiters below: prefer the session-authenticated user,
// then the bearer-token API user (mobile operator app sets req.authUser, not
// req.session.authUser), falling back to IP only when neither is present.
const authKeyGenerator = (req, res) =>
  req.session?.authUser?.empId || req.authUser?.empId || ipKeyGenerator(req, res);

// Per-IP limiter for login (unauthenticated users)
export const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 20, // Limit each IP to 20 login requests per window
  message: "Too many login attempts, please try again after 15 minutes",
  standardHeaders: true,
  legacyHeaders: false,
});

// Per-user limiters for authenticated data routes
export const createLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 10,
  message: "Too many create requests. Please try again later.",
  keyGenerator: authKeyGenerator,
  standardHeaders: true,
  legacyHeaders: false,
});

export const updateLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 30,
  message: "Too many update requests. Please try again later.",
  keyGenerator: authKeyGenerator,
  standardHeaders: true,
  legacyHeaders: false,
});

export const deleteLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 5,
  message: "Too many delete requests. Please try again later.",
  keyGenerator: authKeyGenerator,
  standardHeaders: true,
  legacyHeaders: false,
});
