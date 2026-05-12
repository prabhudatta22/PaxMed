/**
 * Import ~/Downloads/paxmed_large_dataset.xlsx (or path from argv[2])
 * into service_providers, skus, provider_skus, catalog_users,
 * then sync medicine SKUs into cities / pharmacies / medicines / pharmacy_prices
 * for the main compare UI.
 */
import "dotenv/config";
import { createHash } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import xlsx from "xlsx";
import { pool } from "../db/pool.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Deterministic UUID v4-style from string (for stable re-imports). */
function stringToUuid(seed) {
  const h = createHash("sha256").update(`paxmed|${seed}`).digest();
  const b = Buffer.from(h.subarray(0, 16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const hex = b.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

function slugifyCity(name) {
  return String(name)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}

function parseBool(v) {
  if (v === true || v === 1) return true;
  const s = String(v ?? "").trim().toLowerCase();
  return s === "true" || s === "yes" || s === "1";
}

function normalizePhone(raw) {
  const d = String(raw ?? "").replace(/\D/g, "");
  if (d.length === 10) return `+91${d}`;
  if (d.length === 12 && d.startsWith("91")) return `+${d}`;
  if (String(raw).trim().startsWith("+")) return String(raw).trim().slice(0, 16);
  return `+${d}`.slice(0, 16);
}

function extractStrength(name) {
  const m = String(name).match(/(\d+(?:\.\d+)?)\s*mg\b/i);
  return m ? `${m[1]} mg` : "—";
}

const CITY_COORDS = {
  Mumbai: [19.076, 72.8777],
  Hyderabad: [17.385, 78.4867],
  Bangalore: [12.9716, 77.5946],
  Chennai: [13.0827, 80.2707],
  Delhi: [28.6139, 77.209],
};

function coordsForCity(city) {
  return CITY_COORDS[city] || [20.5937, 78.9629];
}

function num(v, def = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}

async function main() {
  const defaultPath = join(homedir(), "Downloads/paxmed_large_dataset.xlsx");
  const xlsxPath = process.argv[2] || defaultPath;
  if (!existsSync(xlsxPath)) {
    console.error(`File not found: ${xlsxPath}`);
    console.error("Usage: node server/scripts/import-paxmed-dataset.js [path/to/paxmed_large_dataset.xlsx]");
    process.exit(1);
  }

  const buf = readFileSync(xlsxPath);
  const wb = xlsx.read(buf, { type: "buffer" });
  const need = ["service_providers", "skus", "provider_skus", "users"];
  for (const n of need) {
    if (!wb.SheetNames.includes(n)) {
      console.error(`Missing sheet "${n}". Found: ${wb.SheetNames.join(", ")}`);
      process.exit(1);
    }
  }

  const serviceProviders = xlsx.utils.sheet_to_json(wb.Sheets.service_providers, { defval: null });
  const skus = xlsx.utils.sheet_to_json(wb.Sheets.skus, { defval: null });
  const providerSkus = xlsx.utils.sheet_to_json(wb.Sheets.provider_skus, { defval: null });
  const catalogUsers = xlsx.utils.sheet_to_json(wb.Sheets.users, { defval: null });

  const spUuid = (excelId) => stringToUuid(`sp:${excelId}`);
  const skuUuid = (excelId) => stringToUuid(`sku:${excelId}`);
  const psUuid = (excelId) => stringToUuid(`ps:${excelId}`);
  const cuUuid = (excelId) => stringToUuid(`cu:${excelId}`);

  const client = await pool.connect();
  const summary = {
    service_providers: 0,
    skus: 0,
    provider_skus: 0,
    catalog_users: 0,
    cities: 0,
    pharmacies: 0,
    medicines: 0,
    pharmacy_prices: 0,
  };

  try {
    await client.query("BEGIN");

    for (const r of serviceProviders) {
      const id = spUuid(r.id);
      await client.query(
        `INSERT INTO service_providers (id, name, address, area, city, state, pincode)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (id) DO UPDATE SET
           name = EXCLUDED.name,
           address = EXCLUDED.address,
           area = EXCLUDED.area,
           city = EXCLUDED.city,
           state = EXCLUDED.state,
           pincode = EXCLUDED.pincode`,
        [id, r.name, r.address, r.area, r.city, r.state, String(r.pincode ?? "").replace(/\D/g, "").slice(0, 10)]
      );
      summary.service_providers++;
    }

    for (const r of skus) {
      const id = skuUuid(r.id);
      const cat = String(r.category || "medicine").toLowerCase().slice(0, 100);
      await client.query(
        `INSERT INTO skus (id, name, details, category)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (id) DO UPDATE SET
           name = EXCLUDED.name,
           details = EXCLUDED.details,
           category = EXCLUDED.category`,
        [id, r.name, r.details, cat]
      );
      summary.skus++;
    }

    for (const r of providerSkus) {
      const id = psUuid(r.id);
      const spId = spUuid(r.service_provider_id);
      const skuId = skuUuid(r.sku_id);
      let discount = num(r.discount, 0);
      const price = num(r.price, 0);
      if (discount < 0) discount = 0;
      if (discount > price) discount = price;
      await client.query(
        `INSERT INTO provider_skus (id, service_provider_id, sku_id, price, discount, availability)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (service_provider_id, sku_id) DO UPDATE SET
           price = EXCLUDED.price,
           discount = EXCLUDED.discount,
           availability = EXCLUDED.availability`,
        [id, spId, skuId, price, discount, parseBool(r.availability)]
      );
      summary.provider_skus++;
    }

    for (const r of catalogUsers) {
      const id = cuUuid(r.id);
      const phone = normalizePhone(r.phone_number);
      await client.query(
        `INSERT INTO catalog_users (id, username, phone_number, address, area, city, state, pincode)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (id) DO UPDATE SET
           username = EXCLUDED.username,
           phone_number = EXCLUDED.phone_number,
           address = EXCLUDED.address,
           area = EXCLUDED.area,
           city = EXCLUDED.city,
           state = EXCLUDED.state,
           pincode = EXCLUDED.pincode`,
        [
          id,
          r.username,
          phone,
          r.address,
          r.area,
          r.city,
          r.state,
          String(r.pincode ?? "").replace(/\D/g, "").slice(0, 10),
        ]
      );
      summary.catalog_users++;
    }

    const skuByExcelId = new Map(skus.map((s) => [String(s.id), s]));
    const spByExcelId = new Map(serviceProviders.map((s) => [String(s.id), s]));

    const cityIdBySlug = new Map();
    const distinctPlaces = new Map();
    for (const sp of serviceProviders) {
      const slug = slugifyCity(sp.city);
      const key = `${slug}|${sp.state}`;
      if (!distinctPlaces.has(key)) distinctPlaces.set(key, { city: sp.city, state: sp.state, slug });
    }
    for (const { city, state, slug } of distinctPlaces.values()) {
      const ins = await client.query(
        `INSERT INTO cities (name, state, slug)
         VALUES ($1, $2, $3)
         ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name, state = EXCLUDED.state
         RETURNING id`,
        [city, state, slug]
      );
      cityIdBySlug.set(slug, ins.rows[0].id);
      summary.cities++;
    }

    const pharmacyIdBySpExcel = new Map();
    for (const sp of serviceProviders) {
      const slug = slugifyCity(sp.city);
      const cityId = cityIdBySlug.get(slug);
      const [lat, lng] = coordsForCity(sp.city);
      const pin = String(sp.pincode ?? "").replace(/\D/g, "").slice(0, 10);
      const existing = await client.query(
        `SELECT id FROM pharmacies WHERE city_id = $1 AND name = $2 LIMIT 1`,
        [cityId, sp.name]
      );
      let pid;
      if (existing.rows.length) {
        pid = existing.rows[0].id;
        await client.query(
          `UPDATE pharmacies SET address_line = COALESCE($1, address_line), pincode = COALESCE(NULLIF($2,''), pincode), chain = COALESCE(chain, $3) WHERE id = $4`,
          [sp.address, pin, "PaxMed dataset", pid]
        );
      } else {
        const ins = await client.query(
          `INSERT INTO pharmacies (name, chain, city_id, address_line, pincode, lat, lng)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           RETURNING id`,
          [sp.name, "PaxMed dataset", cityId, sp.address, pin, lat, lng]
        );
        pid = ins.rows[0].id;
        summary.pharmacies++;
      }
      pharmacyIdBySpExcel.set(String(sp.id), pid);
    }

    /**
     * One medicines row per Excel SKU id. The sheet reuses the same display name across many
     * sku rows (different ids / prices); collapsing by name would overwrite pharmacy_prices.
     * generic_name stores an internal import key (not shown in UI).
     */
    const medicineIdBySkuExcel = new Map();
    for (const sku of skus) {
      if (String(sku.category || "").toLowerCase() !== "medicine") continue;
      const name = String(sku.name || "").trim();
      const importRef = `import:sku:${sku.id}`;
      const found = await client.query(`SELECT id FROM medicines WHERE generic_name = $1 LIMIT 1`, [
        importRef,
      ]);
      let mid;
      if (found.rows.length) {
        mid = found.rows[0].id;
      } else {
        const ins = await client.query(
          `INSERT INTO medicines (display_name, generic_name, strength, form, pack_size, schedule)
           VALUES ($1, $2, $3, 'tablet', 10, 'H')
           RETURNING id`,
          [name, importRef, extractStrength(name)]
        );
        mid = ins.rows[0].id;
        summary.medicines++;
      }
      medicineIdBySkuExcel.set(String(sku.id), mid);
    }

    for (const ps of providerSkus) {
      const sku = skuByExcelId.get(String(ps.sku_id));
      if (!sku || String(sku.category || "").toLowerCase() !== "medicine") continue;
      const spRow = spByExcelId.get(String(ps.service_provider_id));
      if (!spRow) continue;
      const pharmacyId = pharmacyIdBySpExcel.get(String(ps.service_provider_id));
      const medicineId = medicineIdBySkuExcel.get(String(ps.sku_id));
      if (!pharmacyId || !medicineId) continue;

      let discount = num(ps.discount, 0);
      const listPrice = num(ps.price, 0);
      if (discount < 0) discount = 0;
      if (discount > listPrice) discount = listPrice;
      const sell = Math.max(0, listPrice - discount);
      const inStock = parseBool(ps.availability);

      await client.query(
        `INSERT INTO pharmacy_prices (pharmacy_id, medicine_id, price_inr, mrp_inr, in_stock, price_type)
         VALUES ($1, $2, $3, $4, $5, 'retail')
         ON CONFLICT (pharmacy_id, medicine_id, price_type) DO UPDATE SET
           price_inr = EXCLUDED.price_inr,
           mrp_inr = EXCLUDED.mrp_inr,
           in_stock = EXCLUDED.in_stock,
           updated_at = now()`,
        [pharmacyId, medicineId, sell, listPrice || null, inStock]
      );
      summary.pharmacy_prices++;
    }

    await client.query("COMMIT");
    console.log("Import OK:", summary);
    console.log(`Source file: ${xlsxPath}`);
  } catch (e) {
    await client.query("ROLLBACK");
    console.error(e);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

main();
