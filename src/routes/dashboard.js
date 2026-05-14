const express = require("express");
const router = express.Router();

const {
  users, plans, payments, toolUsage, usage, fileRecords, downloadTokens,
} = require("../models/db");
const { requireAuth } = require("../middleware/auth");
const { publicUser } = require("../utils/sanitize");
const { resolveUserAndPlan } = require("../services/limits");
const { planRetentionHours } = require("../utils/storageManager");

const PAID_PLANS = new Set(["starter", "pro", "business", "enterprise"]);

/**
 * Single denormalized payload for the authenticated user's dashboard.
 *
 * We collapse 5+ queries into one round-trip so the dashboard doesn't fan
 * out a bunch of requests on every visit. Caller is required to be
 * authenticated; we never reveal anything cross-user.
 */
router.get("/", requireAuth, (req, res, next) => {
  try {
    const { user, plan: planName } = resolveUserAndPlan(req.user.id);
    if (!user) return res.status(404).json({ error: "User not found" });

    const plan = plans.findByName(planName) || null;

    const today = new Date().toISOString().slice(0, 10);
    const todayTotal = toolUsage.totalForUser(user.id, today);

    // Per-tool counts for today.
    const stats = usage.byUser(user.id);
    const dailyLimit = plan?.daily_limit ?? 5;
    const remaining = dailyLimit === -1 ? -1 : Math.max(0, dailyLimit - todayTotal);

    const recentFiles = fileRecords.findOldest(50)
      .filter((r) => r.user_id === user.id && r.kind === "output")
      .slice(0, 12)
      .map((r) => ({
        tool_route: r.tool_route,
        size_bytes: r.size_bytes,
        expires_at: r.expires_at,
        created_at: r.created_at,
      }));

    const isPaid = PAID_PLANS.has(planName);
    const recentPayments = isPaid
      ? payments.list({ userId: user.id, limit: 10 }).map((p) => ({
          id: p.id,
          razorpay_order_id: p.razorpay_order_id,
          razorpay_payment_id: p.razorpay_payment_id,
          plan_name: p.plan_name,
          amount: p.amount,
          currency: p.currency,
          status: p.status,
          created_at: p.created_at,
        }))
      : [];

    res.json({
      user: {
        ...publicUser(user),
        suspended: !!user.suspended,
        plan_expires_at: user.plan_expires_at || null,
      },
      plan: plan
        ? {
            name: plan.name,
            display_name: plan.display_name,
            price: plan.price,
            currency: plan.currency,
            period: plan.period,
            daily_limit: plan.daily_limit,
            max_file_size_mb: plan.max_file_size_mb,
            retention_hours: plan.retention_hours,
            is_enterprise: !!plan.is_enterprise,
          }
        : null,
      usage: {
        today_total: todayTotal,
        daily_limit: dailyLimit,
        daily_remaining: remaining,
        by_tool_30d: stats.byTool || [],
        daily_30d: stats.daily || [],
      },
      retention_hours: planRetentionHours(planName),
      recent_files: recentFiles,
      recent_payments: recentPayments,
      capabilities: {
        billing: isPaid,
        team_management: planName === "business" || planName === "enterprise",
        api_access: planName === "business" || planName === "enterprise",
        priority_support: planName === "business" || planName === "enterprise",
      },
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
