import { Router } from "express";
import { verifyRazorpayWebhookSignature } from "../payments/razorpayClient.js";
import { processVerifiedRazorpayWebhook } from "../payments/razorpayWebhookProcessor.js";
import { incMetric, logPayment } from "../payments/paymentMetrics.js";

const router = Router();

/**
 * Razorpay webhooks require the raw JSON body for HMAC verification.
 * Mount with express.raw({ type: "application/json" }) before express.json().
 */
router.post("/", async (req, res) => {
  const whSecret = String(process.env.RAZORPAY_WEBHOOK_SECRET || "").trim();
  if (!whSecret) {
    return res.status(503).json({ error: "RAZORPAY_WEBHOOK_SECRET is not configured" });
  }
  const raw = req.body;
  if (!Buffer.isBuffer(raw) || !raw.length) {
    return res.status(400).json({ error: "Expected raw body" });
  }
  const sig = req.get("x-razorpay-signature");
  if (!verifyRazorpayWebhookSignature(raw, sig)) {
    logPayment("webhook_sig_fail", { ip: req.ip });
    return res.status(400).json({ error: "Invalid webhook signature" });
  }

  let parsed;
  try {
    parsed = JSON.parse(raw.toString("utf8"));
  } catch {
    return res.status(400).json({ error: "Invalid JSON" });
  }

  try {
    const out = await processVerifiedRazorpayWebhook(parsed);
    if (!out?.ok) {
      logPayment("webhook_retryable_failure", {
        event_id: parsed?.id,
        event_type: parsed?.event,
        error: out?.error || out?.reason,
      });
      return res.status(500).json({ error: "Webhook processing failed" });
    }
    return res.json({ received: true, ...out });
  } catch (e) {
    incMetric("webhook_insert_err");
    logPayment("webhook_fatal", { message: e?.message || String(e) });
    return res.status(500).json({ error: "Webhook processing failed" });
  }
});

export default router;
