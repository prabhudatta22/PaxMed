import { Router } from "express";
import multer from "multer";
import { timingSafeEqual } from "node:crypto";
import { pool } from "../db/pool.js";
import { requireUser } from "../auth/middleware.js";
import { ensureDiagnosticReportsSchema } from "../diagnostics/reportSchema.js";
import {
  allowedDiagnosticReportMime,
  maxDiagnosticReportBytes,
  readLocalDiagnosticReport,
  signedGetUrlForDiagnosticReport,
  useS3ForDiagnosticReports,
} from "../diagnostics/reportStorage.js";
import {
  diagnosticLabelsFromOrderItems,
  loadDiagnosticsOrderSummary,
} from "../diagnostics/orderMeta.js";
import { insertDiagnosticsReportRecord } from "../diagnostics/partnerReportSync.js";
import { listDiagnosticReportsForUser } from "../diagnostics/userDiagnosticReportsList.js";

const router = Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: Math.min(maxDiagnosticReportBytes(), 25 * 1024 * 1024) },
});

function requireConsumer(req, res, next) {
  if (req.user?.role === "service_provider") {
    res.status(403).json({ error: "Diagnostic reports are available only for consumer accounts." });
    return;
  }
  next();
}

function consumerUserId(req, res) {
  const uid = Number(req.user?.id);
  if (!Number.isFinite(uid) || uid < 1) {
    res.status(400).json({ error: "Invalid session (consumer id missing)" });
    return null;
  }
  return uid;
}

function ingestSecretOk(req) {
  const expected = String(process.env.DIAGNOSTIC_REPORT_INGEST_SECRET || "").trim();
  if (expected.length < 24) return false;
  const got = String(req.headers["x-diagnostic-report-ingest-secret"] || "").trim();
  if (got.length !== expected.length) return false;
  try {
    return timingSafeEqual(Buffer.from(got, "utf8"), Buffer.from(expected, "utf8"));
  } catch {
    return false;
  }
}

/**
 * Labs / fulfilment POST a completed diagnostic PDF/image against a PaxMed order id.
 */
router.post("/lab-ingest", upload.single("file"), async (req, res) => {
  try {
    if (!ingestSecretOk(req)) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    await ensureDiagnosticReportsSchema();
    if (!req.file?.buffer?.length) {
      return res.status(400).json({ error: "Missing file (field name: file)" });
    }

    const orderId = Number(req.body?.order_id);
    if (!Number.isFinite(orderId) || orderId < 1) {
      return res.status(400).json({ error: "order_id is required" });
    }

    const summary = await loadDiagnosticsOrderSummary(pool, orderId);
    if (!summary) {
      return res.status(404).json({ error: "Order not found or not a diagnostics booking" });
    }

    const mime = allowedDiagnosticReportMime(req.file.mimetype);
    if (!mime) {
      return res.status(400).json({ error: "Unsupported type. Upload JPEG, PNG, WebP, or PDF." });
    }

    let diagnosticType = String(req.body?.diagnostic_type || "").trim().slice(0, 600);
    if (!diagnosticType) {
      diagnosticType = await diagnosticLabelsFromOrderItems(pool, orderId);
    }

    const originalFilename = req.file.originalname
      ? String(req.file.originalname).trim().slice(0, 240)
      : null;
    const labSource = String(req.body?.lab_source || "lab_ingest").trim().slice(0, 120) || "lab_ingest";

    try {
      const result = await insertDiagnosticsReportRecord({
        pool,
        orderId,
        userId: summary.order.user_id,
        buffer: req.file.buffer,
        mimeType: mime,
        diagnosticType,
        amountInr: summary.amount_inr,
        bookedAt: summary.booked_at,
        paymentMadeBy: summary.payment_made_by,
        labSource,
        originalFilename,
        ingestEventKey: null,
      });

      if (result.skipped) {
        return res.status(200).json({
          ok: true,
          skipped: true,
          reason: result.reason || "skipped",
          order_id: orderId,
        });
      }

      return res.status(201).json({
        report: { id: result.report_id, uploaded_at: result.uploaded_at },
        order_id: orderId,
      });
    } catch (e) {
      return res.status(400).json({ error: e?.message || "Ingest failed" });
    }
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: e?.message || "Ingest failed" });
  }
});

router.get("/", requireUser, requireConsumer, async (req, res) => {
  try {
    const userId = consumerUserId(req, res);
    if (userId == null) return;
    const rows = await listDiagnosticReportsForUser(pool, userId);
    res.json({ reports: rows });
  } catch (e) {
    res.status(500).json({ error: e?.message || "Failed to list reports" });
  }
});

router.get("/:id/download-url", requireUser, requireConsumer, async (req, res) => {
  try {
    const userId = consumerUserId(req, res);
    if (userId == null) return;
    await ensureDiagnosticReportsSchema();
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id < 1) return res.status(400).json({ error: "Invalid id" });

    const { rows } = await pool.query(
      `SELECT id, storage_backend, storage_key, s3_bucket, mime_type, original_filename
       FROM user_diagnostic_reports
       WHERE id = $1 AND user_id = $2::integer
       LIMIT 1`,
      [id, userId]
    );
    if (!rows.length) return res.status(404).json({ error: "Not found" });
    const r = rows[0];

    if (r.storage_backend === "s3") {
      if (!useS3ForDiagnosticReports()) {
        return res.status(503).json({ error: "S3 is not configured" });
      }
      const secondsRaw = Number(process.env.DIAGNOSTIC_REPORTS_SIGNED_URL_SECONDS);
      const expiresIn =
        Number.isFinite(secondsRaw) && secondsRaw >= 60 && secondsRaw <= 86400 ? Math.floor(secondsRaw) : 900;
      const url = await signedGetUrlForDiagnosticReport({
        storage_key: r.storage_key,
        mime_type: r.mime_type,
      });
      return res.json({
        url,
        expires_in_seconds: expiresIn,
        filename: r.original_filename || "report",
      });
    }

    const path = `/api/diagnostic-reports/${id}/file`;
    return res.json({
      url: path,
      expires_in_seconds: null,
      filename: r.original_filename || "report",
    });
  } catch (e) {
    res.status(500).json({ error: e?.message || "Failed to issue link" });
  }
});

router.get("/:id/file", requireUser, requireConsumer, async (req, res) => {
  try {
    const userId = consumerUserId(req, res);
    if (userId == null) return;
    await ensureDiagnosticReportsSchema();
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id < 1) return res.status(400).json({ error: "Invalid id" });

    const { rows } = await pool.query(
      `SELECT storage_backend, storage_key, mime_type, original_filename
       FROM user_diagnostic_reports
       WHERE id = $1 AND user_id = $2::integer
       LIMIT 1`,
      [id, userId]
    );
    if (!rows.length) return res.status(404).json({ error: "Not found" });
    const r = rows[0];
    if (r.storage_backend !== "local") {
      return res.status(400).json({ error: "Use download-url for this report (stored in S3)" });
    }

    const body = await readLocalDiagnosticReport(r.storage_key);
    res.setHeader("Content-Type", r.mime_type);
    res.setHeader("Cache-Control", "private, no-store");
    const name = encodeURIComponent(String(r.original_filename || "report").replace(/\s+/g, "_"));
    res.setHeader("Content-Disposition", `attachment; filename="${name}"`);
    res.send(body);
  } catch (e) {
    res.status(500).json({ error: e?.message || "Read failed" });
  }
});

export default router;
