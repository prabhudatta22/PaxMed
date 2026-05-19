import { Router } from "express";
import { pool } from "../db/pool.js";
import { requireUser } from "../auth/middleware.js";
import { ensureAbhaSchema } from "../abha/schema.js";
import { loadAbhaLink, mergeAndPushAbhaForUser } from "../abha/syncProfile.js";
import { listDiagnosticReportsForUser } from "../diagnostics/userDiagnosticReportsList.js";

const router = Router();
router.use(requireUser);

let schemaReadyPromise = null;

async function ensureProfileSchema() {
  if (schemaReadyPromise) return schemaReadyPromise;
  schemaReadyPromise = (async () => {
    await pool.query(
      `ALTER TABLE users ADD COLUMN IF NOT EXISTS email TEXT;
       ALTER TABLE users ADD COLUMN IF NOT EXISTS full_name TEXT;
       ALTER TABLE users ADD COLUMN IF NOT EXISTS gender TEXT;
       ALTER TABLE users ADD COLUMN IF NOT EXISTS date_of_birth DATE;

       CREATE TABLE IF NOT EXISTS user_addresses (
         id SERIAL PRIMARY KEY,
         user_id INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
         label TEXT,
         name TEXT,
         phone_e164 TEXT,
         address_line1 TEXT NOT NULL,
         address_line2 TEXT,
         landmark TEXT,
         city TEXT,
         state TEXT,
         pincode TEXT,
         lat DOUBLE PRECISION,
         lng DOUBLE PRECISION,
         created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
         updated_at TIMESTAMPTZ
       );

       ALTER TABLE user_addresses ADD COLUMN IF NOT EXISTS is_default BOOLEAN NOT NULL DEFAULT false;
       CREATE INDEX IF NOT EXISTS idx_user_addresses_user ON user_addresses (user_id, created_at DESC);

       CREATE TABLE IF NOT EXISTS user_payment_methods (
         id SERIAL PRIMARY KEY,
         user_id INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
         method_type TEXT NOT NULL CHECK (method_type IN ('upi','card')),
         provider TEXT NOT NULL DEFAULT 'razorpay',
         label TEXT,
         upi_id TEXT,
         card_last4 TEXT,
         card_network TEXT,
         card_holder_name TEXT,
         is_default BOOLEAN NOT NULL DEFAULT false,
         created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
         updated_at TIMESTAMPTZ
       );

       CREATE INDEX IF NOT EXISTS idx_user_payment_methods_user
         ON user_payment_methods (user_id, created_at DESC);`
    );
  })().catch((e) => {
    schemaReadyPromise = null;
    throw e;
  });
  return schemaReadyPromise;
}

function requireConsumer(req, res) {
  if (req.user?.role === "service_provider") {
    res.status(403).json({ error: "Profile is available only for consumer users" });
    return false;
  }
  return true;
}

/** Resolves Postgres `users.id` for consumer OTP / Google sessions (`req.user.id` must be numeric). */
function consumerDbUserId(req, res) {
  const uid = Number(req.user?.id);
  if (!Number.isFinite(uid) || uid < 1) {
    res.status(400).json({ error: "Invalid session (consumer id missing)" });
    return null;
  }
  return uid;
}

function cleanText(v, max = 200) {
  const s = String(v || "").trim();
  return s ? s.slice(0, max) : null;
}

router.get("/", async (req, res) => {
  if (!requireConsumer(req, res)) return;
  await ensureProfileSchema();
  const userId = consumerDbUserId(req, res);
  if (userId == null) return;

  const { rows: regRows } = await pool.query(
    `SELECT
       to_regclass('public.user_addresses') IS NOT NULL AS has_addresses,
       to_regclass('public.user_payment_methods') IS NOT NULL AS has_payments,
       to_regclass('public.orders') IS NOT NULL AS has_orders`
  );
  const reg = regRows[0] || { has_addresses: false, has_payments: false, has_orders: false };

  const [uRes, aRes, pRes, oRes] = await Promise.all([
    pool.query(
      `SELECT
         id,
         phone_e164,
         to_jsonb(users) ->> 'email' AS email,
         to_jsonb(users) ->> 'full_name' AS full_name,
         to_jsonb(users) ->> 'gender' AS gender,
         (users.date_of_birth)::text AS date_of_birth,
         created_at,
         last_login_at
       FROM users
       WHERE id = $1
       LIMIT 1`,
      [userId]
    ),
    reg.has_addresses
      ? pool.query(
          `SELECT id, label, name, phone_e164, address_line1, address_line2, landmark, city, state, pincode, lat, lng, is_default, created_at
           FROM user_addresses
           WHERE user_id = $1
           ORDER BY is_default DESC, created_at DESC
           LIMIT 50`,
          [userId]
        )
      : Promise.resolve({ rows: [] }),
    reg.has_payments
      ? pool.query(
          `SELECT id, method_type, provider, label, upi_id, card_last4, card_network, card_holder_name, is_default, created_at
           FROM user_payment_methods
           WHERE user_id = $1
           ORDER BY is_default DESC, created_at DESC`,
          [userId]
        )
      : Promise.resolve({ rows: [] }),
    reg.has_orders
      ? pool.query(
          `SELECT id, status, delivery_option, delivery_fee_inr, scheduled_for, created_at
           FROM orders
           WHERE user_id = $1
           ORDER BY created_at DESC
           LIMIT 10`,
          [userId]
        )
      : Promise.resolve({ rows: [] }),
  ]);

  if (!uRes.rows.length) return res.status(404).json({ error: "User not found" });

  let abha = { linked: false };
  try {
    await ensureAbhaSchema();
    const link = await loadAbhaLink(pool, userId);
    if (link) {
      abha = {
        linked: true,
        health_id_masked: link.health_id_masked,
        identifier_kind: link.identifier_kind,
        aadhaar_verified_at: link.aadhaar_verified_at,
        last_sync_at: link.last_sync_at,
      };
    }
  } catch {
    abha = { linked: false };
  }

  let diagnostic_reports = [];
  let diagnostic_reports_load_error = null;
  try {
    diagnostic_reports = await listDiagnosticReportsForUser(pool, userId);
  } catch (e) {
    console.error("PaxMed: listDiagnosticReportsForUser:", e?.message || e);
    diagnostic_reports_load_error =
      process.env.NODE_ENV === "production"
        ? "Could not load diagnostic reports (database issue). Confirm migrations ran against this DATABASE_URL."
        : String(e?.message || "Failed to load diagnostic reports").slice(0, 500);
  }

  const payload = {
    profile: uRes.rows[0],
    addresses: aRes.rows,
    payment_methods: pRes.rows,
    orders: oRes.rows,
    abha,
    diagnostic_reports,
  };
  if (diagnostic_reports_load_error) {
    payload.diagnostic_reports_load_error = diagnostic_reports_load_error;
  }
  return res.json(payload);
});

router.put("/basic", async (req, res) => {
  if (!requireConsumer(req, res)) return;
  await ensureProfileSchema();
  const userId = consumerDbUserId(req, res);
  if (userId == null) return;

  const full_name = cleanText(req.body?.full_name, 120);
  const email = cleanText(req.body?.email, 160)?.toLowerCase() || null;
  const genderRaw = cleanText(req.body?.gender, 40)?.toLowerCase() || null;
  const gender = ["male", "female", "other", "prefer_not_to_say"].includes(genderRaw) ? genderRaw : null;

  let date_of_birth = null;
  const dobRaw = cleanText(req.body?.date_of_birth, 12);
  if (dobRaw) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dobRaw)) {
      return res.status(400).json({ error: "date_of_birth must be YYYY-MM-DD" });
    }
    const t = Date.parse(`${dobRaw}T12:00:00Z`);
    if (!Number.isFinite(t)) return res.status(400).json({ error: "Invalid date_of_birth" });
    date_of_birth = dobRaw;
  }

  try {
    const { rows } = await pool.query(
      `UPDATE users
       SET full_name = $2,
           email = $3,
           gender = $4,
           date_of_birth = COALESCE($5::date, date_of_birth)
       WHERE id = $1
       RETURNING id, phone_e164, to_jsonb(users) ->> 'email' AS email, to_jsonb(users) ->> 'full_name' AS full_name, to_jsonb(users) ->> 'gender' AS gender, (users.date_of_birth)::text AS date_of_birth`,
      [userId, full_name, email, gender, date_of_birth]
    );
    try {
      await mergeAndPushAbhaForUser(pool, userId, {});
    } catch (e) {
      console.warn("ABHA push after profile basic update:", e?.message || e);
    }
    return res.json({ ok: true, profile: rows[0] });
  } catch (e) {
    if (e?.code === "23505") return res.status(409).json({ error: "Email already in use" });
    return res.status(500).json({ error: e?.message || "Update failed" });
  }
});

router.post("/addresses", async (req, res) => {
  if (!requireConsumer(req, res)) return;
  await ensureProfileSchema();
  const userId = consumerDbUserId(req, res);
  if (userId == null) return;
  const b = req.body || {};
  const address_line1 = cleanText(b.address_line1, 220);
  if (!address_line1) return res.status(400).json({ error: "address_line1 is required" });
  const isDefault = Boolean(b.is_default);

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    if (isDefault) {
      await client.query(`UPDATE user_addresses SET is_default = false WHERE user_id = $1`, [userId]);
    }
    const { rows } = await client.query(
      `INSERT INTO user_addresses
        (user_id, label, name, phone_e164, address_line1, address_line2, landmark, city, state, pincode, lat, lng, is_default, updated_at)
       VALUES
        ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13, now())
       RETURNING id, label, name, phone_e164, address_line1, address_line2, landmark, city, state, pincode, lat, lng, is_default, created_at`,
      [
        userId,
        cleanText(b.label, 60),
        cleanText(b.name, 100),
        cleanText(b.phone_e164, 30) || req.user.phone_e164 || null,
        address_line1,
        cleanText(b.address_line2, 220),
        cleanText(b.landmark, 120),
        cleanText(b.city, 80),
        cleanText(b.state, 80),
        cleanText(b.pincode, 12),
        b.lat != null ? Number(b.lat) : null,
        b.lng != null ? Number(b.lng) : null,
        isDefault,
      ]
    );
    await client.query("COMMIT");
    try {
      await mergeAndPushAbhaForUser(pool, userId, {});
    } catch (e) {
      console.warn("ABHA push after address save:", e?.message || e);
    }
    return res.status(201).json({ ok: true, address: rows[0] });
  } catch (e) {
    await client.query("ROLLBACK");
    return res.status(500).json({ error: e?.message || "Failed to save address" });
  } finally {
    client.release();
  }
});

router.post("/addresses/:id/default", async (req, res) => {
  if (!requireConsumer(req, res)) return;
  await ensureProfileSchema();
  const userId = consumerDbUserId(req, res);
  if (userId == null) return;
  const id = Number(req.params.id);
  if (!Number.isFinite(id) || id < 1) return res.status(400).json({ error: "Invalid address id" });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`UPDATE user_addresses SET is_default = false WHERE user_id = $1`, [userId]);
    const { rowCount } = await client.query(`UPDATE user_addresses SET is_default = true WHERE id = $1 AND user_id = $2`, [
      id,
      userId,
    ]);
    if (!rowCount) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Address not found" });
    }
    await client.query("COMMIT");
    try {
      await mergeAndPushAbhaForUser(pool, userId, {});
    } catch (e) {
      console.warn("ABHA push after default address change:", e?.message || e);
    }
    return res.json({ ok: true });
  } catch (e) {
    await client.query("ROLLBACK");
    return res.status(500).json({ error: e?.message || "Failed to set default address" });
  } finally {
    client.release();
  }
});

router.delete("/addresses/:id", async (req, res) => {
  if (!requireConsumer(req, res)) return;
  await ensureProfileSchema();
  const userId = consumerDbUserId(req, res);
  if (userId == null) return;
  const id = Number(req.params.id);
  if (!Number.isFinite(id) || id < 1) return res.status(400).json({ error: "Invalid address id" });
  const { rowCount } = await pool.query(`DELETE FROM user_addresses WHERE id = $1 AND user_id = $2`, [id, userId]);
  if (!rowCount) return res.status(404).json({ error: "Address not found" });
  return res.json({ ok: true });
});

router.put("/addresses/:id", async (req, res) => {
  if (!requireConsumer(req, res)) return;
  await ensureProfileSchema();
  const userId = consumerDbUserId(req, res);
  if (userId == null) return;
  const id = Number(req.params.id);
  if (!Number.isFinite(id) || id < 1) return res.status(400).json({ error: "Invalid address id" });

  const b = req.body || {};
  const address_line1 = cleanText(b.address_line1, 220);
  if (!address_line1) return res.status(400).json({ error: "address_line1 is required" });
  const isDefault = Boolean(b.is_default);

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const own = await client.query(`SELECT id, phone_e164 FROM user_addresses WHERE id = $1 AND user_id = $2 LIMIT 1`, [
      id,
      userId,
    ]);
    if (!own.rows.length) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Address not found" });
    }
    const prevPhone = own.rows[0].phone_e164;
    const nextPhone =
      Object.prototype.hasOwnProperty.call(req.body ?? {}, 'phone_e164')
        ? cleanText(b.phone_e164, 30) || null
        : prevPhone ?? null;

    if (isDefault) {
      await client.query(`UPDATE user_addresses SET is_default = false WHERE user_id = $1`, [userId]);
    }
    const { rows } = await client.query(
      `UPDATE user_addresses SET
         label = $3,
         name = $4,
         phone_e164 = $5,
         address_line1 = $6,
         address_line2 = $7,
         landmark = $8,
         city = $9,
         state = $10,
         pincode = $11,
         lat = $12,
         lng = $13,
         is_default = $14,
         updated_at = now()
       WHERE id = $1 AND user_id = $2
       RETURNING id, label, name, phone_e164, address_line1, address_line2, landmark, city, state, pincode, lat, lng, is_default, created_at`,
      [
        id,
        userId,
        cleanText(b.label, 60),
        cleanText(b.name, 100),
        nextPhone,
        address_line1,
        cleanText(b.address_line2, 220),
        cleanText(b.landmark, 120),
        cleanText(b.city, 80),
        cleanText(b.state, 80),
        cleanText(b.pincode, 12),
        b.lat != null ? Number(b.lat) : null,
        b.lng != null ? Number(b.lng) : null,
        isDefault,
      ]
    );
    await client.query("COMMIT");
    try {
      await mergeAndPushAbhaForUser(pool, userId, {});
    } catch (e) {
      console.warn("ABHA push after address update:", e?.message || e);
    }
    return res.json({ ok: true, address: rows[0] });
  } catch (e) {
    await client.query("ROLLBACK");
    return res.status(500).json({ error: e?.message || "Failed to update address" });
  } finally {
    client.release();
  }
});

router.post("/payment-methods", async (req, res) => {
  if (!requireConsumer(req, res)) return;
  await ensureProfileSchema();
  const userId = consumerDbUserId(req, res);
  if (userId == null) return;
  const b = req.body || {};
  const method_type = String(b.method_type || "").trim().toLowerCase();
  if (!["upi", "card"].includes(method_type)) {
    return res.status(400).json({ error: "method_type must be upi or card" });
  }
  const isDefault = Boolean(b.is_default);
  const provider = "razorpay";

  let upi_id = null;
  let card_last4 = null;
  let card_network = null;
  let card_holder_name = null;
  let label = cleanText(b.label, 80);

  if (method_type === "upi") {
    upi_id = cleanText(b.upi_id, 120);
    if (!upi_id || !/^[a-zA-Z0-9._-]{2,}@[a-zA-Z0-9.-]{2,}$/.test(upi_id)) {
      return res.status(400).json({ error: "Valid UPI ID is required (e.g. name@bank)" });
    }
    if (!label) label = "UPI";
  } else {
    card_last4 = String(b.card_last4 || "").replace(/\D/g, "").slice(-4);
    if (!/^\d{4}$/.test(card_last4)) {
      return res.status(400).json({ error: "card_last4 must be 4 digits" });
    }
    card_network = cleanText(b.card_network, 40);
    card_holder_name = cleanText(b.card_holder_name, 100);
    if (!label) label = "Card";
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    if (isDefault) {
      await client.query(`UPDATE user_payment_methods SET is_default = false WHERE user_id = $1`, [userId]);
    }
    const { rows } = await client.query(
      `INSERT INTO user_payment_methods
        (user_id, method_type, provider, label, upi_id, card_last4, card_network, card_holder_name, is_default, updated_at)
       VALUES
        ($1,$2,$3,$4,$5,$6,$7,$8,$9, now())
       RETURNING id, method_type, provider, label, upi_id, card_last4, card_network, card_holder_name, is_default, created_at`,
      [userId, method_type, provider, label, upi_id, card_last4, card_network, card_holder_name, isDefault]
    );
    await client.query("COMMIT");
    return res.status(201).json({ ok: true, payment_method: rows[0] });
  } catch (e) {
    await client.query("ROLLBACK");
    return res.status(500).json({ error: e?.message || "Failed to save payment method" });
  } finally {
    client.release();
  }
});

router.put("/payment-methods/:id", async (req, res) => {
  if (!requireConsumer(req, res)) return;
  await ensureProfileSchema();
  const userId = consumerDbUserId(req, res);
  if (userId == null) return;
  const id = Number(req.params.id);
  if (!Number.isFinite(id) || id < 1) return res.status(400).json({ error: "Invalid payment method id" });

  const b = req.body || {};
  const sel = await pool.query(`SELECT id, method_type, label, upi_id, card_last4, card_network, card_holder_name, is_default FROM user_payment_methods WHERE id = $1 AND user_id = $2`, [
    id,
    userId,
  ]);
  if (!sel.rows.length) return res.status(404).json({ error: "Payment method not found" });
  const cur = sel.rows[0];

  let label = b.label !== undefined ? cleanText(b.label, 80) : cur.label;
  let upiId = cur.upi_id;
  let cardLast4 = cur.card_last4;
  let cardNetwork = cur.card_network;
  let cardHolderName = cur.card_holder_name;

  const upiRegex = /^[a-zA-Z0-9._-]{2,}@[a-zA-Z0-9.-]{2,}$/;

  if (cur.method_type === "upi") {
    if (b.upi_id !== undefined) {
      upiId = cleanText(b.upi_id, 120);
      if (!upiId || !upiRegex.test(upiId)) {
        return res.status(400).json({ error: "Valid UPI ID is required (e.g. name@bank)" });
      }
    }
    if (!label) label = "UPI";
  } else if (cur.method_type === "card") {
    if (b.card_last4 !== undefined) {
      cardLast4 = String(b.card_last4 || "").replace(/\D/g, "").slice(-4);
      if (!/^\d{4}$/.test(cardLast4)) {
        return res.status(400).json({ error: "card_last4 must be 4 digits" });
      }
    }
    if (b.card_network !== undefined) cardNetwork = cleanText(b.card_network, 40);
    if (b.card_holder_name !== undefined) cardHolderName = cleanText(b.card_holder_name, 100);
    if (!label) label = "Card";
  } else {
    return res.status(400).json({ error: "Unknown payment method type" });
  }

  let isDefault = cur.is_default;
  if (b.is_default !== undefined && b.is_default !== null) {
    isDefault = Boolean(b.is_default);
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    if (isDefault) {
      await client.query(`UPDATE user_payment_methods SET is_default = false WHERE user_id = $1`, [userId]);
    }
    const { rows } = await client.query(
      `UPDATE user_payment_methods
       SET label = $1,
           upi_id = $2,
           card_last4 = $3,
           card_network = $4,
           card_holder_name = $5,
           is_default = $6,
           updated_at = now()
       WHERE id = $7 AND user_id = $8
       RETURNING id, method_type, provider, label, upi_id, card_last4, card_network, card_holder_name, is_default, created_at`,
      [label, upiId, cardLast4, cardNetwork, cardHolderName, isDefault, id, userId]
    );
    if (!rows.length) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Payment method not found" });
    }
    await client.query("COMMIT");
    return res.json({ ok: true, payment_method: rows[0] });
  } catch (e) {
    await client.query("ROLLBACK");
    return res.status(500).json({ error: e?.message || "Failed to update payment method" });
  } finally {
    client.release();
  }
});

router.post("/payment-methods/:id/default", async (req, res) => {
  if (!requireConsumer(req, res)) return;
  await ensureProfileSchema();
  const userId = consumerDbUserId(req, res);
  if (userId == null) return;
  const id = Number(req.params.id);
  if (!Number.isFinite(id) || id < 1) return res.status(400).json({ error: "Invalid payment method id" });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`UPDATE user_payment_methods SET is_default = false WHERE user_id = $1`, [userId]);
    const { rowCount } = await client.query(`UPDATE user_payment_methods SET is_default = true WHERE id = $1 AND user_id = $2`, [
      id,
      userId,
    ]);
    if (!rowCount) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Payment method not found" });
    }
    await client.query("COMMIT");
    return res.json({ ok: true });
  } catch (e) {
    await client.query("ROLLBACK");
    return res.status(500).json({ error: e?.message || "Failed to set default payment method" });
  } finally {
    client.release();
  }
});

router.delete("/payment-methods/:id", async (req, res) => {
  if (!requireConsumer(req, res)) return;
  await ensureProfileSchema();
  const userId = consumerDbUserId(req, res);
  if (userId == null) return;
  const id = Number(req.params.id);
  if (!Number.isFinite(id) || id < 1) return res.status(400).json({ error: "Invalid payment method id" });
  const { rowCount } = await pool.query(`DELETE FROM user_payment_methods WHERE id = $1 AND user_id = $2`, [id, userId]);
  if (!rowCount) return res.status(404).json({ error: "Payment method not found" });
  return res.json({ ok: true });
});

export default router;

