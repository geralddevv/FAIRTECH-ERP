const wantsJson = (req) => req.xhr || req.headers.accept?.includes("application/json");

// Operators sign in at their own portal and have no staff account, so a missing
// or expired session on an operator page has to send them back to the operator
// login -- the staff login is a dead end for them. These middlewares run inside
// routers mounted at /fairtech, so req.path is mount-relative; originalUrl is
// the only reliable view of what was actually asked for.
const OPERATOR_PORTAL_PREFIX = "/fairtech/operator";

const loginUrlFor = (req) => {
  if (req.session?.authUser?.role === "operator") return "/fairtech/operator/login";
  const target = String(req.originalUrl || "").split("?")[0];
  return target.startsWith(OPERATOR_PORTAL_PREFIX) ? "/fairtech/operator/login" : "/fairtech/login";
};

export const requireAuth = (req, res, next) => {
  if (!req.session?.authUser) {
    if (wantsJson(req)) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    return res.redirect(loginUrlFor(req));
  }
  next();
};

export const requireRole = (roles) => (req, res, next) => {
  if (!req.session?.authUser) {
    if (wantsJson(req)) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    return res.redirect(loginUrlFor(req));
  }
  if (!roles.includes(req.session.authUser.role)) {
    if (wantsJson(req)) {
      return res.status(403).json({ error: "Forbidden" });
    }
    return res.status(403).render("errors/accessDenied", {
      title: "Access Denied",
      CSS: false,
      JS: false,
      roleLabel: String(req.session.authUser.role || "").toUpperCase(),
    });
  }
  next();
};
