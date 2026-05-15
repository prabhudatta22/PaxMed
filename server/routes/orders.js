import { Router } from "express";
import { pool } from "../db/pool.js";
import { requireUser } from "../auth/middleware.js";
import { sendTextMessage, isWhatsappConfigured } from "../integrations/whatsappCloud.js";
import {
  createPartnerDiagnosticsBooking,
  getPartnerBookingStatus,
  isDiagnosticsPartnerEnabled,
  toPartnerCallingNumber,
} from "../integrations/diagnosticsPartner.js";
import {
  assertCapturedDiagnosticsPayment,
  isRazorpayConfigured,
} from "../payments/razorpayClient.js";
import { syncDiagnosticsReportForOrder } from "../diagnostics/partnerReportSync.js";

const router = Router();
router.use(requireUser);
let ordersSchemaReadyPromise = null;

async function ensureOrdersSchema() {
  if (ordersSchemaReadyPromise) return ordersSchemaReadyPromise;
  ordersSchemaReadyPromise = (async () => {
    await pool.query(
      `CREATE TABLE IF NOT EXISTS user_addresses (
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
         updated_at TIMESTAMPTZ,
         is_default BOOLEAN NOT NULL DEFAULT false
       );

       CREATE INDEX IF NOT EXISTS idx_user_addresses_user ON user_addresses (user_id, created_at DESC);

       CREATE TABLE IF NOT EXISTS orders (
         id SERIAL PRIMARY KEY,
         user_id INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
         order_kind TEXT NOT NULL DEFAULT 'medicine',
         status TEXT NOT NULL DEFAULT 'created' CHECK (status IN ('created','confirmed','packed','out_for_delivery','delivered','cancelled')),
         delivery_option TEXT NOT NULL DEFAULT 'normal' CHECK (delivery_option IN ('express_60','express_4_6','same_day','normal')),
         delivery_fee_inr NUMERIC(12, 2) NOT NULL DEFAULT 0 CHECK (delivery_fee_inr >= 0),
         scheduled_for TIMESTAMPTZ,
         address_id INTEGER REFERENCES user_addresses (id) ON DELETE SET NULL,
         provider_name TEXT,
         provider_order_ref TEXT,
         provider_payload JSONB,
         notes TEXT,
         created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
         updated_at TIMESTAMPTZ
       );

       CREATE INDEX IF NOT EXISTS idx_orders_user_created ON orders (user_id, created_at DESC);
       CREATE INDEX IF NOT EXISTS idx_orders_status ON orders (status, created_at DESC);

       CREATE TABLE IF NOT EXISTS order_items (
         id SERIAL PRIMARY KEY,
         order_id INTEGER NOT NULL REFERENCES orders (id) ON DELETE CASCADE,
         source TEXT NOT NULL DEFAULT 'local' CHECK (source IN ('local','online','catalog')),
         pharmacy_id INTEGER REFERENCES pharmacies (id) ON DELETE SET NULL,
         medicine_id INTEGER REFERENCES medicines (id) ON DELETE SET NULL,
         item_label TEXT NOT NULL,
         strength TEXT,
         form TEXT,
         pack_size INTEGER,
         quantity_units INTEGER NOT NULL DEFAULT 1 CHECK (quantity_units >= 1),
         tablets_per_day NUMERIC(8, 2),
         provider_item_ref TEXT,
         item_meta JSONB,
         unit_price_inr NUMERIC(12, 2) NOT NULL DEFAULT 0 CHECK (unit_price_inr >= 0),
         mrp_inr NUMERIC(12, 2),
         created_at TIMESTAMPTZ NOT NULL DEFAULT now()
       );

       CREATE INDEX IF NOT EXISTS idx_order_items_order ON order_items (order_id);

       CREATE TABLE IF NOT EXISTS order_events (
         id SERIAL PRIMARY KEY,
         order_id INTEGER NOT NULL REFERENCES orders (id) ON DELETE CASCADE,
         status TEXT NOT NULL,
         message TEXT,
         created_at TIMESTAMPTZ NOT NULL DEFAULT now()
       );

       CREATE INDEX IF NOT EXISTS idx_order_events_order ON order_events (order_id, created_at ASC);

       ALTER TABLE purchase_reminders
         ADD COLUMN IF NOT EXISTS order_id INTEGER REFERENCES orders (id) ON DELETE SET NULL;

       ALTER TABLE orders ADD COLUMN IF NOT EXISTS order_kind TEXT NOT NULL DEFAULT 'medicine';
       ALTER TABLE orders ADD COLUMN IF NOT EXISTS provider_name TEXT;
       ALTER TABLE orders ADD COLUMN IF NOT EXISTS provider_order_ref TEXT;
       ALTER TABLE orders ADD COLUMN IF NOT EXISTS provider_payload JSONB;
       ALTER TABLE order_items ADD COLUMN IF NOT EXISTS provider_item_ref TEXT;
       ALTER TABLE order_items ADD COLUMN IF NOT EXISTS item_meta JSONB;

       CREATE TABLE IF NOT EXISTS user_prescriptions (
         id SERIAL PRIMARY KEY,
         user_id INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
         storage_key TEXT NOT NULL UNIQUE,
         original_filename TEXT,
         mime_type TEXT NOT NULL,
         byte_size INTEGER NOT NULL CHECK (byte_size > 0 AND byte_size <= 10485760),
         source TEXT NOT NULL DEFAULT 'web' CHECK (source IN ('web','whatsapp')),
         ocr_preview TEXT,
         created_at TIMESTAMPTZ NOT NULL DEFAULT now()
       );

       CREATE INDEX IF NOT EXISTS idx_user_prescriptions_user_created
         ON user_prescriptions (user_id, created_at DESC);

       ALTER TABLE carts ADD COLUMN IF NOT EXISTS prescription_id INTEGER REFERENCES user_prescriptions (id) ON DELETE SET NULL;
       ALTER TABLE orders ADD COLUMN IF NOT EXISTS prescription_id INTEGER REFERENCES user_prescriptions (id) ON DELETE RESTRICT;

       ALTER TABLE orders ADD COLUMN IF NOT EXISTS razorpay_order_id TEXT;
       ALTER TABLE orders ADD COLUMN IF NOT EXISTS razorpay_payment_id TEXT;
       ALTER TABLE orders ADD COLUMN IF NOT EXISTS payment_status TEXT;
       ALTER TABLE orders ADD COLUMN IF NOT EXISTS razorpay_reconciled_at TIMESTAMPTZ;

       CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_razorpay_payment_unique
         ON orders (razorpay_payment_id)
         WHERE razorpay_payment_id IS NOT NULL AND btrim(razorpay_payment_id) <> '';

       CREATE TABLE IF NOT EXISTS razorpay_webhook_events (
         id BIGSERIAL PRIMARY KEY,
         razorpay_event_id TEXT NOT NULL UNIQUE,
         event_type TEXT NOT NULL,
         payment_id TEXT,
         order_entity_id TEXT,
         payload_json JSONB NOT NULL,
         processed_ok BOOLEAN NOT NULL DEFAULT false,
         order_link_id INTEGER REFERENCES orders (id) ON DELETE SET NULL,
         error_message TEXT,
         created_at TIMESTAMPTZ NOT NULL DEFAULT now()
       );

       CREATE INDEX IF NOT EXISTS idx_rz_wh_payment ON razorpay_webhook_events (payment_id);
       CREATE INDEX IF NOT EXISTS idx_rz_wh_created ON razorpay_webhook_events (created_at DESC);

       CREATE TABLE IF NOT EXISTS razorpay_order_refunds (
         id SERIAL PRIMARY KEY,
         order_id INTEGER NOT NULL REFERENCES orders (id) ON DELETE CASCADE,
         razorpay_refund_id TEXT NOT NULL UNIQUE,
         amount_paise INTEGER NOT NULL CHECK (amount_paise > 0),
         status TEXT,
         raw_json JSONB,
         created_at TIMESTAMPTZ NOT NULL DEFAULT now()
       );

       CREATE INDEX IF NOT EXISTS idx_rz_refunds_order ON razorpay_order_refunds (order_id, created_at DESC);`
    );
  })().catch((e) => {
    ordersSchemaReadyPromise = null;
    throw e;
  });
  return ordersSchemaReadyPromise;
}

function nowPlusMinutes(min) {
  return new Date(Date.now() + min * 60_000);
}

async function resolvePrescriptionId(poolConn, userId, body) {
  const rawPresc = body?.prescription_id ?? body?.prescriptionId;
  if (rawPresc == null || rawPresc === "") return null;
  const p = Number(rawPresc);
  if (!Number.isFinite(p) || p < 1) throw new Error("Invalid prescription_id");
  const pr = await poolConn.query(
    `SELECT id FROM user_prescriptions WHERE id = $1 AND user_id = $2 LIMIT 1`,
    [p, userId]
  );
  if (!pr.rows.length) throw new Error("Prescription not found for your account");
  return p;
}

function quoteDelivery(delivery_option) {
  const opt = String(delivery_option || "normal");
  switch (opt) {
    case "express_60":
      return { delivery_option: opt, fee_inr: 49, scheduled_for: nowPlusMinutes(60) };
    case "express_4_6":
      return { delivery_option: opt, fee_inr: 29, scheduled_for: nowPlusMinutes(5 * 60) };
    case "same_day":
      return { delivery_option: opt, fee_inr: 19, scheduled_for: nowPlusMinutes(8 * 60) };
    case "normal":
    default:
      return { delivery_option: "normal", fee_inr: 0, scheduled_for: nowPlusMinutes(24 * 60) };
  }
}

function toWaIdFromE164(phone_e164) {
  const d = String(phone_e164 || "").replace(/[^\d]/g, "");
  return d || null;
}

function normalizeGender(g) {
  const x = String(g || "").trim().toLowerCase();
  if (x === "male" || x === "m") return "male";
  if (x === "female" || x === "f") return "female";
  return "other";
}

function parseScheduledFor(value) {
  if (!value) return null;
  const d = new Date(String(value));
  if (Number.isNaN(d.getTime())) return null;
  return d;
}

function normalizeDiagnosticsPackages(body) {
  const defaultVendorKey = String(body?.vendor_key || "").trim().toLowerCase();
  const raw = Array.isArray(body?.packages) && body.packages.length
    ? body.packages
    : [
        {
          package_id: body?.package_id || body?.id || "",
          deal_id: body?.deal_id || body?.package_id || body?.id || "",
          package_name: body?.package_name || body?.heading || "",
          city: body?.city || "",
          price_inr: body?.price_inr,
          mrp_inr: body?.mrp_inr,
          vendor_key: body?.vendor_key,
        },
      ];
  const out = [];
  for (const p of raw) {
    const packageId = String(p?.package_id || p?.id || "").trim();
    const dealId = String(p?.deal_id || packageId).trim();
    const packageName = String(p?.package_name || p?.heading || "").trim();
    const city = String(p?.city || body?.city || "").trim().toLowerCase();
    const priceInr = Number(p?.price_inr);
    const mrpInr = p?.mrp_inr == null || p?.mrp_inr === "" ? null : Number(p.mrp_inr);
    const vendorKeyRaw = String(p?.vendor_key || defaultVendorKey || "").trim().toLowerCase();
    if (!packageId || !dealId || !packageName || !city || !Number.isFinite(priceInr) || priceInr <= 0) {
      throw new Error("Each package needs package_id, deal_id, package_name, city, and valid price_inr");
    }
    out.push({
      package_id: packageId,
      deal_id: dealId,
      package_name: packageName,
      city,
      price_inr: priceInr,
      mrp_inr: Number.isFinite(mrpInr) ? mrpInr : null,
      vendor_key: vendorKeyRaw || "",
    });
  }
  return out;
}

/** Uses Healthians B2B APIs only when every line is Partner Healthians SKU (missing vendor_key = legacy client, treated as Healthians). */
function useHealthiansPartnerApiForPackages(partnerEnabled, packages) {
  if (!partnerEnabled) return false;
  for (const p of packages) {
    const vk = String(p?.vendor_key || "").trim().toLowerCase();
    if (vk && vk !== "healthians") return false;
  }
  return true;
}

function storedDiagnosticsProviderName(usePartnerApi, primaryVendorKey) {
  if (usePartnerApi) return "healthians";
  const v = String(primaryVendorKey || "").trim().toLowerCase().replace(/_/g, "-");
  return v || "paxmed-local";
}

function sanitizePaymentMeta(meta) {
  if (!meta || typeof meta !== "object") return null;
  const method = String(meta.method || "").trim().toLowerCase();
  if (method === "upi") {
    const upi = String(meta.upi_id || "").trim();
    if (!upi) return { method: "upi" };
    const [left, right] = upi.split("@");
    const masked = left ? `${left.slice(0, 2)}***@${right || "upi"}` : "upi";
    return { method: "upi", upi_masked: masked };
  }
  if (method === "card") {
    const last4 = String(meta.card_last4 || "").replace(/\D/g, "").slice(-4);
    return {
      method: "card",
      card_last4: last4 || "****",
      card_network: String(meta.card_network || "CARD").slice(0, 16),
      card_holder_name: String(meta.card_holder_name || "").slice(0, 80),
    };
  }
  return { method: "unknown" };
}

async function createDiagnosticReminder({ client, userId, orderId, packageName, scheduledFor }) {
  const now = Date.now();
  const at = new Date(scheduledFor).getTime();
  if (!Number.isFinite(at) || at <= now + 15 * 60_000) return null;
  let remindAt = at - 24 * 60 * 60_000;
  if (remindAt <= now + 10 * 60_000) remindAt = at - 2 * 60 * 60_000;
  if (remindAt <= now + 10 * 60_000) remindAt = at - 30 * 60_000;
  if (remindAt <= now + 5 * 60_000) return null;

  const label = `Diagnostic appointment · ${String(packageName || "Package").slice(0, 160)}`;
  const note = `Auto reminder for order #${orderId} scheduled sample collection`;
  await client.query(
    `INSERT INTO purchase_reminders (user_id, medicine_id, medicine_label, remind_at, repeat_interval_days, notes, order_id)
     VALUES ($1, NULL, $2, $3, NULL, $4, $5)`,
    [userId, label, new Date(remindAt).toISOString(), note, orderId]
  );
  return new Date(remindAt).toISOString();
}

async function loadBookingAddress({ userId, addressId }) {
  if (addressId) {
    const fromId = await pool.query(
      `SELECT id, address_line1, address_line2, landmark, city, state, pincode, lat, lng
       FROM user_addresses
       WHERE id = $1 AND user_id = $2
       LIMIT 1`,
      [addressId, userId]
    );
    if (fromId.rows.length) return fromId.rows[0];
  }
  const fallback = await pool.query(
    `SELECT id, address_line1, address_line2, landmark, city, state, pincode, lat, lng
     FROM user_addresses
     WHERE user_id = $1
     ORDER BY is_default DESC, created_at DESC
     LIMIT 1`,
    [userId]
  );
  return fallback.rows[0] || null;
}

function hasCompleteCollectionAddress(addr) {
  if (!addr) return false;
  const line = String(addr.address_line1 || "").trim();
  const pin = String(addr.pincode || "").replace(/\D/g, "");
  return Boolean(line && pin.length === 6);
}

/**
 * When Profile has no saved address but the Diagnostics page sends a pincode from the finder form,
 * create a minimal pickup row so home-collection booking can complete.
 */
async function ensureDiagnosticsAddressFromLabsForm(pool, userId, body, citySlug) {
  const pin = String(body?.collection_pincode ?? "").replace(/\D/g, "").slice(0, 6);
  if (!/^\d{6}$/.test(pin)) return null;
  const line1 =
    String(body?.collection_address_line1 || "").trim().slice(0, 200) || "Home collection";
  const city = String(citySlug || "").trim().toLowerCase();
  const { rows: cntRows } = await pool.query(`SELECT COUNT(*)::int AS c FROM user_addresses WHERE user_id = $1`, [
    userId,
  ]);
  const makeDefault = (cntRows[0]?.c || 0) === 0;
  const ins = await pool.query(
    `INSERT INTO user_addresses (user_id, label, address_line1, city, state, pincode, is_default, updated_at)
     VALUES ($1, 'Diagnostics', $2, $3, '', $4, $5, now())
     RETURNING id, address_line1, address_line2, landmark, city, state, pincode, lat, lng`,
    [userId, line1, city, pin, makeDefault]
  );
  return ins.rows[0] || null;
}

async function maybeNotifyWhatsapp({ userPhoneE164, text }) {
  if (!isWhatsappConfigured()) return;
  const wa = toWaIdFromE164(userPhoneE164);
  if (!wa) return;
  await sendTextMessage({ toWaId: wa, text }).catch(() => {});
}

router.post("/", async (req, res) => {
  await ensureOrdersSchema();
  const userId = req.user.id;
  const role = req.user.role;
  if (role === "service_provider") return res.status(403).json({ error: "Service provider cannot place consumer orders" });

  const items = Array.isArray(req.body?.items) ? req.body.items : [];
  if (!items.length) return res.status(400).json({ error: "items[] is required" });

  // MVP: only allow local items for home delivery
  const nonLocal = items.find((i) => String(i.source || "local") !== "local");
  if (nonLocal) {
    return res.status(400).json({ error: "Only local pharmacy items can be ordered for delivery (for now)." });
  }

  const addr = req.body?.address || {};
  const address_line1 = String(addr.address_line1 || "").trim().slice(0, 200);
  if (!address_line1) return res.status(400).json({ error: "address.address_line1 is required" });

  let prescriptionId = null;
  try {
    prescriptionId = await resolvePrescriptionId(pool, userId, req.body);
  } catch (e) {
    return res.status(400).json({ error: e?.message || "Invalid prescription" });
  }

  const delivery_option = String(req.body?.delivery_option || "normal");
  const q = quoteDelivery(delivery_option);

  let itemsSubtotalPaise = 0;
  for (const it of items) {
    const pharmacy_id = Number(it.pharmacyId);
    const medicine_id = Number(it.medicineId);
    const quantity_units = Math.max(1, Math.floor(Number(it.quantity || it.quantity_units || 1)));
    const item_label = String(it.medicineLabel || it.item_label || "").trim().slice(0, 200);

    if (!Number.isFinite(pharmacy_id) || pharmacy_id < 1) {
      return res.status(400).json({ error: "Invalid pharmacyId in items[]" });
    }
    if (!Number.isFinite(medicine_id) || medicine_id < 1) {
      return res.status(400).json({ error: "Invalid medicineId in items[]" });
    }
    if (!item_label) {
      return res.status(400).json({ error: "item_label/medicineLabel required" });
    }
    const unit = Number(it.unitPriceInr || it.unit_price_inr || 0) || 0;
    itemsSubtotalPaise += Math.round(unit * 100 * quantity_units);
  }

  const feePaise = Math.round(Number(q.fee_inr) * 100);
  const totalPaise = itemsSubtotalPaise + feePaise;

  const paymentType = String(req.body?.payment_type || "cod").trim().toLowerCase() === "prepaid" ? "prepaid" : "cod";
  if (paymentType === "prepaid") {
    if (totalPaise < 100) {
      return res.status(400).json({ error: "Order total must be at least ₹1 for online payment." });
    }
  } else if (totalPaise <= 0) {
    return res.status(400).json({ error: "Order total must be greater than ₹0 for cash on delivery." });
  }

  let paymentMeta = null;
  if (paymentType === "prepaid") {
    const rzOrder = String(req.body?.razorpay_order_id || "").trim();
    const rzPay = String(req.body?.razorpay_payment_id || "").trim();
    const rzSig = String(req.body?.razorpay_signature || "").trim();
    if (!rzOrder || !rzPay || !rzSig) {
      return res.status(400).json({
        error:
          "Prepaid requires Razorpay checkout: pay first, then the app sends razorpay_order_id, razorpay_payment_id, and razorpay_signature.",
      });
    }
    if (!isRazorpayConfigured()) {
      return res.status(400).json({ error: "Razorpay is not configured — choose Cash on delivery." });
    }
    try {
      await assertCapturedDiagnosticsPayment({
        razorpayOrderId: rzOrder,
        razorpayPaymentId: rzPay,
        razorpaySignature: rzSig,
        expectedAmountPaise: totalPaise,
      });
      paymentMeta = {
        razorpay_order_id: rzOrder,
        razorpay_payment_id: rzPay,
        razorpay_signature: rzSig,
      };
    } catch (e) {
      return res.status(400).json({ error: e?.message || "Razorpay payment verification failed" });
    }
  }

  let dbPaymentStatus = paymentType === "prepaid" && paymentMeta ? "prepaid_verified" : "cod";

  const rzPaymentDupCheck = paymentMeta?.razorpay_payment_id ? String(paymentMeta.razorpay_payment_id).trim() : "";
  if (rzPaymentDupCheck) {
    const dup = await pool.query(`SELECT id FROM orders WHERE razorpay_payment_id = $1 LIMIT 1`, [rzPaymentDupCheck]);
    if (dup.rows.length) {
      return res.status(409).json({ error: "This Razorpay payment is already linked to an order." });
    }
  }

  const rzOrderIdForInsert = paymentMeta?.razorpay_order_id ? String(paymentMeta.razorpay_order_id).trim() : null;
  const rzPaymentIdForInsert = paymentMeta?.razorpay_payment_id ? String(paymentMeta.razorpay_payment_id).trim() : null;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const addrRes = await client.query(
      `INSERT INTO user_addresses (user_id, label, name, phone_e164, address_line1, address_line2, landmark, city, state, pincode, lat, lng, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12, now())
       RETURNING id`,
      [
        userId,
        addr.label ? String(addr.label).trim().slice(0, 60) : null,
        addr.name ? String(addr.name).trim().slice(0, 80) : null,
        addr.phone_e164 ? String(addr.phone_e164).trim().slice(0, 30) : req.user.phone_e164 || null,
        address_line1,
        addr.address_line2 ? String(addr.address_line2).trim().slice(0, 200) : null,
        addr.landmark ? String(addr.landmark).trim().slice(0, 120) : null,
        addr.city ? String(addr.city).trim().slice(0, 80) : null,
        addr.state ? String(addr.state).trim().slice(0, 80) : null,
        addr.pincode ? String(addr.pincode).trim().slice(0, 12) : null,
        addr.lat != null ? Number(addr.lat) : null,
        addr.lng != null ? Number(addr.lng) : null,
      ]
    );

    let order;
    try {
      const orderRes = await client.query(
      `INSERT INTO orders (user_id, status, delivery_option, delivery_fee_inr, scheduled_for, address_id, notes, prescription_id, razorpay_order_id, razorpay_payment_id, payment_status, updated_at)
       VALUES ($1,'created',$2,$3,$4,$5,$6,$7,$8,$9,$10, now())
       RETURNING id, status, delivery_option, delivery_fee_inr, scheduled_for, created_at, prescription_id, razorpay_order_id, razorpay_payment_id, payment_status`,
      [
        userId,
        q.delivery_option,
        q.fee_inr,
        q.scheduled_for.toISOString(),
        addrRes.rows[0].id,
        req.body?.notes ? String(req.body.notes).trim().slice(0, 500) : null,
        prescriptionId,
        rzOrderIdForInsert,
        rzPaymentIdForInsert,
        dbPaymentStatus,
      ]
    );
      order = orderRes.rows[0];
    } catch (e) {
      if (e && e.code === "23505") {
        await client.query("ROLLBACK");
        return res.status(409).json({ error: "This Razorpay payment is already linked to an order." });
      }
      throw e;
    }

    await client.query(
      `INSERT INTO order_events (order_id, status, message)
       VALUES ($1,$2,$3)`,
      [
        order.id,
        "created",
        paymentType === "prepaid"
          ? "Order created · prepaid verified"
          : "Order created · pay on delivery",
      ]
    );

    for (const it of items) {
      const pharmacy_id = Number(it.pharmacyId);
      const medicine_id = Number(it.medicineId);
      const quantity_units = Math.max(1, Math.floor(Number(it.quantity || it.quantity_units || 1)));
      const tablets_per_day =
        it.tablets_per_day == null || it.tablets_per_day === ""
          ? null
          : Number(it.tablets_per_day);

      if (!Number.isFinite(pharmacy_id) || pharmacy_id < 1) throw new Error("Invalid pharmacyId in items[]");
      if (!Number.isFinite(medicine_id) || medicine_id < 1) throw new Error("Invalid medicineId in items[]");

      const item_label = String(it.medicineLabel || it.item_label || "").trim().slice(0, 200);
      if (!item_label) throw new Error("item_label/medicineLabel required");

      await client.query(
        `INSERT INTO order_items
           (order_id, source, pharmacy_id, medicine_id, item_label, strength, form, pack_size, quantity_units, tablets_per_day, unit_price_inr, mrp_inr)
         VALUES
           ($1,'local',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [
          order.id,
          pharmacy_id,
          medicine_id,
          item_label,
          it.strength ? String(it.strength).trim().slice(0, 80) : null,
          it.form ? String(it.form).trim().slice(0, 40) : null,
          it.pack_size != null ? Number(it.pack_size) : null,
          quantity_units,
          tablets_per_day,
          Number(it.unitPriceInr || it.unit_price_inr || 0) || 0,
          it.mrpInr != null ? Number(it.mrpInr) : it.mrp_inr != null ? Number(it.mrp_inr) : null,
        ]
      );
    }

    await client.query("COMMIT");

    // WhatsApp: push initial status
    await maybeNotifyWhatsapp({
      userPhoneE164: req.user.phone_e164,
      text:
        paymentType === "prepaid"
          ? `PaxMed: Order #${order.id} placed · prepaid ✓ (${order.payment_status}). Delivery: ${order.delivery_option}.`
          : `PaxMed: Order #${order.id} placed (${order.payment_status}). Status: ${order.status}. Delivery option: ${order.delivery_option}.`,
    });

    res.status(201).json({
      ok: true,
      order: {
        ...order,
        payment_type: paymentType,
      },
    });
  } catch (e) {
    await client.query("ROLLBACK");
    res.status(500).json({ ok: false, error: e.message });
  } finally {
    client.release();
  }
});

router.get("/", async (req, res) => {
  await ensureOrdersSchema();
  const userId = req.user.id;
  const { rows } = await pool.query(
    `SELECT id, order_kind, status, delivery_option, delivery_fee_inr, scheduled_for, provider_name, provider_order_ref, notes, created_at, updated_at
     FROM orders
     WHERE user_id = $1
     ORDER BY created_at DESC
     LIMIT 10`,
    [userId]
  );
  res.json({ orders: rows });
});

router.post("/diagnostics", async (req, res) => {
  await ensureOrdersSchema();
  const userId = req.user.id;
  const role = req.user.role;
  if (role === "service_provider") return res.status(403).json({ error: "Service provider cannot place consumer orders" });

  let packages;
  try {
    packages = normalizeDiagnosticsPackages(req.body || {});
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }
  const primary = packages[0];
  const packageId = primary.package_id;
  const packageName = primary.package_name;
  const city = primary.city;
  const partnerEnabled = isDiagnosticsPartnerEnabled();
  const priceInr = Number(primary.price_inr);
  const paymentType = String(req.body?.payment_type || "cod").trim().toLowerCase() === "prepaid" ? "prepaid" : "cod";
  const addressId = Number(req.body?.address_id);
  const requestedSchedule = parseScheduledFor(req.body?.scheduled_for);
  if (!requestedSchedule) return res.status(400).json({ error: "scheduled_for is required and must be a valid future date" });
  if (requestedSchedule.getTime() < Date.now() + 10 * 60_000) {
    return res.status(400).json({ error: "scheduled_for must be in the future" });
  }
  const maxSchedule = Date.now() + 30 * 24 * 60 * 60_000;
  if (requestedSchedule.getTime() > maxSchedule) {
    return res.status(400).json({ error: "scheduled_for can be at most 30 days in advance" });
  }

  if (!packageId || !packageName) return res.status(400).json({ error: "package_id and package_name are required" });
  if (!city) return res.status(400).json({ error: "city is required" });
  if (!Number.isFinite(priceInr) || priceInr <= 0) return res.status(400).json({ error: "price_inr must be greater than 0" });

  const totalPaise = packages.reduce((sum, p) => sum + Math.round(Number(p.price_inr) * 100), 0);
  let paymentMeta = null;
  if (paymentType === "prepaid") {
    const rzOrder = String(req.body?.razorpay_order_id || "").trim();
    const rzPay = String(req.body?.razorpay_payment_id || "").trim();
    const rzSig = String(req.body?.razorpay_signature || "").trim();
    if (rzOrder && rzPay && rzSig) {
      try {
        await assertCapturedDiagnosticsPayment({
          razorpayOrderId: rzOrder,
          razorpayPaymentId: rzPay,
          razorpaySignature: rzSig,
          expectedAmountPaise: totalPaise,
        });
        paymentMeta = {
          provider: "razorpay",
          razorpay_order_id: rzOrder,
          razorpay_payment_id: rzPay,
          verified: true,
        };
      } catch (e) {
        return res.status(400).json({ error: e?.message || "Razorpay payment verification failed" });
      }
    } else if (isRazorpayConfigured()) {
      return res.status(400).json({
        error: "Prepaid requires Razorpay checkout: send razorpay_order_id, razorpay_payment_id, and razorpay_signature after payment.",
      });
    } else {
      paymentMeta = sanitizePaymentMeta(req.body?.payment_meta);
      if (!paymentMeta) {
        return res.status(400).json({ error: "payment_meta is required for prepaid booking (or configure Razorpay)" });
      }
    }
  }

  let dbPaymentStatus = "cod";
  if (paymentType === "prepaid") {
    dbPaymentStatus = paymentMeta ? "prepaid_verified" : "cod";
  }

  const rzPaymentDupCheck = paymentMeta?.razorpay_payment_id
    ? String(paymentMeta.razorpay_payment_id).trim()
    : "";
  if (rzPaymentDupCheck) {
    const dup = await pool.query(`SELECT id FROM orders WHERE razorpay_payment_id = $1 LIMIT 1`, [
      rzPaymentDupCheck,
    ]);
    if (dup.rows.length) {
      return res.status(409).json({ error: "This Razorpay payment is already linked to an order." });
    }
  }

  const address = await loadBookingAddress({
    userId,
    addressId: Number.isFinite(addressId) && addressId > 0 ? addressId : null,
  });
  let bookingAddress = hasCompleteCollectionAddress(address)
    ? address
    : await ensureDiagnosticsAddressFromLabsForm(pool, userId, req.body, primary.city);
  if (!hasCompleteCollectionAddress(bookingAddress)) {
    return res.status(400).json({
      error:
        "Enter a 6-digit pincode on the Diagnostics page (Pickup pincode field) or add a saved address with pincode under Profile before booking.",
    });
  }

  const patient = req.body?.patient || {};
  const patientName = String(patient.name || req.user.full_name || "").trim();
  const patientAge = Number(patient.age || 30);
  const patientGender = normalizeGender(patient.gender || req.user.gender);
  const patientPhoneRaw = String(patient.phone || req.user.phone_e164 || "").trim();
  const patientPhone = toPartnerCallingNumber(patientPhoneRaw);
  const patientEmail = String(patient.email || req.user.email || "").trim();
  if (!patientName || !/^\d{10}$/.test(patientPhone)) {
    return res.status(400).json({
      error:
        "Patient name and a valid 10-digit Indian mobile are required. Add your phone under Profile (or OTP login) before booking COD/prepaid.",
    });
  }

  let diagPrescriptionId = null;
  try {
    diagPrescriptionId = await resolvePrescriptionId(pool, userId, req.body);
  } catch (e) {
    return res.status(400).json({ error: e?.message || "Invalid prescription" });
  }

  const usePartnerApi = useHealthiansPartnerApiForPackages(partnerEnabled, packages);
  const storedProviderName = storedDiagnosticsProviderName(usePartnerApi, primary.vendor_key);

  let providerBooking;
  if (usePartnerApi) {
    try {
      providerBooking = await createPartnerDiagnosticsBooking({
        packageItems: packages.map((p) => ({
          package_id: p.package_id,
          deal_id: p.deal_id,
          heading: p.package_name,
          price_inr: p.price_inr,
          mrp_inr: p.mrp_inr,
        })),
        customer: {
          name: patientName,
          age: Number.isFinite(patientAge) && patientAge > 0 ? patientAge : 30,
          gender: patientGender,
          phone: patientPhone,
          email: patientEmail || null,
          vendor_user_id: `paxmed-${userId}`,
        },
        address: {
          address_line1: bookingAddress.address_line1,
          address_line2: bookingAddress.address_line2 || "",
          locality: bookingAddress.city || city,
          landmark: bookingAddress.landmark || "",
          city: bookingAddress.city || city,
          state: bookingAddress.state || "",
          pincode: String(bookingAddress.pincode || "").trim(),
          lat: bookingAddress.lat,
          lng: bookingAddress.lng,
        },
        city,
        paymentType,
        preferredDate: requestedSchedule.toISOString(),
      });
    } catch (e) {
      return res.status(502).json({ error: e?.message || "Diagnostics partner booking failed" });
    }
  } else {
    const localRef = `LOCAL-${Date.now()}`;
    const localNote = partnerEnabled
      ? "PaxMed-confirmed request (catalog or non-Healthians vendor; not sent to Healthians B2B booking API)"
      : "Partner integration is disabled";
    providerBooking = {
      booking_ref: localRef,
      vendor_booking_id: localRef,
      vendor_billing_user_id: `paxmed-${userId}`,
      vendor_customer_id: null,
      slot: null,
      freeze_ref: null,
      provider_response: { mode: "local_fallback", note: localNote, vendor_key: primary.vendor_key || null },
    };
  }

  const diagnosticsPayloadEnvelope = {
    paxmed: {
      partner_booking_id: providerBooking.booking_ref ?? null,
      vendor_booking_id: providerBooking.vendor_booking_id ?? null,
      vendor_billing_user_id: providerBooking.vendor_billing_user_id ?? null,
      vendor_customer_id: providerBooking.vendor_customer_id ?? null,
    },
    partner_response:
      providerBooking.provider_response && typeof providerBooking.provider_response === "object"
        ? providerBooking.provider_response
        : {},
  };

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const scheduledIso = requestedSchedule.toISOString();
    const rzOrderId = paymentMeta?.razorpay_order_id ? String(paymentMeta.razorpay_order_id) : null;
    const rzPaymentId = paymentMeta?.razorpay_payment_id ? String(paymentMeta.razorpay_payment_id) : null;
    let order;
    try {
      const orderRes = await client.query(
        `INSERT INTO orders
         (user_id, order_kind, status, delivery_option, delivery_fee_inr, scheduled_for, address_id, provider_name, provider_order_ref, provider_payload, notes, prescription_id, razorpay_order_id, razorpay_payment_id, payment_status, razorpay_reconciled_at, updated_at)
       VALUES
         ($1,'diagnostics','confirmed','normal',0,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12, now())
       RETURNING id, order_kind, status, scheduled_for, provider_name, provider_order_ref, created_at, prescription_id, razorpay_order_id, razorpay_payment_id, payment_status`,
        [
          userId,
          scheduledIso,
          bookingAddress.id,
          storedProviderName,
          providerBooking.booking_ref || null,
          JSON.stringify(diagnosticsPayloadEnvelope),
          `Diagnostics package booking in ${city} (${paymentType.toUpperCase()}) · ${packages.length} test(s)`,
          diagPrescriptionId,
          rzOrderId,
          rzPaymentId,
          dbPaymentStatus,
          null,
        ]
      );
      order = orderRes.rows[0];
    } catch (e) {
      if (e && e.code === "23505") {
        await client.query("ROLLBACK");
        return res.status(409).json({ error: "This Razorpay payment is already linked to an order." });
      }
      throw e;
    }
    for (const pkg of packages) {
      await client.query(
        `INSERT INTO order_items
          (order_id, source, item_label, quantity_units, unit_price_inr, mrp_inr, provider_item_ref, item_meta)
         VALUES
          ($1,'catalog',$2,1,$3,$4,$5,$6)`,
        [
          order.id,
          pkg.package_name,
          pkg.price_inr,
          pkg.mrp_inr,
          pkg.package_id,
          JSON.stringify({
            package_id: pkg.package_id,
            deal_id: pkg.deal_id,
            city: pkg.city,
            vendor_key: pkg.vendor_key || null,
            patient_name: patientName,
            patient_age: Number.isFinite(patientAge) ? patientAge : null,
            patient_gender: patientGender,
            slot: providerBooking.slot || null,
            freeze_ref: providerBooking.freeze_ref || null,
            payment_type: paymentType,
            payment_meta: paymentMeta,
            scheduled_for: scheduledIso,
          }),
        ]
      );
    }
    await client.query(
      `INSERT INTO order_events (order_id, status, message)
       VALUES ($1, 'confirmed', $2)`,
      [
        order.id,
        usePartnerApi
          ? providerBooking.booking_ref
            ? `Healthians booking confirmed (${packages.length} test(s)). Ref: ${providerBooking.booking_ref}`
            : `Healthians booking confirmed (${packages.length} test(s)).`
          : providerBooking.booking_ref
            ? `Diagnostics booking confirmed (${packages.length} test(s)). PaxMed ref: ${providerBooking.booking_ref}`
            : `Diagnostics booking confirmed (${packages.length} test(s)).`,
      ]
    );
    const reminderAt = await createDiagnosticReminder({
      client,
      userId,
      orderId: order.id,
      packageName: packages.length > 1 ? `${packages[0].package_name} +${packages.length - 1} more` : packageName,
      scheduledFor: scheduledIso,
    });
    await client.query("COMMIT");
    res.status(201).json({
      ok: true,
      order: {
        ...order,
        razorpay_order_id: order.razorpay_order_id || null,
        razorpay_payment_id: order.razorpay_payment_id || null,
        partner_booking_ref: providerBooking.booking_ref || null,
        reminder_scheduled_for: reminderAt,
      },
    });
  } catch (e) {
    await client.query("ROLLBACK");
    res.status(500).json({ ok: false, error: e.message });
  } finally {
    client.release();
  }
});

router.get("/:id", async (req, res) => {
  await ensureOrdersSchema();
  const userId = req.user.id;
  const id = Number(req.params.id);
  if (!Number.isFinite(id) || id < 1) return res.status(400).json({ error: "Invalid id" });

  const orderRes = await pool.query(
    `SELECT o.*, a.address_line1, a.address_line2, a.landmark, a.city, a.state, a.pincode,
            up.id AS prescription_file_id,
            up.original_filename AS prescription_filename,
            up.mime_type AS prescription_mime,
            up.created_at AS prescription_uploaded_at
     FROM orders o
     LEFT JOIN user_addresses a ON a.id = o.address_id
     LEFT JOIN user_prescriptions up ON up.id = o.prescription_id
     WHERE o.id = $1 AND o.user_id = $2
     LIMIT 1`,
    [id, userId]
  );
  if (!orderRes.rows.length) return res.status(404).json({ error: "Not found" });

  const itemsRes = await pool.query(
    `SELECT oi.*, p.name AS pharmacy_name
     FROM order_items oi
     LEFT JOIN pharmacies p ON p.id = oi.pharmacy_id
     WHERE oi.order_id = $1
     ORDER BY oi.id ASC`,
    [id]
  );

  const eventsRes = await pool.query(
    `SELECT id, status, message, created_at
     FROM order_events
     WHERE order_id = $1
     ORDER BY created_at ASC`,
    [id]
  );

  let partnerStatus = null;
  if (orderRes.rows[0]?.order_kind === "diagnostics" && orderRes.rows[0]?.provider_order_ref) {
    try {
      partnerStatus = await getPartnerBookingStatus({ bookingId: orderRes.rows[0].provider_order_ref });
    } catch (_e) {
      partnerStatus = null;
    }
  }

  const diagRow = orderRes.rows[0];
  if (
    String(process.env.DIAGNOSTIC_REPORT_SYNC_ON_ORDER_VIEW || "").trim() === "1" &&
    diagRow?.order_kind === "diagnostics" &&
    diagRow?.provider_order_ref &&
    !String(diagRow.provider_order_ref).startsWith("LOCAL-") &&
    isDiagnosticsPartnerEnabled()
  ) {
    const oid = diagRow.id;
    const uid = diagRow.user_id;
    setImmediate(() => {
      syncDiagnosticsReportForOrder(pool, oid, uid).catch((e) =>
        console.error("[diagnostic report sync on order view]", e?.message || e)
      );
    });
  }

  res.json({ order: orderRes.rows[0], items: itemsRes.rows, events: eventsRes.rows, partner_status: partnerStatus });
});

router.post("/:id/sync-diagnostic-report", async (req, res) => {
  await ensureOrdersSchema();
  const userId = req.user.id;
  const id = Number(req.params.id);
  if (!Number.isFinite(id) || id < 1) return res.status(400).json({ error: "Invalid id" });

  const own = await pool.query(
    `SELECT id, user_id, order_kind FROM orders WHERE id = $1 AND user_id = $2 LIMIT 1`,
    [id, userId]
  );
  if (!own.rows.length) return res.status(404).json({ error: "Not found" });
  if (String(own.rows[0].order_kind) !== "diagnostics") {
    return res.status(400).json({ error: "Only diagnostics orders can sync lab reports" });
  }

  try {
    const out = await syncDiagnosticsReportForOrder(pool, id, userId);
    return res.json({ ok: true, sync: out });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e?.message || "Sync failed" });
  }
});

// MVP: user can cancel only if not yet out_for_delivery/delivered
router.post("/:id/cancel", async (req, res) => {
  await ensureOrdersSchema();
  const userId = req.user.id;
  const id = Number(req.params.id);
  if (!Number.isFinite(id) || id < 1) return res.status(400).json({ error: "Invalid id" });

  const { rows } = await pool.query(
    `SELECT id, status FROM orders WHERE id = $1 AND user_id = $2 LIMIT 1`,
    [id, userId]
  );
  if (!rows.length) return res.status(404).json({ error: "Not found" });
  const st = rows[0].status;
  if (["out_for_delivery", "delivered", "cancelled"].includes(st)) {
    return res.status(400).json({ error: `Cannot cancel order in status ${st}` });
  }

  await pool.query(`UPDATE orders SET status = 'cancelled', updated_at = now() WHERE id = $1 AND user_id = $2`, [
    id,
    userId,
  ]);
  await pool.query(`INSERT INTO order_events (order_id, status, message) VALUES ($1,'cancelled',$2)`, [
    id,
    "Cancelled by user",
  ]);

  await maybeNotifyWhatsapp({
    userPhoneE164: req.user.phone_e164,
    text: `PaxMed: Order #${id} cancelled.`,
  });

  res.json({ ok: true });
});

// Internal helper: create reminders for order items (called when order delivered)
async function createRefillRemindersFromOrder({ orderId, userId }) {
  const { rows: items } = await pool.query(
    `SELECT id, medicine_id, item_label, quantity_units, pack_size, tablets_per_day
     FROM order_items
     WHERE order_id = $1`,
    [orderId]
  );
  for (const it of items) {
    const perDay = it.tablets_per_day != null ? Number(it.tablets_per_day) : null;
    const pack = it.pack_size != null ? Number(it.pack_size) : null;
    const qtyUnits = Number(it.quantity_units) || 1;
    if (!perDay || !Number.isFinite(perDay) || perDay <= 0) continue;
    if (!pack || !Number.isFinite(pack) || pack <= 0) continue;

    const totalTabs = qtyUnits * pack;
    const daysSupply = totalTabs / perDay;
    if (!Number.isFinite(daysSupply) || daysSupply <= 0.5) continue;

    const bufferDays = 3;
    const remindInDays = Math.max(1, Math.floor(daysSupply - bufferDays));
    const remindAt = new Date(Date.now() + remindInDays * 24 * 60 * 60_000).toISOString();

    await pool.query(
      `INSERT INTO purchase_reminders (user_id, medicine_id, medicine_label, remind_at, repeat_interval_days, notes, order_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT DO NOTHING`,
      [
        userId,
        it.medicine_id || null,
        String(it.item_label).slice(0, 200),
        remindAt,
        Math.max(1, Math.floor(daysSupply)),
        `Auto reminder from order #${orderId} (${totalTabs} tablets @ ${perDay}/day)`,
        orderId,
      ]
    );
  }
}

// Fulfillment status updates: service-provider (pharmacy dashboard) sessions only — not consumers.
router.post("/:id/events", async (req, res) => {
  await ensureOrdersSchema();
  if (req.user?.role !== "service_provider") {
    return res.status(403).json({
      error: "Order status can only be updated by a pharmacy partner session (service provider login).",
    });
  }

  const id = Number(req.params.id);
  if (!Number.isFinite(id) || id < 1) return res.status(400).json({ error: "Invalid id" });

  const status = String(req.body?.status || "").trim();
  const message = req.body?.message != null ? String(req.body.message).trim().slice(0, 300) : null;
  const allowed = ["confirmed", "packed", "out_for_delivery", "delivered", "cancelled"];
  if (!allowed.includes(status)) return res.status(400).json({ error: `Invalid status. Allowed: ${allowed.join(", ")}` });

  // Find order + owner
  const { rows } = await pool.query(`SELECT id, user_id, status AS current_status FROM orders WHERE id = $1 LIMIT 1`, [
    id,
  ]);
  if (!rows.length) return res.status(404).json({ error: "Not found" });
  const ord = rows[0];

  await pool.query(`UPDATE orders SET status = $1, updated_at = now() WHERE id = $2`, [status, id]);
  await pool.query(`INSERT INTO order_events (order_id, status, message) VALUES ($1,$2,$3)`, [id, status, message]);

  // If delivered: create reminders based on qty/day
  if (status === "delivered") {
    await createRefillRemindersFromOrder({ orderId: id, userId: ord.user_id });
  }

  // WhatsApp push
  const u = await pool.query(`SELECT phone_e164 FROM users WHERE id = $1 LIMIT 1`, [ord.user_id]);
  const phone = u.rows[0]?.phone_e164;
  await maybeNotifyWhatsapp({
    userPhoneE164: phone,
    text: `PaxMed: Order #${id} status updated → ${status}${message ? ` (${message})` : ""}`,
  });

  res.json({ ok: true });
});

export default router;

