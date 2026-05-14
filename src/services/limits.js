const multer = require("multer");
const path = require("path");
const crypto = require("crypto");
const fs = require("fs");

const { plans, toolLimits, toolUsage, users, userOverrides } = require("../models/db");
const { validateFileContent } = require("../utils/validateFile");
const { guestKey } = require("../utils/guestKey");
const logger = require("../utils/logger");

const UPLOADS_DIR = path.join(__dirname, "../../uploads");
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

const GLOBAL_ALLOWED_MIMES = new Set([
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "image/bmp",
  "image/tiff",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "text/plain",
  "video/mp4",
  "audio/mpeg",
]);

// Hard cap so admin can't accidentally allow arbitrarily large uploads.
const ABSOLUTE_MAX_MB = 1024;
const ABSOLUTE_MAX_FILES = 50;

const DEFAULTS = {
  daily_limit: 5,
  max_file_size_mb: 25,
  max_files_per_request: 1,
  allowed_mime_types: null, // null = use global allowlist
};

/**
 * Resolve the active plan for a user. If their plan_expires_at has passed,
 * automatically downgrade to "free" so all subsequent checks use the right tier.
 */
function resolveUserAndPlan(userId) {
  if (!userId) return { user: null, plan: "free" };
  const user = users.findById(userId);
  if (!user) return { user: null, plan: "free" };
  if (user.plan_expires_at && user.plan !== "free") {
    const expired = new Date(user.plan_expires_at).getTime() < Date.now();
    if (expired) {
      users.update(userId, { plan: "free", plan_expires_at: null });
      return { user: { ...user, plan: "free", plan_expires_at: null }, plan: "free" };
    }
  }
  return { user, plan: user.plan || "free" };
}

function resolvePlanName(req) {
  if (!req || !req.user || !req.user.id) return "free";
  return resolveUserAndPlan(req.user.id).plan;
}

/**
 * Compute the effective limits for a (user, plan, tool) tuple:
 *   user_tool_override > plan_tool_limit_override > plan default > module DEFAULTS
 * Returns null fields if no override exists at that level.
 */
function getEffectiveLimits(planName, toolRoute, userId = null) {
  const plan = plans.findByName(planName);
  const planOverride = toolLimits.find(planName, toolRoute);
  const userOverride = userId ? userOverrides.find(userId, toolRoute) : null;

  const max_file_size_mb =
    userOverride?.max_file_size_mb ??
    planOverride?.max_file_size_mb ??
    plan?.max_file_size_mb ??
    DEFAULTS.max_file_size_mb;

  const daily_limit =
    userOverride?.daily_limit ??
    planOverride?.daily_limit ??
    plan?.daily_limit ??
    DEFAULTS.daily_limit;

  const max_files_per_request =
    userOverride?.max_files_per_request ??
    planOverride?.max_files_per_request ??
    DEFAULTS.max_files_per_request;

  const allowed_mime_types =
    userOverride?.allowed_mime_types ?? planOverride?.allowed_mime_types ?? null;

  return {
    plan: planName,
    tool_route: toolRoute,
    daily_limit, // -1 = unlimited
    max_file_size_mb: Math.min(max_file_size_mb || ABSOLUTE_MAX_MB, ABSOLUTE_MAX_MB),
    max_files_per_request: Math.min(max_files_per_request, ABSOLUTE_MAX_FILES),
    allowed_mime_types,
    overridden_at: userOverride ? "user" : planOverride ? "plan" : null,
  };
}

function buildFileFilter(limits) {
  const allow = limits.allowed_mime_types
    ? new Set(limits.allowed_mime_types)
    : GLOBAL_ALLOWED_MIMES;
  return (req, file, cb) => {
    if (!allow.has(file.mimetype)) {
      return cb(null, false);
    }
    cb(null, true);
  };
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_DIR),
  filename: (req, file, cb) => {
    const unique = crypto.randomBytes(8).toString("hex");
    const ext = path
      .extname(file.originalname || "")
      .toLowerCase()
      .replace(/[^a-z0-9.]/g, "")
      .slice(0, 8);
    cb(null, `${Date.now()}_${unique}${ext}`);
  },
});

function tryUnlink(p) {
  try {
    if (p && fs.existsSync(p)) fs.unlinkSync(p);
  } catch {
    // ignore
  }
}

function validateAndCleanup(files, res) {
  for (const f of files) {
    if (!validateFileContent(f.path, f.mimetype)) {
      files.forEach((x) => tryUnlink(x.path));
      res.status(400).json({
        error: `File content does not match declared type (${f.originalname || "file"})`,
      });
      return false;
    }
  }
  return true;
}

/**
 * toolGuard(toolRoute, kind)
 * kind: "single" | "multiple" | "text" (no upload, just limit-check)
 * Returns an array of middlewares that:
 *   1. resolve effective limits from user's plan
 *   2. enforce daily limit (per-tool + plan-level total)
 *   3. apply dynamic multer with correct file-size/count/MIME caps
 *   4. magic-byte validate after upload
 *   5. attach req.toolLimits + req.toolRoute
 */
function toolGuard(toolRoute, kind = "single") {
  return [
    (req, res, next) => {
      const userId = req.user?.id || null;
      if (userId) {
        const { user } = resolveUserAndPlan(userId);
        if (user && user.suspended) {
          return res.status(403).json({ error: "Account is suspended" });
        }
      }
      const planName = resolvePlanName(req);
      const limits = getEffectiveLimits(planName, toolRoute, userId);
      req.toolRoute = toolRoute;
      req.toolLimits = limits;
      req.userPlan = planName;

      const today = new Date().toISOString().slice(0, 10);

      // For anonymous callers, scope the per-tool counter by a stable hash of
      // their IP so two guests on different networks each get their own
      // budget. Stashed on req so `recordUsage` uses the same key after the
      // handler runs.
      const usageKey = userId || guestKey(req);
      req.usageKey = usageKey;

      if (limits.daily_limit !== -1) {
        const used = toolUsage.countForUser(usageKey, toolRoute, today);
        if (used >= limits.daily_limit) {
          return res.status(429).json({
            error: "Daily limit reached for this tool",
            limit: limits.daily_limit,
            used,
            plan: planName,
          });
        }
      }
      next();
    },

    (req, res, next) => {
      if (kind === "text") return next();

      const limits = req.toolLimits;
      const maxBytes = limits.max_file_size_mb * 1024 * 1024;
      // For "multiple" tools (merge, batch ops), the global DEFAULTS cap of 1
      // makes the tool effectively unusable — multer rejects every request
      // before the route handler runs and the user just sees "merge failed"
      // with no explanation. When the admin hasn't set a per-plan/per-tool
      // override and we fell through to the global default, bump the floor.
      // Explicit admin overrides (recorded in `overridden_at`) still win.
      const fellThroughToDefault =
        limits.overridden_at == null && limits.max_files_per_request === DEFAULTS.max_files_per_request;
      const minForKind = kind === "multiple" && fellThroughToDefault ? 10 : 1;
      const maxFiles = Math.max(minForKind, limits.max_files_per_request);

      const m = multer({
        storage,
        fileFilter: buildFileFilter(limits),
        limits: { fileSize: maxBytes, files: maxFiles },
      });

      const handler = kind === "multiple" ? m.array("files", maxFiles) : m.single("file");

      handler(req, res, (err) => {
        if (err) {
          if (err.code === "LIMIT_FILE_SIZE") {
            return res.status(413).json({
              error: `File too large. Limit: ${limits.max_file_size_mb}MB on plan ${limits.plan}`,
              max_file_size_mb: limits.max_file_size_mb,
            });
          }
          if (err.code === "LIMIT_FILE_COUNT") {
            return res.status(413).json({
              error: `Too many files. Limit: ${maxFiles} per request on plan ${limits.plan}`,
              max_files_per_request: maxFiles,
            });
          }
          return next(err);
        }

        if (kind === "single" && !req.file) return next();
        if (kind === "multiple" && (!req.files || req.files.length === 0)) return next();

        const files = kind === "multiple" ? req.files : [req.file];
        if (!validateAndCleanup(files, res)) return;

        // Register every accepted upload in the storage manager so the cleanup
        // job + quota enforcer can see and reap it.
        try {
          const { registerFile } = require("../utils/storageManager");
          for (const f of files) {
            registerFile(f.path, {
              kind: "upload",
              userId: req.user?.id || null,
              plan: req.userPlan || null,
              toolRoute: req.toolRoute || null,
            });
          }
        } catch {
          // never let bookkeeping fail the request
        }

        next();
      });
    },
  ];
}

function recordUsage(req) {
  try {
    // Prefer the usageKey stashed by toolGuard so increments land on the same
    // row the limit check read from (real user id or guest:<hash>).
    const key = req.usageKey || req.user?.id || (req.toolRoute ? guestKey(req) : null);
    const today = new Date().toISOString().slice(0, 10);
    if (req.toolRoute) toolUsage.increment(key, req.toolRoute, today);
  } catch (e) {
    logger.warn("Failed to record tool usage", { error: e.message });
  }
}

module.exports = {
  toolGuard,
  getEffectiveLimits,
  resolveUserAndPlan,
  recordUsage,
  GLOBAL_ALLOWED_MIMES,
  ABSOLUTE_MAX_MB,
  ABSOLUTE_MAX_FILES,
  DEFAULTS,
};
