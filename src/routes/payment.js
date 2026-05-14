const express = require("express");
const Razorpay = require("razorpay");
const crypto = require("crypto");
const { users, plans, payments } = require("../models/db");
const logger = require("../utils/logger");

const router = express.Router();

let razorpay = null;

function getRazorpay() {
  if (razorpay) return razorpay;
  if (!process.env.RAZORPAY_KEY_ID || !process.env.RAZORPAY_SECRET) return null;
  razorpay = new Razorpay({
    key_id: process.env.RAZORPAY_KEY_ID,
    key_secret: process.env.RAZORPAY_SECRET,
  });
  return razorpay;
}

// In-flight order map: order_id -> { userId, plan, amount, createdAt }
// Persistence is in `payments` table; this map is just a fast-path cache.
const pendingOrders = new Map();
const ORDER_TTL_MS = 30 * 60 * 1000;

setInterval(() => {
  const now = Date.now();
  for (const [orderId, entry] of pendingOrders) {
    if (now - entry.createdAt > ORDER_TTL_MS) pendingOrders.delete(orderId);
  }
}, 5 * 60 * 1000).unref();

router.post("/create-order", async (req, res, next) => {
  try {
    const rp = getRazorpay();
    if (!rp) return res.status(503).json({ error: "Payment service not configured" });

    const { plan: planName } = req.body;
    if (!planName || typeof planName !== "string") {
      return res.status(400).json({ error: "Plan is required" });
    }

    const requester = users.findById(req.user.id);
    if (!requester) return res.status(401).json({ error: "User no longer exists" });
    if (requester.suspended) return res.status(403).json({ error: "Account is suspended" });

    const plan = plans.findByName(planName);
    if (!plan) return res.status(400).json({ error: "Unknown plan" });
    if (!plan.is_active) return res.status(400).json({ error: "Plan is not active" });
    if (plan.is_enterprise) return res.status(400).json({ error: "Enterprise plans require sales contact" });
    if (!plan.price || plan.price <= 0) {
      return res.status(400).json({ error: "This plan is free and does not require checkout" });
    }

    const amount = plan.price;
    const currency = plan.currency || "INR";

    const order = await rp.orders.create({
      amount,
      currency,
      receipt: `r_${Date.now()}`,
      notes: { userId: req.user.id, plan: plan.name },
    });

    pendingOrders.set(order.id, {
      userId: req.user.id,
      plan: plan.name,
      amount,
      createdAt: Date.now(),
    });

    try {
      payments.create({
        razorpay_order_id: order.id,
        user_id: req.user.id,
        plan_name: plan.name,
        amount,
        currency,
        status: "created",
        notes: { receipt: order.receipt },
      });
    } catch (e) {
      logger.warn("Failed to persist payment row", { error: e.message, orderId: order.id });
    }

    res.json(order);
  } catch (err) {
    next(err);
  }
});

router.post("/verify", (req, res, next) => {
  try {
    if (!process.env.RAZORPAY_SECRET) {
      return res.status(503).json({ success: false, message: "Payment service not configured" });
    }

    const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;
    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
      return res.status(400).json({ success: false, message: "Missing fields" });
    }

    // Prefer the cache; fall back to the DB row if process restarted between create and verify.
    const cached = pendingOrders.get(razorpay_order_id);
    const persisted = cached ? null : payments.findByOrderId(razorpay_order_id);
    const pending = cached || (persisted
      ? { userId: persisted.user_id, plan: persisted.plan_name, amount: persisted.amount, createdAt: Date.now() }
      : null);

    if (!pending) {
      return res.status(400).json({ success: false, message: "Order not found or expired" });
    }

    if (pending.userId !== req.user.id) {
      return res.status(403).json({ success: false, message: "Order belongs to a different user" });
    }

    // Re-check suspension at verify time. requireAuth already blocks suspended
    // users on the JWT path, but the user may have been suspended between
    // create-order and verify; we don't want a stale token to slip an upgrade
    // through on a now-disabled account.
    const liveUser = users.findById(req.user.id);
    if (!liveUser) {
      return res.status(401).json({ success: false, message: "User no longer exists" });
    }
    if (liveUser.suspended) {
      payments.updateByOrderId(razorpay_order_id, { status: "rejected" });
      return res.status(403).json({ success: false, message: "Account is suspended" });
    }

    const body = razorpay_order_id + "|" + razorpay_payment_id;
    const expectedSignature = crypto
      .createHmac("sha256", process.env.RAZORPAY_SECRET)
      .update(body)
      .digest("hex");
    const expectedBuf = Buffer.from(expectedSignature, "hex");
    const givenBuf = Buffer.from(razorpay_signature, "hex");
    if (
      expectedBuf.length !== givenBuf.length ||
      !crypto.timingSafeEqual(expectedBuf, givenBuf)
    ) {
      payments.updateByOrderId(razorpay_order_id, { status: "failed" });
      return res.status(400).json({ success: false, message: "Invalid payment signature" });
    }

    users.update(req.user.id, { plan: pending.plan });
    payments.updateByOrderId(razorpay_order_id, {
      razorpay_payment_id,
      razorpay_signature,
      status: "paid",
    });
    pendingOrders.delete(razorpay_order_id);

    res.json({ success: true, plan: pending.plan, message: `Upgraded to ${pending.plan}` });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
