const express = require("express");
const router = express.Router();

const { users, usage, errorLogs, siteSettings, plans } = require("../models/db");
const { optionalAuth, requireAdmin } = require("../middleware/auth");
const { STATS_CACHE_TTL } = require("../config/constants");
const { guestKey } = require("../utils/guestKey");

function guestDailyLimit() {
  const v = siteSettings.getValue("limits.guest_daily", 3);
  return Number.isFinite(Number(v)) ? Number(v) : 3;
}

function freeDailyLimit() {
  const v = siteSettings.getValue("limits.free_user_daily", 5);
  return Number.isFinite(Number(v)) ? Number(v) : 5;
}

// Resolve the daily ceiling for a request. Guests use the site-level
// `limits.guest_daily` setting; authenticated users fall back to whatever
// `plans.daily_limit` says for their plan, which is the source of truth for
// every paid tier (a value of 0 or negative means "unlimited").
function resolveDailyLimit(userId) {
  if (!userId) return guestDailyLimit();

  const user = users.findById(userId);
  const planName = user?.plan || "free";

  // Admins are never capped by the daily limit.
  if (planName === "admin") return Infinity;

  const plan = plans.findByName(planName);
  if (!plan) {
    // Unknown plan name on the user row — treat as free so we don't accidentally
    // open the gates for a malformed record.
    return freeDailyLimit();
  }

  const limit = Number(plan.daily_limit);
  if (!Number.isFinite(limit) || limit <= 0) return Infinity;
  return limit;
}

let cachedStats = null;
let lastFetch = 0;

// Track Tool Usage
router.post("/track", optionalAuth, (req, res, next) => {
  try {
    const { tool } = req.body;
    if (!tool || typeof tool !== "string") {
      return res.status(400).json({ error: "Tool name is required" });
    }

    const userId = req.user?.id || null;
    const today = new Date().toISOString().slice(0, 10);
    const key = userId || guestKey(req);

    usage.upsertDaily(tool, key, today);

    const io = req.app.get("io");
    if (io) io.emit("usageUpdated");

    res.json({ success: true });
  } catch (err) {
    errorLogs.create({ message: err.message, tool: "track", user_id: req.user?.id || null });
    next(err);
  }
});

// Check Daily Limit (uses authenticated user when available, otherwise guest)
router.post("/check-limit", optionalAuth, (req, res, next) => {
  try {
    const userId = req.user?.id || null;
    const today = new Date().toISOString().slice(0, 10);
    const key = userId || guestKey(req);

    const total = usage.totalForUserOnDate(key, today);
    const limit = resolveDailyLimit(userId);

    if (limit === Infinity) {
      return res.json({ canProcess: true, remaining: -1, unlimited: true });
    }
    if (total >= limit) {
      return res.json({ canProcess: false, remaining: 0 });
    }

    res.json({ canProcess: true, remaining: limit - total });
  } catch (err) {
    errorLogs.create({ message: err.message, tool: "limit-check", user_id: req.user?.id || null });
    next(err);
  }
});

// Dashboard Stats — admin only (exposes revenue, emails, error logs)
router.get("/stats", requireAdmin, (req, res, next) => {
  try {
    if (cachedStats && Date.now() - lastFetch < STATS_CACHE_TTL) {
      return res.json(cachedStats);
    }

    const today = new Date().toISOString().slice(0, 10);

    const response = {
      totalUsage: usage.totalUsage(),
      toolStats: usage.toolStats(),
      dailyStats: usage.dailyStats(),
      activeUsers: usage.activeUsers(today),
      totalUsers: users.count(),
      revenue: users.count({ clause: "plan = ?", params: ["pro"] }) * 99,
      errors: errorLogs.count(),
      recentErrors: errorLogs.recent(5),
      topUsers: usage.topUsers(5),
    };

    cachedStats = response;
    lastFetch = Date.now();

    res.json(response);
  } catch (err) {
    errorLogs.create({ message: err.message, tool: "stats", user_id: null });
    next(err);
  }
});

module.exports = router;
