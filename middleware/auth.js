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
