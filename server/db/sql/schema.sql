-- PaxMed India: PostgreSQL schema (use with DATABASE_URL)

CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS cities (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  state TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS pharmacies (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  chain TEXT,
  city_id INTEGER NOT NULL REFERENCES cities (id) ON DELETE CASCADE,
  address_line TEXT,
  pincode TEXT,
  lat DOUBLE PRECISION NOT NULL,
  lng DOUBLE PRECISION NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_pharmacies_city ON pharmacies (city_id);

CREATE TABLE IF NOT EXISTS medicines (
  id SERIAL PRIMARY KEY,
  display_name TEXT NOT NULL,
  generic_name TEXT,
  strength TEXT NOT NULL,
  form TEXT NOT NULL DEFAULT 'tablet',
  pack_size INTEGER NOT NULL DEFAULT 10,
  schedule TEXT,
  search_vector TEXT GENERATED ALWAYS AS (
    lower(
      coalesce(display_name, '') || ' ' ||
      coalesce(generic_name, '') || ' ' ||
      coalesce(strength, '')
    )
  ) STORED
);

CREATE INDEX IF NOT EXISTS idx_medicines_search ON medicines USING gin (search_vector gin_trgm_ops);

CREATE TABLE IF NOT EXISTS pharmacy_prices (
  id SERIAL PRIMARY KEY,
  pharmacy_id INTEGER NOT NULL REFERENCES pharmacies (id) ON DELETE CASCADE,
  medicine_id INTEGER NOT NULL REFERENCES medicines (id) ON DELETE CASCADE,
  price_inr NUMERIC(12, 2) NOT NULL CHECK (price_inr >= 0),
  mrp_inr NUMERIC(12, 2),
  in_stock BOOLEAN NOT NULL DEFAULT true,
  price_type TEXT NOT NULL DEFAULT 'retail' CHECK (price_type IN ('retail', 'online', 'discount')),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (pharmacy_id, medicine_id, price_type)
);

CREATE INDEX IF NOT EXISTS idx_prices_medicine ON pharmacy_prices (medicine_id);

-- WhatsApp intake -> OCR -> cart
CREATE TABLE IF NOT EXISTS carts (
  id SERIAL PRIMARY KEY,
  source TEXT NOT NULL DEFAULT 'whatsapp' CHECK (source IN ('whatsapp', 'web')),
  source_ref TEXT, -- e.g. wa:phone_number_id:message_id
  wa_from TEXT, -- WhatsApp sender phone (wa_id)
  wa_message_id TEXT,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'ready', 'failed')),
  ocr_text TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_carts_created_at ON carts (created_at DESC);

CREATE TABLE IF NOT EXISTS cart_items (
  id SERIAL PRIMARY KEY,
  cart_id INTEGER NOT NULL REFERENCES carts (id) ON DELETE CASCADE,
  medicine_id INTEGER NOT NULL REFERENCES medicines (id) ON DELETE RESTRICT,
  quantity INTEGER NOT NULL DEFAULT 1 CHECK (quantity >= 1),
  match_score REAL,
  match_line TEXT,
  UNIQUE (cart_id, medicine_id)
);

CREATE INDEX IF NOT EXISTS idx_cart_items_cart ON cart_items (cart_id);

-- Partner pharmacies: sales + profit dashboard
CREATE TABLE IF NOT EXISTS partner_pharmacies (
  id SERIAL PRIMARY KEY,
  pharmacy_id INTEGER NOT NULL UNIQUE REFERENCES pharmacies (id) ON DELETE CASCADE,
  display_name TEXT NOT NULL,
  api_key TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_partner_pharmacy_id ON partner_pharmacies (pharmacy_id);

CREATE TABLE IF NOT EXISTS sales (
  id SERIAL PRIMARY KEY,
  pharmacy_id INTEGER NOT NULL REFERENCES pharmacies (id) ON DELETE CASCADE,
  sold_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  channel TEXT NOT NULL DEFAULT 'walkin' CHECK (channel IN ('walkin', 'online', 'phone')),
  customer_ref TEXT
);

CREATE INDEX IF NOT EXISTS idx_sales_pharmacy_sold_at ON sales (pharmacy_id, sold_at DESC);

CREATE TABLE IF NOT EXISTS sale_items (
  id SERIAL PRIMARY KEY,
  sale_id INTEGER NOT NULL REFERENCES sales (id) ON DELETE CASCADE,
  medicine_id INTEGER NOT NULL REFERENCES medicines (id) ON DELETE RESTRICT,
  quantity INTEGER NOT NULL CHECK (quantity >= 1),
  unit_sell_inr NUMERIC(12, 2) NOT NULL CHECK (unit_sell_inr >= 0),
  unit_cost_inr NUMERIC(12, 2) NOT NULL CHECK (unit_cost_inr >= 0),
  UNIQUE (sale_id, medicine_id)
);

CREATE INDEX IF NOT EXISTS idx_sale_items_sale ON sale_items (sale_id);

-- Users: phone OTP auth (India/mobile-first)
CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  phone_e164 TEXT UNIQUE, -- e.g. +919876543210 (nullable for OAuth-only users)
  email TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_login_at TIMESTAMPTZ
);

-- Back-compat migration for existing DBs:
ALTER TABLE users ALTER COLUMN phone_e164 DROP NOT NULL;
ALTER TABLE users ADD COLUMN IF NOT EXISTS email TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS full_name TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS gender TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email_unique ON users (lower(email)) WHERE email IS NOT NULL;

CREATE TABLE IF NOT EXISTS otp_codes (
  id SERIAL PRIMARY KEY,
  phone_e164 TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  purpose TEXT NOT NULL DEFAULT 'login' CHECK (purpose IN ('login')),
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ip TEXT,
  user_agent TEXT
);

CREATE INDEX IF NOT EXISTS idx_otp_phone_created ON otp_codes (phone_e164, created_at DESC);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY, -- random token
  user_id INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions (user_id, created_at DESC);

-- OAuth identities (e.g. Google login). Maps provider identity -> local user_id.
CREATE TABLE IF NOT EXISTS oauth_identities (
  id SERIAL PRIMARY KEY,
  provider TEXT NOT NULL CHECK (provider IN ('google')),
  provider_subject TEXT NOT NULL,
  email TEXT,
  user_id INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (provider, provider_subject)
);

CREATE INDEX IF NOT EXISTS idx_oauth_user ON oauth_identities (user_id);

-- Service Provider users (username/password). Store only password hashes.
CREATE TABLE IF NOT EXISTS service_provider_users (
  id SERIAL PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_login_at TIMESTAMPTZ
);

-- Registered service provider businesses (pharmacy / lab partners, etc.)
CREATE TABLE IF NOT EXISTS service_providers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(255) NOT NULL,
  address TEXT,
  area VARCHAR(100),
  city VARCHAR(100),
  state VARCHAR(100),
  pincode VARCHAR(10),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_provider_location ON service_providers (pincode, city);

-- SKU master (medicine / diagnostic sellable items)
CREATE TABLE IF NOT EXISTS skus (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(255) NOT NULL,
  details TEXT,
  category VARCHAR(100),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_sku_name ON skus (name);

-- Consumer profiles for catalog / orders (OTP login still uses integer `users` above)
CREATE TABLE IF NOT EXISTS catalog_users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  username VARCHAR(100) NOT NULL,
  phone_number VARCHAR(15) UNIQUE NOT NULL,
  address TEXT,
  area VARCHAR(100),
  city VARCHAR(100),
  state VARCHAR(100),
  pincode VARCHAR(10),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Per-provider pricing for SKUs (discount stored as INR off list price; app may treat as % later)
CREATE TABLE IF NOT EXISTS provider_skus (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  service_provider_id UUID NOT NULL REFERENCES service_providers (id) ON DELETE CASCADE,
  sku_id UUID NOT NULL REFERENCES skus (id) ON DELETE CASCADE,
  price NUMERIC(10, 2) NOT NULL,
  discount NUMERIC(5, 2) DEFAULT 0,
  final_price NUMERIC(10, 2) GENERATED ALWAYS AS (price - discount) STORED,
  availability BOOLEAN DEFAULT TRUE,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (service_provider_id, sku_id)
);

CREATE INDEX IF NOT EXISTS idx_price_lookup ON provider_skus (sku_id, price);

-- Purchase reminders (refill / buy-again) for logged-in users
CREATE TABLE IF NOT EXISTS purchase_reminders (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  medicine_id INTEGER REFERENCES medicines (id) ON DELETE SET NULL,
  medicine_label TEXT NOT NULL,
  remind_at TIMESTAMPTZ NOT NULL,
  repeat_interval_days INTEGER CHECK (repeat_interval_days IS NULL OR (repeat_interval_days >= 1 AND repeat_interval_days <= 730)),
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_purchase_reminders_user_next ON purchase_reminders (user_id, remind_at);

-- -----------------------------
-- Orders + delivery (home delivery MVP)
-- -----------------------------

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

ALTER TABLE user_addresses
  ADD COLUMN IF NOT EXISTS is_default BOOLEAN NOT NULL DEFAULT false;

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

CREATE INDEX IF NOT EXISTS idx_user_payment_methods_user ON user_payment_methods (user_id, created_at DESC);

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

-- Diagnostics / lab tests (demo dataset; extend with partner integrations)
CREATE TABLE IF NOT EXISTS lab_tests (
  id SERIAL PRIMARY KEY,
  heading TEXT NOT NULL, -- e.g. "CBC (Complete Blood Count)"
  sub_heading TEXT,      -- e.g. "Contains 21 tests"
  category TEXT NOT NULL DEFAULT 'PATHOLOGY' CHECK (category IN ('PATHOLOGY', 'RADIOLOGY')),
  icon_url TEXT,
  slug TEXT,             -- optional deep link path
  report_tat_hours INTEGER, -- typical report ETA (hours)
  home_collection BOOLEAN NOT NULL DEFAULT true,
  search_vector TEXT GENERATED ALWAYS AS (lower(coalesce(heading, '') || ' ' || coalesce(sub_heading, ''))) STORED
);

CREATE INDEX IF NOT EXISTS idx_lab_tests_search ON lab_tests USING gin (search_vector gin_trgm_ops);

CREATE TABLE IF NOT EXISTS lab_test_prices (
  id SERIAL PRIMARY KEY,
  city_id INTEGER NOT NULL REFERENCES cities (id) ON DELETE CASCADE,
  lab_name TEXT NOT NULL DEFAULT 'Tata 1mg Labs',
  test_id INTEGER NOT NULL REFERENCES lab_tests (id) ON DELETE CASCADE,
  price_inr NUMERIC(12, 2) NOT NULL CHECK (price_inr >= 0),
  mrp_inr NUMERIC(12, 2),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (city_id, lab_name, test_id)
);

CREATE INDEX IF NOT EXISTS idx_lab_prices_city ON lab_test_prices (city_id);
CREATE INDEX IF NOT EXISTS idx_lab_prices_test ON lab_test_prices (test_id);

-- =====================================================================
-- Catalog intelligence (drug mapping, availability, analytics, premium)
-- =====================================================================

CREATE TABLE IF NOT EXISTS drug_concepts (
  id SERIAL PRIMARY KEY,
  key_hash TEXT NOT NULL UNIQUE,
  canonical_label TEXT NOT NULL,
  generic_key TEXT NOT NULL,
  strength TEXT NOT NULL DEFAULT '',
  form TEXT NOT NULL DEFAULT 'tablet',
  search_blob TEXT GENERATED ALWAYS AS (
    trim(lower(canonical_label)) || ' ' || trim(lower(generic_key)) || ' ' || trim(lower(strength)) || ' ' ||
    trim(lower(form))
  ) STORED,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_drug_concepts_trgm ON drug_concepts USING gin (search_blob gin_trgm_ops);

CREATE TABLE IF NOT EXISTS medicine_aliases (
  id SERIAL PRIMARY KEY,
  alias_normalized TEXT NOT NULL,
  drug_concept_id INTEGER NOT NULL REFERENCES drug_concepts (id) ON DELETE CASCADE,
  source TEXT NOT NULL DEFAULT 'manual',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (alias_normalized, drug_concept_id)
);

CREATE INDEX IF NOT EXISTS idx_medicine_aliases_norm ON medicine_aliases (alias_normalized);

CREATE TABLE IF NOT EXISTS medicine_external_codes (
  id SERIAL PRIMARY KEY,
  source TEXT NOT NULL,
  code TEXT NOT NULL,
  drug_concept_id INTEGER NOT NULL REFERENCES drug_concepts (id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (source, code)
);

ALTER TABLE medicines ADD COLUMN IF NOT EXISTS drug_concept_id INTEGER REFERENCES drug_concepts (id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_medicines_drug_concept ON medicines (drug_concept_id);

ALTER TABLE pharmacy_prices ADD COLUMN IF NOT EXISTS stock_status TEXT NOT NULL DEFAULT 'unknown'
  CHECK (stock_status IN ('in_stock', 'limited', 'out_of_stock', 'unknown'));
ALTER TABLE pharmacy_prices ADD COLUMN IF NOT EXISTS stock_qty INTEGER CHECK (stock_qty IS NULL OR stock_qty >= 0);
ALTER TABLE pharmacy_prices ADD COLUMN IF NOT EXISTS stock_observed_at TIMESTAMPTZ;

ALTER TABLE pharmacies ADD COLUMN IF NOT EXISTS listing_tier TEXT NOT NULL DEFAULT 'standard'
  CHECK (listing_tier IN ('standard', 'featured', 'premium'));
ALTER TABLE pharmacies ADD COLUMN IF NOT EXISTS featured_until TIMESTAMPTZ;
ALTER TABLE pharmacies ADD COLUMN IF NOT EXISTS premium_rank_weight NUMERIC(8, 4) NOT NULL DEFAULT 0
  CHECK (premium_rank_weight >= 0 AND premium_rank_weight <= 1);

CREATE TABLE IF NOT EXISTS analytics_events (
  id BIGSERIAL PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  event_type TEXT NOT NULL,
  user_id INTEGER REFERENCES users (id) ON DELETE SET NULL,
  pharmacy_id INTEGER REFERENCES pharmacies (id) ON DELETE SET NULL,
  medicine_id INTEGER REFERENCES medicines (id) ON DELETE SET NULL,
  drug_concept_id INTEGER REFERENCES drug_concepts (id) ON DELETE SET NULL,
  city_slug TEXT,
  query TEXT,
  meta JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_analytics_events_created ON analytics_events (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_analytics_events_type_time ON analytics_events (event_type, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_analytics_events_pharmacy_time ON analytics_events (pharmacy_id, created_at DESC);

-- Saved prescriptions (web upload + WhatsApp image); linked to orders for fulfilment & history
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

CREATE INDEX IF NOT EXISTS idx_user_prescriptions_user_created ON user_prescriptions (user_id, created_at DESC);

ALTER TABLE carts ADD COLUMN IF NOT EXISTS prescription_id INTEGER REFERENCES user_prescriptions (id) ON DELETE SET NULL;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS prescription_id INTEGER REFERENCES user_prescriptions (id) ON DELETE RESTRICT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS razorpay_order_id TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS razorpay_payment_id TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS payment_status TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS razorpay_reconciled_at TIMESTAMPTZ;

-- One PaxMed order per Razorpay payment (replay / double-booking safety)
CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_razorpay_payment_unique
  ON orders (razorpay_payment_id)
  WHERE razorpay_payment_id IS NOT NULL AND btrim(razorpay_payment_id) <> '';

-- Razorpay webhooks: idempotency by Razorpay event id (evt_…)
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

-- Refund audit (Razorpay may send multiple partial refunds)
CREATE TABLE IF NOT EXISTS razorpay_order_refunds (
  id SERIAL PRIMARY KEY,
  order_id INTEGER NOT NULL REFERENCES orders (id) ON DELETE CASCADE,
  razorpay_refund_id TEXT NOT NULL UNIQUE,
  amount_paise INTEGER NOT NULL CHECK (amount_paise > 0),
  status TEXT,
  raw_json JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_rz_refunds_order ON razorpay_order_refunds (order_id, created_at DESC);

-- ABHA (Health ID) link + Aadhaar OTP session (also ensured at runtime in server/abha/schema.js)
ALTER TABLE users ADD COLUMN IF NOT EXISTS date_of_birth DATE;

CREATE TABLE IF NOT EXISTS abha_link (
  user_id INTEGER PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  health_id_number TEXT NOT NULL,
  health_id_masked TEXT,
  identifier_kind TEXT NOT NULL DEFAULT 'number',
  aadhaar_verified_at TIMESTAMPTZ NOT NULL,
  last_sync_at TIMESTAMPTZ,
  source_mode TEXT NOT NULL DEFAULT 'stub',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS abha_aadhaar_sessions (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  txn_id TEXT NOT NULL UNIQUE,
  health_id_number TEXT NOT NULL,
  identifier_kind TEXT NOT NULL DEFAULT 'number',
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_abha_sessions_user ON abha_aadhaar_sessions (user_id);
CREATE INDEX IF NOT EXISTS idx_abha_sessions_expires ON abha_aadhaar_sessions (expires_at);

-- User diagnostic lab reports (S3 or local uploads; keyed to diagnostics orders when present)
CREATE TABLE IF NOT EXISTS user_diagnostic_reports (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  order_id INTEGER REFERENCES orders (id) ON DELETE SET NULL,
  diagnostic_type TEXT NOT NULL,
  storage_backend TEXT NOT NULL DEFAULT 'local' CHECK (storage_backend IN ('local','s3')),
  storage_key TEXT NOT NULL UNIQUE,
  s3_bucket TEXT,
  mime_type TEXT NOT NULL,
  byte_size INTEGER NOT NULL CHECK (byte_size > 0 AND byte_size <= 20971520),
  original_filename TEXT,
  amount_inr NUMERIC(12, 2),
  booked_at TIMESTAMPTZ NOT NULL,
  payment_made_by TEXT NOT NULL,
  uploaded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  lab_source TEXT NOT NULL DEFAULT 'lab_ingest',
  content_sha256 TEXT,
  ingest_event_key TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_user_diag_reports_ingest_key
  ON user_diagnostic_reports (ingest_event_key)
  WHERE ingest_event_key IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_user_diag_reports_order_sha
  ON user_diagnostic_reports (order_id, content_sha256)
  WHERE order_id IS NOT NULL AND content_sha256 IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_user_diag_reports_user_booked
  ON user_diagnostic_reports (user_id, booked_at DESC);

-- Retail / lab discount % on MRP (optional; derived on import when MRP + price present)
ALTER TABLE pharmacy_prices ADD COLUMN IF NOT EXISTS discount_pct NUMERIC(6, 3);
ALTER TABLE lab_test_prices ADD COLUMN IF NOT EXISTS discount_pct NUMERIC(6, 3);
