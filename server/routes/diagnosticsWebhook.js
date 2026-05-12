import { Router } from "express";
import { timingSafeEqual } from "node:crypto";
import { pool } from "../db/pool.js";
import { ensureDiagnosticReportsSchema } from "../diagnostics/reportSchema.js";
import {
  ingestDiagnosticsReportFromUrl,
  syncDiagnosticsReportForOrder,
} from "../diagnostics/partnerReportSync.js";

const router = Router();

function diagnosticsWebhookSecretOk(req) {
  const expected = String(process.env.DIAGNOSTICS_WEBHOOK_SECRET || "").trim();
  if (expected.length < 24) return false;
  const got = String(
    req.headers["x-diagnostics-webhook-secret"] || req.headers["x-webhook-secret"] || ""
  ).trim();
  if (got.length !== expected.length) return false;
  try {
    return timingSafeEqual(Buffer.from(got, "utf8"), Buffer.from(expected, "utf8"));
  } catch {
    return false;
  }
}

/**
 * Partner pushes "report ready" + optional HTTPS `report_url` (Healthians-style signed URL).
 * When `report_url` is omitted, PaxMed pulls via getCustomerReport_v2 (`syncDiagnosticsReportForOrder`).
 *
 * Expected JSON keys (flexible): booking_id | booking_ref, report_url?, event_id?,
 * diagnostic_type?, verified_at? (dedupe hints).
 */
router.post("/", async (req, res) => {
  if (!diagnosticsWebhookSecretOk(req)) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  await ensureDiagnosticReportsSchema();

  const body = req.body && typeof req.body === "object" ? req.body : {};
  const bookingRef = String(
    body.booking_id || body.booking_ref || body.partner_booking_id || ""
  ).trim();
  if (!bookingRef) {
    return res.status(400).json({ error: "booking_id or booking_ref is required" });
  }

  const reportUrl = String(body.report_url || body.reportUrl || body.report_url_signed || "").trim();
  const eventIdRaw = body.event_id != null ? String(body.event_id).trim().slice(0, 280) : "";
  const verifiedAtRaw = body.verified_at != null ? String(body.verified_at).trim().slice(0, 120) : "";

  const { rows } = await pool.query(
    `SELECT id, user_id
     FROM orders
     WHERE order_kind = 'diagnostics'
       AND (
         provider_order_ref = $1
        OR COALESCE(provider_payload::jsonb -> 'paxmed' ->> 'partner_booking_id', '') = $1
       )
     ORDER BY created_at DESC
     LIMIT 20`,
    [bookingRef]
  );
  if (!rows.length) {
    return res.status(404).json({ error: "No diagnostics order matches this booking reference" });
  }

  const ingestEventKey =
    eventIdRaw ||
    (verifiedAtRaw && reportUrl
      ? `${bookingRef}:${verifiedAtRaw}:${reportUrl.slice(-48)}`
      : reportUrl
        ? `${bookingRef}:url:${reportUrl.slice(-48)}`
        : null);

  const diagTypeHint = body.diagnostic_type ? String(body.diagnostic_type).trim().slice(0, 600) : null;

  const results = [];
  for (const row of rows) {
    try {
      if (reportUrl.startsWith("https://")) {
        const ing = await ingestDiagnosticsReportFromUrl(pool, {
          orderId: row.id,
          userId: row.user_id,
          reportUrl,
          ingestEventKey,
          labSource: "diagnostics_webhook_url",
          diagnosticType: diagTypeHint,
          originalFilename: body.filename ? String(body.filename).slice(0, 240) : undefined,
        });
        results.push({ order_id: row.id, ingest: ing });
      } else {
        const pulled = await syncDiagnosticsReportForOrder(pool, row.id, row.user_id);
        results.push({ order_id: row.id, sync: pulled });
      }
    } catch (e) {
      results.push({ order_id: row.id, error: e?.message || String(e) });
    }
  }

  return res.status(200).json({ ok: true, booking_ref: bookingRef, matched_orders: rows.length, results });
});

export default router;
