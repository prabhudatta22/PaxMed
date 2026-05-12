import XLSX from "xlsx";
import { deriveDiscountPct, parseOptionalDiscountPct } from "./discountPct.js";

function normHeader(h) {
  return String(h || "")
    .trim()
    .toLowerCase()
    .replace(/[^\w]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function toRows(buffer) {
  const wb = XLSX.read(buffer, { type: "buffer", cellDates: true });
  const sheetName = wb.SheetNames[0];
  if (!sheetName) throw new Error("No worksheet found");
  const ws = wb.Sheets[sheetName];
  const aoa = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true });
  if (!aoa.length) throw new Error("Sheet is empty");
  const headers = (aoa[0] || []).map(normHeader);
  const rows = [];
  for (let i = 1; i < aoa.length; i += 1) {
    const line = aoa[i];
    if (!line || line.every((c) => c === undefined || c === null || String(c).trim() === "")) continue;
    const obj = {};
    for (let c = 0; c < headers.length; c += 1) {
      const k = headers[c];
      if (!k) continue;
      obj[k] = line[c];
    }
    rows.push({ rowNum: i + 1, row: obj });
  }
  return { sheetName, headers, rows };
}

function pick(row, keys) {
  for (const k of keys) {
    if (row[k] != null && String(row[k]).trim() !== "") return row[k];
  }
  return null;
}

function asMoney(v) {
  if (v == null || String(v).trim() === "") return null;
  const n = Number(String(v).replace(/,/g, "").trim());
  return Number.isFinite(n) ? n : null;
}

function asQty(v) {
  if (v == null || String(v).trim() === "") return null;
  const n = Number(String(v).replace(/,/g, "").trim());
  if (!Number.isFinite(n)) return null;
  return n;
}

function asBool(v) {
  if (v === true) return true;
  if (v === false) return false;
  const s = String(v ?? "").trim().toLowerCase();
  if (!s) return null;
  if (["true", "1", "yes", "y", "available", "in_stock", "instock"].includes(s)) return true;
  if (["false", "0", "no", "n", "na", "n_a", "out", "out_of_stock", "oos"].includes(s)) return false;
  return null;
}

/**
 * Parse an ERP export (Marg/RetailGraph/etc.) into PaxMed normalized rows.
 *
 * Because these exports usually don't contain store identity, the caller must provide:
 * { city, state, pharmacy_name } and optionally { chain, address_line, pincode, lat, lng }.
 *
 * Supported file types: .xlsx, .xls, .csv (XLSX can read CSV buffers).
 */
export function parseErpExport(buffer, meta, opts) {
  const { sheetName, headers, rows } = toRows(buffer);
  const flavor = opts?.flavor || "unknown";

  const city = String(meta?.city || "").trim();
  const state = String(meta?.state || "").trim();
  const pharmacyName = String(meta?.pharmacy_name || "").trim();
  if (!city || !state || !pharmacyName) {
    throw new Error('Missing required fields: "city", "state", "pharmacy_name"');
  }

  const chain = meta?.chain != null && String(meta.chain).trim() !== "" ? String(meta.chain).trim() : null;
  const addressLine =
    meta?.address_line != null && String(meta.address_line).trim() !== "" ? String(meta.address_line).trim() : null;
  const pincode = meta?.pincode != null && String(meta.pincode).trim() !== "" ? String(meta.pincode).trim() : null;
  const lat = meta?.lat != null && String(meta.lat).trim() !== "" ? Number(meta.lat) : null;
  const lng = meta?.lng != null && String(meta.lng).trim() !== "" ? Number(meta.lng) : null;

  const normalized = [];
  for (const { rowNum, row } of rows) {
    // Common column aliases across Marg/RetailGraph style exports:
    const name = pick(row, [
      "item_name",
      "item",
      "product",
      "product_name",
      "medicine",
      "drug_name",
      "description",
      "particulars",
      "name",
    ]);

    if (!name || String(name).trim().length < 2) continue;

    const strength = pick(row, ["strength", "dose", "dosage"]) || "—";
    const form = pick(row, ["form", "dosage_form"]) || "tablet";
    const packSizeRaw = pick(row, ["pack_size", "pack", "pack_qty", "packqty"]);
    const packSize = packSizeRaw != null && String(packSizeRaw).trim() !== "" ? Number(packSizeRaw) : 10;

    const mrp = asMoney(pick(row, ["mrp", "mrp_rs", "mrp_inr", "mrp_rate", "mrpamount", "mrp_amount"]));
    const sell = asMoney(
      pick(row, [
        "sale_rate",
        "saleprice",
        "sale_price",
        "rate",
        "retail_rate",
        "net_rate",
        "netrate",
        "price",
        "price_inr",
      ])
    );
    const qty = asQty(pick(row, ["qty", "quantity", "stock", "closing_stock", "balance", "bal_qty"]));
    const avail =
      asBool(pick(row, ["availability", "available", "in_stock", "instock"])) ??
      (qty != null ? qty > 0 : null);

    let priceInr = sell ?? mrp;
    let discountPct = null;
    try {
      discountPct = parseOptionalDiscountPct(row);
    } catch {
      /* invalid or unknown discount column */
    }
    if (priceInr == null && mrp != null && discountPct != null) {
      const d = Number(mrp) * (1 - Number(discountPct) / 100);
      priceInr = Math.round(d * 100) / 100;
    }
    if (priceInr == null) {
      // Can't price this row; skip.
      continue;
    }

    if (discountPct == null && mrp != null && Number.isFinite(Number(mrp)) && Number(mrp) > 0) {
      discountPct = deriveDiscountPct(Number(priceInr), Number(mrp));
    }

    normalized.push({
      rowNum,
      source: `erp:${flavor}`,
      city,
      state,
      pharmacy: { name: pharmacyName, chain, address_line: addressLine, pincode, lat, lng },
      medicine: {
        display_name: String(name).trim(),
        generic_name: null,
        strength: String(strength || "—").trim(),
        form: String(form || "tablet").trim(),
        pack_size: Number.isFinite(packSize) && packSize > 0 ? Math.floor(packSize) : 10,
      },
      price: {
        price_inr: Number(priceInr),
        mrp_inr: mrp != null ? Number(mrp) : null,
        discount_pct: discountPct,
        price_type: "retail",
        in_stock: avail == null ? true : Boolean(avail),
      },
      raw: row,
    });
  }

  return {
    flavor,
    sheetName,
    headers,
    rows: normalized,
    stats: { input_rows: rows.length, normalized_rows: normalized.length },
  };
}

