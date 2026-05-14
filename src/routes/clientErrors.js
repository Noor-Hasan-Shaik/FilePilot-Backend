const express = require("express");
const rateLimit = require("express-rate-limit");
const router = express.Router();

const { errorLogs } = require("../models/db");
const { optionalAuth } = require("../middleware/auth");
const logger = require("../utils/logger");

// Tight cap — error reporters that get into a loop must not be allowed to
// flood the DB or our log shipping. 60/min/IP is enough for normal browsing
// even if the user opens many tabs.
const clientErrorLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many error reports" },
});

const MAX_FIELD = 2000;
const MAX_STACK = 8000;

function safeString(value, max) {
  if (typeof value !== "string") return null;
  return value.slice(0, max);
}

router.post("/", clientErrorLimiter, optionalAuth, (req, res) => {
  try {
    const body = req.body || {};
    const message = safeString(body.message, MAX_FIELD);
    if (!message) {
      return res.status(400).json({ error: "message is required" });
    }
    const route = safeString(body.route, MAX_FIELD) || req.get("Referer") || null;
    const stack = safeString(body.stack, MAX_STACK);
    const tool = safeString(body.tool, MAX_FIELD);
    const userAgent = req.get("User-Agent") || null;

    // We store everything in `error_logs.message` as JSON so the existing
    // admin error view shows the full context inline.
    const payload = JSON.stringify({
      message,
      route,
      stack: stack || undefined,
      userAgent,
      source: "client",
    });

    errorLogs.create({
      message: payload.slice(0, MAX_STACK + MAX_FIELD * 2),
      tool: tool || route || "client",
      user_id: req.user?.id || null,
    });
    res.json({ success: true });
  } catch (e) {
    logger.warn("Client error endpoint failed", { error: e.message });
    // Never propagate — we don't want a logging endpoint to itself become
    // a source of 5xx that clients then report again in a loop.
    res.json({ success: false });
  }
});

module.exports = router;
