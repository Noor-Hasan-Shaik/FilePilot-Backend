const fs = require("fs");
const path = require("path");
const { UPLOADS_DIR, OUTPUTS_DIR } = require("../config/upload");
const logger = require("./logger");
const storageManager = require("./storageManager");

const CLEANUP_INTERVAL_MS = 5 * 60 * 1000; // 5 min
// Files that were created outside of the request pipeline (e.g. by an aborted
// process that died before registerFile ran). We sweep them after this age so
// they don't accumulate forever.
const ORPHAN_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * Best-effort delete. Never throws.
 */
function removeFile(filePath) {
  try {
    if (filePath && fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch {
    // ignore — file may have been deleted by another process
  }
}

/**
 * Walk a directory and unlink files not registered in file_records AND older
 * than ORPHAN_MAX_AGE_MS. This is a backstop for crashed/aborted requests; the
 * normal path is `storageManager.cleanupExpired()`.
 */
function sweepOrphans(dirPath) {
  if (!fs.existsSync(dirPath)) return 0;
  const { fileRecords } = require("../models/db");
  const now = Date.now();
  let removed = 0;
  for (const name of fs.readdirSync(dirPath)) {
    if (name === ".gitkeep") continue;
    const full = path.join(dirPath, name);
    try {
      const st = fs.statSync(full);
      if (now - st.mtimeMs <= ORPHAN_MAX_AGE_MS) continue;
      if (fileRecords.findByPath(full)) continue;
      fs.unlinkSync(full);
      removed += 1;
    } catch {
      // ignore
    }
  }
  return removed;
}

function runCleanup() {
  try {
    const expired = storageManager.cleanupExpired();
    const tokens = storageManager.purgeExpiredDownloadTokens();
    const { evicted } = storageManager.enforceQuota();
    const orphansUploads = sweepOrphans(UPLOADS_DIR);
    const orphansOutputs = sweepOrphans(OUTPUTS_DIR);
    if (expired || tokens || evicted || orphansUploads || orphansOutputs) {
      logger.info("Storage cleanup ran", {
        expired_files: expired,
        expired_tokens: tokens,
        quota_evicted: evicted,
        orphans_uploads: orphansUploads,
        orphans_outputs: orphansOutputs,
      });
    }
  } catch (e) {
    logger.error("Storage cleanup failed", { error: e.message });
  }
}

function startCleanupInterval(intervalMs = CLEANUP_INTERVAL_MS) {
  runCleanup();
  const handle = setInterval(runCleanup, intervalMs);
  handle.unref();
  return handle;
}

// Back-compat exports used elsewhere in the codebase.
module.exports = {
  removeFile,
  runCleanup,
  startCleanupInterval,
  cleanupAll: runCleanup,
  cleanupUploads: runCleanup,
  cleanupOutputs: runCleanup,
};
