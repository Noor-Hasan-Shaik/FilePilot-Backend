const express = require("express");
const { rateLimit, ipKeyGenerator } = require("express-rate-limit");
const router = express.Router();
const { OAuth2Client } = require("google-auth-library");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");
const crypto = require("crypto");

// Per-account limiters. The app-level `authLimiter` is per-IP only, which a
// distributed attacker bypasses by rotating IPs. These limiters key on the
// account identifier (email, lowercased) so brute force against one account
// hits the cap no matter how many IPs the attacker uses. Each limiter falls
// back to req.ip when no email is present so callers can't omit the field to
// dodge the cap.
function emailKey(req) {
  const raw = req.body?.email;
  if (typeof raw === "string" && raw.length <= 320) {
    return `email:${raw.trim().toLowerCase()}`;
  }
  // Route the IP fallback through express-rate-limit's helper so IPv6 callers
  // get normalized into a /64 prefix (raw IPv6 addresses can vary per-request
  // and would otherwise let a single client dodge the per-IP cap).
  return `ip:${ipKeyGenerator(req)}`;
}

const otpVerifyLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: emailKey,
  message: { error: "Too many OTP attempts. Please request a new code." },
});

const otpRequestLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 3,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: emailKey,
  message: { error: "Too many OTP requests. Try again in an hour." },
});

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: emailKey,
  // Don't count successful logins against the budget — only failed ones.
  skipSuccessfulRequests: true,
  message: { error: "Too many login attempts. Try again later." },
});

const resetLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: emailKey,
  message: { error: "Too many password reset attempts. Try again later." },
});

const signupLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: emailKey,
  message: { error: "Too many signup attempts for this email." },
});

const { users, refreshTokens } = require("../models/db");
const { sendOTP } = require("../utils/sendEmail");
const { requireAuth } = require("../middleware/auth");
const {
  ACCESS_TOKEN_EXPIRY,
  OTP_EXPIRY_MINUTES,
  RESET_OTP_EXPIRY_MINUTES,
  MAX_OTP_ATTEMPTS,
  PLANS,
  PASSWORD_MIN_LENGTH,
} = require("../config/constants");

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
function isValidEmail(email) {
  return typeof email === "string" && email.length <= 320 && EMAIL_REGEX.test(email);
}

// Constant-time string equality. `crypto.timingSafeEqual` requires equal-length
// buffers, so we short-circuit when lengths differ — but still run the compare
// against a same-length dummy to keep the timing profile flat.
function constantTimeEquals(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const aBuf = Buffer.from(a, "utf8");
  const bBuf = Buffer.from(b, "utf8");
  if (aBuf.length !== bBuf.length) {
    // Compare against a buffer of matching length so the path takes ~same time.
    crypto.timingSafeEqual(aBuf, Buffer.alloc(aBuf.length));
    return false;
  }
  return crypto.timingSafeEqual(aBuf, bBuf);
}

const client = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

function generateOtp() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

function signAccessToken(user) {
  return jwt.sign(
    { id: user.id, email: user.email },
    process.env.JWT_SECRET,
    { expiresIn: ACCESS_TOKEN_EXPIRY }
  );
}

function createRefreshToken(userId) {
  const token = crypto.randomBytes(40).toString("hex");
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
  refreshTokens.create(userId, token, expiresAt);
  return token;
}

function formatAuthResponse(user) {
  const accessToken = signAccessToken(user);
  const refreshToken = createRefreshToken(user.id);
  return {
    user: {
      id: user.id,
      _id: user.id,
      name: user.name,
      email: user.email,
      picture: user.picture,
      plan: user.plan || PLANS.FREE,
      is_verified: user.is_verified,
    },
    token: accessToken,
    accessToken,
    refreshToken,
  };
}

// Google Login
router.post("/google", async (req, res, next) => {
  try {
    const { token } = req.body;
    if (!token) return res.status(400).json({ error: "Token is required" });

    const ticket = await client.verifyIdToken({
      idToken: token,
      audience: process.env.GOOGLE_CLIENT_ID,
    });

    const payload = ticket.getPayload();
    let user = users.findByEmail(payload.email);

    if (!user) {
      user = users.create({
        name: payload.name,
        email: payload.email,
        picture: payload.picture,
        is_verified: 1,
        plan: PLANS.FREE,
      });
    }

    res.json(formatAuthResponse(user));
  } catch (err) {
    next(err);
  }
});

// Signup
router.post("/signup", signupLimiter, async (req, res, next) => {
  try {
    const { name, email, password } = req.body;
    if (!name || !email || !password) {
      return res.status(400).json({ error: "All fields are required" });
    }
    if (typeof name !== "string" || name.trim().length < 1 || name.trim().length > 100) {
      return res.status(400).json({ error: "Invalid name" });
    }
    if (!isValidEmail(email)) {
      return res.status(400).json({ error: "Invalid email format" });
    }
    if (typeof password !== "string" || password.length < PASSWORD_MIN_LENGTH) {
      return res.status(400).json({ error: `Password must be at least ${PASSWORD_MIN_LENGTH} characters` });
    }

    const existing = users.findByEmail(email);

    // Don't disclose whether an account exists. Always respond with the same
    // shape; for an already-verified account we simply don't issue a new OTP.
    if (existing && existing.is_verified) {
      return res.json({ message: "If this email is available, an OTP has been sent" });
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const otp = generateOtp();
    const otpExpiry = Date.now() + OTP_EXPIRY_MINUTES * 60 * 1000;

    if (!existing) {
      users.create({
        name,
        email,
        password: hashedPassword,
        is_verified: 0,
        otp,
        otp_expiry: otpExpiry,
        plan: PLANS.FREE,
      });
    } else {
      // Re-signup for an unverified account: refresh the OTP but keep
      // `otp_attempts` so this path can't be used to wipe brute-force counters
      // (see resend-otp comment).
      users.update(existing.id, {
        otp,
        otp_expiry: otpExpiry,
      });
    }

    await sendOTP(email, otp);
    res.json({ message: "If this email is available, an OTP has been sent" });
  } catch (err) {
    next(err);
  }
});

// Verify OTP
router.post("/verify-otp", otpVerifyLimiter, async (req, res, next) => {
  try {
    const { email, otp } = req.body;
    if (!email || !otp) {
      return res.status(400).json({ error: "Email and OTP are required" });
    }

    const user = users.findByEmail(email);
    if (!user) return res.status(400).json({ error: "User not found" });

    if (user.otp_attempts >= MAX_OTP_ATTEMPTS) {
      return res.status(429).json({ error: "Too many attempts" });
    }

    const otpMatches = user.otp && constantTimeEquals(String(user.otp), String(otp));
    const expiryValid = typeof user.otp_expiry === "number" && user.otp_expiry > Date.now();
    if (!otpMatches || !expiryValid) {
      users.update(user.id, { otp_attempts: (user.otp_attempts || 0) + 1 });
      return res.status(400).json({ error: "Invalid or expired OTP" });
    }

    const updated = users.update(user.id, {
      is_verified: 1,
      otp: null,
      otp_expiry: null,
      otp_attempts: 0,
    });

    res.json(formatAuthResponse(updated));
  } catch (err) {
    next(err);
  }
});

// Resend OTP
//
// Two things to be careful about here:
//   1. Don't reset `otp_attempts` to 0 — otherwise an attacker hitting the
//      MAX_OTP_ATTEMPTS lockout just resends to wipe the counter and brute
//      again forever. The counter only clears on a *successful* verify.
//   2. Throttle resends to once per minute per account, so an attacker can't
//      keep cycling fresh OTPs (which also gives them a fresh attempt budget
//      against `MAX_OTP_ATTEMPTS` after every resend if we did reset).
router.post("/resend-otp", otpRequestLimiter, async (req, res, next) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: "Email is required" });

    const user = users.findByEmail(email);
    if (user && !user.is_verified) {
      const issuedAt = (user.otp_expiry || 0) - OTP_EXPIRY_MINUTES * 60 * 1000;
      const sinceLast = Date.now() - issuedAt;
      if (sinceLast < 60 * 1000) {
        // Don't surface the cooldown loudly — same response shape so the caller
        // can't probe account state by measuring response codes.
        return res.json({ message: "If an unverified account exists, an OTP has been sent" });
      }

      const otp = generateOtp();
      users.update(user.id, {
        otp,
        otp_expiry: Date.now() + OTP_EXPIRY_MINUTES * 60 * 1000,
      });
      await sendOTP(email, otp);
    }

    res.json({ message: "If an unverified account exists, an OTP has been sent" });
  } catch (err) {
    next(err);
  }
});

// Forgot Password
router.post("/forgot-password", otpRequestLimiter, async (req, res, next) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: "Email is required" });

    const user = users.findByEmail(email);
    // Uniform success — never reveal whether the email belongs to an account.
    if (user && user.is_verified) {
      const otp = generateOtp();
      users.update(user.id, {
        reset_otp: otp,
        reset_otp_expiry: Date.now() + RESET_OTP_EXPIRY_MINUTES * 60 * 1000,
      });
      await sendOTP(email, otp);
    }

    res.json({ message: "If an account exists for this email, a reset OTP has been sent" });
  } catch (err) {
    next(err);
  }
});

router.post("/resend-reset-otp", otpRequestLimiter, async (req, res, next) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: "Email is required" });

    const user = users.findByEmail(email);
    if (user && user.is_verified) {
      const issuedAt = (user.reset_otp_expiry || 0) - RESET_OTP_EXPIRY_MINUTES * 60 * 1000;
      if (Date.now() - issuedAt >= 60 * 1000) {
        const otp = generateOtp();
        users.update(user.id, {
          reset_otp: otp,
          reset_otp_expiry: Date.now() + RESET_OTP_EXPIRY_MINUTES * 60 * 1000,
        });
        await sendOTP(email, otp);
      }
    }

    res.json({ message: "If an account exists for this email, a reset OTP has been sent" });
  } catch (err) {
    next(err);
  }
});

// Reset Password
router.post("/reset-password", resetLimiter, async (req, res, next) => {
  try {
    const { email, otp, newPassword } = req.body;
    if (!email || !otp || !newPassword) {
      return res.status(400).json({ error: "All fields are required" });
    }

    if (typeof newPassword !== "string" || newPassword.length < PASSWORD_MIN_LENGTH) {
      return res.status(400).json({ error: `Password must be at least ${PASSWORD_MIN_LENGTH} characters` });
    }

    const user = users.findByEmail(email);
    // Treat missing/null expiry as already-expired rather than letting JS's
    // null-coerces-to-0 semantics decide for us. Belt-and-suspenders against a
    // future change that forgets to set reset_otp_expiry alongside reset_otp.
    const expiry = user?.reset_otp_expiry;
    const expiryValid = typeof expiry === "number" && expiry > Date.now();
    const resetMatches =
      user && user.reset_otp && constantTimeEquals(String(user.reset_otp), String(otp));
    if (!resetMatches || !expiryValid) {
      return res.status(400).json({ error: "Invalid or expired OTP" });
    }

    const hashedPassword = await bcrypt.hash(newPassword, 10);
    users.update(user.id, {
      password: hashedPassword,
      reset_otp: null,
      reset_otp_expiry: null,
    });
    refreshTokens.deleteByUser(user.id);

    res.json({ message: "Password reset successful" });
  } catch (err) {
    next(err);
  }
});

// Login
router.post("/login", loginLimiter, async (req, res, next) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: "Email and password are required" });
    }

    const user = users.findByEmail(email);
    // Use a single generic message for every "can't sign you in" branch so an
    // unauthenticated caller can't distinguish "no such account" from
    // "wrong password" from "this email is a Google-only login."
    const GENERIC = "Invalid email or password";
    if (!user) return res.status(400).json({ error: GENERIC });
    if (!user.password) return res.status(400).json({ error: GENERIC });

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) return res.status(400).json({ error: GENERIC });

    // Verification status isn't enumeration-sensitive once credentials are
    // correct — at that point the caller already proved they own the account.
    if (!user.is_verified) return res.status(400).json({ error: "Please verify your email first" });

    res.json(formatAuthResponse(user));
  } catch (err) {
    next(err);
  }
});

// Refresh Token
router.post("/refresh", (req, res, next) => {
  try {
    const { refreshToken } = req.body;
    if (!refreshToken || typeof refreshToken !== "string") {
      return res.status(400).json({ error: "Refresh token is required" });
    }

    const stored = refreshTokens.findByToken(refreshToken);
    if (!stored) return res.status(401).json({ error: "Invalid refresh token" });

    // Reuse detection: token already rotated. Revoke entire family.
    if (stored.revoked_at) {
      refreshTokens.deleteByUser(stored.user_id);
      return res.status(401).json({ error: "Refresh token reuse detected; please log in again" });
    }

    if (new Date(stored.expires_at) < new Date()) {
      refreshTokens.revoke(refreshToken);
      return res.status(401).json({ error: "Refresh token expired" });
    }

    const user = users.findById(stored.user_id);
    if (!user) {
      refreshTokens.deleteByUser(stored.user_id);
      return res.status(401).json({ error: "User not found" });
    }

    refreshTokens.revoke(refreshToken);
    const newAccessToken = signAccessToken(user);
    const newRefreshToken = createRefreshToken(user.id);

    res.json({
      accessToken: newAccessToken,
      token: newAccessToken,
      refreshToken: newRefreshToken,
      user: {
        id: user.id,
        _id: user.id,
        name: user.name,
        email: user.email,
        picture: user.picture,
        plan: user.plan || PLANS.FREE,
        is_verified: user.is_verified,
      },
    });
  } catch (err) {
    next(err);
  }
});

// Logout (revoke refresh token)
router.post("/logout", (req, res) => {
  const { refreshToken } = req.body;
  if (refreshToken) {
    refreshTokens.deleteByToken(refreshToken);
  }
  res.json({ message: "Logged out" });
});

// Get Profile
router.get("/profile", requireAuth, (req, res, next) => {
  try {
    const user = users.findById(req.user.id);
    if (!user) return res.status(404).json({ error: "User not found" });

    res.json({
      id: user.id,
      name: user.name,
      email: user.email,
      picture: user.picture,
      plan: user.plan,
      is_verified: user.is_verified,
      created_at: user.created_at,
    });
  } catch (err) {
    next(err);
  }
});

// Update Profile
router.put("/profile", requireAuth, (req, res, next) => {
  try {
    const { name } = req.body;
    if (typeof name !== "string" || !name.trim()) {
      return res.status(400).json({ error: "Name is required" });
    }
    if (name.trim().length > 100) {
      return res.status(400).json({ error: "Name too long" });
    }

    const updated = users.update(req.user.id, { name: name.trim() });
    if (!updated) return res.status(404).json({ error: "User not found" });

    res.json({
      id: updated.id,
      name: updated.name,
      email: updated.email,
      picture: updated.picture,
      plan: updated.plan,
    });
  } catch (err) {
    next(err);
  }
});

// Change Password
router.post("/change-password", requireAuth, async (req, res, next) => {
  try {
    const user = users.findById(req.user.id);
    if (!user) return res.status(404).json({ error: "User not found" });
    if (!user.password) return res.status(400).json({ error: "Google accounts cannot change password here" });

    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword) {
      return res.status(400).json({ error: "Both current and new password are required" });
    }
    if (typeof newPassword !== "string" || newPassword.length < PASSWORD_MIN_LENGTH) {
      return res.status(400).json({ error: `New password must be at least ${PASSWORD_MIN_LENGTH} characters` });
    }

    const isMatch = await bcrypt.compare(currentPassword, user.password);
    if (!isMatch) return res.status(400).json({ error: "Current password is incorrect" });

    const hashed = await bcrypt.hash(newPassword, 10);
    users.update(user.id, { password: hashed });
    refreshTokens.deleteByUser(user.id);

    res.json({ message: "Password changed successfully" });
  } catch (err) {
    next(err);
  }
});

module.exports = router;