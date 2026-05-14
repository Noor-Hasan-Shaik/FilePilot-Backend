const express = require("express");
const fs = require("fs");
const crypto = require("crypto");
const router = express.Router();

const { OUTPUTS_DIR } = require("../config/upload");
const { safeResolveInside, safeFilename } = require("../utils/sanitize");
const { downloadTokens, users } = require("../models/db");
const { optionalAuth } = require("../middleware/auth");
const logger = require("../utils/logger");

// In-process LRU cache to keep the hot path fast (no SQLite round-trip on
// every download). DB is still the source of truth across restarts and
// multi-process deployments.
const tokenCache = new Map();
const TOKEN_TTL_MS = 30 * 60 * 1000;
const CACHE_MAX = 5000;

function cachePut(token, entry) {
  if (tokenCache.size >= CACHE_MAX) {
    // Drop the oldest 10% so we don't pay this cost on every set.
    const entries = [...tokenCache.entries()].sort((a, b) => a[1].cachedAt - b[1].cachedAt);
    for (let i = 0; i < Math.ceil(CACHE_MAX * 0.1) && i < entries.length; i++) {
      tokenCache.delete(entries[i][0]);
    }
  }
  tokenCache.set(token, { ...entry, cachedAt: Date.now() });
}

function loadToken(token) {
  const cached = tokenCache.get(token);
  if (cached) return cached;
  const row = downloadTokens.find(token);
  if (!row) return null;
  const entry = {
    filePath: row.file_path,
    filename: row.filename,
    expiresAt: new Date(row.expires_at).getTime(),
    userId: row.user_id,
  };
  cachePut(token, entry);
  return entry;
}

function createDownloadToken(filePath, filename, { userId = null, ttlMs = TOKEN_TTL_MS } = {}) {
  const resolved = safeResolveInside(OUTPUTS_DIR, filePath);
  if (!resolved) {
    throw new Error("Refusing to create download token for path outside outputs dir");
  }
  const token = crypto.randomUUID();
  const expiresAt = Date.now() + ttlMs;
  const expiresAtIso = new Date(expiresAt).toISOString();

  const cleanName = safeFilename(filename, "download");

  try {
    downloadTokens.create({ token, filePath: resolved, filename: cleanName, userId, expiresAt: expiresAtIso });
  } catch (e) {
    // If the DB insert fails (e.g. UNIQUE clash) fall back to a fresh UUID.
    logger.warn("download token DB insert failed; retrying", { error: e.message });
    const retry = crypto.randomUUID();
    downloadTokens.create({ token: retry, filePath: resolved, filename: cleanName, userId, expiresAt: expiresAtIso });
    cachePut(retry, { filePath: resolved, filename: cleanName, expiresAt, userId });
    return retry;
  }
  cachePut(token, { filePath: resolved, filename: cleanName, expiresAt, userId });
  return token;
}

router.get("/:token", optionalAuth, (req, res) => {
  const token = req.params.token;
  if (!token || token.length > 100) {
    return res.status(404).json({ error: "Invalid download token" });
  }

  const entry = loadToken(token);
  if (!entry || Date.now() > entry.expiresAt) {
    if (entry) {
      tokenCache.delete(token);
      downloadTokens.remove(token);
    }
    return res.status(404).json({ error: "Download link expired or invalid" });
  }

  // Ownership check — if the token was created by an authenticated user, only
  // that user (or an admin) may download. Tokens generated for guest sessions
  // (entry.userId == null) remain open by design.
  //
  // A leaked token without auth must NOT unlock a private user's file.
  if (entry.userId) {
    const requester = req.user;
    let isOwner = requester && requester.id === entry.userId;
    let isAdmin = false;
    if (requester && !isOwner) {
      try {
        const u = users.findById(requester.id);
        isAdmin = u && u.plan === "admin";
      } catch {
        isAdmin = false;
      }
    }
    if (!isOwner && !isAdmin) {
      // Return 404 (not 403) — don't reveal whether the token exists. Same
      // response shape as "invalid token" so an attacker can't distinguish
      // "valid but yours" from "doesn't exist."
      return res.status(404).json({ error: "Download link expired or invalid" });
    }
  }

  if (!fs.existsSync(entry.filePath)) {
    tokenCache.delete(token);
    downloadTokens.remove(token);
    return res.status(404).json({ error: "File not found" });
  }

  res.download(entry.filePath, entry.filename, (err) => {
    if (err && !res.headersSent) {
      try { res.status(500).end(); } catch {}
    }
  });
});

module.exports = { router, createDownloadToken };
