-- PaxMed: first-time PostgreSQL setup script
--
-- Usage:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f server/db/sql/first_time_setup.sql
--
-- Notes:
-- - This script creates extensions, tables, and indexes (idempotent via IF NOT EXISTS).
-- - For demo data, run: psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f server/db/sql/seed.sql
-- - For full snapshot data, run: psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f server/db/sql/postgres_data.sql

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
  source_ref TEXT,
  wa_from TEXT,
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
  phone_e164 TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_login_at TIMESTAMPTZ
);

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
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions (user_id, created_at DESC);

-- Service Provider users (username/password). Store only password hashes.
CREATE TABLE IF NOT EXISTS service_provider_users (
  id SERIAL PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_login_at TIMESTAMPTZ
);

-- Registered service provider businesses
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

-- SKU master
CREATE TABLE IF NOT EXISTS skus (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(255) NOT NULL,
  details TEXT,
  category VARCHAR(100),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_sku_name ON skus (name);

-- Consumer profiles for catalog / orders
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

-- Per-provider pricing for SKUs
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

-- Purchase reminders
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

-- Diagnostics / lab tests (demo dataset; extend with partner integrations)
CREATE TABLE IF NOT EXISTS lab_tests (
  id SERIAL PRIMARY KEY,
  heading TEXT NOT NULL,
  sub_heading TEXT,
  category TEXT NOT NULL DEFAULT 'PATHOLOGY' CHECK (category IN ('PATHOLOGY', 'RADIOLOGY')),
  icon_url TEXT,
  slug TEXT,
  report_tat_hours INTEGER,
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

