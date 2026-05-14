const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

function envLevel() {
  const lvl = (process.env.LOG_LEVEL || (process.env.NODE_ENV === "production" ? "info" : "debug")).toLowerCase();
  return LEVELS[lvl] || LEVELS.info;
}

const threshold = envLevel();
const useJson = process.env.NODE_ENV === "production" || process.env.LOG_FORMAT === "json";

function emit(level, msg, meta) {
  if (LEVELS[level] < threshold) return;

  if (useJson) {
    const payload = { level, time: new Date().toISOString(), msg };
    if (meta && typeof meta === "object") Object.assign(payload, meta);
    const line = JSON.stringify(payload);
    if (level === "error") process.stderr.write(line + "\n");
    else process.stdout.write(line + "\n");
    return;
  }

  const prefix = `[${level.toUpperCase()}]`;
  if (meta) {
    if (level === "error") console.error(prefix, msg, meta);
    else if (level === "warn") console.warn(prefix, msg, meta);
    else console.log(prefix, msg, meta);
  } else {
    if (level === "error") console.error(prefix, msg);
    else if (level === "warn") console.warn(prefix, msg);
    else console.log(prefix, msg);
  }
}

module.exports = {
  debug: (msg, meta) => emit("debug", msg, meta),
  info: (msg, meta) => emit("info", msg, meta),
  warn: (msg, meta) => emit("warn", msg, meta),
  error: (msg, meta) => emit("error", msg, meta),
};
