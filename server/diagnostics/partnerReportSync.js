/**
 * Fetch partner-signed report URLs (Healthians getCustomerReport_v2), download PDFs,
 * persist to diagnostic report storage + user_diagnostic_reports.
 */

import { createHash } from "node:crypto";
import {
  getPartnerBookingStatus,
  getPartnerCustomerReport,
  isDiagnosticsPartnerEnabled,
} from "../integrations/diagnosticsPartner.js";
import { diagnosticLabelsFromOrderItems, loadDiagnosticsOrderSummary } from "./orderMeta.js";
import { ensureDiagnosticReportsSchema } from "./reportSchema.js";
import {
  allowedDiagnosticReportMime,
  deleteDiagnosticReportBlob,
  persistDiagnosticReportFile,
} from "./reportStorage.js";

function customerReportEnvPath() {
  return String(process.env.DIAG_B2B_CUSTOMER_REPORT_PATH || "getCustomerReport_v2");
}

function parsePayload(raw) {
  if (raw == null) return {};
  if (typeof raw === "object") return raw;
  try {
    return JSON.parse(String(raw));
  } catch {
    return {};
  }
}

/**
 * Read PaxMed booking context from orders.provider_payload (new envelope + legacy fallback).
 */
export function extractDiagnosticsReportContext(order) {
  const p = parsePayload(order?.provider_payload);
  const envelope = p?.paxmed && typeof p.paxmed === "object" ? p.paxmed : null;
  if (envelope && typeof envelope === "object") {
    return {
      partner_booking_id: envelope.partner_booking_id != null ? String(envelope.partner_booking_id) : null,
      vendor_booking_id: envelope.vendor_booking_id != null ? String(envelope.vendor_booking_id) : "",
      vendor_billing_user_id: envelope.vendor_billing_user_id != null ? String(envelope.vendor_billing_user_id) : "",
      vendor_customer_id:
        envelope.vendor_customer_id != null ? String(envelope.vendor_customer_id).trim() : "",
      envelope: p,
    };
  }
  const fb = process.env.DIAG_B2B_FALLBACK_VENDOR_CUSTOMER_ID
    ? String(process.env.DIAG_B2B_FALLBACK_VENDOR_CUSTOMER_ID).trim()
    : "";
  return {
    partner_booking_id: order?.provider_order_ref != null ? String(order.provider_order_ref) : null,
    vendor_booking_id: "",
    vendor_billing_user_id: order?.user_id != null ? `paxmed-${order.user_id}` : "",
    vendor_customer_id: fb,
    envelope: p,
    legacy: true,
  };
}

export async function insertDiagnosticsReportRecord({
  pool,
  orderId,
  userId,
  buffer,
  diagnosticType,
  amountInr,
  bookedAt,
  paymentMadeBy,
  labSource,
  originalFilename,
  mimeType,
  ingestEventKey,
}) {
  const mime = allowedDiagnosticReportMime(mimeType || "") || sniffMime(buffer);
  if (!mime) throw new Error("Could not detect a supported PDF or image format");

  const sha = createHash("sha256").update(buffer).digest("hex");
  const dupSha = await pool.query(
    `SELECT 1 FROM user_diagnostic_reports WHERE order_id = $1 AND content_sha256 = $2 LIMIT 1`,
    [orderId, sha]
  );
  if (dupSha.rows.length) {
    return { ok: false, skipped: true, reason: "duplicate_content" };
  }
  if (ingestEventKey) {
    const dupEv = await pool.query(
      `SELECT 1 FROM user_diagnostic_reports WHERE ingest_event_key = $1 LIMIT 1`,
      [ingestEventKey]
    );
    if (dupEv.rows.length) {
      return { ok: false, skipped: true, reason: "duplicate_webhook_event" };
    }
  }

  const blob = await persistDiagnosticReportFile({
    userId,
    buffer,
    mimeType: mime,
    originalFilename,
  });

  try {
    const { rows } = await pool.query(
      `INSERT INTO user_diagnostic_reports (
         user_id, order_id, diagnostic_type,
         storage_backend, storage_key, s3_bucket,
         mime_type, byte_size, original_filename,
         amount_inr, booked_at, payment_made_by, lab_source,
         content_sha256, ingest_event_key
       )
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
       RETURNING id, uploaded_at`,
      [
        userId,
        orderId,
        diagnosticType.slice(0, 600),
        blob.storage_backend,
        blob.storage_key,
        blob.s3_bucket,
        mime,
        blob.byte_size,
        originalFilename ? String(originalFilename).slice(0, 240) : null,
        amountInr,
        bookedAt,
        paymentMadeBy,
        labSource,
        sha,
        ingestEventKey || null,
      ]
    );
    return {
      ok: true,
      report_id: rows[0]?.id,
      uploaded_at: rows[0]?.uploaded_at,
    };
  } catch (e) {
    await deleteDiagnosticReportBlob({
      storage_backend: blob.storage_backend,
      storage_key: blob.storage_key,
      s3_bucket: blob.s3_bucket,
    });
    throw e;
  }
}

function sniffMime(buf) {
  if (!buf?.length) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return "image/png";
  if (buf[0] === 0x25 && buf[1] === 0x50 && buf[2] === 0x44 && buf[3] === 0x46) return "application/pdf";
  if (buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) return "image/webp";
  return null;
}

/**
 * Fetch a partner-signed HTTPS URL (no auth cookie).
 */
export async function fetchReportFromUrl(reportUrl, { timeoutMs = 55000 } = {}) {
  const u = String(reportUrl || "").trim();
  if (!u.startsWith("https://")) {
    throw new Error("report_url must be an https URL");
  }
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(u, {
      method: "GET",
      redirect: "follow",
      signal: controller.signal,
      headers: { Accept: "application/pdf,image/*,*/*" },
    });
    if (!res.ok) throw new Error(`Report download failed (${res.status})`);
    const hdrMime = res.headers.get("content-type");
    const mime = allowedDiagnosticReportMime(hdrMime);
    const buf = Buffer.from(await res.arrayBuffer());
    if (!buf.length) throw new Error("Empty report body");
    return { buffer: buf, mimeHint: mime || hdrMime, finalUrl: res.url };
  } finally {
    clearTimeout(t);
  }
}

/**
 * Skip when duplicate webhook key or duplicate content hash per order.
 */
export async function ingestDiagnosticsReportFromUrl(pool, opts) {
  await ensureDiagnosticReportsSchema();
  const {
    orderId,
    userId,
    reportUrl,
    ingestEventKey,
    labSource,
    diagnosticType,
    summary,
    originalFilename,
  } = opts;
  const fetched = await fetchReportFromUrl(reportUrl);
  const finSummary = summary || (await loadDiagnosticsOrderSummary(pool, orderId));
  if (!finSummary) throw new Error("Order not found or not diagnostics");
  const diagType =
    diagnosticType?.trim()?.slice(0, 600) || (await diagnosticLabelsFromOrderItems(pool, orderId));
  return insertDiagnosticsReportRecord({
    pool,
    orderId,
    userId,
    buffer: fetched.buffer,
    mimeType: fetched.mimeHint,
    diagnosticType: diagType,
    amountInr: finSummary.amount_inr,
    bookedAt: finSummary.booked_at,
    paymentMadeBy: finSummary.payment_made_by,
    labSource,
    originalFilename:
      originalFilename ||
      `diag-report-${orderId}${String(fetched.mimeHint || "").includes("pdf") ? ".pdf" : ".bin"}`,
    ingestEventKey,
  });
}

/**
 * Partner getCustomerReport_v2 → first signed HTTPS URL → local/S3 ingest.
 */
export async function syncDiagnosticsReportForOrder(pool, orderId, userId) {
  await ensureDiagnosticReportsSchema();
  if (!isDiagnosticsPartnerEnabled()) {
    return { ok: false, skipped: true, reason: "partner_disabled" };
  }

  const { rows } = await pool.query(
    `SELECT id, user_id, order_kind, provider_order_ref, provider_payload
     FROM orders
     WHERE id = $1 AND user_id = $2
     LIMIT 1`,
    [orderId, userId]
  );
  if (!rows.length) return { ok: false, skipped: true, reason: "order_not_found" };
  const order = rows[0];
  if (String(order.order_kind) !== "diagnostics") {
    return { ok: false, skipped: true, reason: "not_diagnostics_order" };
  }

  const ctx = extractDiagnosticsReportContext(order);
  const bookingRef = ctx.partner_booking_id || String(order.provider_order_ref || "").trim();
  if (!bookingRef || String(bookingRef).startsWith("LOCAL-")) {
    return { ok: false, skipped: true, reason: "local_or_missing_booking_ref" };
  }

  let vendorBilling = ctx.vendor_billing_user_id || "";
  let vendorCustomer =
    ctx.vendor_customer_id?.trim() || String(process.env.DIAG_B2B_FALLBACK_VENDOR_CUSTOMER_ID || "").trim();

  if (!vendorCustomer || !vendorBilling) {
    try {
      const st = await getPartnerBookingStatus({ bookingId: bookingRef });
      const c0 = st?.customer?.[0];
      vendorBilling =
        vendorBilling ||
        String(c0?.vendor_billing_user_id || c0?.billing_user_id || ctx.vendor_billing_user_id || "").trim();
      vendorCustomer =
        vendorCustomer || String(c0?.vendor_customer_id || c0?.customer_id || "").trim();
    } catch {
      /* continue with env fallbacks */
    }
  }

  if (!vendorBilling) vendorBilling = `paxmed-${userId}`;
  if (!vendorCustomer) {
    return { ok: false, skipped: true, reason: "vendor_customer_id_unknown" };
  }

  const allowPartial = Number(process.env.DIAG_B2B_CUSTOMER_REPORT_ALLOW_PARTIAL ?? "1") ? 1 : 0;

  let rep;
  try {
    rep = await getPartnerCustomerReport({
      bookingId: bookingRef,
      vendorBillingUserId: vendorBilling,
      vendorCustomerId: vendorCustomer,
      allowPartial,
    });
  } catch (_e) {
    return { ok: false, skipped: true, reason: "partner_report_api_failed" };
  }

  const url = rep.urls?.[0];
  if (!url) {
    return { ok: false, skipped: true, reason: "no_report_url_yet" };
  }

  const summary = await loadDiagnosticsOrderSummary(pool, orderId);
  if (!summary) return { ok: false, skipped: true, reason: "summary_load_failed" };
  const diagType = await diagnosticLabelsFromOrderItems(pool, orderId);

  const ingest = await ingestDiagnosticsReportFromUrl(pool, {
    orderId,
    userId,
    reportUrl: url,
    ingestEventKey: null,
    labSource: `healthians_${customerReportEnvPath().replace(/\W+/g, "_")}`,
    diagnosticType: diagType,
    summary,
    originalFilename: `booking-${bookingRef}-report.pdf`,
  });
  return ingest;
}
