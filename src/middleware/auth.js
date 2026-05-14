const jwt = require("jsonwebtoken");
const { users } = require("../models/db");
const { PLANS } = require("../config/constants");

function verifyToken(token) {
  return jwt.verify(token, process.env.JWT_SECRET);
}

function extractToken(req) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) return null;
  return authHeader.slice(7).trim() || null;
}

function requireAuth(req, res, next) {
  const token = extractToken(req);
  if (!token) {
    return res.status(401).json({ error: "Authentication required" });
  }
  try {
    const decoded = verifyToken(token);
    const user = users.findById(decoded.id);
    if (!user) {
      return res.status(401).json({ error: "User no longer exists" });
    }
    if (user.suspended) {
      return res.status(403).json({ error: "Account is suspended" });
    }
    req.user = { id: user.id, email: user.email };
    next();
  } catch (err) {
    if (err.name === "TokenExpiredError") {
      return res.status(401).json({ error: "Token expired" });
    }
    return res.status(401).json({ error: "Invalid token" });
  }
}

function requireAdmin(req, res, next) {
  requireAuth(req, res, (err) => {
    if (err) return next(err);
    // Defense in depth: requireAuth is the only path that populates req.user,
    // but if anyone ever refactors it to call `next()` without setting the
    // user object the admin check below would dereference undefined. Fail
    // closed and re-verify here rather than trusting upstream state.
    if (!req.user || !req.user.id) {
      return res.status(401).json({ error: "Authentication required" });
    }
    const user = users.findById(req.user.id);
    if (!user) {
      return res.status(401).json({ error: "User no longer exists" });
    }
    if (user.suspended) {
      return res.status(403).json({ error: "Account is suspended" });
    }
    if (user.plan !== PLANS.ADMIN) {
      return res.status(403).json({ error: "Admin access required" });
    }
    req.user.plan = user.plan;
    next();
  });
}

function optionalAuth(req, res, next) {
  const token = extractToken(req);
  if (!token) {
    req.user = null;
    return next();
  }
  try {
    const decoded = verifyToken(token);
    req.user = { id: decoded.id, email: decoded.email };
  } catch {
    req.user = null;
  }
  next();
}

module.exports = {
  requireAuth,
  requireAdmin,
  optionalAuth,
  authMiddleware: requireAuth,
};
