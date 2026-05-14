const crypto = require("crypto");

const GUEST_PREFIX = "guest:";

// Derive a stable per-request identity for an unauthenticated caller so we
// can scope per-day usage counters to them. Using `req.ip` keeps it simple;
// when behind a proxy/load balancer the upstream `trust proxy` setting decides
// whether `req.ip` reflects the real client IP. We hash it (with a per-process
// salt mixed in via SESSION_SECRET when available) so the value isn't a PII
// echo of the source IP in DB rows.
function guestKey(req) {
  const ip = (req && (req.ip || req.connection?.remoteAddress)) || "unknown";
  const salt = process.env.SESSION_SECRET || "filepilot-guest";
  const h = crypto.createHash("sha256").update(`${salt}:${ip}`).digest("hex").slice(0, 32);
  return `${GUEST_PREFIX}${h}`;
}

function isGuestKey(key) {
  return typeof key === "string" && key.startsWith(GUEST_PREFIX);
}

module.exports = { guestKey, isGuestKey, GUEST_PREFIX };
