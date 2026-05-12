import { Router } from "express";
import multer from "multer";
import { pool } from "../db/pool.js";
import { parsePricesXlsx } from "../import/excelPrices.js";
import { parseLabPricesXlsx } from "../import/labPricesExcel.js";
import { parseErpExport } from "../import/erpExports.js";

const router = Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 }, // 15MB
});

function slugifyCity(name) {
  return String(name)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}

function detectPriceAnomalies(r) {
  const issues = [];
  const price = Number(r?.price?.price_inr);
  const mrp = r?.price?.mrp_inr == null ? null : Number(r.price.mrp_inr);
  if (!Number.isFinite(price) || price < 0) issues.push("invalid_price");
  if (Number.isFinite(price) && price === 0) issues.push("zero_price");
  if (mrp != null && (!Number.isFinite(mrp) || mrp < 0)) issues.push("invalid_mrp");
  if (mrp != null && Number.isFinite(price) && price > mrp * 1.05) issues.push("price_gt_mrp");
  if (mrp != null && mrp > 0 && Number.isFinite(price) && price >= 0) {
    const off = (mrp - price) / mrp;
    if (off >= 0.8) issues.push("huge_discount");
  }
  const disc = r?.price?.discount_pct;
  if (mrp != null && Number.isFinite(price) && mrp > 0 && disc != null && Number.isFinite(Number(disc))) {
    const implied = (1 - price / mrp) * 100;
    if (Math.abs(implied - Number(disc)) > 2.5) issues.push("discount_pct_mismatch");
  }
  if (Number.isFinite(price) && price > 250_000) issues.push("very_high_price");
  return issues;
}

async function ingestNormalizedRows(client, rows, summary) {
  for (const r of rows) {
    try {
      const anomalies = detectPriceAnomalies(r);
      if (anomalies.length) {
        summary.warnings.push({ row: r.rowNum, issues: anomalies });
      }

      const citySlug = slugifyCity(r.city);
      const cityRes = await client.query(
        `INSERT INTO cities (name, state, slug)
         VALUES ($1, $2, $3)
         ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name, state = EXCLUDED.state
         RETURNING id`,
        [r.city, r.state, citySlug]
      );
      const cityId = cityRes.rows[0].id;

      // Find-or-create pharmacy (name + city). If lat/lng missing, default to 0,0 (caller should provide for map).
      const lat = r.pharmacy.lat ?? 0;
      const lng = r.pharmacy.lng ?? 0;

      const existingPharm = await client.query(
        `SELECT id FROM pharmacies WHERE city_id = $1 AND lower(name) = lower($2) LIMIT 1`,
        [cityId, r.pharmacy.name]
      );
      let pharmacyId;
      if (existingPharm.rows.length) {
        pharmacyId = existingPharm.rows[0].id;
        await client.query(
          `UPDATE pharmacies
           SET chain = COALESCE($1, chain),
               address_line = COALESCE($2, address_line),
               pincode = COALESCE($3, pincode),
               lat = CASE WHEN $4::double precision = 0 AND lat <> 0 THEN lat ELSE $4 END,
               lng = CASE WHEN $5::double precision = 0 AND lng <> 0 THEN lng ELSE $5 END
           WHERE id = $6`,
          [r.pharmacy.chain, r.pharmacy.address_line, r.pharmacy.pincode, lat, lng, pharmacyId]
        );
      } else {
        const insPharm = await client.query(
          `INSERT INTO pharmacies (name, chain, city_id, address_line, pincode, lat, lng)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           RETURNING id`,
          [r.pharmacy.name, r.pharmacy.chain, cityId, r.pharmacy.address_line, r.pharmacy.pincode, lat, lng]
        );
        pharmacyId = insPharm.rows[0].id;
        summary.inserted.pharmacies += 1;
      }

      // Find-or-create medicine (display_name + strength + form + pack_size)
      const existingMed = await client.query(
        `SELECT id FROM medicines
         WHERE lower(display_name) = lower($1)
           AND lower(strength) = lower($2)
           AND lower(form) = lower($3)
           AND pack_size = $4
         LIMIT 1`,
        [r.medicine.display_name, r.medicine.strength, r.medicine.form, r.medicine.pack_size]
      );
      let medicineId;
      if (existingMed.rows.length) {
        medicineId = existingMed.rows[0].id;
        await client.query(
          `UPDATE medicines
           SET generic_name = COALESCE($1, generic_name)
           WHERE id = $2`,
          [r.medicine.generic_name, medicineId]
        );
      } else {
        const insMed = await client.query(
          `INSERT INTO medicines (display_name, generic_name, strength, form, pack_size)
           VALUES ($1, $2, $3, $4, $5)
           RETURNING id`,
          [r.medicine.display_name, r.medicine.generic_name, r.medicine.strength, r.medicine.form, r.medicine.pack_size]
        );
        medicineId = insMed.rows[0].id;
        summary.inserted.medicines += 1;
      }

      // Upsert price (unique on pharmacy_id, medicine_id, price_type)
      const up = await client.query(
        `INSERT INTO pharmacy_prices (pharmacy_id, medicine_id, price_inr, mrp_inr, discount_pct, in_stock, price_type)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (pharmacy_id, medicine_id, price_type)
         DO UPDATE SET price_inr = EXCLUDED.price_inr,
                       mrp_inr = EXCLUDED.mrp_inr,
                       discount_pct = EXCLUDED.discount_pct,
                       in_stock = EXCLUDED.in_stock,
                       updated_at = now()
         RETURNING (xmax = 0) AS inserted`,
        [
          pharmacyId,
          medicineId,
          r.price.price_inr,
          r.price.mrp_inr,
          r.price.discount_pct ?? null,
          r.price.in_stock,
          r.price.price_type,
        ]
      );
      if (up.rows[0].inserted) summary.inserted.prices += 1;
      else summary.updated.prices += 1;
    } catch (e) {
      summary.errors.push({ row: r.rowNum, error: e.message });
    }
  }
}

async function ingestLabPriceRows(client, rows, summary) {
  for (const r of rows) {
    try {
      const { rows: trows } = await client.query(`SELECT 1 FROM lab_tests WHERE id = $1 LIMIT 1`, [r.test_id]);
      if (!trows.length) {
        summary.errors.push({ row: r.rowNum, error: `Unknown test_id ${r.test_id} (use id from PaxMed lab catalog)` });
        continue;
      }

      const citySlug = slugifyCity(r.city);
      const cityRes = await client.query(
        `INSERT INTO cities (name, state, slug)
         VALUES ($1, $2, $3)
         ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name, state = EXCLUDED.state
         RETURNING id`,
        [r.city, r.state, citySlug],
      );
      const cityId = cityRes.rows[0].id;

      const up = await client.query(
        `INSERT INTO lab_test_prices (city_id, lab_name, test_id, price_inr, mrp_inr, discount_pct)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (city_id, lab_name, test_id)
         DO UPDATE SET price_inr = EXCLUDED.price_inr,
                       mrp_inr = EXCLUDED.mrp_inr,
                       discount_pct = EXCLUDED.discount_pct,
                       updated_at = now()
         RETURNING (xmax = 0) AS inserted`,
        [cityId, r.lab_name, r.test_id, r.price_inr, r.mrp_inr, r.discount_pct ?? null],
      );
      if (up.rows[0].inserted) summary.inserted.lab_prices += 1;
      else summary.updated.lab_prices += 1;
    } catch (e) {
      summary.errors.push({ row: r.rowNum, error: e.message });
    }
  }
}

router.post("/prices/xlsx", upload.single("file"), async (req, res) => {
  if (!req.file?.buffer) return res.status(400).json({ error: "Missing file (field name: file)" });

  let parsed;
  try {
    parsed = parsePricesXlsx(req.file.buffer);
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }

  const client = await pool.connect();
  const summary = {
    sheet: parsed.sheetName,
    rows: parsed.rows.length,
    inserted: { cities: 0, pharmacies: 0, medicines: 0, prices: 0, lab_prices: 0 },
    updated: { prices: 0, lab_prices: 0 },
    errors: [],
    warnings: [],
  };

  try {
    await client.query("BEGIN");
    await ingestNormalizedRows(client, parsed.rows, summary);

    await client.query("COMMIT");
    return res.json({ ok: true, summary });
  } catch (e) {
    await client.query("ROLLBACK");
    return res.status(500).json({ ok: false, error: e.message, summary });
  } finally {
    client.release();
  }
});

router.post("/lab-prices/xlsx", upload.single("file"), async (req, res) => {
  if (!req.file?.buffer) return res.status(400).json({ error: "Missing file (field name: file)" });

  let parsed;
  try {
    parsed = parseLabPricesXlsx(req.file.buffer);
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }

  const client = await pool.connect();
  const summary = {
    sheet: parsed.sheetName,
    rows: parsed.rows.length,
    inserted: { lab_prices: 0 },
    updated: { lab_prices: 0 },
    errors: [],
    warnings: [],
  };

  try {
    await client.query("BEGIN");
    await ingestLabPriceRows(client, parsed.rows, summary);
    await client.query("COMMIT");
    return res.json({ ok: true, summary });
  } catch (e) {
    await client.query("ROLLBACK");
    return res.status(500).json({ ok: false, error: e.message, summary });
  } finally {
    client.release();
  }
});

router.post("/erp/marg", upload.single("file"), async (req, res) => {
  if (!req.file?.buffer) return res.status(400).json({ error: "Missing file (field name: file)" });
  let parsed;
  try {
    parsed = parseErpExport(req.file.buffer, req.body, { flavor: "marg" });
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }

  const client = await pool.connect();
  const summary = {
    flavor: "marg",
    sheet: parsed.sheetName,
    rows: parsed.rows.length,
    inserted: { cities: 0, pharmacies: 0, medicines: 0, prices: 0, lab_prices: 0 },
    updated: { prices: 0, lab_prices: 0 },
    errors: [],
    warnings: [],
    detected_headers: parsed.headers,
    stats: parsed.stats,
  };

  try {
    await client.query("BEGIN");
    await ingestNormalizedRows(client, parsed.rows, summary);
    await client.query("COMMIT");
    return res.json({ ok: true, summary });
  } catch (e) {
    await client.query("ROLLBACK");
    return res.status(500).json({ ok: false, error: e.message, summary });
  } finally {
    client.release();
  }
});

router.post("/erp/retailgraph", upload.single("file"), async (req, res) => {
  if (!req.file?.buffer) return res.status(400).json({ error: "Missing file (field name: file)" });
  let parsed;
  try {
    parsed = parseErpExport(req.file.buffer, req.body, { flavor: "retailgraph" });
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }

  const client = await pool.connect();
  const summary = {
    flavor: "retailgraph",
    sheet: parsed.sheetName,
    rows: parsed.rows.length,
    inserted: { cities: 0, pharmacies: 0, medicines: 0, prices: 0, lab_prices: 0 },
    updated: { prices: 0, lab_prices: 0 },
    errors: [],
    warnings: [],
    detected_headers: parsed.headers,
    stats: parsed.stats,
  };

  try {
    await client.query("BEGIN");
    await ingestNormalizedRows(client, parsed.rows, summary);
    await client.query("COMMIT");
    return res.json({ ok: true, summary });
  } catch (e) {
    await client.query("ROLLBACK");
    return res.status(500).json({ ok: false, error: e.message, summary });
  } finally {
    client.release();
  }
});

export default router;

