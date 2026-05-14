const { auditLog, users } = require("../models/db");
const logger = require("./logger");

function logAudit(req, opts) {
  try {
    let actorEmail = null;
    const actorId = req?.user?.id || null;
    if (actorId) {
      const u = users.findById(actorId);
      if (u) actorEmail = u.email;
    }
    const ip = (req?.headers?.["x-forwarded-for"] || req?.ip || "").toString().split(",")[0].trim() || null;
    auditLog.create({
      actor_id: actorId,
      actor_email: actorEmail,
      action: opts.action,
      target_type: opts.targetType,
      target_id: opts.targetId,
      before_value: opts.before,
      after_value: opts.after,
      ip,
      user_agent: req?.headers?.["user-agent"] || null,
    });
  } catch (e) {
    logger.warn("Audit log failure", { action: opts?.action, error: e.message });
  }
}

module.exports = { logAudit };
