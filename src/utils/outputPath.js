const path = require("path");
const crypto = require("crypto");
const { OUTPUTS_DIR } = require("../config/upload");

/**
 * Compute a fresh path under OUTPUTS_DIR for a tool output.
 *
 *   outputPathFor(inputPath, "compressed", ".pdf")
 *     → /<outputs>/{ts}_{8hex}_compressed.pdf
 *
 * Outputs MUST live in OUTPUTS_DIR — the cleanup interval and the download
 * token guard both rely on that. Uploads/ has its own (shorter) retention and
 * is meant for transient input files only.
 */
function outputPathFor(inputPath, suffix, explicitExt) {
  const ext = explicitExt || path.extname(inputPath) || "";
  const unique = `${Date.now()}_${crypto.randomBytes(6).toString("hex")}`;
  const tag = suffix ? `_${suffix}` : "";
  return path.join(OUTPUTS_DIR, `${unique}${tag}${ext}`);
}

module.exports = { outputPathFor, OUTPUTS_DIR };
