-- Demo data for India (INR). Replace with real feeds in production.

TRUNCATE
  cart_items,
  carts,
  sale_items,
  sales,
  partner_pharmacies,
  provider_skus,
  skus,
  catalog_users,
  service_providers,
  service_provider_users,
  lab_test_prices,
  lab_tests,
  pharmacy_prices,
  purchase_reminders,
  sessions,
  otp_codes,
  medicines,
  pharmacies,
  cities,
  users
RESTART IDENTITY CASCADE;

-- Service Provider demo login (username: admin, password: Admin)
INSERT INTO service_provider_users (username, password_hash, active) VALUES
  ('admin', '$2b$10$XgnD1GSE6UOB8DvhVLCUluBKSsw0X5B9hHWuCx6x/SZbtd74EPtJ6', true)
ON CONFLICT (username) DO UPDATE SET password_hash = EXCLUDED.password_hash, active = true;

INSERT INTO cities (name, state, slug) VALUES
  ('Mumbai', 'Maharashtra', 'mumbai'),
  ('Bengaluru', 'Karnataka', 'bengaluru'),
  ('New Delhi', 'Delhi', 'new-delhi'),
  ('Hyderabad', 'Telangana', 'hyderabad'),
  ('Chennai', 'Tamil Nadu', 'chennai'),
  ('Kolkata', 'West Bengal', 'kolkata'),
  ('Pune', 'Maharashtra', 'pune'),
  ('Ahmedabad', 'Gujarat', 'ahmedabad'),
  ('Kochi', 'Kerala', 'kochi'),
  ('Jaipur', 'Rajasthan', 'jaipur');

-- Service provider businesses (UUID) for SKU catalog / provider_skus
INSERT INTO service_providers (id, name, address, area, city, state, pincode) VALUES
  ('b1111111-1111-4111-8111-111111111101', 'MedPlus Health — Bandra', 'Hill Road, Bandra West', 'Bandra West', 'Mumbai', 'Maharashtra', '400050'),
  ('b1111111-1111-4111-8111-111111111102', 'Apollo Pharmacy — Koramangala', '80 Feet Road, 4th Block', 'Koramangala', 'Bengaluru', 'Karnataka', '560034');

INSERT INTO pharmacies (name, chain, city_id, address_line, pincode, lat, lng) VALUES
  ('Apollo Pharmacy — Bandra', 'Apollo', 1, 'Linking Rd, Bandra West', '400050', 19.0596, 72.8295),
  ('MedPlus — Bandra', 'MedPlus', 1, 'Hill Rd, Bandra West', '400050', 19.0544, 72.8326),
  ('Wellness Forever — Khar', 'Wellness Forever', 1, 'SV Rd, Khar West', '400052', 19.0712, 72.8361),
  ('Apollo Pharmacy — Koramangala', 'Apollo', 2, '80 Feet Rd, Koramangala 4th Block', '560034', 12.9352, 77.6245),
  ('MedPlus — Indiranagar', 'MedPlus', 2, '100 Feet Rd, Indiranagar', '560038', 12.9719, 77.6412),
  ('Netmeds Store — Whitefield', 'Netmeds', 2, 'Whitefield Main Rd', '560066', 12.9698, 77.7499),
  ('Apollo Pharmacy — Connaught Place', 'Apollo', 3, 'Block A, CP', '110001', 28.6315, 77.2167),
  ('MedPlus — Karol Bagh', 'MedPlus', 3, 'Ajmal Khan Rd', '110005', 28.6517, 77.1909);

INSERT INTO medicines (display_name, generic_name, strength, form, pack_size, schedule) VALUES
  ('Metformin 500 mg', 'Metformin hydrochloride', '500 mg', 'tablet', 10, 'H'),
  ('Atorvastatin 20 mg', 'Atorvastatin calcium', '20 mg', 'tablet', 10, 'H'),
  ('Telma 40 (Telmisartan)', 'Telmisartan', '40 mg', 'tablet', 10, 'H'),
  ('Pantoprazole 40 mg', 'Pantoprazole', '40 mg', 'tablet', 10, 'H'),
  ('Amoxicillin 500 mg', 'Amoxicillin', '500 mg', 'capsule', 10, 'H1'),
  ('Paracetamol 650 mg', 'Paracetamol', '650 mg', 'tablet', 15, 'H'),
  ('Dolo 650 Tablet', 'Paracetamol', '650 mg', 'tablet', 15, 'H');

-- OTP users (integer id; distinct phones from catalog_users demo)
INSERT INTO users (phone_e164, last_login_at) VALUES
  ('+919998887766', now() - interval '2 hours'),
  ('+919887766554', now() - interval '1 day'),
  ('+917777666655', NULL);

-- Demo session for user 1 (for DB inspection; request real login for a fresh token)
INSERT INTO sessions (id, user_id, created_at, expires_at, revoked_at) VALUES
  ('seed-demo-session-paxmed-01', 1, now() - interval '1 hour', now() + interval '6 days', NULL);

-- OTP row (expired; hash is placeholder — use real /api/auth flow for login)
INSERT INTO otp_codes (phone_e164, code_hash, purpose, expires_at, consumed_at, ip, user_agent) VALUES
  ('+919998887766', '$2b$10$placeholderExpiredOtpHashDemoOnly', 'login', now() - interval '1 day', now() - interval '1 day', '127.0.0.1', 'PaxMed seed'),
  ('+919887766554', '$2b$10$placeholderPendingOtpHashDemoOnly', 'login', now() + interval '10 minutes', NULL, '127.0.0.1', 'PaxMed seed');

-- WhatsApp draft cart + web ready cart (OCR / cart API demos)
INSERT INTO carts (source, source_ref, wa_from, wa_message_id, status, ocr_text) VALUES
  ('whatsapp', 'wa:demo:msg-1001', '919811122233', 'wamid.demo.001', 'draft', 'Metformin 500\nAtorva 20mg strip'),
  ('web', 'web:demo:checkout-42', NULL, NULL, 'ready', NULL),
  ('whatsapp', 'wa:demo:msg-1002', '919876543210', 'wamid.demo.002', 'failed', 'unclear photo');

INSERT INTO cart_items (cart_id, medicine_id, quantity, match_score, match_line) VALUES
  (1, 1, 2, 0.94, 'Metformin 500'),
  (1, 2, 1, 0.88, 'Atorva 20mg'),
  (2, 3, 1, 1.00, 'Telma 40'),
  (2, 4, 2, 0.92, 'Pantoprazole 40 mg');

-- Purchase reminders (user 1 · medicines 1 & 2)
INSERT INTO purchase_reminders (user_id, medicine_id, medicine_label, remind_at, repeat_interval_days, notes) VALUES
  (1, 1, 'Metformin 500 mg · strip of 10', now() + interval '25 days', 30, 'After breakfast · demo refill'),
  (1, 2, 'Atorvastatin 20 mg', now() + interval '60 days', 90, NULL),
  (2, NULL, 'Vitamin D3 60k (OTC demo)', now() + interval '14 days', NULL, 'medicine_id NULL example');

-- Mumbai Metformin: show 30–50% style spread (illustrative)
INSERT INTO pharmacy_prices (pharmacy_id, medicine_id, price_inr, mrp_inr, price_type) VALUES
  (1, 1, 45.00, 120.00, 'retail'),
  (2, 1, 38.50, 120.00, 'retail'),
  (3, 1, 62.00, 120.00, 'retail');

-- Bengaluru Metformin
INSERT INTO pharmacy_prices (pharmacy_id, medicine_id, price_inr, mrp_inr, price_type) VALUES
  (4, 1, 42.00, 120.00, 'retail'),
  (5, 1, 36.75, 120.00, 'retail'),
  (6, 1, 55.00, 120.00, 'retail');

-- Delhi Metformin
INSERT INTO pharmacy_prices (pharmacy_id, medicine_id, price_inr, mrp_inr, price_type) VALUES
  (7, 1, 48.00, 120.00, 'retail'),
  (8, 1, 40.25, 120.00, 'retail');

-- Atorvastatin 20 mg across a few outlets
INSERT INTO pharmacy_prices (pharmacy_id, medicine_id, price_inr, mrp_inr, price_type) VALUES
  (1, 2, 95.00, 350.00, 'retail'),
  (2, 2, 78.00, 350.00, 'retail'),
  (4, 2, 88.00, 350.00, 'retail'),
  (5, 2, 72.50, 350.00, 'retail'),
  (7, 2, 90.00, 350.00, 'retail');

-- Telma 40
INSERT INTO pharmacy_prices (pharmacy_id, medicine_id, price_inr, mrp_inr, price_type) VALUES
  (1, 3, 185.00, 280.00, 'retail'),
  (2, 3, 152.00, 280.00, 'retail'),
  (4, 3, 178.00, 280.00, 'retail');

-- Pantoprazole
INSERT INTO pharmacy_prices (pharmacy_id, medicine_id, price_inr, mrp_inr, price_type) VALUES
  (2, 4, 55.00, 165.00, 'retail'),
  (3, 4, 79.00, 165.00, 'retail'),
  (5, 4, 51.00, 165.00, 'retail');

-- Amoxicillin
INSERT INTO pharmacy_prices (pharmacy_id, medicine_id, price_inr, mrp_inr, price_type) VALUES
  (1, 5, 125.00, 240.00, 'retail'),
  (6, 5, 98.00, 240.00, 'retail'),
  (8, 5, 110.00, 240.00, 'retail');

-- Paracetamol 650 mg / Dolo 650 (matches home quick search "Paracetamol 650", "Dolo 650")
INSERT INTO pharmacy_prices (pharmacy_id, medicine_id, price_inr, mrp_inr, discount_pct, price_type) VALUES
  (1, 6, 25.50, 30.00, 15.000, 'retail'),
  (2, 6, 24.90, 30.00, 17.000, 'retail'),
  (3, 6, 27.00, 30.00, 10.000, 'retail'),
  (4, 6, 26.00, 30.00, 13.333, 'retail'),
  (5, 6, 24.75, 30.00, 17.500, 'retail'),
  (1, 7, 26.00, 32.00, 18.750, 'retail'),
  (2, 7, 25.40, 32.00, 20.625, 'retail'),
  (4, 7, 26.40, 32.00, 17.500, 'retail');

-- Partner demo: Apollo Bandra (pharmacy_id=1)
INSERT INTO partner_pharmacies (pharmacy_id, display_name, api_key) VALUES
  (1, 'Apollo Bandra (Demo Partner)', 'demo-apollo-bandra-key');

-- Sales demo (last 14 days) with sell + cost for profit calculation
INSERT INTO sales (pharmacy_id, sold_at, channel, customer_ref) VALUES
  (1, now() - interval '1 day', 'walkin', 'INV-1001'),
  (1, now() - interval '2 days', 'walkin', 'INV-1002'),
  (1, now() - interval '5 days', 'phone', 'INV-1003'),
  (1, now() - interval '9 days', 'online', 'INV-1004'),
  (1, now() - interval '13 days', 'walkin', 'INV-1005');

-- Items per sale (unit_sell_inr approximates shelf price; unit_cost_inr is pharmacy purchase cost)
INSERT INTO sale_items (sale_id, medicine_id, quantity, unit_sell_inr, unit_cost_inr) VALUES
  (1, 1, 2, 45.00, 28.00),
  (1, 4, 1, 60.00, 35.00),
  (2, 2, 1, 95.00, 62.00),
  (2, 3, 1, 185.00, 130.00),
  (3, 1, 1, 45.00, 28.00),
  (3, 5, 1, 125.00, 80.00),
  (4, 4, 2, 60.00, 35.00),
  (5, 3, 1, 185.00, 130.00);

-- Diagnostics / labs (demo)
INSERT INTO lab_tests (heading, sub_heading, category, icon_url, slug, report_tat_hours, home_collection) VALUES
  ('CBC (Complete Blood Count)', 'Contains 21 tests', 'PATHOLOGY', 'https://onemg.gumlet.io/assets/6d2f9d7c-694c-11ec-98c6-0219de0cd346.png', '/labs/test/1717', 7, true),
  ('Thyroid Profile Total (T3, T4 & TSH)', 'Contains 3 tests', 'PATHOLOGY', 'https://onemg.gumlet.io/assets/6d2f9d7c-694c-11ec-98c6-0219de0cd346.png', '/labs/test/thyroid-profile', 7, true),
  ('Lipid Profile', 'Contains 8 tests', 'PATHOLOGY', 'https://onemg.gumlet.io/assets/6d2f9d7c-694c-11ec-98c6-0219de0cd346.png', '/labs/test/lipid-profile', 7, true),
  ('Comprehensive Gold Full Body Checkup', 'Contains 86 tests · Smart Report', 'PATHOLOGY', 'https://onemg.gumlet.io/2026-03%2F1774354424_Labs-Strip.webp', '/labs/package/gold-full-body', 18, true),
  ('Senior Citizen Health Checkup', 'Contains 83 tests · Smart Report', 'PATHOLOGY', 'https://onemg.gumlet.io/2026-03%2F1774354424_Labs-Strip.webp', '/labs/package/senior-citizen', 18, true);

-- Prices vary by city (illustrative). City IDs: 1 Mumbai, 2 Bengaluru, 3 New Delhi
INSERT INTO lab_test_prices (city_id, lab_name, test_id, price_inr, mrp_inr) VALUES
  (1, 'Tata 1mg Labs', 1, 299.00, 350.00),
  (1, 'Tata 1mg Labs', 2, 490.00, 550.00),
  (1, 'Tata 1mg Labs', 3, 399.00, 450.00),
  (1, 'Tata 1mg Labs', 4, 2249.00, 4498.00),
  (1, 'Tata 1mg Labs', 5, 1999.00, 3998.00),
  (2, 'Tata 1mg Labs', 1, 319.00, 350.00),
  (2, 'Tata 1mg Labs', 2, 470.00, 550.00),
  (2, 'Tata 1mg Labs', 3, 389.00, 450.00),
  (2, 'Tata 1mg Labs', 4, 2299.00, 4498.00),
  (2, 'Tata 1mg Labs', 5, 2099.00, 3998.00),
  (3, 'Tata 1mg Labs', 1, 289.00, 350.00),
  (3, 'Tata 1mg Labs', 2, 499.00, 550.00),
  (3, 'Tata 1mg Labs', 3, 419.00, 450.00),
  (3, 'Tata 1mg Labs', 4, 2199.00, 4498.00),
  (3, 'Tata 1mg Labs', 5, 1899.00, 3998.00);

-- Demo: copy reference lab prices to every city missing that (lab_name, test_id).
INSERT INTO lab_test_prices (city_id, lab_name, test_id, price_inr, mrp_inr)
SELECT c.id, r.lab_name, r.test_id, r.price_inr, r.mrp_inr
FROM cities c
CROSS JOIN (
  SELECT DISTINCT ON (p.test_id)
    p.lab_name,
    p.test_id,
    p.price_inr,
    p.mrp_inr
  FROM lab_test_prices p
  INNER JOIN cities ct ON ct.id = p.city_id
  ORDER BY
    p.test_id,
    (ct.slug IN ('bengaluru', 'bangalore'))::int DESC,
    ct.id ASC
) r
WHERE NOT EXISTS (
  SELECT 1 FROM lab_test_prices x
  WHERE x.city_id = c.id AND x.test_id = r.test_id AND x.lab_name = r.lab_name
)
ON CONFLICT (city_id, lab_name, test_id) DO NOTHING;

-- SKU master + catalog consumer profiles + provider pricing (demo)
INSERT INTO skus (id, name, details, category) VALUES
  ('c2222222-2222-4222-8222-222222222201', 'Metformin 500 mg — strip of 10', 'Antidiabetic · schedule H', 'medicine'),
  ('c2222222-2222-4222-8222-222222222202', 'CBC (Complete Blood Count)', '21 parameters · home collection', 'diagnostic'),
  ('c2222222-2222-4222-8222-222222222203', 'Lipid Profile', '8 tests · fasting advised', 'diagnostic');

INSERT INTO catalog_users (id, username, phone_number, address, area, city, state, pincode) VALUES
  ('d3333333-3333-4333-8333-333333333301', 'riya_shah', '+919876543210', '12 Turner Road', 'Bandra West', 'Mumbai', 'Maharashtra', '400050'),
  ('d3333333-3333-4333-8333-333333333302', 'arjun_k', '+919811122233', '45 100 Feet Road', 'Indiranagar', 'Bengaluru', 'Karnataka', '560038');

-- discount is INR off `price` for demo; final_price is generated (price - discount)
INSERT INTO provider_skus (service_provider_id, sku_id, price, discount, availability) VALUES
  ('b1111111-1111-4111-8111-111111111101', 'c2222222-2222-4222-8222-222222222201', 52.00, 4.00, true),
  ('b1111111-1111-4111-8111-111111111101', 'c2222222-2222-4222-8222-222222222202', 320.00, 21.00, true),
  ('b1111111-1111-4111-8111-111111111101', 'c2222222-2222-4222-8222-222222222203', 410.00, 11.00, true),
  ('b1111111-1111-4111-8111-111111111102', 'c2222222-2222-4222-8222-222222222201', 48.50, 0.00, true),
  ('b1111111-1111-4111-8111-111111111102', 'c2222222-2222-4222-8222-222222222202', 299.00, 0.00, false),
  ('b1111111-1111-4111-8111-111111111102', 'c2222222-2222-4222-8222-222222222203', 389.00, 15.50, true);
