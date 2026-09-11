import rateLimit, { ipKeyGenerator } from "express-rate-limit";

// Shared by the per-user limiters below: prefer the session-authenticated user,
// then the bearer-token API user (mobile operator app sets req.authUser, not
// req.session.authUser), falling back to IP only when neither is present.
const authKeyGenerator = (req, res) =>
  req.session?.authUser?.empId || req.authUser?.empId || ipKeyGenerator(req, res);

// Every masters-page edit/create/delete dialog across the app (see "CSRF" in
// CLAUDE.md) submits via fetch() and unconditionally does `await res.json()`
// on the response. express-rate-limit's own default handler replies with
// `res.send(message)` -- plain text/HTML, not JSON -- so once a limiter's cap
// is hit, that `res.json()` throws a SyntaxError client-side. The dialog's
// catch block then shows a generic "Server error. Please try again." with no
// page reload, which reads exactly like "the edit didn't apply" even though
// the real cause is a request that was never sent to the route at all (it was
// rejected here, one layer up). A user doing several quick edits in a row --
// e.g. batch-correcting a run of Paper Master rows -- is exactly the case
// most likely to hit this. Giving every limiter a JSON handler keeps that
// failure legible instead of silently unparseable.
const jsonLimitHandler = (req, res, next, options) => {
  res.status(options.statusCode).json({ success: false, message: options.message });
};

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
  handler: jsonLimitHandler,
});

export const updateLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 30,
  message: "Too many update requests. Please try again later.",
  keyGenerator: authKeyGenerator,
  standardHeaders: true,
  legacyHeaders: false,
  handler: jsonLimitHandler,
});

export const deleteLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 5,
  message: "Too many delete requests. Please try again later.",
  keyGenerator: authKeyGenerator,
  standardHeaders: true,
  legacyHeaders: false,
  handler: jsonLimitHandler,
});
