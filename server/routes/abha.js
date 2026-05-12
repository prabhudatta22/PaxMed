import express from "express";
import crypto from "node:crypto";
import { pool } from "../db/pool.js";
import { requireUser } from "../auth/middleware.js";
import { normalizeAbhaIdentifier, maskHealthIdNumber } from "../abha/validate.js";
import { getAbhaIntegrationMode, fetchAbhaDemographics } from "../abha/client.js";
import {
  syncFromAbha,
  mergeAndPushAbhaForUser,
  loadAbhaLink,
  identifierFromLinkRow,
  applyAbhaDemographicsToUser,
} from "../abha/syncProfile.js";
import { ensureAbhaSchema } from "../abha/schema.js";

const router = express.Router();

function requireConsumer(req, res, next) {
  if (req.user?.role === "service_provider") {
    return res.status(403).json({ error: "ABHA is available only for consumer accounts" });
  }
  return next();
}

function stubOtp() {
  return String(process.env.ABHA_STUB_AADHAAR_OTP || "123456").trim();
}

router.use(async (req, res, next) => {
  try {
    await ensureAbhaSchema();
    next();
  } catch (e) {
    next(e);
  }
});

router.get("/status", requireUser, requireConsumer, async (req, res) => {
  const mode = getAbhaIntegrationMode();
  res.json({
    mode,
    configured: mode !== "off",
    message:
      mode === "stub"
        ? "Stub mode: use OTP from ABHA_STUB_AADHAAR_OTP (default 123456). No external ABDM calls."
        : mode === "live"
          ? "Live mode: requires ABDM credentials and implemented token/signing flows."
          : "ABHA integration disabled.",
  });
});

router.get("/link", requireUser, requireConsumer, async (req, res) => {
  const userId = req.user.id;
  const row = await loadAbhaLink(pool, userId);
  if (!row) return res.json({ linked: false, link: null });
  res.json({
    linked: true,
    link: {
      health_id_masked: row.health_id_masked,
      identifier_kind: row.identifier_kind,
      aadhaar_verified_at: row.aadhaar_verified_at,
      last_sync_at: row.last_sync_at,
      source_mode: row.source_mode,
    },
  });
});

/**
 * Start Aadhaar OTP step. Only call after user has entered a valid ABHA / PHR identifier.
 */
router.post("/aadhaar/initiate", requireUser, requireConsumer, async (req, res) => {
  const userId = req.user.id;
  const existing = await loadAbhaLink(pool, userId);
  if (existing) return res.status(400).json({ error: "ABHA is already linked for this account." });

  let identifier;
  try {
    identifier = normalizeAbhaIdentifier(req.body?.health_id || req.body?.abha_id || req.body?.identifier);
  } catch (e) {
    return res.status(400).json({ error: e.message || "Invalid ABHA identifier" });
  }

  const mode = getAbhaIntegrationMode();
  if (mode === "off") return res.status(503).json({ error: "ABHA integration is disabled." });

  const txnId = crypto.randomUUID();
  const healthStored = identifier.kind === "number" ? identifier.value : identifier.value;
  const masked = identifier.kind === "number" ? maskHealthIdNumber(identifier.value) : `${identifier.value.slice(0, 3)}***`;
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000);

  await pool.query(`DELETE FROM abha_aadhaar_sessions WHERE user_id = $1`, [userId]);
  await pool.query(
    `INSERT INTO abha_aadhaar_sessions (user_id, txn_id, health_id_number, identifier_kind, expires_at)
     VALUES ($1, $2, $3, $4, $5)`,
    [userId, txnId, healthStored, identifier.kind, expiresAt],
  );

  res.json({
    txn_id: txnId,
    expires_at: expiresAt.toISOString(),
    masked_hint: masked,
    mode,
    message:
      mode === "stub"
        ? `Stub: enter OTP ${stubOtp()} to complete Aadhaar verification.`
        : "OTP sent to Aadhaar-linked mobile (ABDM). Enter OTP to complete.",
  });
});

router.post("/aadhaar/complete", requireUser, requireConsumer, async (req, res) => {
  const userId = req.user.id;
  const txnId = String(req.body?.txn_id || "").trim();
  const otp = String(req.body?.otp || "").trim();
  if (!txnId || !otp) return res.status(400).json({ error: "txn_id and otp are required" });

  const existing = await loadAbhaLink(pool, userId);
  if (existing) return res.status(400).json({ error: "ABHA is already linked." });

  const { rows } = await pool.query(
    `SELECT * FROM abha_aadhaar_sessions WHERE txn_id = $1 AND user_id = $2`,
    [txnId, userId],
  );
  const sess = rows[0];
  if (!sess) return res.status(400).json({ error: "Invalid or expired session. Start again." });
  if (new Date(sess.expires_at) < new Date()) {
    await pool.query(`DELETE FROM abha_aadhaar_sessions WHERE id = $1`, [sess.id]);
    return res.status(400).json({ error: "Session expired. Start again." });
  }

  const mode = getAbhaIntegrationMode();
  if (mode === "stub") {
    if (otp !== stubOtp()) return res.status(400).json({ error: "Invalid OTP (stub mode)." });
  } else {
    // Live: verify OTP with ABDM gateway (implement per ABDM docs).
    return res.status(501).json({ error: "Live Aadhaar OTP verification not implemented yet." });
  }

  const identifier =
    sess.identifier_kind === "phr"
      ? { kind: "phr", value: String(sess.health_id_number).toLowerCase() }
      : { kind: "number", value: String(sess.health_id_number).replace(/\D/g, "") };

  let demo;
  try {
    demo = await fetchAbhaDemographics({ identifier });
  } catch (e) {
    return res.status(502).json({ error: e.message || "Failed to fetch ABHA profile" });
  }

  const masked =
    identifier.kind === "number" ? maskHealthIdNumber(identifier.value) : `${identifier.value.slice(0, 3)}***`;
  const healthStored = identifier.kind === "number" ? identifier.value : identifier.value;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`DELETE FROM abha_aadhaar_sessions WHERE id = $1`, [sess.id]);
    await client.query(
      `INSERT INTO abha_link (user_id, health_id_number, health_id_masked, identifier_kind, aadhaar_verified_at, last_sync_at, source_mode, updated_at)
       VALUES ($1, $2, $3, $4, now(), now(), $5, now())
       ON CONFLICT (user_id) DO UPDATE SET
         health_id_number = EXCLUDED.health_id_number,
         health_id_masked = EXCLUDED.health_id_masked,
         identifier_kind = EXCLUDED.identifier_kind,
         aadhaar_verified_at = EXCLUDED.aadhaar_verified_at,
         last_sync_at = EXCLUDED.last_sync_at,
         source_mode = EXCLUDED.source_mode,
         updated_at = now()`,
      [userId, healthStored, masked, identifier.kind, demo.source || mode],
    );
    await applyAbhaDemographicsToUser(client, userId, demo);
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    return res.status(500).json({ error: e.message || "Failed to save ABHA link" });
  } finally {
    client.release();
  }

  res.json({
    ok: true,
    linked: true,
    health_id_masked: masked,
    profile_synced: true,
    message: "PaxMed profile was updated from ABHA (ABHA data wins on conflict).",
  });
});

/** Pull latest from ABHA and overwrite local profile (only when linked). */
router.post("/sync-from-abha", requireUser, requireConsumer, async (req, res) => {
  const userId = req.user.id;
  const row = await loadAbhaLink(pool, userId);
  if (!row) return res.status(400).json({ error: "Link ABHA first (Aadhaar verification)." });

  const identifier = identifierFromLinkRow(row);
  if (!identifier) return res.status(400).json({ error: "Invalid stored identifier." });

  try {
    await syncFromAbha(pool, userId, identifier);
    await pool.query(`UPDATE abha_link SET last_sync_at = now(), updated_at = now() WHERE user_id = $1`, [userId]);
  } catch (e) {
    return res.status(502).json({ error: e.message || "Sync failed" });
  }

  res.json({ ok: true, message: "Profile updated from ABHA." });
});

/** Called after user edits profile locally — push to ABHA when linked. */
router.post("/push-profile", requireUser, requireConsumer, async (req, res) => {
  const userId = req.user.id;
  const row = await loadAbhaLink(pool, userId);
  if (!row) return res.json({ ok: true, skipped: true, reason: "not_linked" });

  try {
    const out = await mergeAndPushAbhaForUser(pool, userId, req.body || {});
    res.json({ ok: true, ...out });
  } catch (e) {
    res.status(502).json({ error: e.message || "Push to ABHA failed" });
  }
});

export default router;
export { loadAbhaLink, identifierFromLinkRow };
