const isProduction = process.env.NODE_ENV === "production";

function parseOrigins(value) {
  if (!value) return [];
  return value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function requireEnv(name) {
  const value = process.env[name];
  if (!value || !value.trim()) {
    console.error(`[FATAL] Missing required env var: ${name}`);
    process.exit(1);
  }
  return value;
}

// Catches common placeholder secrets copy-pasted from .env.example or generic
// "change me" strings. We can't keep an exhaustive blocklist, so detect the
// shape: contains words like "change", "your_", "placeholder", "secret_here",
// or repeats the same character / has very low entropy.
function looksLikePlaceholder(value) {
  if (typeof value !== "string") return true;
  const v = value.trim().toLowerCase();
  if (!v) return true;
  if (/(change[_\- ]?me|your[_\- ]|placeholder|example|secret[_\- ]here|jwt[_\- ]secret[_\- ]here)/.test(v)) {
    return true;
  }
  // Single repeated character (e.g. "aaaaaaaa...").
  if (/^(.)\1+$/.test(v)) return true;
  // Effectively no entropy — only a handful of distinct chars across a long
  // string almost certainly means it's a typed placeholder, not random.
  const distinct = new Set(v).size;
  if (v.length >= 32 && distinct < 8) return true;
  return false;
}

function validateEnv() {
  requireEnv("JWT_SECRET");

  const secret = process.env.JWT_SECRET || "";
  if (secret.length < 32) {
    console.error("[FATAL] JWT_SECRET must be at least 32 characters");
    console.error("       Generate one with: node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\"");
    process.exit(1);
  }
  if (looksLikePlaceholder(secret)) {
    console.error("[FATAL] JWT_SECRET looks like a placeholder. Set a real random secret.");
    console.error("       Generate one with: node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\"");
    process.exit(1);
  }

  if (isProduction) {
    requireEnv("CORS_ORIGIN");
    requireEnv("GOOGLE_CLIENT_ID");
    if (!process.env.RAZORPAY_KEY_ID || !process.env.RAZORPAY_SECRET) {
      console.warn("[WARN] Razorpay keys not set — payment endpoints will return 503");
    }
    if (!process.env.EMAIL_USER || !process.env.EMAIL_PASS) {
      console.warn("[WARN] Email credentials not set — OTP delivery will fail");
    }
  }
}

validateEnv();

const corsOrigins = parseOrigins(process.env.CORS_ORIGIN || "http://localhost:8080");

module.exports = {
  isProduction,

  // Default aligned with the frontend's VITE_API_BASE_URL fallback so a dev
  // who forgets to copy the backend .env still gets a working pair instead of
  // a silent 5000-vs-5001 mismatch.
  PORT: parseInt(process.env.PORT, 10) || 5001,

  CORS_ORIGIN: corsOrigins.length === 1 ? corsOrigins[0] : corsOrigins,
  CORS_ORIGINS: corsOrigins,

  ACCESS_TOKEN_EXPIRY: "15m",

  OTP_EXPIRY_MINUTES: 5,
  RESET_OTP_EXPIRY_MINUTES: 10,
  MAX_OTP_ATTEMPTS: 5,

  PLANS: {
    FREE: "free",
    PRO: "pro",
    BUSINESS: "business",
    ADMIN: "admin",
  },

  STATS_CACHE_TTL: 10000,

  PASSWORD_MIN_LENGTH: 8,
};
