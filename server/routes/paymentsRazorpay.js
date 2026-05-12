import { Router } from "express";
import { requireUser } from "../auth/middleware.js";
import { pool } from "../db/pool.js";
import {
  createRazorpayOrder,
  createRazorpayRefund,
  getRazorpayPublicKeyId,
  isRazorpayConfigured,
} from "../payments/razorpayClient.js";
import { razorpayOrderCreateRateLimit } from "../payments/orderRateLimit.js";
import { getMetrics, incMetric, logPayment } from "../payments/paymentMetrics.js";
import { recomputeOrderRefundPaymentStatus } from "../payments/razorpayWebhookProcessor.js";

const router = Router();

/** No secrets: readiness for load balancers. */
router.get("/health", (_req, res) => {
  res.json({
    razorpay_configured: isRazorpayConfigured(),
    webhook_secret_configured: Boolean(String(process.env.RAZORPAY_WEBHOOK_SECRET || "").trim()),
    node_env: process.env.NODE_ENV || "development",
  });
});

/** Counters (optional). Set PAYMENTS_METRICS_SECRET and send X-Payments-Metrics-Secret. */
router.get("/metrics", (req, res) => {
  const secret = String(process.env.PAYMENTS_METRICS_SECRET || "").trim();
  if (!secret) return res.status(404).json({ error: "Not found" });
  if (String(req.get("x-payments-metrics-secret") || "").trim() !== secret) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  return res.json(getMetrics());
});

/** Public: only exposes key_id when configured (safe client-side). */
router.get("/status", (_req, res) => {
  res.json({
    configured: isRazorpayConfigured(),
    key_id: isRazorpayConfigured() ? getRazorpayPublicKeyId() : null,
  });
});

router.post(
  "/order",
  requireUser,
  razorpayOrderCreateRateLimit(),
  async (req, res) => {
    if (!isRazorpayConfigured()) {
      return res.status(503).json({ error: "Razorpay is not configured on the server" });
    }
    const role = req.user?.role;
    if (role === "service_provider") {
      return res.status(403).json({ error: "Service provider cannot create consumer payments" });
    }
    const amountInr = Number(req.body?.amount_inr);
    if (!Number.isFinite(amountInr) || amountInr <= 0) {
      return res.status(400).json({ error: "amount_inr must be a positive number" });
    }
    const amountPaise = Math.round(amountInr * 100);
    const uid = Number(req.user.id);
    const receipt = `ml_${Number.isFinite(uid) ? uid : 0}_${Date.now()}`
      .replace(/[^a-zA-Z0-9_-]/g, "_")
      .slice(0, 40);
    try {
      const order = await createRazorpayOrder({
        amountPaise,
        receipt,
        notes: { paxmed_user: String(req.user.id), paxmed_flow: "diagnostics" },
      });
      res.json({
        key_id: getRazorpayPublicKeyId(),
        order_id: order.id,
        amount: order.amount,
        currency: order.currency || "INR",
        receipt: order.receipt || receipt,
      });
    } catch (e) {
      res.status(502).json({ error: e?.message || "Failed to create Razorpay order" });
    }
  }
);

/**
 * Initiate a refund for a diagnostics order you own (Razorpay test/live).
 * Body: { order_id, amount_inr? } — omit amount for full refund of order total.
 */
router.post("/refund", requireUser, async (req, res) => {
  if (!isRazorpayConfigured()) {
    return res.status(503).json({ error: "Razorpay is not configured on the server" });
  }
  if (req.user?.role === "service_provider") {
    return res.status(403).json({ error: "Service provider cannot request consumer refunds" });
  }
  const userId = req.user.id;
  const orderId = Number(req.body?.order_id);
  if (!Number.isFinite(orderId) || orderId < 1) {
    return res.status(400).json({ error: "order_id is required" });
  }

  const o = await pool.query(
    `SELECT id, user_id, order_kind, razorpay_payment_id, payment_status, status
       FROM orders WHERE id = $1 LIMIT 1`,
    [orderId]
  );
  if (!o.rows.length) return res.status(404).json({ error: "Order not found" });
  const row = o.rows[0];
  if (row.user_id !== userId) return res.status(403).json({ error: "Not your order" });
  if (row.order_kind !== "diagnostics") {
    return res.status(400).json({ error: "Refunds are only supported for diagnostics orders" });
  }
  if (!row.razorpay_payment_id) {
    return res.status(400).json({ error: "Order has no Razorpay payment to refund" });
  }
  if (row.status === "cancelled") {
    return res.status(400).json({ error: "Order is cancelled" });
  }
  if (row.payment_status === "refunded") {
    return res.status(400).json({ error: "Order is already fully refunded" });
  }

  const tot = await pool.query(
    `SELECT COALESCE(SUM(unit_price_inr * quantity_units), 0)::numeric AS t
       FROM order_items WHERE order_id = $1`,
    [orderId]
  );
  const orderTotalPaise = Math.round(Number(tot.rows[0]?.t || 0) * 100);
  if (orderTotalPaise <= 0) {
    return res.status(400).json({ error: "Order has no billable amount" });
  }

  const sumR = await pool.query(
    `SELECT COALESCE(SUM(amount_paise), 0)::bigint AS s FROM razorpay_order_refunds WHERE order_id = $1`,
    [orderId]
  );
  const already = Number(sumR.rows[0]?.s || 0);
  const remaining = orderTotalPaise - already;
  if (remaining <= 0) {
    return res.status(400).json({ error: "Nothing left to refund" });
  }

  let amountInr = req.body?.amount_inr;
  let amountPaise = null;
  if (amountInr != null && amountInr !== "") {
    const n = Number(amountInr);
    if (!Number.isFinite(n) || n <= 0) {
      return res.status(400).json({ error: "amount_inr must be positive when provided" });
    }
    amountPaise = Math.round(n * 100);
    if (amountPaise > remaining) {
      return res.status(400).json({ error: "Refund amount exceeds remaining refundable balance" });
    }
  }

  try {
    const refund = await createRazorpayRefund({
      paymentId: row.razorpay_payment_id,
      amountPaise: amountPaise == null ? undefined : amountPaise,
      notes: { paxmed_order_id: String(orderId), paxmed_user_id: String(userId) },
    });
    incMetric("refund_api_ok");
    const rid = String(refund?.id || "").trim();
    const rAmt = Math.round(Number(refund?.amount || 0));
    if (rid && rAmt > 0) {
      await pool.query(
        `INSERT INTO razorpay_order_refunds
           (order_id, razorpay_refund_id, amount_paise, status, raw_json)
         VALUES ($1, $2, $3, $4, $5::jsonb)
         ON CONFLICT (razorpay_refund_id) DO UPDATE
           SET status = EXCLUDED.status, raw_json = EXCLUDED.raw_json`,
        [orderId, rid, rAmt, refund?.status || null, JSON.stringify(refund)]
      );
      await recomputeOrderRefundPaymentStatus(orderId);
    }
    logPayment("refund_ok", { order_id: orderId, refund_id: rid });
    return res.json({ ok: true, refund });
  } catch (e) {
    incMetric("refund_api_err");
    logPayment("refund_err", { order_id: orderId, message: e?.message });
    return res.status(502).json({ error: e?.message || "Refund failed" });
  }
});

export default router;
