const { getDB } = require("../config/database");
const crypto = require("crypto");

function generateId() {
  return crypto.randomBytes(12).toString("hex");
}

function now() {
  return new Date().toISOString().replace("T", " ").slice(0, 19);
}

// ─── Users ───────────────────────────────────────────

const users = {
  findByEmail(email) {
    return getDB().prepare("SELECT * FROM users WHERE email = ?").get(email);
  },

  findById(id) {
    return getDB().prepare("SELECT * FROM users WHERE id = ?").get(id);
  },

  create(data) {
    const id = generateId();
    const ts = now();
    getDB()
      .prepare(
        `INSERT INTO users (id, name, email, password, picture, plan, otp, otp_expiry, otp_attempts, is_verified, reset_otp, reset_otp_expiry, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        data.name,
        data.email,
        data.password || null,
        data.picture || null,
        data.plan || "free",
        data.otp || null,
        data.otp_expiry || null,
        data.otp_attempts || 0,
        data.is_verified ? 1 : 0,
        data.reset_otp || null,
        data.reset_otp_expiry || null,
        ts,
        ts
      );
    return users.findById(id);
  },

  update(id, fields) {
    const allowed = [
      "name", "email", "password", "picture", "plan",
      "otp", "otp_expiry", "otp_attempts", "is_verified",
      "reset_otp", "reset_otp_expiry",
      "suspended", "plan_expires_at", "admin_notes",
    ];
    const sets = [];
    const values = [];
    for (const [key, val] of Object.entries(fields)) {
      if (allowed.includes(key)) {
        sets.push(`${key} = ?`);
        values.push(val);
      }
    }
    if (sets.length === 0) return users.findById(id);
    sets.push("updated_at = ?");
    values.push(now());
    values.push(id);
    getDB()
      .prepare(`UPDATE users SET ${sets.join(", ")} WHERE id = ?`)
      .run(...values);
    return users.findById(id);
  },

  upsertByEmail(email, data) {
    const existing = users.findByEmail(email);
    if (existing) {
      return users.update(existing.id, data);
    }
    return users.create({ email, ...data });
  },

  deleteById(id) {
    getDB().prepare("DELETE FROM users WHERE id = ?").run(id);
  },

  findAll(orderBy = "created_at DESC") {
    const allowedColumns = ["created_at", "updated_at", "name", "email", "plan", "id"];
    const allowedDirs = ["ASC", "DESC"];
    const [col, dir = "DESC"] = orderBy.split(/\s+/);
    const safeCol = allowedColumns.includes(col) ? col : "created_at";
    const safeDir = allowedDirs.includes(dir.toUpperCase()) ? dir.toUpperCase() : "DESC";
    return getDB().prepare(`SELECT * FROM users ORDER BY ${safeCol} ${safeDir}`).all();
  },

  count(where) {
    if (!where) return getDB().prepare("SELECT COUNT(*) as c FROM users").get().c;
    const { clause, params } = where;
    return getDB().prepare(`SELECT COUNT(*) as c FROM users WHERE ${clause}`).get(...params).c;
  },
};

// ─── Usage ───────────────────────────────────────────

const { isGuestKey } = require("../utils/guestKey");

const usage = {
  upsertDaily(tool, userId, date) {
    // `userId` may be a real user id, a "guest:<hash>" key for an anonymous
    // session, or null. Guests get their own row scoped by the key so they
    // don't all collide on a single `user_id IS NULL` bucket.
    const isGuest = !userId || isGuestKey(userId) ? 1 : 0;
    getDB()
      .prepare(
        `INSERT INTO usage (tool, user_id, is_guest, date, count, created_at, updated_at)
         VALUES (?, ?, ?, ?, 1, datetime('now'), datetime('now'))
         ON CONFLICT(tool, user_id, date)
         DO UPDATE SET count = count + 1, updated_at = datetime('now')`
      )
      .run(tool, userId || null, isGuest, date);
  },

  findByUserAndDate(userId, date) {
    if (userId) {
      return getDB()
        .prepare("SELECT * FROM usage WHERE user_id = ? AND date = ?")
        .all(userId, date);
    }
    return getDB()
      .prepare("SELECT * FROM usage WHERE user_id IS NULL AND is_guest = 1 AND date = ?")
      .all(date);
  },

  totalForUserOnDate(userId, date) {
    // A non-null userId (real user id or guest key) is scoped to that single
    // row. A null userId means "all guests on this date" — kept for legacy
    // callers, but new code should pass a guestKey instead.
    const row = userId
      ? getDB()
          .prepare("SELECT COALESCE(SUM(count), 0) as total FROM usage WHERE user_id = ? AND date = ?")
          .get(userId, date)
      : getDB()
          .prepare("SELECT COALESCE(SUM(count), 0) as total FROM usage WHERE user_id IS NULL AND is_guest = 1 AND date = ?")
          .get(date);
    return row.total;
  },

  totalUsage(since) {
    if (since) {
      return getDB()
        .prepare("SELECT COALESCE(SUM(count), 0) as total FROM usage WHERE created_at >= ?")
        .get(since).total;
    }
    return getDB().prepare("SELECT COALESCE(SUM(count), 0) as total FROM usage").get().total;
  },

  toolStats(since) {
    const q = since
      ? "SELECT tool as _id, SUM(count) as count FROM usage WHERE created_at >= ? GROUP BY tool ORDER BY count DESC"
      : "SELECT tool as _id, SUM(count) as count FROM usage GROUP BY tool ORDER BY count DESC";
    return since ? getDB().prepare(q).all(since) : getDB().prepare(q).all();
  },

  dailyStats(since, format = "%Y-%m-%d") {
    const q = since
      ? `SELECT strftime('${format}', created_at) as label, SUM(count) as count FROM usage WHERE created_at >= ? GROUP BY label ORDER BY label`
      : `SELECT date as label, SUM(count) as count FROM usage GROUP BY date ORDER BY date`;
    return since ? getDB().prepare(q).all(since) : getDB().prepare(q).all();
  },

  activeUsers(date, since) {
    if (since) {
      return getDB()
        .prepare("SELECT COUNT(DISTINCT user_id) as c FROM usage WHERE user_id IS NOT NULL AND created_at >= ?")
        .get(since).c;
    }
    return getDB()
      .prepare("SELECT COUNT(DISTINCT user_id) as c FROM usage WHERE user_id IS NOT NULL AND date = ?")
      .get(date).c;
  },

  topUsers(limit = 5, since) {
    const q = since
      ? `SELECT u.user_id as _id, COALESCE(usr.email, 'Unknown') as email, SUM(u.count) as usage
         FROM usage u LEFT JOIN users usr ON u.user_id = usr.id
         WHERE u.user_id IS NOT NULL AND u.created_at >= ?
         GROUP BY u.user_id ORDER BY usage DESC LIMIT ?`
      : `SELECT u.user_id as _id, COALESCE(usr.email, 'Unknown') as email, SUM(u.count) as usage
         FROM usage u LEFT JOIN users usr ON u.user_id = usr.id
         WHERE u.user_id IS NOT NULL
         GROUP BY u.user_id ORDER BY usage DESC LIMIT ?`;
    return since
      ? getDB().prepare(q).all(since, limit)
      : getDB().prepare(q).all(limit);
  },

  byUser(userId) {
    return {
      daily: getDB()
        .prepare("SELECT date as _id, SUM(count) as count FROM usage WHERE user_id = ? GROUP BY date ORDER BY date")
        .all(userId),
      byTool: getDB()
        .prepare("SELECT tool as _id, SUM(count) as count FROM usage WHERE user_id = ? GROUP BY tool ORDER BY count DESC")
        .all(userId),
      total: getDB()
        .prepare("SELECT COALESCE(SUM(count), 0) as total FROM usage WHERE user_id = ?")
        .get(userId).total,
    };
  },

  deleteByUser(userId) {
    getDB().prepare("DELETE FROM usage WHERE user_id = ?").run(userId);
  },
};

// ─── Error Logs ──────────────────────────────────────

const errorLogs = {
  create(data) {
    getDB()
      .prepare("INSERT INTO error_logs (message, tool, user_id) VALUES (?, ?, ?)")
      .run(data.message || null, data.tool || null, data.user_id || null);
  },

  count(since) {
    if (since) {
      return getDB()
        .prepare("SELECT COUNT(*) as c FROM error_logs WHERE created_at >= ?")
        .get(since).c;
    }
    return getDB().prepare("SELECT COUNT(*) as c FROM error_logs").get().c;
  },

  recent(limit = 5, since) {
    if (since) {
      return getDB()
        .prepare("SELECT * FROM error_logs WHERE created_at >= ? ORDER BY created_at DESC LIMIT ?")
        .all(since, limit);
    }
    return getDB()
      .prepare("SELECT * FROM error_logs ORDER BY created_at DESC LIMIT ?")
      .all(limit);
  },
};

// ─── Refresh Tokens ──────────────────────────────────

const refreshTokens = {
  create(userId, token, expiresAt) {
    getDB()
      .prepare("INSERT INTO refresh_tokens (user_id, token, expires_at) VALUES (?, ?, ?)")
      .run(userId, token, expiresAt);
  },

  findByToken(token) {
    return getDB().prepare("SELECT * FROM refresh_tokens WHERE token = ?").get(token);
  },

  revoke(token) {
    getDB()
      .prepare("UPDATE refresh_tokens SET revoked_at = datetime('now') WHERE token = ? AND revoked_at IS NULL")
      .run(token);
  },

  deleteByToken(token) {
    getDB().prepare("DELETE FROM refresh_tokens WHERE token = ?").run(token);
  },

  deleteByUser(userId) {
    getDB().prepare("DELETE FROM refresh_tokens WHERE user_id = ?").run(userId);
  },

  deleteExpired() {
    getDB().prepare("DELETE FROM refresh_tokens WHERE expires_at < datetime('now') OR (revoked_at IS NOT NULL AND revoked_at < datetime('now','-7 days'))").run();
  },
};

// ─── Plans ───────────────────────────────────────────

const plans = {
  findAll(activeOnly = false) {
    const q = activeOnly
      ? "SELECT * FROM plans WHERE is_active = 1 ORDER BY sort_order, id"
      : "SELECT * FROM plans ORDER BY sort_order, id";
    return getDB().prepare(q).all().map(plans._parse);
  },

  findById(id) {
    const row = getDB().prepare("SELECT * FROM plans WHERE id = ?").get(id);
    return row ? plans._parse(row) : null;
  },

  findByName(name) {
    const row = getDB().prepare("SELECT * FROM plans WHERE name = ?").get(name);
    return row ? plans._parse(row) : null;
  },

  create(data) {
    const ts = now();
    const result = getDB()
      .prepare(
        `INSERT INTO plans (name, display_name, price, currency, period, description, daily_limit, max_file_size_mb, features, is_popular, is_enterprise, is_active, sort_order, cta_text, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        data.name,
        data.display_name || data.name,
        data.price || 0,
        data.currency || "INR",
        data.period || "month",
        data.description || "",
        data.daily_limit ?? 5,
        data.max_file_size_mb ?? 25,
        JSON.stringify(data.features || []),
        data.is_popular ? 1 : 0,
        data.is_enterprise ? 1 : 0,
        data.is_active !== false ? 1 : 0,
        data.sort_order ?? 0,
        data.cta_text || "Get Started",
        ts,
        ts
      );
    return plans.findById(result.lastInsertRowid);
  },

  update(id, fields) {
    const allowed = [
      "name", "display_name", "price", "currency", "period", "description",
      "daily_limit", "max_file_size_mb", "features", "is_popular",
      "is_enterprise", "is_active", "sort_order", "cta_text", "retention_hours",
    ];
    const sets = [];
    const values = [];
    for (const [key, val] of Object.entries(fields)) {
      if (allowed.includes(key)) {
        sets.push(`${key} = ?`);
        values.push(key === "features" ? JSON.stringify(val) : val);
      }
    }
    if (sets.length === 0) return plans.findById(id);
    sets.push("updated_at = ?");
    values.push(now());
    values.push(id);
    getDB().prepare(`UPDATE plans SET ${sets.join(", ")} WHERE id = ?`).run(...values);
    return plans.findById(id);
  },

  deleteById(id) {
    getDB().prepare("DELETE FROM plans WHERE id = ?").run(id);
    getDB().prepare("DELETE FROM tool_access WHERE plan_name = (SELECT name FROM plans WHERE id = ?)").run(id);
  },

  _parse(row) {
    if (!row) return null;
    try {
      row.features = JSON.parse(row.features || "[]");
    } catch {
      row.features = [];
    }
    return row;
  },
};

// ─── Tool Access ─────────────────────────────────────

const toolAccess = {
  getForPlan(planName) {
    return getDB()
      .prepare("SELECT tool_route FROM tool_access WHERE plan_name = ?")
      .all(planName)
      .map((r) => r.tool_route);
  },

  getAll() {
    return getDB().prepare("SELECT * FROM tool_access ORDER BY plan_name, tool_route").all();
  },

  getGroupedByPlan() {
    const rows = toolAccess.getAll();
    const grouped = {};
    for (const row of rows) {
      if (!grouped[row.plan_name]) grouped[row.plan_name] = [];
      grouped[row.plan_name].push(row.tool_route);
    }
    return grouped;
  },

  getAccessMap() {
    // Returns { tool_route: [plan_names] } for frontend consumption
    const rows = toolAccess.getAll();
    const map = {};
    for (const row of rows) {
      if (!map[row.tool_route]) map[row.tool_route] = [];
      map[row.tool_route].push(row.plan_name);
    }
    return map;
  },

  setForPlan(planName, toolRoutes) {
    const db = getDB();
    const del = db.prepare("DELETE FROM tool_access WHERE plan_name = ?");
    const ins = db.prepare("INSERT INTO tool_access (tool_route, plan_name) VALUES (?, ?)");

    const tx = db.transaction(() => {
      del.run(planName);
      for (const route of toolRoutes) {
        ins.run(route, planName);
      }
    });
    tx();
  },

  addTool(planName, toolRoute) {
    getDB()
      .prepare("INSERT OR IGNORE INTO tool_access (tool_route, plan_name) VALUES (?, ?)")
      .run(toolRoute, planName);
  },

  removeTool(planName, toolRoute) {
    getDB()
      .prepare("DELETE FROM tool_access WHERE plan_name = ? AND tool_route = ?")
      .run(planName, toolRoute);
  },
};

// ─── Tools Config ────────────────────────────────────

const toolsConfig = {
  findAll() {
    return getDB().prepare("SELECT * FROM tools_config ORDER BY sort_order, id").all();
  },

  findById(id) {
    return getDB().prepare("SELECT * FROM tools_config WHERE id = ?").get(id);
  },

  findByRoute(route) {
    return getDB().prepare("SELECT * FROM tools_config WHERE route = ?").get(route);
  },

  create(data) {
    const ts = now();
    const result = getDB()
      .prepare(
        `INSERT INTO tools_config (title, route, category, description, icon, is_active, sort_order, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        data.title, data.route, data.category || "utility",
        data.description || "", data.icon || "FileText",
        data.is_active !== false ? 1 : 0, data.sort_order ?? 0, ts, ts
      );
    return toolsConfig.findById(result.lastInsertRowid);
  },

  update(id, fields) {
    const allowed = ["title", "route", "category", "description", "icon", "is_active", "sort_order"];
    const sets = [];
    const values = [];
    for (const [key, val] of Object.entries(fields)) {
      if (allowed.includes(key)) {
        sets.push(`${key} = ?`);
        values.push(val);
      }
    }
    if (sets.length === 0) return toolsConfig.findById(id);
    sets.push("updated_at = ?");
    values.push(now());
    values.push(id);
    getDB().prepare(`UPDATE tools_config SET ${sets.join(", ")} WHERE id = ?`).run(...values);
    return toolsConfig.findById(id);
  },

  deleteById(id) {
    const tool = toolsConfig.findById(id);
    if (tool) {
      getDB().prepare("DELETE FROM tool_access WHERE tool_route = ?").run(tool.route);
    }
    getDB().prepare("DELETE FROM tools_config WHERE id = ?").run(id);
  },
};

// ─── Tool Limits ─────────────────────────────────────

const toolLimits = {
  _parse(row) {
    if (!row) return null;
    try {
      row.allowed_mime_types = row.allowed_mime_types ? JSON.parse(row.allowed_mime_types) : null;
    } catch {
      row.allowed_mime_types = null;
    }
    return row;
  },

  find(planName, toolRoute) {
    const row = getDB()
      .prepare("SELECT * FROM tool_limits WHERE plan_name = ? AND tool_route = ?")
      .get(planName, toolRoute);
    return toolLimits._parse(row);
  },

  findAll() {
    return getDB().prepare("SELECT * FROM tool_limits ORDER BY plan_name, tool_route").all().map(toolLimits._parse);
  },

  findByPlan(planName) {
    return getDB().prepare("SELECT * FROM tool_limits WHERE plan_name = ?").all(planName).map(toolLimits._parse);
  },

  findByTool(toolRoute) {
    return getDB().prepare("SELECT * FROM tool_limits WHERE tool_route = ?").all(toolRoute).map(toolLimits._parse);
  },

  upsert(planName, toolRoute, fields) {
    const mime = Array.isArray(fields.allowed_mime_types)
      ? JSON.stringify(fields.allowed_mime_types)
      : fields.allowed_mime_types ?? null;
    getDB()
      .prepare(
        `INSERT INTO tool_limits (plan_name, tool_route, daily_limit, max_file_size_mb, max_files_per_request, allowed_mime_types, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
         ON CONFLICT(plan_name, tool_route) DO UPDATE SET
           daily_limit = excluded.daily_limit,
           max_file_size_mb = excluded.max_file_size_mb,
           max_files_per_request = excluded.max_files_per_request,
           allowed_mime_types = excluded.allowed_mime_types,
           updated_at = datetime('now')`
      )
      .run(
        planName,
        toolRoute,
        fields.daily_limit ?? null,
        fields.max_file_size_mb ?? null,
        fields.max_files_per_request ?? null,
        mime
      );
    return toolLimits.find(planName, toolRoute);
  },

  remove(planName, toolRoute) {
    getDB().prepare("DELETE FROM tool_limits WHERE plan_name = ? AND tool_route = ?").run(planName, toolRoute);
  },

  removeByPlan(planName) {
    getDB().prepare("DELETE FROM tool_limits WHERE plan_name = ?").run(planName);
  },

  removeByTool(toolRoute) {
    getDB().prepare("DELETE FROM tool_limits WHERE tool_route = ?").run(toolRoute);
  },
};

// ─── Per-tool Daily Usage ────────────────────────────

const toolUsage = {
  increment(userId, toolRoute, date) {
    // Same as `usage.upsertDaily`: a "guest:<hash>" key counts as a guest but
    // gets its own row, so two anonymous users on different IPs don't share
    // (and exhaust) a single counter.
    const isGuest = !userId || isGuestKey(userId) ? 1 : 0;
    getDB()
      .prepare(
        `INSERT INTO tool_usage_daily (user_id, is_guest, tool_route, date, count, created_at, updated_at)
         VALUES (?, ?, ?, ?, 1, datetime('now'), datetime('now'))
         ON CONFLICT(user_id, tool_route, date)
         DO UPDATE SET count = count + 1, updated_at = datetime('now')`
      )
      .run(userId || null, isGuest, toolRoute, date);
  },

  countForUser(userId, toolRoute, date) {
    const row = userId
      ? getDB()
          .prepare("SELECT COALESCE(count,0) as c FROM tool_usage_daily WHERE user_id = ? AND tool_route = ? AND date = ?")
          .get(userId, toolRoute, date)
      : getDB()
          .prepare("SELECT COALESCE(count,0) as c FROM tool_usage_daily WHERE user_id IS NULL AND tool_route = ? AND date = ?")
          .get(toolRoute, date);
    return row ? row.c : 0;
  },

  totalForUser(userId, date) {
    const row = userId
      ? getDB()
          .prepare("SELECT COALESCE(SUM(count),0) as c FROM tool_usage_daily WHERE user_id = ? AND date = ?")
          .get(userId, date)
      : getDB()
          .prepare("SELECT COALESCE(SUM(count),0) as c FROM tool_usage_daily WHERE user_id IS NULL AND date = ?")
          .get(date);
    return row ? row.c : 0;
  },

  resetForUser(userId) {
    getDB().prepare("DELETE FROM tool_usage_daily WHERE user_id = ?").run(userId);
  },
};

// ─── Site Settings (CMS) ─────────────────────────────

const siteSettings = {
  _parse(row) {
    if (!row) return null;
    try {
      row.value = JSON.parse(row.value);
    } catch {
      row.value = null;
    }
    return row;
  },

  get(key) {
    const row = getDB().prepare("SELECT * FROM site_settings WHERE key = ?").get(key);
    return siteSettings._parse(row);
  },

  getValue(key, fallback = null) {
    const row = siteSettings.get(key);
    return row ? row.value : fallback;
  },

  list({ publicOnly = false } = {}) {
    const q = publicOnly
      ? "SELECT * FROM site_settings WHERE is_public = 1 ORDER BY key"
      : "SELECT * FROM site_settings ORDER BY key";
    return getDB().prepare(q).all().map(siteSettings._parse);
  },

  set(key, value, { isPublic = true, description = null } = {}) {
    const serialized = JSON.stringify(value);
    getDB()
      .prepare(
        `INSERT INTO site_settings (key, value, is_public, description, updated_at)
         VALUES (?, ?, ?, ?, datetime('now'))
         ON CONFLICT(key) DO UPDATE SET
           value = excluded.value,
           is_public = excluded.is_public,
           description = COALESCE(excluded.description, site_settings.description),
           updated_at = datetime('now')`
      )
      .run(key, serialized, isPublic ? 1 : 0, description);
    return siteSettings.get(key);
  },

  setIfAbsent(key, value, opts) {
    const existing = getDB().prepare("SELECT key FROM site_settings WHERE key = ?").get(key);
    if (existing) return;
    siteSettings.set(key, value, opts);
  },

  delete(key) {
    getDB().prepare("DELETE FROM site_settings WHERE key = ?").run(key);
  },
};

// ─── Blog Posts ──────────────────────────────────────

const blogPosts = {
  _parse(row) {
    if (!row) return null;
    try {
      row.tags = row.tags ? JSON.parse(row.tags) : [];
    } catch {
      row.tags = [];
    }
    return row;
  },

  findAll({ publishedOnly = false, limit, offset = 0 } = {}) {
    const where = publishedOnly ? "WHERE published = 1" : "";
    const lim = typeof limit === "number" ? `LIMIT ${parseInt(limit, 10)} OFFSET ${parseInt(offset, 10) || 0}` : "";
    return getDB()
      .prepare(`SELECT * FROM blog_posts ${where} ORDER BY COALESCE(published_at, created_at) DESC, id DESC ${lim}`)
      .all()
      .map(blogPosts._parse);
  },

  findById(id) {
    return blogPosts._parse(getDB().prepare("SELECT * FROM blog_posts WHERE id = ?").get(id));
  },

  findBySlug(slug, { publishedOnly = false } = {}) {
    const row = getDB().prepare("SELECT * FROM blog_posts WHERE slug = ?").get(slug);
    if (!row) return null;
    if (publishedOnly && !row.published) return null;
    return blogPosts._parse(row);
  },

  create(data) {
    const ts = now();
    const result = getDB()
      .prepare(
        `INSERT INTO blog_posts (slug, title, excerpt, content, author, cover_image_url, tags, published, published_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        data.slug,
        data.title,
        data.excerpt || null,
        data.content,
        data.author || null,
        data.cover_image_url || null,
        JSON.stringify(Array.isArray(data.tags) ? data.tags : []),
        data.published ? 1 : 0,
        data.published_at || (data.published ? ts : null),
        ts,
        ts
      );
    return blogPosts.findById(result.lastInsertRowid);
  },

  createIfAbsent(data) {
    const existing = blogPosts.findBySlug(data.slug);
    if (existing) return existing;
    return blogPosts.create(data);
  },

  update(id, fields) {
    const allowed = ["slug", "title", "excerpt", "content", "author", "cover_image_url", "tags", "published", "published_at"];
    const sets = [];
    const values = [];
    let publishingNow = false;
    const current = blogPosts.findById(id);
    if (!current) return null;

    for (const [key, val] of Object.entries(fields)) {
      if (!allowed.includes(key)) continue;
      if (key === "tags") {
        sets.push("tags = ?");
        values.push(JSON.stringify(Array.isArray(val) ? val : []));
      } else if (key === "published") {
        const next = val ? 1 : 0;
        sets.push("published = ?");
        values.push(next);
        if (next === 1 && current.published === 0) publishingNow = true;
      } else {
        sets.push(`${key} = ?`);
        values.push(val);
      }
    }
    if (publishingNow && !("published_at" in fields)) {
      sets.push("published_at = ?");
      values.push(now());
    }
    if (sets.length === 0) return current;
    sets.push("updated_at = ?");
    values.push(now());
    values.push(id);
    getDB().prepare(`UPDATE blog_posts SET ${sets.join(", ")} WHERE id = ?`).run(...values);
    return blogPosts.findById(id);
  },

  deleteById(id) {
    getDB().prepare("DELETE FROM blog_posts WHERE id = ?").run(id);
  },
};

// ─── Payments ────────────────────────────────────────

const payments = {
  _parse(row) {
    if (!row) return null;
    try {
      row.notes = row.notes ? JSON.parse(row.notes) : null;
    } catch {
      row.notes = null;
    }
    return row;
  },

  create(data) {
    const ts = now();
    const result = getDB()
      .prepare(
        `INSERT INTO payments (razorpay_order_id, user_id, plan_name, amount, currency, status, notes, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        data.razorpay_order_id,
        data.user_id,
        data.plan_name,
        data.amount,
        data.currency || "INR",
        data.status || "created",
        data.notes ? JSON.stringify(data.notes) : null,
        ts,
        ts
      );
    return payments.findById(result.lastInsertRowid);
  },

  findById(id) {
    return payments._parse(getDB().prepare("SELECT * FROM payments WHERE id = ?").get(id));
  },

  findByOrderId(orderId) {
    return payments._parse(getDB().prepare("SELECT * FROM payments WHERE razorpay_order_id = ?").get(orderId));
  },

  updateByOrderId(orderId, fields) {
    const allowed = ["razorpay_payment_id", "razorpay_signature", "status", "notes"];
    const sets = [];
    const values = [];
    for (const [key, val] of Object.entries(fields)) {
      if (!allowed.includes(key)) continue;
      sets.push(`${key} = ?`);
      values.push(key === "notes" ? JSON.stringify(val) : val);
    }
    if (sets.length === 0) return payments.findByOrderId(orderId);
    sets.push("updated_at = ?");
    values.push(now());
    values.push(orderId);
    getDB().prepare(`UPDATE payments SET ${sets.join(", ")} WHERE razorpay_order_id = ?`).run(...values);
    return payments.findByOrderId(orderId);
  },

  list({ status, userId, since, limit = 100, offset = 0 } = {}) {
    const where = [];
    const params = [];
    if (status) { where.push("status = ?"); params.push(status); }
    if (userId) { where.push("user_id = ?"); params.push(userId); }
    if (since) { where.push("created_at >= ?"); params.push(since); }
    const w = where.length ? `WHERE ${where.join(" AND ")}` : "";
    return getDB()
      .prepare(`SELECT * FROM payments ${w} ORDER BY created_at DESC LIMIT ? OFFSET ?`)
      .all(...params, parseInt(limit, 10) || 100, parseInt(offset, 10) || 0)
      .map(payments._parse);
  },

  totalRevenue({ status = "paid", since } = {}) {
    if (since) {
      return (
        getDB()
          .prepare("SELECT COALESCE(SUM(amount), 0) as t FROM payments WHERE status = ? AND created_at >= ?")
          .get(status, since).t || 0
      );
    }
    return (
      getDB().prepare("SELECT COALESCE(SUM(amount), 0) as t FROM payments WHERE status = ?").get(status).t || 0
    );
  },
};

// ─── Audit Log ───────────────────────────────────────

const auditLog = {
  _parse(row) {
    if (!row) return null;
    try { row.before_value = row.before_value ? JSON.parse(row.before_value) : null; } catch { row.before_value = null; }
    try { row.after_value = row.after_value ? JSON.parse(row.after_value) : null; } catch { row.after_value = null; }
    return row;
  },

  create(data) {
    getDB()
      .prepare(
        `INSERT INTO audit_log (actor_id, actor_email, action, target_type, target_id, before_value, after_value, ip, user_agent, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`
      )
      .run(
        data.actor_id || null,
        data.actor_email || null,
        data.action,
        data.target_type || null,
        data.target_id != null ? String(data.target_id) : null,
        data.before_value !== undefined && data.before_value !== null ? JSON.stringify(data.before_value) : null,
        data.after_value !== undefined && data.after_value !== null ? JSON.stringify(data.after_value) : null,
        data.ip || null,
        data.user_agent || null
      );
  },

  list({ actorId, action, targetType, since, limit = 100, offset = 0 } = {}) {
    const where = [];
    const params = [];
    if (actorId) { where.push("actor_id = ?"); params.push(actorId); }
    if (action) { where.push("action LIKE ?"); params.push(`${action}%`); }
    if (targetType) { where.push("target_type = ?"); params.push(targetType); }
    if (since) { where.push("created_at >= ?"); params.push(since); }
    const w = where.length ? `WHERE ${where.join(" AND ")}` : "";
    return getDB()
      .prepare(`SELECT * FROM audit_log ${w} ORDER BY created_at DESC LIMIT ? OFFSET ?`)
      .all(...params, parseInt(limit, 10) || 100, parseInt(offset, 10) || 0)
      .map(auditLog._parse);
  },

  count(filters = {}) {
    const where = [];
    const params = [];
    if (filters.actorId) { where.push("actor_id = ?"); params.push(filters.actorId); }
    if (filters.action) { where.push("action LIKE ?"); params.push(`${filters.action}%`); }
    if (filters.targetType) { where.push("target_type = ?"); params.push(filters.targetType); }
    if (filters.since) { where.push("created_at >= ?"); params.push(filters.since); }
    const w = where.length ? `WHERE ${where.join(" AND ")}` : "";
    return getDB().prepare(`SELECT COUNT(*) as c FROM audit_log ${w}`).get(...params).c;
  },
};

// ─── Per-user tool overrides ─────────────────────────

const userOverrides = {
  _parse(row) {
    if (!row) return null;
    try {
      row.allowed_mime_types = row.allowed_mime_types ? JSON.parse(row.allowed_mime_types) : null;
    } catch {
      row.allowed_mime_types = null;
    }
    return row;
  },

  find(userId, toolRoute) {
    return userOverrides._parse(
      getDB()
        .prepare("SELECT * FROM user_tool_overrides WHERE user_id = ? AND tool_route = ?")
        .get(userId, toolRoute)
    );
  },

  findByUser(userId) {
    return getDB()
      .prepare("SELECT * FROM user_tool_overrides WHERE user_id = ? ORDER BY tool_route")
      .all(userId)
      .map(userOverrides._parse);
  },

  upsert(userId, toolRoute, fields) {
    const mime = Array.isArray(fields.allowed_mime_types)
      ? JSON.stringify(fields.allowed_mime_types)
      : fields.allowed_mime_types ?? null;
    getDB()
      .prepare(
        `INSERT INTO user_tool_overrides (user_id, tool_route, daily_limit, max_file_size_mb, max_files_per_request, allowed_mime_types, notes, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
         ON CONFLICT(user_id, tool_route) DO UPDATE SET
           daily_limit = excluded.daily_limit,
           max_file_size_mb = excluded.max_file_size_mb,
           max_files_per_request = excluded.max_files_per_request,
           allowed_mime_types = excluded.allowed_mime_types,
           notes = excluded.notes,
           updated_at = datetime('now')`
      )
      .run(
        userId,
        toolRoute,
        fields.daily_limit ?? null,
        fields.max_file_size_mb ?? null,
        fields.max_files_per_request ?? null,
        mime,
        fields.notes ?? null
      );
    return userOverrides.find(userId, toolRoute);
  },

  remove(userId, toolRoute) {
    getDB()
      .prepare("DELETE FROM user_tool_overrides WHERE user_id = ? AND tool_route = ?")
      .run(userId, toolRoute);
  },

  removeByUser(userId) {
    getDB().prepare("DELETE FROM user_tool_overrides WHERE user_id = ?").run(userId);
  },
};

// ─── Landing Pages ───────────────────────────────────

const landingPages = {
  _parse(row) {
    if (!row) return null;
    try { row.faqs = row.faqs ? JSON.parse(row.faqs) : []; } catch { row.faqs = []; }
    return row;
  },

  findAll({ publishedOnly = false } = {}) {
    const w = publishedOnly ? "WHERE published = 1" : "";
    return getDB().prepare(`SELECT * FROM landing_pages ${w} ORDER BY slug`).all().map(landingPages._parse);
  },

  findById(id) {
    return landingPages._parse(getDB().prepare("SELECT * FROM landing_pages WHERE id = ?").get(id));
  },

  findBySlug(slug, { publishedOnly = false } = {}) {
    const row = getDB().prepare("SELECT * FROM landing_pages WHERE slug = ?").get(slug);
    if (!row) return null;
    if (publishedOnly && !row.published) return null;
    return landingPages._parse(row);
  },

  create(data) {
    const ts = now();
    const result = getDB()
      .prepare(
        `INSERT INTO landing_pages (slug, title, h1, description, tool_link, tool_name, keywords, faqs, meta_title, meta_description, og_image, published, published_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        data.slug,
        data.title,
        data.h1 || data.title,
        data.description || "",
        data.tool_link || null,
        data.tool_name || null,
        data.keywords || null,
        JSON.stringify(Array.isArray(data.faqs) ? data.faqs : []),
        data.meta_title || null,
        data.meta_description || null,
        data.og_image || null,
        data.published ? 1 : 0,
        data.published_at || (data.published ? ts : null),
        ts,
        ts
      );
    return landingPages.findById(result.lastInsertRowid);
  },

  createIfAbsent(data) {
    const existing = landingPages.findBySlug(data.slug);
    if (existing) return existing;
    return landingPages.create(data);
  },

  update(id, fields) {
    const allowed = ["slug", "title", "h1", "description", "tool_link", "tool_name", "keywords", "faqs", "meta_title", "meta_description", "og_image", "published"];
    const current = landingPages.findById(id);
    if (!current) return null;
    const sets = [];
    const values = [];
    let publishingNow = false;
    for (const [key, val] of Object.entries(fields)) {
      if (!allowed.includes(key)) continue;
      if (key === "faqs") {
        sets.push("faqs = ?");
        values.push(JSON.stringify(Array.isArray(val) ? val : []));
      } else if (key === "published") {
        const next = val ? 1 : 0;
        sets.push("published = ?");
        values.push(next);
        if (next === 1 && current.published === 0) publishingNow = true;
      } else {
        sets.push(`${key} = ?`);
        values.push(val);
      }
    }
    if (publishingNow && !("published_at" in fields)) {
      sets.push("published_at = ?");
      values.push(now());
    }
    if (sets.length === 0) return current;
    sets.push("updated_at = ?");
    values.push(now());
    values.push(id);
    getDB().prepare(`UPDATE landing_pages SET ${sets.join(", ")} WHERE id = ?`).run(...values);
    return landingPages.findById(id);
  },

  deleteById(id) {
    getDB().prepare("DELETE FROM landing_pages WHERE id = ?").run(id);
  },
};

// ─── File Records (storage manager) ──────────────────

const fileRecords = {
  upsert(filePath, fields) {
    getDB()
      .prepare(
        `INSERT INTO file_records (path, kind, user_id, plan, tool_route, size_bytes, expires_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
         ON CONFLICT(path) DO UPDATE SET
           kind = excluded.kind,
           user_id = excluded.user_id,
           plan = excluded.plan,
           tool_route = excluded.tool_route,
           size_bytes = excluded.size_bytes,
           expires_at = excluded.expires_at,
           updated_at = datetime('now')`
      )
      .run(
        filePath,
        fields.kind,
        fields.user_id || null,
        fields.plan || null,
        fields.tool_route || null,
        fields.size_bytes || 0,
        fields.expires_at
      );
  },

  findByPath(filePath) {
    return getDB().prepare("SELECT * FROM file_records WHERE path = ?").get(filePath) || null;
  },

  findExpired(limit = 1000) {
    return getDB()
      .prepare("SELECT * FROM file_records WHERE expires_at <= datetime('now') ORDER BY expires_at ASC LIMIT ?")
      .all(parseInt(limit, 10) || 1000);
  },

  findOldest(limit = 1000) {
    return getDB()
      .prepare("SELECT * FROM file_records ORDER BY created_at ASC LIMIT ?")
      .all(parseInt(limit, 10) || 1000);
  },

  totalBytes() {
    const row = getDB().prepare("SELECT COALESCE(SUM(size_bytes), 0) AS t FROM file_records").get();
    return row ? row.t || 0 : 0;
  },

  countByKind() {
    return getDB()
      .prepare("SELECT kind, COUNT(*) AS n, COALESCE(SUM(size_bytes), 0) AS bytes FROM file_records GROUP BY kind")
      .all();
  },

  removeByPath(filePath) {
    getDB().prepare("DELETE FROM file_records WHERE path = ?").run(filePath);
  },
};

// ─── Persistent Download Tokens ──────────────────────

const downloadTokens = {
  create({ token, filePath, filename, expiresAt, userId }) {
    getDB()
      .prepare(
        `INSERT INTO download_tokens (token, file_path, filename, user_id, expires_at, created_at)
         VALUES (?, ?, ?, ?, ?, datetime('now'))`
      )
      .run(token, filePath, filename, userId || null, expiresAt);
  },

  find(token) {
    return getDB().prepare("SELECT * FROM download_tokens WHERE token = ?").get(token) || null;
  },

  remove(token) {
    getDB().prepare("DELETE FROM download_tokens WHERE token = ?").run(token);
  },

  removeExpired() {
    const info = getDB().prepare("DELETE FROM download_tokens WHERE expires_at <= datetime('now')").run();
    return info.changes;
  },
};

module.exports = { users, usage, errorLogs, refreshTokens, plans, toolAccess, toolsConfig, toolLimits, toolUsage, siteSettings, blogPosts, payments, auditLog, userOverrides, landingPages, fileRecords, downloadTokens };
