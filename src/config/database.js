const Database = require("better-sqlite3");
const path = require("path");
const fs = require("fs");

// Tests + alternative deployments may override with DB_PATH (absolute path).
const DB_PATH = process.env.DB_PATH
  ? path.resolve(process.env.DB_PATH)
  : path.join(__dirname, "../../data/filepilot.db");

let db = null;

function initDB() {
  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  db = new Database(DB_PATH);

  // Production PRAGMAs
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("synchronous = NORMAL");
  db.pragma("cache_size = -64000");
  db.pragma("temp_store = MEMORY");

  // Create tables
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(12)))),
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE COLLATE NOCASE,
      password TEXT,
      picture TEXT,
      plan TEXT NOT NULL DEFAULT 'free',
      otp TEXT,
      otp_expiry INTEGER,
      otp_attempts INTEGER DEFAULT 0,
      is_verified INTEGER DEFAULT 0,
      reset_otp TEXT,
      reset_otp_expiry INTEGER,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS usage (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tool TEXT NOT NULL,
      user_id TEXT,
      is_guest INTEGER DEFAULT 0,
      date TEXT NOT NULL,
      count INTEGER DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      UNIQUE(tool, user_id, date)
    );

    CREATE TABLE IF NOT EXISTS error_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      message TEXT,
      tool TEXT,
      user_id TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS refresh_tokens (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      token TEXT NOT NULL UNIQUE,
      expires_at TEXT NOT NULL,
      revoked_at TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS plans (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE COLLATE NOCASE,
      display_name TEXT NOT NULL,
      price INTEGER NOT NULL DEFAULT 0,
      currency TEXT NOT NULL DEFAULT 'INR',
      period TEXT NOT NULL DEFAULT 'month',
      description TEXT,
      daily_limit INTEGER NOT NULL DEFAULT 5,
      max_file_size_mb INTEGER NOT NULL DEFAULT 25,
      features TEXT NOT NULL DEFAULT '[]',
      is_popular INTEGER DEFAULT 0,
      is_enterprise INTEGER DEFAULT 0,
      is_active INTEGER DEFAULT 1,
      sort_order INTEGER DEFAULT 0,
      cta_text TEXT DEFAULT 'Get Started',
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS tools_config (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      route TEXT NOT NULL UNIQUE,
      category TEXT NOT NULL DEFAULT 'utility',
      description TEXT DEFAULT '',
      icon TEXT DEFAULT 'FileText',
      is_active INTEGER DEFAULT 1,
      sort_order INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS tool_access (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tool_route TEXT NOT NULL,
      plan_name TEXT NOT NULL,
      UNIQUE(tool_route, plan_name)
    );

    CREATE TABLE IF NOT EXISTS tool_limits (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      plan_name TEXT NOT NULL,
      tool_route TEXT NOT NULL,
      daily_limit INTEGER,
      max_file_size_mb INTEGER,
      max_files_per_request INTEGER,
      allowed_mime_types TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      UNIQUE(plan_name, tool_route)
    );

    CREATE TABLE IF NOT EXISTS tool_usage_daily (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT,
      is_guest INTEGER DEFAULT 0,
      tool_route TEXT NOT NULL,
      date TEXT NOT NULL,
      count INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      UNIQUE(user_id, tool_route, date)
    );

    CREATE TABLE IF NOT EXISTS site_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      is_public INTEGER DEFAULT 1,
      description TEXT,
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS blog_posts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      slug TEXT NOT NULL UNIQUE,
      title TEXT NOT NULL,
      excerpt TEXT,
      content TEXT NOT NULL,
      author TEXT,
      cover_image_url TEXT,
      tags TEXT NOT NULL DEFAULT '[]',
      published INTEGER NOT NULL DEFAULT 0,
      published_at TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS payments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      razorpay_order_id TEXT NOT NULL UNIQUE,
      razorpay_payment_id TEXT,
      razorpay_signature TEXT,
      user_id TEXT NOT NULL,
      plan_name TEXT NOT NULL,
      amount INTEGER NOT NULL,
      currency TEXT NOT NULL DEFAULT 'INR',
      status TEXT NOT NULL DEFAULT 'created',
      notes TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      actor_id TEXT,
      actor_email TEXT,
      action TEXT NOT NULL,
      target_type TEXT,
      target_id TEXT,
      before_value TEXT,
      after_value TEXT,
      ip TEXT,
      user_agent TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS user_tool_overrides (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      tool_route TEXT NOT NULL,
      daily_limit INTEGER,
      max_file_size_mb INTEGER,
      max_files_per_request INTEGER,
      allowed_mime_types TEXT,
      notes TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      UNIQUE(user_id, tool_route)
    );

    CREATE TABLE IF NOT EXISTS landing_pages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      slug TEXT NOT NULL UNIQUE,
      title TEXT NOT NULL,
      h1 TEXT NOT NULL,
      description TEXT NOT NULL,
      tool_link TEXT,
      tool_name TEXT,
      keywords TEXT,
      faqs TEXT NOT NULL DEFAULT '[]',
      meta_title TEXT,
      meta_description TEXT,
      og_image TEXT,
      published INTEGER NOT NULL DEFAULT 0,
      published_at TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS file_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      path TEXT NOT NULL UNIQUE,
      kind TEXT NOT NULL,
      user_id TEXT,
      plan TEXT,
      tool_route TEXT,
      size_bytes INTEGER NOT NULL DEFAULT 0,
      expires_at TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS download_tokens (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      token TEXT NOT NULL UNIQUE,
      file_path TEXT NOT NULL,
      filename TEXT NOT NULL,
      user_id TEXT,
      expires_at TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );
  `);

  // Migrations for older schemas
  try {
    const cols = db.prepare("PRAGMA table_info(refresh_tokens)").all();
    if (!cols.some((c) => c.name === "revoked_at")) {
      db.exec("ALTER TABLE refresh_tokens ADD COLUMN revoked_at TEXT");
    }
  } catch (e) {
    const logger = require("../utils/logger");
    logger.warn("refresh_tokens migration check failed", { error: e.message });
  }

  try {
    const cols = db.prepare("PRAGMA table_info(users)").all();
    const have = new Set(cols.map((c) => c.name));
    if (!have.has("suspended")) {
      db.exec("ALTER TABLE users ADD COLUMN suspended INTEGER DEFAULT 0");
    }
    if (!have.has("plan_expires_at")) {
      db.exec("ALTER TABLE users ADD COLUMN plan_expires_at TEXT");
    }
    if (!have.has("admin_notes")) {
      db.exec("ALTER TABLE users ADD COLUMN admin_notes TEXT");
    }
  } catch (e) {
    const logger = require("../utils/logger");
    logger.warn("users migration check failed", { error: e.message });
  }

  try {
    const cols = db.prepare("PRAGMA table_info(plans)").all();
    if (!cols.some((c) => c.name === "retention_hours")) {
      db.exec("ALTER TABLE plans ADD COLUMN retention_hours INTEGER NOT NULL DEFAULT 1");
    }
  } catch (e) {
    const logger = require("../utils/logger");
    logger.warn("plans retention_hours migration failed", { error: e.message });
  }

  // Older payment tables may pre-date the `notes` and `updated_at` columns; if
  // we don't backfill them now, the next verify call will explode with
  // "no column named notes" / "no column named updated_at" and the user can't
  // upgrade. SQLite can't add a column with a non-constant default, so the
  // updated_at backfill uses NULL and a follow-up UPDATE.
  try {
    const cols = db.prepare("PRAGMA table_info(payments)").all();
    const have = new Set(cols.map((c) => c.name));
    if (!have.has("notes")) {
      db.exec("ALTER TABLE payments ADD COLUMN notes TEXT");
    }
    if (!have.has("updated_at")) {
      db.exec("ALTER TABLE payments ADD COLUMN updated_at TEXT");
      db.exec("UPDATE payments SET updated_at = created_at WHERE updated_at IS NULL");
    }
  } catch (e) {
    const logger = require("../utils/logger");
    logger.warn("payments migration check failed", { error: e.message });
  }

  // Create indexes (IF NOT EXISTS)
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_usage_tool_date ON usage(tool, date);
    CREATE INDEX IF NOT EXISTS idx_usage_user_date ON usage(user_id, date);
    CREATE INDEX IF NOT EXISTS idx_usage_user_count ON usage(user_id, count DESC);
    CREATE INDEX IF NOT EXISTS idx_usage_date_count ON usage(date, count DESC);
    CREATE INDEX IF NOT EXISTS idx_errors_created ON error_logs(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user ON refresh_tokens(user_id);
    CREATE INDEX IF NOT EXISTS idx_refresh_tokens_token ON refresh_tokens(token);
    CREATE INDEX IF NOT EXISTS idx_tool_access_route ON tool_access(tool_route);
    CREATE INDEX IF NOT EXISTS idx_tool_access_plan ON tool_access(plan_name);
    CREATE INDEX IF NOT EXISTS idx_tool_limits_plan ON tool_limits(plan_name);
    CREATE INDEX IF NOT EXISTS idx_tool_limits_route ON tool_limits(tool_route);
    CREATE INDEX IF NOT EXISTS idx_tool_usage_user_date ON tool_usage_daily(user_id, date);
    CREATE INDEX IF NOT EXISTS idx_tool_usage_tool_date ON tool_usage_daily(tool_route, date);
    CREATE INDEX IF NOT EXISTS idx_blog_published ON blog_posts(published, published_at DESC);
    CREATE INDEX IF NOT EXISTS idx_payments_user ON payments(user_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_payments_status ON payments(status, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_audit_actor ON audit_log(actor_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_log(action, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_user_overrides_user ON user_tool_overrides(user_id);
    CREATE INDEX IF NOT EXISTS idx_landing_published ON landing_pages(published, slug);
    CREATE INDEX IF NOT EXISTS idx_file_records_expires ON file_records(expires_at);
    CREATE INDEX IF NOT EXISTS idx_file_records_created ON file_records(created_at);
    CREATE INDEX IF NOT EXISTS idx_file_records_user ON file_records(user_id);
    CREATE INDEX IF NOT EXISTS idx_download_tokens_expires ON download_tokens(expires_at);
  `);

  const logger = require("../utils/logger");
  logger.info("SQLite database initialized", { path: DB_PATH });
  return db;
}

function getDB() {
  if (!db) throw new Error("Database not initialized. Call initDB() first.");
  return db;
}

function closeDB() {
  if (db) {
    try {
      db.close();
    } catch (e) {
      const logger = require("../utils/logger");
      logger.error("Failed to close DB", { error: e.message });
    }
    db = null;
  }
}

module.exports = { initDB, getDB, closeDB };
