import { Router } from "express";
import { pool } from "../db/pool.js";
import { randomSessionId } from "../auth/phone.js";

const router = Router();

function loadTestToken(env = process.env) {
  return String(env.LOAD_TEST_TOKEN || "").trim();
}

export function isLoadTestRouteEnabled(env = process.env) {
  return Boolean(loadTestToken(env) && env.NODE_ENV !== "production");
}

/**
 * Gated stress-test helper: creates/returns a consumer user + default Mumbai address + new session.
 * Enable only in non-production or in isolated environments: set LOAD_TEST_TOKEN to a long random secret.
 * POST /api/load-test/session  body: { token, user_index }  user_index: 1 .. 9_999_999
 */
router.post("/load-test/session", async (req, res) => {
  if (!isLoadTestRouteEnabled()) {
    return res.status(404).json({ error: "Not found" });
  }
  const expected = loadTestToken();
  if (!expected) {
    return res.status(404).json({ error: "Not found" });
  }
  if (String(req.body?.token || "") !== expected) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const idx = Number(req.body?.user_index);
  if (!Number.isFinite(idx) || idx < 1 || idx > 3_999_999_999) {
    return res.status(400).json({ error: "user_index must be an integer 1 .. 3999999999" });
  }

  const national = 6_000_000_000 + Math.floor(idx);
  if (national > 9_999_999_999) {
    return res.status(400).json({ error: "user_index too large for 10-digit synthetic national number" });
  }
  const phoneE164 = `+91${national}`;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const userRes = await client.query(
      `INSERT INTO users (phone_e164, last_login_at)
       VALUES ($1, now())
       ON CONFLICT (phone_e164) DO UPDATE SET last_login_at = now()
       RETURNING id, phone_e164`,
      [phoneE164]
    );
    const user = userRes.rows[0];

    const hasAddr = await client.query(
      `SELECT id FROM user_addresses WHERE user_id = $1 ORDER BY id ASC LIMIT 1`,
      [user.id]
    );
    if (!hasAddr.rows.length) {
      await client.query(
        `INSERT INTO user_addresses
          (user_id, label, name, phone_e164, address_line1, address_line2, city, state, pincode, is_default, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, true, now())`,
        [
          user.id,
          "Load test",
          `User ${idx}`,
          phoneE164,
          `${idx} Load Test Street`,
          "Near stress tower",
          "Mumbai",
          "Maharashtra",
          "400001",
        ]
      );
    }

    const sid = randomSessionId();
    const days = Number(process.env.SESSION_DAYS || 30);
    const expiresAt = new Date(Date.now() + days * 24 * 60 * 60_000).toISOString();
    await client.query(`INSERT INTO sessions (id, user_id, expires_at) VALUES ($1, $2, $3)`, [
      sid,
      user.id,
      expiresAt,
    ]);

    await client.query("COMMIT");

    res.cookie("sid", sid, {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      expires: new Date(expiresAt),
    });

    return res.json({ ok: true, user_id: user.id, phone_e164: user.phone_e164 });
  } catch (e) {
    await client.query("ROLLBACK");
    return res.status(500).json({ error: e?.message || "load-test session failed" });
  } finally {
    client.release();
  }
});

export default router;
