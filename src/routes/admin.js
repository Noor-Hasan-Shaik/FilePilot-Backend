const express = require("express");
const router = express.Router();
const { users, usage, errorLogs, plans, toolAccess, toolsConfig, toolLimits, siteSettings, blogPosts, payments, auditLog, userOverrides, toolUsage, landingPages } = require("../models/db");
const { publicUser, publicUsers } = require("../utils/sanitize");
const { oneOf, clampInt } = require("../utils/validators");
const { getEffectiveLimits, ABSOLUTE_MAX_MB, ABSOLUTE_MAX_FILES, GLOBAL_ALLOWED_MIMES } = require("../services/limits");
const { logAudit } = require("../utils/audit");

const ALLOWED_RANGES = ["daily", "weekly", "monthly", "yearly"];

function getRangeConfig(range) {
  const now = new Date();
  let startDate = new Date();
  let format = "%Y-%m-%d";

  switch (range) {
    case "daily":
      startDate.setHours(0, 0, 0, 0);
      format = "%Y-%m-%d %H:00";
      break;
    case "weekly":
      startDate.setDate(now.getDate() - 7);
      break;
    case "monthly":
      startDate.setDate(now.getDate() - 30);
      break;
    case "yearly":
      startDate.setFullYear(now.getFullYear() - 1);
      format = "%Y-%m";
      break;
    default:
      startDate.setDate(now.getDate() - 7);
  }

  return { startDate: startDate.toISOString(), format, range: range || "weekly" };
}

// ─── User Management ────────────────────────────────

router.get("/users", (req, res, next) => {
  try {
    res.json(publicUsers(users.findAll()));
  } catch (err) {
    next(err);
  }
});

router.post("/toggle-premium", (req, res, next) => {
  try {
    const { userId, plan } = req.body;
    if (!userId) return res.status(400).json({ error: "userId is required" });

    const user = users.findById(userId);
    if (!user) return res.status(404).json({ error: "User not found" });

    if (plan && typeof plan === "string") {
      const exists = plans.findByName(plan);
      if (!exists) return res.status(400).json({ error: "Plan does not exist" });
    }

    const newPlan = plan || (user.plan === "pro" ? "free" : "pro");
    users.update(userId, { plan: newPlan });

    logAudit(req, {
      action: "user.plan.update",
      targetType: "user",
      targetId: userId,
      before: { plan: user.plan },
      after: { plan: newPlan },
    });

    res.json({ success: true, plan: newPlan });
  } catch (err) {
    next(err);
  }
});

router.delete("/user/:id", (req, res, next) => {
  try {
    const userId = req.params.id;
    if (userId === req.user.id) {
      return res.status(400).json({ error: "Cannot delete your own account" });
    }
    const existing = users.findById(userId);
    users.deleteById(userId);
    usage.deleteByUser(userId);
    userOverrides.removeByUser(userId);
    if (existing) {
      logAudit(req, {
        action: "user.delete",
        targetType: "user",
        targetId: userId,
        before: publicUser(existing),
      });
    }
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

router.get("/user/:id", (req, res, next) => {
  try {
    const userId = req.params.id;
    const user = users.findById(userId);
    if (!user) return res.status(404).json({ error: "User not found" });

    const stats = usage.byUser(userId);
    const overrides = userOverrides.findByUser(userId);

    const safeUser = publicUser(user);
    safeUser.suspended = !!user.suspended;
    safeUser.plan_expires_at = user.plan_expires_at || null;
    safeUser.admin_notes = user.admin_notes || null;

    res.json({
      user: safeUser,
      totalUsage: stats.total,
      dailyUsage: stats.daily,
      toolUsage: stats.byTool,
      overrides,
    });
  } catch (err) {
    next(err);
  }
});

// Full user update — name, plan, plan_expires_at, suspended, admin_notes.
router.put("/user/:id", (req, res, next) => {
  try {
    const userId = req.params.id;
    const before = users.findById(userId);
    if (!before) return res.status(404).json({ error: "User not found" });

    const allowed = ["name", "plan", "plan_expires_at", "suspended", "admin_notes"];
    const patch = {};
    for (const key of allowed) {
      if (req.body[key] !== undefined) patch[key] = req.body[key];
    }

    if (patch.plan && typeof patch.plan === "string") {
      const exists = plans.findByName(patch.plan);
      if (!exists) return res.status(400).json({ error: "Plan does not exist" });
    }

    if (patch.plan_expires_at !== undefined && patch.plan_expires_at !== null) {
      const d = new Date(patch.plan_expires_at);
      if (Number.isNaN(d.getTime())) {
        return res.status(400).json({ error: "plan_expires_at must be an ISO date" });
      }
      patch.plan_expires_at = d.toISOString();
    }

    if (patch.suspended !== undefined) {
      patch.suspended = patch.suspended ? 1 : 0;
      if (userId === req.user.id && patch.suspended === 1) {
        return res.status(400).json({ error: "Cannot suspend your own account" });
      }
    }

    if (patch.name !== undefined) {
      if (typeof patch.name !== "string" || patch.name.trim().length < 1) {
        return res.status(400).json({ error: "Name cannot be empty" });
      }
      patch.name = patch.name.trim().slice(0, 100);
    }

    const updated = users.update(userId, patch);

    logAudit(req, {
      action: "user.update",
      targetType: "user",
      targetId: userId,
      before: publicUser(before),
      after: publicUser(updated),
    });

    const safe = publicUser(updated);
    safe.suspended = !!updated.suspended;
    safe.plan_expires_at = updated.plan_expires_at || null;
    safe.admin_notes = updated.admin_notes || null;
    res.json(safe);
  } catch (err) {
    next(err);
  }
});

// Per-user tool overrides
router.get("/user/:id/overrides", (req, res, next) => {
  try {
    const user = users.findById(req.params.id);
    if (!user) return res.status(404).json({ error: "User not found" });
    res.json(userOverrides.findByUser(req.params.id));
  } catch (err) {
    next(err);
  }
});

router.put("/user/:id/overrides/:toolRoute", (req, res, next) => {
  try {
    const userId = req.params.id;
    const toolRoute = decodeURIComponent(req.params.toolRoute);

    const user = users.findById(userId);
    if (!user) return res.status(404).json({ error: "User not found" });
    const tool = toolsConfig.findByRoute(toolRoute);
    if (!tool) return res.status(404).json({ error: "Tool not found" });

    const { daily_limit, max_file_size_mb, max_files_per_request, allowed_mime_types, notes } = req.body;

    if (daily_limit !== undefined && daily_limit !== null) {
      const n = Number(daily_limit);
      if (!Number.isFinite(n) || n < -1 || n > 1_000_000) {
        return res.status(400).json({ error: "daily_limit must be a number >= -1" });
      }
    }
    if (max_file_size_mb !== undefined && max_file_size_mb !== null) {
      const n = Number(max_file_size_mb);
      if (!Number.isFinite(n) || n < 0 || n > ABSOLUTE_MAX_MB) {
        return res.status(400).json({ error: `max_file_size_mb must be 0..${ABSOLUTE_MAX_MB}` });
      }
    }
    if (max_files_per_request !== undefined && max_files_per_request !== null) {
      const n = Number(max_files_per_request);
      if (!Number.isFinite(n) || n < 1 || n > ABSOLUTE_MAX_FILES) {
        return res.status(400).json({ error: `max_files_per_request must be 1..${ABSOLUTE_MAX_FILES}` });
      }
    }
    if (allowed_mime_types !== undefined && allowed_mime_types !== null) {
      if (!Array.isArray(allowed_mime_types) || !allowed_mime_types.every((m) => typeof m === "string")) {
        return res.status(400).json({ error: "allowed_mime_types must be an array of strings" });
      }
      const unknown = allowed_mime_types.filter((m) => !GLOBAL_ALLOWED_MIMES.has(m));
      if (unknown.length > 0) {
        return res.status(400).json({ error: `Unsupported MIME type(s): ${unknown.join(", ")}` });
      }
    }

    const before = userOverrides.find(userId, toolRoute);
    const saved = userOverrides.upsert(userId, toolRoute, {
      daily_limit: daily_limit ?? null,
      max_file_size_mb: max_file_size_mb ?? null,
      max_files_per_request: max_files_per_request ?? null,
      allowed_mime_types: allowed_mime_types ?? null,
      notes: notes ?? null,
    });

    logAudit(req, {
      action: "user_override.set",
      targetType: "user_override",
      targetId: `${userId}::${toolRoute}`,
      before,
      after: saved,
    });

    res.json(saved);
  } catch (err) {
    next(err);
  }
});

router.delete("/user/:id/overrides/:toolRoute", (req, res, next) => {
  try {
    const userId = req.params.id;
    const toolRoute = decodeURIComponent(req.params.toolRoute);
    const before = userOverrides.find(userId, toolRoute);
    userOverrides.remove(userId, toolRoute);
    logAudit(req, {
      action: "user_override.clear",
      targetType: "user_override",
      targetId: `${userId}::${toolRoute}`,
      before,
    });
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// Reset all daily usage counters for this user (current and history both gone).
router.post("/user/:id/reset-usage", (req, res, next) => {
  try {
    const userId = req.params.id;
    const user = users.findById(userId);
    if (!user) return res.status(404).json({ error: "User not found" });
    toolUsage.resetForUser(userId);
    logAudit(req, {
      action: "user.usage.reset",
      targetType: "user",
      targetId: userId,
    });
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// ─── Dashboard Stats ────────────────────────────────

router.get("/stats", (req, res, next) => {
  try {
    const range = oneOf(req.query.range, ALLOWED_RANGES, "weekly");
    const { startDate, format, range: usedRange } = getRangeConfig(range);

    const allPlans = plans.findAll();
    let revenue = 0;
    for (const plan of allPlans) {
      if (plan.price > 0) {
        const count = users.count({ clause: "plan = ? AND created_at >= ?", params: [plan.name, startDate] });
        revenue += count * (plan.price / 100);
      }
    }

    res.json({
      range: usedRange,
      totalUsers: users.count(),
      activeUsers: usage.activeUsers(null, startDate),
      totalUsage: usage.totalUsage(startDate),
      revenue,
      errors: errorLogs.count(startDate),
      toolStats: usage.toolStats(startDate),
      dailyStats: usage.dailyStats(startDate, format),
      topUsers: usage.topUsers(5, startDate),
      recentErrors: errorLogs.recent(5, startDate),
    });
  } catch (err) {
    next(err);
  }
});

// ─── Plan Management (CRUD) ─────────────────────────

const PLAN_PERIODS = new Set(["month", "year", "lifetime", "trial"]);

// Validate the fields that flow into plans.create / plans.update. Returns null
// when the input is acceptable, or { error } describing the first violation.
// Fields not present in `body` are left untouched (so this can validate either
// a full create payload or a partial update patch).
function validatePlanInput(body, { partial = false } = {}) {
  if (!body || typeof body !== "object") return { error: "Invalid request body" };

  if ("display_name" in body && body.display_name != null) {
    if (typeof body.display_name !== "string" || body.display_name.length > 80) {
      return { error: "display_name must be a string up to 80 chars" };
    }
  }

  if ("price" in body) {
    const p = Number(body.price);
    if (!Number.isFinite(p) || p < 0 || p > 10_000_000) {
      return { error: "price must be a non-negative number" };
    }
  } else if (!partial) {
    // create-time: omitted price is allowed and defaults to 0.
  }

  if ("period" in body && body.period != null) {
    if (typeof body.period !== "string" || !PLAN_PERIODS.has(body.period)) {
      return { error: `period must be one of ${[...PLAN_PERIODS].join(", ")}` };
    }
  }

  if ("daily_limit" in body && body.daily_limit != null) {
    const n = Number(body.daily_limit);
    if (!Number.isInteger(n) || n < 0 || n > 100_000) {
      return { error: "daily_limit must be a non-negative integer" };
    }
  }

  if ("max_file_size_mb" in body && body.max_file_size_mb != null) {
    const n = Number(body.max_file_size_mb);
    if (!Number.isFinite(n) || n <= 0 || n > 10_240) {
      return { error: "max_file_size_mb must be a positive number up to 10240" };
    }
  }

  if ("description" in body && body.description != null && typeof body.description !== "string") {
    return { error: "description must be a string" };
  }
  if ("description" in body && typeof body.description === "string" && body.description.length > 2000) {
    return { error: "description too long" };
  }

  if ("features" in body && body.features != null) {
    if (!Array.isArray(body.features)) return { error: "features must be an array" };
    if (body.features.length > 50) return { error: "too many features" };
    for (const f of body.features) {
      if (typeof f !== "string" || f.length > 200) {
        return { error: "each feature must be a string up to 200 chars" };
      }
    }
  }

  if ("sort_order" in body && body.sort_order != null) {
    const n = Number(body.sort_order);
    if (!Number.isInteger(n) || n < 0 || n > 10_000) {
      return { error: "sort_order must be a non-negative integer" };
    }
  }

  if ("cta_text" in body && body.cta_text != null) {
    if (typeof body.cta_text !== "string" || body.cta_text.length > 60) {
      return { error: "cta_text must be a string up to 60 chars" };
    }
  }

  return null;
}

router.get("/plans", (req, res, next) => {
  try {
    res.json(plans.findAll());
  } catch (err) {
    next(err);
  }
});

router.get("/plans/:id", (req, res, next) => {
  try {
    const plan = plans.findById(req.params.id);
    if (!plan) return res.status(404).json({ error: "Plan not found" });
    res.json(plan);
  } catch (err) {
    next(err);
  }
});

router.post("/plans", (req, res, next) => {
  try {
    const { name, display_name, price, period, description, daily_limit, max_file_size_mb, features, is_popular, is_enterprise, is_active, sort_order, cta_text } = req.body;
    if (!name || typeof name !== "string" || name.length > 60) {
      return res.status(400).json({ error: "Plan name is required (max 60 chars)" });
    }

    const normalizedName = name.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "");
    if (!normalizedName) return res.status(400).json({ error: "Plan name is invalid" });

    const validation = validatePlanInput(req.body);
    if (validation) return res.status(400).json(validation);

    const existing = plans.findByName(normalizedName);
    if (existing) return res.status(409).json({ error: "Plan with this name already exists" });

    const plan = plans.create({
      name: normalizedName,
      display_name: display_name || name,
      price: Number.isFinite(+price) ? +price : 0,
      period: period || "month",
      description: description || "",
      daily_limit: daily_limit ?? 5,
      max_file_size_mb: max_file_size_mb ?? 25,
      features: Array.isArray(features) ? features : [],
      is_popular: is_popular ? 1 : 0,
      is_enterprise: is_enterprise ? 1 : 0,
      is_active: is_active !== false ? 1 : 0,
      sort_order: Number.isFinite(+sort_order) ? +sort_order : 0,
      cta_text: cta_text || "Get Started",
    });

    logAudit(req, { action: "plan.create", targetType: "plan", targetId: plan.id, after: plan });
    res.status(201).json(plan);
  } catch (err) {
    next(err);
  }
});

router.put("/plans/:id", (req, res, next) => {
  try {
    const plan = plans.findById(req.params.id);
    if (!plan) return res.status(404).json({ error: "Plan not found" });

    const validation = validatePlanInput(req.body, { partial: true });
    if (validation) return res.status(400).json(validation);

    const updated = plans.update(req.params.id, req.body);
    logAudit(req, { action: "plan.update", targetType: "plan", targetId: plan.id, before: plan, after: updated });
    res.json(updated);
  } catch (err) {
    next(err);
  }
});

router.delete("/plans/:id", (req, res, next) => {
  try {
    const plan = plans.findById(req.params.id);
    if (!plan) return res.status(404).json({ error: "Plan not found" });

    if (plan.name === "free") {
      return res.status(400).json({ error: "Cannot delete the free plan" });
    }

    plans.deleteById(req.params.id);
    logAudit(req, { action: "plan.delete", targetType: "plan", targetId: plan.id, before: plan });
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// ─── Tool Access Management ─────────────────────────

router.get("/tool-access", (req, res, next) => {
  try {
    res.json(toolAccess.getGroupedByPlan());
  } catch (err) {
    next(err);
  }
});

router.put("/tool-access/:planName", (req, res, next) => {
  try {
    const { planName } = req.params;
    const { tools } = req.body;

    if (!Array.isArray(tools)) {
      return res.status(400).json({ error: "tools must be an array of route strings" });
    }
    if (!tools.every((t) => typeof t === "string" && t.startsWith("/tool/"))) {
      return res.status(400).json({ error: "tools must be route strings starting with /tool/" });
    }

    const plan = plans.findByName(planName);
    if (!plan) return res.status(404).json({ error: "Plan not found" });

    const before = toolAccess.getForPlan(planName);
    toolAccess.setForPlan(planName, tools);
    logAudit(req, {
      action: "tool_access.set",
      targetType: "plan",
      targetId: planName,
      before,
      after: tools,
    });
    res.json({ success: true, plan: planName, toolCount: tools.length });
  } catch (err) {
    next(err);
  }
});

// ─── Tools Config (CRUD) ─────────────────────────────

router.get("/tools-config", (req, res, next) => {
  try {
    res.json(toolsConfig.findAll());
  } catch (err) {
    next(err);
  }
});

router.post("/tools-config", (req, res, next) => {
  try {
    const { title, route, category, description, icon, is_active, sort_order } = req.body;
    if (!title || !route) return res.status(400).json({ error: "Title and route are required" });
    if (typeof route !== "string" || !route.startsWith("/tool/")) {
      return res.status(400).json({ error: "route must start with /tool/" });
    }

    const existing = toolsConfig.findByRoute(route);
    if (existing) return res.status(409).json({ error: "Tool with this route already exists" });

    const tool = toolsConfig.create({ title, route, category, description, icon, is_active, sort_order });
    res.status(201).json(tool);
  } catch (err) {
    next(err);
  }
});

router.put("/tools-config/:id", (req, res, next) => {
  try {
    const tool = toolsConfig.findById(req.params.id);
    if (!tool) return res.status(404).json({ error: "Tool not found" });

    const updated = toolsConfig.update(req.params.id, req.body);
    res.json(updated);
  } catch (err) {
    next(err);
  }
});

router.delete("/tools-config/:id", (req, res, next) => {
  try {
    const tool = toolsConfig.findById(req.params.id);
    if (!tool) return res.status(404).json({ error: "Tool not found" });

    toolLimits.removeByTool(tool.route);
    toolsConfig.deleteById(req.params.id);
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// Set which plans a given tool belongs to (tool → plans direction).
router.put("/tools-config/:id/plans", (req, res, next) => {
  try {
    const tool = toolsConfig.findById(req.params.id);
    if (!tool) return res.status(404).json({ error: "Tool not found" });

    const { plans: planNames } = req.body;
    if (!Array.isArray(planNames)) {
      return res.status(400).json({ error: "plans must be an array of plan names" });
    }

    const allPlans = plans.findAll().map((p) => p.name);
    const invalid = planNames.filter((p) => typeof p !== "string" || !allPlans.includes(p));
    if (invalid.length > 0) {
      return res.status(400).json({ error: `Unknown plan(s): ${invalid.join(", ")}` });
    }

    // For each known plan, ensure this tool is present iff selected.
    for (const planName of allPlans) {
      const current = toolAccess.getForPlan(planName);
      const shouldHave = planNames.includes(planName);
      const hasIt = current.includes(tool.route);
      if (shouldHave && !hasIt) {
        toolAccess.addTool(planName, tool.route);
      } else if (!shouldHave && hasIt) {
        toolAccess.removeTool(planName, tool.route);
      }
    }

    res.json({ success: true, tool: tool.route, plans: planNames });
  } catch (err) {
    next(err);
  }
});

// ─── Tool Limits ─────────────────────────────────────

router.get("/tool-limits", (req, res, next) => {
  try {
    res.json(toolLimits.findAll());
  } catch (err) {
    next(err);
  }
});

router.get("/tool-limits/effective/:planName/:toolRoute", (req, res, next) => {
  try {
    const planName = req.params.planName;
    const toolRoute = decodeURIComponent(req.params.toolRoute);
    const plan = plans.findByName(planName);
    if (!plan) return res.status(404).json({ error: "Plan not found" });
    res.json(getEffectiveLimits(planName, toolRoute));
  } catch (err) {
    next(err);
  }
});

router.put("/tool-limits/:planName/:toolRoute", (req, res, next) => {
  try {
    const planName = req.params.planName;
    const toolRoute = decodeURIComponent(req.params.toolRoute);

    const plan = plans.findByName(planName);
    if (!plan) return res.status(404).json({ error: "Plan not found" });

    const tool = toolsConfig.findByRoute(toolRoute);
    if (!tool) return res.status(404).json({ error: "Tool not found" });

    const { daily_limit, max_file_size_mb, max_files_per_request, allowed_mime_types } = req.body;

    if (daily_limit !== undefined && daily_limit !== null) {
      const n = Number(daily_limit);
      if (!Number.isFinite(n) || (n < -1) || n > 1_000_000) {
        return res.status(400).json({ error: "daily_limit must be a number >= -1" });
      }
    }
    if (max_file_size_mb !== undefined && max_file_size_mb !== null) {
      const n = Number(max_file_size_mb);
      if (!Number.isFinite(n) || n < 0 || n > ABSOLUTE_MAX_MB) {
        return res.status(400).json({ error: `max_file_size_mb must be 0..${ABSOLUTE_MAX_MB}` });
      }
    }
    if (max_files_per_request !== undefined && max_files_per_request !== null) {
      const n = Number(max_files_per_request);
      if (!Number.isFinite(n) || n < 1 || n > ABSOLUTE_MAX_FILES) {
        return res.status(400).json({ error: `max_files_per_request must be 1..${ABSOLUTE_MAX_FILES}` });
      }
    }
    if (allowed_mime_types !== undefined && allowed_mime_types !== null) {
      if (!Array.isArray(allowed_mime_types) || !allowed_mime_types.every((m) => typeof m === "string")) {
        return res.status(400).json({ error: "allowed_mime_types must be an array of strings" });
      }
      const unknown = allowed_mime_types.filter((m) => !GLOBAL_ALLOWED_MIMES.has(m));
      if (unknown.length > 0) {
        return res.status(400).json({ error: `Unsupported MIME type(s): ${unknown.join(", ")}` });
      }
    }

    const before = toolLimits.find(planName, toolRoute);
    const saved = toolLimits.upsert(planName, toolRoute, {
      daily_limit: daily_limit ?? null,
      max_file_size_mb: max_file_size_mb ?? null,
      max_files_per_request: max_files_per_request ?? null,
      allowed_mime_types: allowed_mime_types ?? null,
    });

    logAudit(req, {
      action: "tool_limit.set",
      targetType: "tool_limit",
      targetId: `${planName}::${toolRoute}`,
      before,
      after: saved,
    });

    res.json(saved);
  } catch (err) {
    next(err);
  }
});

router.delete("/tool-limits/:planName/:toolRoute", (req, res, next) => {
  try {
    const planName = req.params.planName;
    const toolRoute = decodeURIComponent(req.params.toolRoute);
    const before = toolLimits.find(planName, toolRoute);
    toolLimits.remove(planName, toolRoute);
    logAudit(req, {
      action: "tool_limit.clear",
      targetType: "tool_limit",
      targetId: `${planName}::${toolRoute}`,
      before,
    });
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// ─── Site Settings (CMS) ─────────────────────────────

router.get("/site-settings", (req, res, next) => {
  try {
    res.json(siteSettings.list());
  } catch (err) {
    next(err);
  }
});

router.get("/site-settings/:key", (req, res, next) => {
  try {
    const row = siteSettings.get(req.params.key);
    if (!row) return res.status(404).json({ error: "Not found" });
    res.json(row);
  } catch (err) {
    next(err);
  }
});

router.put("/site-settings/:key", (req, res, next) => {
  try {
    const key = req.params.key;
    if (typeof key !== "string" || key.length > 100 || !/^[a-z0-9._-]+$/i.test(key)) {
      return res.status(400).json({ error: "Invalid setting key" });
    }
    if (!Object.prototype.hasOwnProperty.call(req.body, "value")) {
      return res.status(400).json({ error: "Missing value" });
    }
    const { value, isPublic = true, description } = req.body;

    try {
      JSON.stringify(value);
    } catch {
      return res.status(400).json({ error: "Value must be JSON-serializable" });
    }

    const before = siteSettings.get(key);
    const saved = siteSettings.set(key, value, { isPublic, description });
    logAudit(req, {
      action: "site_setting.set",
      targetType: "site_setting",
      targetId: key,
      before: before ? before.value : null,
      after: saved.value,
    });
    res.json(saved);
  } catch (err) {
    next(err);
  }
});

router.delete("/site-settings/:key", (req, res, next) => {
  try {
    const before = siteSettings.get(req.params.key);
    siteSettings.delete(req.params.key);
    logAudit(req, {
      action: "site_setting.delete",
      targetType: "site_setting",
      targetId: req.params.key,
      before: before ? before.value : null,
    });
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// ─── Blog Posts (CMS) ────────────────────────────────

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function validateBlogPayload(body, { partial = false } = {}) {
  const errors = [];
  if (!partial || body.slug !== undefined) {
    if (typeof body.slug !== "string" || !SLUG_RE.test(body.slug) || body.slug.length > 120) {
      errors.push("slug must be kebab-case (a-z, 0-9, -) up to 120 chars");
    }
  }
  if (!partial || body.title !== undefined) {
    if (typeof body.title !== "string" || !body.title.trim() || body.title.length > 200) {
      errors.push("title is required (<=200 chars)");
    }
  }
  if (!partial || body.content !== undefined) {
    if (typeof body.content !== "string" || !body.content.trim()) {
      errors.push("content is required");
    }
    if (typeof body.content === "string" && body.content.length > 500_000) {
      errors.push("content too long (max 500KB)");
    }
  }
  if (body.excerpt !== undefined && typeof body.excerpt !== "string") {
    errors.push("excerpt must be a string");
  }
  if (body.author !== undefined && body.author !== null && typeof body.author !== "string") {
    errors.push("author must be a string or null");
  }
  if (body.cover_image_url !== undefined && body.cover_image_url !== null && typeof body.cover_image_url !== "string") {
    errors.push("cover_image_url must be a string or null");
  }
  if (body.tags !== undefined) {
    if (!Array.isArray(body.tags) || !body.tags.every((t) => typeof t === "string" && t.length < 60)) {
      errors.push("tags must be an array of short strings");
    }
  }
  return errors;
}

router.get("/blog", (req, res, next) => {
  try {
    res.json(blogPosts.findAll());
  } catch (err) {
    next(err);
  }
});

router.get("/blog/:id", (req, res, next) => {
  try {
    const post = blogPosts.findById(Number(req.params.id));
    if (!post) return res.status(404).json({ error: "Not found" });
    res.json(post);
  } catch (err) {
    next(err);
  }
});

router.post("/blog", (req, res, next) => {
  try {
    const errors = validateBlogPayload(req.body);
    if (errors.length > 0) return res.status(400).json({ error: errors.join("; ") });

    const existing = blogPosts.findBySlug(req.body.slug);
    if (existing) return res.status(409).json({ error: "A post with that slug already exists" });

    const created = blogPosts.create({
      slug: req.body.slug.trim(),
      title: req.body.title.trim(),
      excerpt: (req.body.excerpt || "").trim(),
      content: req.body.content,
      author: req.body.author || null,
      cover_image_url: req.body.cover_image_url || null,
      tags: req.body.tags || [],
      published: !!req.body.published,
      published_at: req.body.published_at || null,
    });
    res.status(201).json(created);
  } catch (err) {
    next(err);
  }
});

router.put("/blog/:id", (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const existing = blogPosts.findById(id);
    if (!existing) return res.status(404).json({ error: "Not found" });

    const errors = validateBlogPayload(req.body, { partial: true });
    if (errors.length > 0) return res.status(400).json({ error: errors.join("; ") });

    if (req.body.slug && req.body.slug !== existing.slug) {
      const dup = blogPosts.findBySlug(req.body.slug);
      if (dup && dup.id !== id) return res.status(409).json({ error: "Slug already used by another post" });
    }

    const updated = blogPosts.update(id, req.body);
    res.json(updated);
  } catch (err) {
    next(err);
  }
});

router.delete("/blog/:id", (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const existing = blogPosts.findById(id);
    if (!existing) return res.status(404).json({ error: "Not found" });
    blogPosts.deleteById(id);
    logAudit(req, {
      action: "blog.delete",
      targetType: "blog_post",
      targetId: id,
      before: { slug: existing.slug, title: existing.title },
    });
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// ─── Landing Pages (CMS) ─────────────────────────────

function validateLandingPayload(body, { partial = false } = {}) {
  const errors = [];
  if (!partial || body.slug !== undefined) {
    if (typeof body.slug !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(body.slug) || body.slug.length > 150) {
      errors.push("slug must be kebab-case");
    }
  }
  if (!partial || body.title !== undefined) {
    if (typeof body.title !== "string" || !body.title.trim() || body.title.length > 250) {
      errors.push("title is required (<=250 chars)");
    }
  }
  if (!partial || body.h1 !== undefined) {
    if (typeof body.h1 !== "string" || !body.h1.trim() || body.h1.length > 250) {
      errors.push("h1 is required (<=250 chars)");
    }
  }
  if (!partial || body.description !== undefined) {
    if (typeof body.description !== "string" || body.description.length > 5000) {
      errors.push("description must be a string (<=5000 chars)");
    }
  }
  if (body.tool_link !== undefined && body.tool_link !== null) {
    if (typeof body.tool_link !== "string" || !body.tool_link.startsWith("/")) {
      errors.push("tool_link must be a relative path starting with /");
    }
  }
  if (body.faqs !== undefined) {
    if (
      !Array.isArray(body.faqs) ||
      !body.faqs.every((f) => f && typeof f.q === "string" && typeof f.a === "string")
    ) {
      errors.push("faqs must be an array of {q, a} pairs");
    }
  }
  return errors;
}

router.get("/landing-pages", (req, res, next) => {
  try {
    res.json(landingPages.findAll());
  } catch (err) {
    next(err);
  }
});

router.get("/landing-pages/:id", (req, res, next) => {
  try {
    const page = landingPages.findById(Number(req.params.id));
    if (!page) return res.status(404).json({ error: "Not found" });
    res.json(page);
  } catch (err) {
    next(err);
  }
});

router.post("/landing-pages", (req, res, next) => {
  try {
    const errors = validateLandingPayload(req.body);
    if (errors.length > 0) return res.status(400).json({ error: errors.join("; ") });
    if (landingPages.findBySlug(req.body.slug)) {
      return res.status(409).json({ error: "A page with that slug already exists" });
    }
    const created = landingPages.create({
      slug: req.body.slug,
      title: req.body.title,
      h1: req.body.h1,
      description: req.body.description,
      tool_link: req.body.tool_link || null,
      tool_name: req.body.tool_name || null,
      keywords: req.body.keywords || null,
      faqs: req.body.faqs || [],
      meta_title: req.body.meta_title || null,
      meta_description: req.body.meta_description || null,
      og_image: req.body.og_image || null,
      published: !!req.body.published,
    });
    logAudit(req, { action: "landing_page.create", targetType: "landing_page", targetId: created.id, after: created });
    res.status(201).json(created);
  } catch (err) {
    next(err);
  }
});

router.put("/landing-pages/:id", (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const existing = landingPages.findById(id);
    if (!existing) return res.status(404).json({ error: "Not found" });
    const errors = validateLandingPayload(req.body, { partial: true });
    if (errors.length > 0) return res.status(400).json({ error: errors.join("; ") });
    if (req.body.slug && req.body.slug !== existing.slug) {
      const dup = landingPages.findBySlug(req.body.slug);
      if (dup && dup.id !== id) return res.status(409).json({ error: "Slug already used" });
    }
    const updated = landingPages.update(id, req.body);
    logAudit(req, {
      action: "landing_page.update",
      targetType: "landing_page",
      targetId: id,
      before: existing,
      after: updated,
    });
    res.json(updated);
  } catch (err) {
    next(err);
  }
});

router.delete("/landing-pages/:id", (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const existing = landingPages.findById(id);
    if (!existing) return res.status(404).json({ error: "Not found" });
    landingPages.deleteById(id);
    logAudit(req, {
      action: "landing_page.delete",
      targetType: "landing_page",
      targetId: id,
      before: { slug: existing.slug, title: existing.title },
    });
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// ─── Payments & Audit (read-only admin views) ────────

router.get("/payments", (req, res, next) => {
  try {
    const limit = clampInt(req.query.limit, 100, 1, 500);
    const offset = clampInt(req.query.offset, 0, 0, 1000000);
    const status = oneOf(req.query.status, ["created", "paid", "failed", "refunded"], null);
    const filters = { limit, offset };
    if (status) filters.status = status;
    if (req.query.user_id) filters.userId = String(req.query.user_id);
    if (req.query.since) filters.since = String(req.query.since);
    res.json({
      items: payments.list(filters),
      total_revenue_paise: payments.totalRevenue({ status: "paid" }),
    });
  } catch (err) {
    next(err);
  }
});

router.get("/audit-log", (req, res, next) => {
  try {
    const limit = clampInt(req.query.limit, 100, 1, 500);
    const offset = clampInt(req.query.offset, 0, 0, 1000000);
    const filters = { limit, offset };
    if (req.query.actor_id) filters.actorId = String(req.query.actor_id);
    if (req.query.action) filters.action = String(req.query.action);
    if (req.query.target_type) filters.targetType = String(req.query.target_type);
    if (req.query.since) filters.since = String(req.query.since);
    res.json({
      items: auditLog.list(filters),
      total: auditLog.count(filters),
    });
  } catch (err) {
    next(err);
  }
});

// Bulk: set every cell in the limits matrix for a plan in one shot.
router.put("/tool-limits/plan/:planName/bulk", (req, res, next) => {
  try {
    const planName = req.params.planName;
    const plan = plans.findByName(planName);
    if (!plan) return res.status(404).json({ error: "Plan not found" });

    const entries = req.body && Array.isArray(req.body.entries) ? req.body.entries : null;
    if (!entries) return res.status(400).json({ error: "entries must be an array" });

    const knownTools = new Set(toolsConfig.findAll().map((t) => t.route));
    for (const e of entries) {
      if (!e || typeof e.tool_route !== "string" || !knownTools.has(e.tool_route)) {
        return res.status(400).json({ error: `Unknown tool_route: ${e?.tool_route}` });
      }
    }

    for (const e of entries) {
      toolLimits.upsert(planName, e.tool_route, {
        daily_limit: e.daily_limit ?? null,
        max_file_size_mb: e.max_file_size_mb ?? null,
        max_files_per_request: e.max_files_per_request ?? null,
        allowed_mime_types: e.allowed_mime_types ?? null,
      });
    }

    res.json({ success: true, updated: entries.length });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
