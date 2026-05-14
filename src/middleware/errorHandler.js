const { isProduction } = require("../config/constants");
const logger = require("../utils/logger");

// Full stack traces can disclose file paths, line numbers, and dependency
// internals — not something we want in shared dev consoles or aggregated logs
// by default. Opt in explicitly via DEBUG_ERRORS=1 when actively debugging.
const includeFullStack = process.env.DEBUG_ERRORS === "1";

function shortFrame(stack) {
  if (typeof stack !== "string") return undefined;
  // Keep just the first call-site line ("at fn (file:line:col)") which is
  // usually enough to triage without leaking the whole call tree.
  const lines = stack.split("\n").map((l) => l.trim());
  return lines.find((l) => l.startsWith("at ")) || undefined;
}

function errorHandler(err, req, res, next) {
  const status = err.status || err.statusCode || 500;

  if (status >= 500) {
    logger.error(`${req.method} ${req.path}`, {
      name: err.name,
      message: err.message,
      ...(includeFullStack ? { stack: err.stack } : { frame: shortFrame(err.stack) }),
    });
  }

  if (err && err.message && err.message.startsWith("Not allowed by CORS")) {
    return res.status(403).json({ error: "CORS: origin not allowed" });
  }

  if (err.code === "SQLITE_CONSTRAINT_UNIQUE") {
    return res.status(409).json({ error: "Duplicate entry" });
  }
  if (err.code === "SQLITE_CONSTRAINT") {
    return res.status(400).json({ error: "Validation failed" });
  }
  if (err.code === "LIMIT_FILE_SIZE") {
    return res.status(413).json({ error: "File too large" });
  }
  if (err.code === "LIMIT_UNEXPECTED_FILE") {
    return res.status(400).json({ error: "Unexpected file field" });
  }
  if (err.type === "entity.parse.failed") {
    return res.status(400).json({ error: "Invalid JSON body" });
  }
  if (err.type === "entity.too.large") {
    return res.status(413).json({ error: "Request body too large" });
  }

  if (status >= 500) {
    return res.status(500).json({
      error: isProduction ? "Internal server error" : err.message || "Internal server error",
    });
  }

  res.status(status).json({ error: err.message || "Request failed" });
}

module.exports = errorHandler;
