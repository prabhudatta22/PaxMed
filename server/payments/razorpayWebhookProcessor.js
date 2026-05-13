import { pool } from "../db/pool.js";
import { incMetric, logPayment } from "./paymentMetrics.js";

function safeJson(obj) {
  try {
    return JSON.stringify(obj ?? {});
  } catch {
    return "{}";
  }
}

/**
 * Idempotent insert + business reconciliation for Razorpay Dashboard webhooks.
 * @returns {{ ok: boolean, duplicate?: boolean, matched_order_id?: number }}
 */
export async function processVerifiedRazorpayWebhook(body) {
  incMetric("webhook_received");
  const eventId = String(body?.id || "").trim();
  if (!eventId) {
    logPayment("webhook_skip", { reason: "missing_event_id" });
    return { ok: false, reason: "missing_event_id" };
  }

  const eventType = String(body?.event || "").trim();
  const payEnt = body?.payload?.payment?.entity;
  const payId = payEnt?.id != null ? String(payEnt.id).trim() : null;
  const orderEntId = payEnt?.order_id != null ? String(payEnt.order_id).trim() : null;

  let eventRow = null;
  try {
    const { rows } = await pool.query(
      `INSERT INTO razorpay_webhook_events
         (razorpay_event_id, event_type, payment_id, order_entity_id, payload_json)
       VALUES ($1, $2, $3, $4, $5::jsonb)
       ON CONFLICT (razorpay_event_id) DO NOTHING
       RETURNING id, processed_ok, order_link_id`,
      [eventId, eventType, payId, orderEntId, safeJson(body)]
    );
    if (!rows.length) {
      const existing = await pool.query(
        `SELECT id, processed_ok, order_link_id
           FROM razorpay_webhook_events
          WHERE razorpay_event_id = $1
          LIMIT 1`,
        [eventId]
      );
      eventRow = existing.rows[0] || null;
      if (eventRow?.processed_ok) {
        incMetric("webhook_duplicate");
        logPayment("webhook_duplicate", { event_id: eventId, event_type: eventType });
        return { ok: true, duplicate: true, matched_order_id: eventRow.order_link_id ?? null };
      }
      logPayment("webhook_duplicate_retry", { event_id: eventId, event_type: eventType });
    } else {
      eventRow = rows[0];
    }
  } catch (e) {
    incMetric("webhook_insert_err");
    logPayment("webhook_insert_err", { message: e?.message });
    throw e;
  }

  if (!eventRow?.id) {
    throw new Error("Webhook event row could not be loaded for processing");
  }

  let matchedOrderId = null;
  let errMsg = null;

  try {
    const result = await dispatchEvent(eventType, body, { payId, orderEntId });
    matchedOrderId = result?.matched_order_id ?? null;
    if (result?.missing_order) incMetric("webhook_order_missing");
    if (matchedOrderId != null) incMetric("webhook_orders_matched");
  } catch (e) {
    errMsg = e?.message || String(e);
    logPayment("webhook_dispatch_err", { event_id: eventId, message: errMsg });
  }

  await pool.query(
    `UPDATE razorpay_webhook_events
       SET processed_ok = $2,
           order_link_id = COALESCE($3::integer, order_link_id),
           error_message = $4
     WHERE id = $1`,
    [eventRow.id, !errMsg, matchedOrderId, errMsg]
  );

  return { ok: !errMsg, matched_order_id: matchedOrderId, error: errMsg };
}

async function dispatchEvent(eventType, body, { payId, orderEntId }) {
  if (eventType === "payment.captured") {
    incMetric("webhook_payment_captured");
    return updateOrderForPaymentCaptured({ payId, orderEntId });
  }
  if (eventType === "payment.failed") {
    incMetric("webhook_payment_failed");
    return updateOrderForPaymentFailed({ payId, orderEntId });
  }
  if (eventType === "refund.processed") {
    incMetric("webhook_refund_processed");
    return recordRefundFromWebhook(body);
  }
  incMetric("webhook_unhandled_event");
  logPayment("webhook_unhandled", { event_type: eventType });
  return {};
}

async function updateOrderForPaymentCaptured({ payId, orderEntId }) {
  if (!payId && !orderEntId) return { missing_order: true };

  const { rows } = await pool.query(
    `UPDATE orders
        SET razorpay_reconciled_at = COALESCE(razorpay_reconciled_at, now()),
            payment_status = CASE
              WHEN payment_status IN ('refunded', 'partially_refunded') THEN payment_status
              WHEN payment_status = 'prepaid_verified' THEN 'prepaid_reconciled'
              WHEN payment_status IS NULL AND razorpay_payment_id IS NOT NULL THEN 'prepaid_reconciled'
              ELSE payment_status
            END
      WHERE ($1::text IS NOT NULL AND razorpay_payment_id = $1)
         OR (
              $2::text IS NOT NULL
              AND razorpay_order_id = $2
              AND (razorpay_payment_id IS NULL OR btrim(razorpay_payment_id) = '' OR razorpay_payment_id = $1)
            )
      RETURNING id`,
    [payId, orderEntId]
  );

  if (!rows.length) {
    logPayment("webhook_captured_no_order", { payId, orderEntId });
    return { missing_order: true };
  }
  return { matched_order_id: rows[0].id };
}

async function updateOrderForPaymentFailed({ payId, orderEntId }) {
  if (!payId && !orderEntId) return {};

  const { rows } = await pool.query(
    `UPDATE orders
        SET payment_status = CASE
              WHEN payment_status IN ('prepaid_reconciled', 'refunded', 'partially_refunded') THEN payment_status
              WHEN payment_status = 'prepaid_verified' THEN 'payment_failed'
              ELSE payment_status
            END
      WHERE ($1::text IS NOT NULL AND razorpay_payment_id = $1)
         OR (
              $2::text IS NOT NULL
              AND razorpay_order_id = $2
              AND (razorpay_payment_id IS NULL OR btrim(razorpay_payment_id) = '' OR razorpay_payment_id = $1)
            )
      RETURNING id, payment_status`,
    [payId, orderEntId]
  );

  if (!rows.length) return { missing_order: true };
  return { matched_order_id: rows[0].id };
}

async function recordRefundFromWebhook(body) {
  const ref = body?.payload?.refund?.entity;
  if (!ref?.id || !ref?.payment_id) return {};

  const refundId = String(ref.id);
  const paymentId = String(ref.payment_id);
  const amountPaise = Math.round(Number(ref.amount || 0));
  if (!Number.isFinite(amountPaise) || amountPaise <= 0) return {};

  const o = await pool.query(`SELECT id FROM orders WHERE razorpay_payment_id = $1 LIMIT 1`, [paymentId]);
  if (!o.rows.length) {
    logPayment("webhook_refund_no_order", { payment_id: paymentId });
    return { missing_order: true };
  }
  const orderId = o.rows[0].id;

  await pool.query(
    `INSERT INTO razorpay_order_refunds
       (order_id, razorpay_refund_id, amount_paise, status, raw_json)
     VALUES ($1, $2, $3, $4, $5::jsonb)
     ON CONFLICT (razorpay_refund_id) DO NOTHING`,
    [orderId, refundId, amountPaise, ref.status || null, safeJson(ref)]
  );

  await refreshRefundPaymentStatus(orderId);
  return { matched_order_id: orderId };
}

async function refreshRefundPaymentStatus(orderId) {
  const sumR = await pool.query(
    `SELECT COALESCE(SUM(amount_paise), 0)::bigint AS s FROM razorpay_order_refunds WHERE order_id = $1`,
    [orderId]
  );
  const refundedPaise = Number(sumR.rows[0]?.s || 0);

  const tot = await pool.query(
    `SELECT COALESCE(SUM(unit_price_inr * quantity_units), 0)::numeric AS t FROM order_items WHERE order_id = $1`,
    [orderId]
  );
  const totalPaise = Math.round(Number(tot.rows[0]?.t || 0) * 100);

  let status = "partially_refunded";
  if (totalPaise > 0 && refundedPaise >= totalPaise) status = "refunded";
  else if (refundedPaise <= 0) return;

  await pool.query(`UPDATE orders SET payment_status = $2 WHERE id = $1`, [orderId, status]);
}

/** After API or webhook refund, call to update orders.payment_status from razorpay_order_refunds. */
export async function recomputeOrderRefundPaymentStatus(orderId) {
  return refreshRefundPaymentStatus(orderId);
}
