const fs = require("fs");
const path = require("path");
const { spawn, execFileSync } = require("child_process");
const { JobQueue } = require("./jobQueue");
const { outputPathFor, OUTPUTS_DIR } = require("../utils/outputPath");
const logger = require("../utils/logger");

// Office formats need a real layout engine. LibreOffice headless is the
// industry-standard open-source path: stable enough for prod, no per-call
// network anything, and free. We treat it as a system dependency — if
// missing, `pptToPdf` returns a 503-flagged error so the route can respond
// gracefully without exploding.

const CANDIDATE_BINARIES = [
  process.env.LIBREOFFICE_BIN, // explicit override wins
  "soffice",
  "libreoffice",
  "/Applications/LibreOffice.app/Contents/MacOS/soffice",
  "/usr/bin/soffice",
  "/usr/local/bin/soffice",
  "/snap/bin/libreoffice",
].filter(Boolean);

let resolvedBinary = null;
let resolvedAt = 0;
const RESOLVE_TTL_MS = 60_000;

function resolveBinary() {
  if (resolvedBinary && Date.now() - resolvedAt < RESOLVE_TTL_MS) return resolvedBinary;
  for (const candidate of CANDIDATE_BINARIES) {
    try {
      // For absolute paths just check existence; for command names rely on PATH.
      if (candidate.startsWith("/")) {
        if (fs.existsSync(candidate)) {
          resolvedBinary = candidate;
          resolvedAt = Date.now();
          return resolvedBinary;
        }
      } else {
        execFileSync(candidate, ["--version"], { stdio: "ignore", timeout: 2000 });
        resolvedBinary = candidate;
        resolvedAt = Date.now();
        return resolvedBinary;
      }
    } catch {
      // try next
    }
  }
  resolvedBinary = null;
  resolvedAt = Date.now();
  return null;
}

// LibreOffice startup is ~2–4s and the converter is single-user-per-profile.
// One-at-a-time keeps the host responsive; raise if you have many CPU cores
// AND give each task its own --user-installation profile dir.
const queue = new JobQueue({ name: "office", concurrency: 1, defaultTimeoutMs: 60_000 });

const SUPPORTED_INPUT_EXTS = [".ppt", ".pptx", ".odp", ".doc", ".docx", ".odt", ".xls", ".xlsx", ".ods"];

function notConfiguredError() {
  const err = new Error("Office conversion is not configured on this server");
  err.status = 503;
  return err;
}

/**
 * Convert a presentation/document/spreadsheet to PDF via LibreOffice headless.
 *
 * LibreOffice writes the converted file into `--outdir <dir>` named after the
 * input basename — we feed it our OUTPUTS_DIR and rename to a fresh path so
 * the rest of the pipeline (download tokens, storage manager) keeps working.
 */
exports.officeToPdf = async (inputPath) => {
  const bin = resolveBinary();
  if (!bin) throw notConfiguredError();

  const ext = path.extname(inputPath).toLowerCase();
  if (!SUPPORTED_INPUT_EXTS.includes(ext)) {
    const err = new Error(`Unsupported office format: ${ext}`);
    err.status = 400;
    throw err;
  }

  return queue.run(() => new Promise((resolve, reject) => {
    const args = [
      "--headless",
      "--norestore",
      "--nofirststartwizard",
      "--nolockcheck",
      "--convert-to", "pdf",
      "--outdir", OUTPUTS_DIR,
      inputPath,
    ];

    const proc = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    proc.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    proc.on("error", (err) => reject(err));
    proc.on("close", (code) => {
      if (code !== 0) {
        const err = new Error(`LibreOffice exited ${code}: ${stderr.slice(0, 500)}`);
        return reject(err);
      }

      // LibreOffice writes <basename>.pdf into OUTPUTS_DIR
      const baseName = path.basename(inputPath, ext);
      const producedPath = path.join(OUTPUTS_DIR, `${baseName}.pdf`);
      if (!fs.existsSync(producedPath)) {
        return reject(new Error("LibreOffice produced no output"));
      }
      // Rename to a fresh randomized path under OUTPUTS_DIR so the result
      // doesn't collide with another concurrent conversion of the same name.
      const finalPath = outputPathFor(inputPath, "office", ".pdf");
      try {
        fs.renameSync(producedPath, finalPath);
        resolve(finalPath);
      } catch (e) {
        reject(e);
      }
    });

    // Hook for the queue's timeout: kill the still-running process so it
    // doesn't keep eating CPU after we've already returned 504.
    return () => { try { proc.kill("SIGKILL"); } catch {} };
  }), {
    timeoutMs: 60_000,
    onCancel: () => logger.warn("LibreOffice conversion timed out", { inputPath }),
  });
};

exports.isAvailable = () => Boolean(resolveBinary());
exports.queueStats = () => queue.stats();
exports.SUPPORTED_INPUT_EXTS = SUPPORTED_INPUT_EXTS;
