const express = require("express");
const router = express.Router();
const { plans, toolAccess, toolsConfig, users } = require("../models/db");
const { optionalAuth } = require("../middleware/auth");
const { getEffectiveLimits, GLOBAL_ALLOWED_MIMES } = require("../services/limits");

// Public: Get all active plans (for pricing page)
router.get("/", (req, res, next) => {
  try {
    const allPlans = plans.findAll(true); // activeOnly = true
    // Convert price from paise to display format
    const formatted = allPlans.map((p) => ({
      ...p,
      price_display: p.is_enterprise ? "Custom" : p.price === 0 ? "0" : (p.price / 100).toString(),
    }));
    res.json(formatted);
  } catch (err) {
    next(err);
  }
});

// Public: Get tool access map (for frontend access control)
router.get("/tool-access", (req, res, next) => {
  try {
    res.json(toolAccess.getAccessMap());
  } catch (err) {
    next(err);
  }
});

// Public: Get tools config (for frontend dynamic tools)
router.get("/tools", (req, res, next) => {
  try {
    res.json(toolsConfig.findAll());
  } catch (err) {
    next(err);
  }
});

// Effective limits for the caller (authenticated → own plan, else "free")
router.get("/tool-limits/:toolRoute", optionalAuth, (req, res, next) => {
  try {
    const toolRoute = decodeURIComponent(req.params.toolRoute);
    let planName = "free";
    if (req.user?.id) {
      const u = users.findById(req.user.id);
      if (u) planName = u.plan || "free";
    }
    res.json(getEffectiveLimits(planName, toolRoute));
  } catch (err) {
    next(err);
  }
});

// Global MIME allowlist (for admin UI to populate dropdowns)
router.get("/mime-types", (req, res) => {
  res.json([...GLOBAL_ALLOWED_MIMES]);
});

module.exports = router;
