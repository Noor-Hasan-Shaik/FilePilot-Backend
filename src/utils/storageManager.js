const fs = require("fs");
const path = require("path");
const { fileRecords, plans, siteSettings, downloadTokens } = require("../models/db");
const { UPLOADS_DIR, OUTPUTS_DIR } = require("../config/upload");
const logger = require("./logger");

// Uploads are always short-lived — they only need to live long enough for the
// tool to process them. 1h is generous; user has already downloaded the result
// long before this would matter.
const UPLOAD_RETENTION_HOURS = 1;
const DEFAULT_PLAN_RETENTION_HOURS = 1;
const DEFAULT_MAX_DISK_GB = 10;
const EVICT_TO_FRACTION = 0.9; // when over cap, evict down to 90% of cap

function planRetentionHours(planName) {
  if (!planName) return DEFAULT_PLAN_RETENTION_HOURS;
  const plan = plans.findByName(planName);
  if (!plan || !plan.retention_hours) return DEFAULT_PLAN_RETENTION_HOURS;
  return plan.retention_hours;
}

function expiresAtFor(kind, planName) {
  const hours = kind === "upload" ? UPLOAD_RETENTION_HOURS : planRetentionHours(planName);
  return new Date(Date.now() + hours * 60 * 60 * 1000).toISOString();
}

function isInsideManagedDirs(filePath) {
  const resolved = path.resolve(filePath);
  return (
    resolved === path.resolve(UPLOADS_DIR) ||
    resolved.startsWith(path.resolve(UPLOADS_DIR) + path.sep) ||
    resolved === path.resolve(OUTPUTS_DIR) ||
    resolved.startsWith(path.resolve(OUTPUTS_DIR) + path.sep)
  );
}

/**
 * Register a file as managed storage. Should be called any time a file is
 * created inside uploads/ or outputs/.
 *   kind        "upload" | "output"
 *   planName    plan name (for output retention); ignored for uploads
 *   userId      authenticated user id, if any
 *   toolRoute   /tool/... route this file was produced by
 */
function registerFile(filePath, { kind, userId = null, plan = null, toolRoute = null } = {}) {
  try {
    if (!filePath || !isInsideManagedDirs(filePath)) return;
    let size = 0;
    try { size = fs.statSync(filePath).size; } catch { size = 0; }
    fileRecords.upsert(filePath, {
      kind,
      user_id: userId,
      plan,
      tool_route: toolRoute,
      size_bytes: size,
      expires_at: expiresAtFor(kind, plan),
    });
  } catch (e) {
    logger.warn("registerFile failed", { error: e.message, filePath });
  }
}

function unregister(filePath) {
  try { fileRecords.removeByPath(filePath); } catch {}
}

function deleteManagedFile(filePath) {
  try {
    if (filePath && fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch (e) {
    logger.warn("deleteManagedFile unlink failed", { error: e.message, filePath });
  }
  unregister(filePath);
}

function maxDiskBytes() {
  const gb = Number(siteSettings.getValue("storage.max_disk_gb", DEFAULT_MAX_DISK_GB));
  const safe = Number.isFinite(gb) && gb > 0 ? gb : DEFAULT_MAX_DISK_GB;
  return Math.floor(safe * 1024 * 1024 * 1024);
}

/**
 * Delete all expired files + their records. Safe to call repeatedly.
 * Returns the number of files deleted.
 */
function cleanupExpired() {
  const expired = fileRecords.findExpired(1000);
  for (const r of expired) deleteManagedFile(r.path);
  return expired.length;
}

/**
 * Enforce the total-disk-size cap. If above the cap, evict oldest first
 * (LRU by created_at) until total <= cap * EVICT_TO_FRACTION. Skips already-
 * expired records (cleanupExpired handles those) by virtue of pulling oldest.
 */
function enforceQuota() {
  const cap = maxDiskBytes();
  let total = fileRecords.totalBytes();
  if (total <= cap) return { evicted: 0, total, cap };

  const target = Math.floor(cap * EVICT_TO_FRACTION);
  const candidates = fileRecords.findOldest(5000);
  let evicted = 0;
  for (const r of candidates) {
    if (total <= target) break;
    deleteManagedFile(r.path);
    total -= r.size_bytes || 0;
    evicted += 1;
  }
  if (evicted > 0) {
    logger.info("Storage quota enforced", { evicted, total, cap });
  }
  return { evicted, total, cap };
}

function purgeExpiredDownloadTokens() {
  try { return downloadTokens.removeExpired(); } catch { return 0; }
}

function diskStats() {
  return {
    by_kind: fileRecords.countByKind(),
    total_bytes: fileRecords.totalBytes(),
    max_bytes: maxDiskBytes(),
  };
}

module.exports = {
  registerFile,
  unregister,
  deleteManagedFile,
  cleanupExpired,
  enforceQuota,
  purgeExpiredDownloadTokens,
  diskStats,
  expiresAtFor,
  planRetentionHours,
  UPLOAD_RETENTION_HOURS,
};
