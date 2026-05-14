const express = require("express");
const router = express.Router();
const { siteSettings } = require("../models/db");

// Returns { "key.path": value, ... } for all PUBLIC settings.
router.get("/settings", (req, res, next) => {
  try {
    const rows = siteSettings.list({ publicOnly: true });
    const out = {};
    for (const r of rows) out[r.key] = r.value;
    res.json(out);
  } catch (err) {
    next(err);
  }
});

router.get("/settings/:key", (req, res, next) => {
  try {
    const row = siteSettings.get(req.params.key);
    if (!row) return res.status(404).json({ error: "Not found" });
    if (!row.is_public) return res.status(404).json({ error: "Not found" });
    res.json({ key: row.key, value: row.value });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
