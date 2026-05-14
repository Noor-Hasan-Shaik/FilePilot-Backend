const path = require("path");

const PUBLIC_USER_FIELDS = ["id", "name", "email", "picture", "plan", "is_verified", "created_at", "updated_at"];

function publicUser(user) {
  if (!user) return null;
  const out = {};
  for (const k of PUBLIC_USER_FIELDS) {
    if (user[k] !== undefined) out[k] = user[k];
  }
  out._id = user.id;
  return out;
}

function publicUsers(list) {
  return Array.isArray(list) ? list.map(publicUser) : [];
}

function safeFilename(name, fallback = "file") {
  if (typeof name !== "string" || !name) return fallback;
  const base = path.basename(name).replace(/[/\\\x00-\x1f]/g, "_").trim();
  if (!base) return fallback;
  return base.length > 200 ? base.slice(-200) : base;
}

function safeResolveInside(rootDir, candidatePath) {
  const resolvedRoot = path.resolve(rootDir);
  const resolvedTarget = path.resolve(candidatePath);
  if (resolvedTarget !== resolvedRoot && !resolvedTarget.startsWith(resolvedRoot + path.sep)) {
    return null;
  }
  return resolvedTarget;
}

module.exports = { publicUser, publicUsers, safeFilename, safeResolveInside };
