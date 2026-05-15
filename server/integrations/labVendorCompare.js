import crypto from "node:crypto";
import { parseUserLatLngFromQuery } from "../geo/pharmacyOffersGeo.js";
import { labPriceLateralSql } from "../labs/priceJoin.js";
import {
  isDiagnosticsPartnerEnabled,
  mapPartnerPackageToLabRow,
  searchPartnerPackages,
} from "./diagnosticsPartner.js";

function getEnv(name, fallback = "") {
  return String(process.env[name] || fallback).trim();
}

export function labsGeoAttachmentForReq(req) {
  const u = parseUserLatLngFromQuery(req.query);
  if (!u) return {};
  return {
    geo: {
      user_lat: u.lat,
      user_lng: u.lng,
      note:
        "Diagnostics catalog is city-scoped; coordinates are echoed for clients and passed to the partner API when supported.",
    },
  };
}

/** Group multiple vendor rows for the same consumer-facing test name. */
export function normalizeDiagGroupingKey(heading) {
  return String(heading || "")
    .toLowerCase()
    .replace(/[\u2019']/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function hashSeed(parts) {
  return crypto.createHash("sha256").update(parts.join("|")).digest("hex");
}

function stubPriceFromBase(baseInr, vendorKey, groupingKey) {
  const n = Number(baseInr);
  if (!Number.isFinite(n) || n <= 0) return null;
  const h = hashSeed(["diag_stub", vendorKey, groupingKey]);
  const offset = Number.parseInt(h.slice(0, 4), 16) % 19;
  const pct = (offset - 9) / 100;
  return Math.max(1, Math.round(n * (1 + pct)));
}

function vendorStubsEnabled() {
  const v = getEnv("DIAG_VENDOR_STUB_QUOTES", "true").toLowerCase();
  return v !== "false" && v !== "0";
}

/**
 * Placeholder vendor HTTP integrations. Returns normalized offers when a base URL exists;
 * parsing is intentionally minimal — extend once contract JSON is finalized.
 */
async function fetchQuotesFromConfigurableVendor({ baseEnv, bearerEnv, vendorKey, vendorLabel, q, pincode }) {
  const base = getEnv(baseEnv);
  const bearer = getEnv(bearerEnv);
  if (!base || !/^https?:\/\//i.test(base)) return [];
  try {
    const u = new URL("search", base.endsWith("/") ? base : `${base}/`);
    u.searchParams.set("q", String(q || "").slice(0, 120));
    if (pincode) u.searchParams.set("pincode", String(pincode).slice(0, 10));
    const headers = { Accept: "application/json" };
    if (bearer) headers.Authorization = `Bearer ${bearer}`;
    const res = await fetch(u.toString(), { method: "GET", headers, signal: AbortSignal.timeout(12_000) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return [];
    const raw = Array.isArray(data.items)
      ? data.items
      : Array.isArray(data.packages)
        ? data.packages
        : Array.isArray(data.data)
          ? data.data
          : [];
    return raw
      .slice(0, 40)
      .map((item, idx) => {
      const heading = String(item.heading ?? item.name ?? item.package_name ?? item.title ?? "Diagnostics").slice(0, 200);
      const price = Number(item.price_inr ?? item.price ?? item.offer_price);
      if (!Number.isFinite(price) || price <= 0) return null;
      const mrp = item.mrp_inr != null ? Number(item.mrp_inr) : item.mrp != null ? Number(item.mrp) : null;
      const pid = String(item.package_id ?? item.deal_id ?? item.id ?? `ext-${idx}`).slice(0, 120);
      return decorateOffer(rowCoreFromParts({ heading, sub: "", price, mrp, packageId: pid, dealId: pid }), {
        vendor_key: vendorKey,
        vendor_label: vendorLabel,
        booking_supported: true,
        data_mode: "partner_api_exploratory",
        vendor_note:
          "Live quote preview; book via PaxMed as a confirmed request (vendor order API not wired to this flow yet).",
      });
    })
      .filter(Boolean);
  } catch {
    return [];
  }
}

function rowCoreFromParts({
  heading,
  sub,
  category = "PATHOLOGY",
  icon_url = null,
  slug = "",
  report_tat_hours = null,
  home_collection = true,
  lab_name = "",
  price,
  mrp,
  discount_pct = null,
  provider = "",
  packageId,
  dealId,
  tests_included = [],
}) {
  return {
    heading: String(heading || "").trim(),
    sub_heading: String(sub || "").trim(),
    category,
    icon_url,
    slug,
    report_tat_hours,
    home_collection,
    lab_name,
    price_inr: Number(price),
    mrp_inr: mrp == null ? null : Number(mrp),
    discount_pct,
    provider,
    package_id: String(packageId || ""),
    deal_id: String(dealId || packageId || ""),
    tests_included,
  };
}

function decorateOffer(row, meta) {
  return {
    ...row,
    vendor_key: meta.vendor_key,
    vendor_label: meta.vendor_label,
    booking_supported: Boolean(meta.booking_supported),
    data_mode: meta.data_mode || "unknown",
    vendor_note: meta.vendor_note || null,
    id: row.package_id || row.id,
  };
}

function dedupeOffers(list) {
  const seen = new Set();
  const out = [];
  for (const o of list) {
    const pid = `${o.vendor_key}|${o.package_id}|${o.deal_id}`;
    if (seen.has(pid)) continue;
    seen.add(pid);
    out.push(o);
  }
  return out;
}

/** Stub vs API share a consumer brand label; skip synthetic stub row if we already surface that vendor for the grouping key. */
function hasBrandOfferForGrouping(items, stubVendorKey, groupingKeyNorm) {
  const g = String(groupingKeyNorm || "").trim();
  if (!g) return false;
  for (const x of items) {
    const xv = String(x.vendor_key || "");
    let same = xv === stubVendorKey;
    if (stubVendorKey === "thyrocare") same = xv === "thyrocare" || xv === "thyrocare_api";
    if (stubVendorKey === "lucid") same = xv === "lucid" || xv === "lucid_api";
    if (same && normalizeDiagGroupingKey(x.heading) === g) return true;
  }
  return false;
}

async function loadLocalLabOfferRows(pool, { q, citySlug, category }) {
  const like = `%${q.toLowerCase()}%`;
  const params = [like, citySlug];
  let catSql = "";
  if (category === "PATHOLOGY" || category === "RADIOLOGY") {
    params.push(category);
    catSql = " AND t.category = $3";
  }
  const { rows } = await pool.query(
    `SELECT
      t.id,
      t.heading,
      t.sub_heading,
      t.category,
      t.icon_url,
      t.slug,
      t.report_tat_hours,
      t.home_collection,
      p.lab_name,
      p.price_inr,
      p.mrp_inr,
      p.discount_pct
     FROM lab_tests t
     JOIN cities c ON c.slug = $2
     ${labPriceLateralSql("$2")}
     WHERE t.search_vector LIKE $1${catSql}
     ORDER BY p.price_inr ASC NULLS LAST
     LIMIT 60`,
    params
  );
  return rows;
}

function offersIntoGroups(offers) {
  const map = new Map();
  for (const o of offers) {
    const k = normalizeDiagGroupingKey(o.heading);
    if (!k) continue;
    if (!map.has(k)) {
      map.set(k, {
        grouping_key: k,
        heading: o.heading,
        sub_heading: o.sub_heading || "",
        category: o.category || "PATHOLOGY",
        icon_url: o.icon_url || null,
        offers: [],
      });
    }
    const g = map.get(k);
    if (!g.icon_url && o.icon_url) g.icon_url = o.icon_url;
    g.offers.push(o);
  }
  const groups = [...map.values()].map((g) => ({
    ...g,
    offers: g.offers.sort((a, b) => {
      const pa = Number(a.price_inr);
      const pb = Number(b.price_inr);
      if (Number.isFinite(pa) && Number.isFinite(pb) && pa !== pb) return pa - pb;
      return String(a.vendor_label || "").localeCompare(String(b.vendor_label || ""));
    }),
  }));
  groups.sort((a, b) => String(a.heading).localeCompare(String(b.heading)));
  return groups;
}

/**
 * @param {import("pg").Pool} pool
 * @param {{ q: string; citySlug: string; pincode: string; category: string; lat?: number|null; lng?: number|null }} p
 */
export async function labsCompareBundles(pool, p) {
  const partnerEnabled = isDiagnosticsPartnerEnabled();
  /** Catalog rows remain bookable: server routes them to PaxMed-confirmed orders, not Healthians deal IDs when partner APIs are on. */
  const catalogBookingOk = true;
  const items = [];

  if (partnerEnabled) {
    try {
      const partner = await searchPartnerPackages({
        query: p.q,
        city: p.citySlug,
        category: p.category,
        pincode: p.pincode,
        ...(p.lat != null && p.lng != null ? { lat: p.lat, lng: p.lng } : {}),
      });
      for (const pkg of partner.packages || []) {
        const row = mapPartnerPackageToLabRow(pkg);
        items.push(
          decorateOffer(
            rowCoreFromParts({
              heading: row.heading,
              sub: row.sub_heading,
              category: row.category,
              icon_url: row.icon_url,
              slug: row.slug,
              report_tat_hours: row.report_tat_hours,
              home_collection: row.home_collection,
              lab_name: row.lab_name,
              price: row.price_inr,
              mrp: row.mrp_inr,
              discount_pct: row.discount_pct,
              provider: row.provider,
              packageId: row.package_id,
              dealId: row.deal_id,
              tests_included: row.tests_included || [],
            }),
            {
              vendor_key: "healthians",
              vendor_label: "Healthians",
              booking_supported: true,
              data_mode: "partner_api",
            },
          ),
        );
      }
    } catch {
      /* partner optional for compare UX */
    }
  }

  const localRows = await loadLocalLabOfferRows(pool, p);
  for (const r of localRows) {
    items.push(
      decorateOffer(
        rowCoreFromParts({
          heading: r.heading,
          sub: r.sub_heading,
          category: r.category,
          icon_url: r.icon_url,
          slug: r.slug,
          report_tat_hours: r.report_tat_hours,
          home_collection: r.home_collection,
          lab_name: r.lab_name,
          price: r.price_inr,
          mrp: r.mrp_inr,
          discount_pct: r.discount_pct,
          provider: "",
          packageId: String(r.id),
          dealId: String(r.id),
          tests_included: [],
        }),
        {
          vendor_key: "paxmed_catalog",
          vendor_label: String(r.lab_name || "PaxMed catalog"),
          booking_supported: catalogBookingOk,
          data_mode: "local_catalog",
          vendor_note: partnerEnabled
            ? "Book via PaxMed; confirmed as our order (catalog SKU, separate from Healthians B2B slot booking)."
            : null,
        },
      ),
    );
  }

  const exploratory = [];
  exploratory.push(
    ...(await fetchQuotesFromConfigurableVendor({
      baseEnv: "THYROCARE_PARTNER_API_BASE",
      bearerEnv: "THYROCARE_PARTNER_BEARER",
      vendorKey: "thyrocare_api",
      vendorLabel: "Thyrocare",
      q: p.q,
      pincode: p.pincode,
    })),
  );
  exploratory.push(
    ...(await fetchQuotesFromConfigurableVendor({
      baseEnv: "LUCID_PARTNER_API_BASE",
      bearerEnv: "LUCID_PARTNER_BEARER",
      vendorKey: "lucid_api",
      vendorLabel: "Lucid Diagnostics",
      q: p.q,
      pincode: p.pincode,
    })),
  );
  items.push(...exploratory);

  if (vendorStubsEnabled()) {
    const baseKeys = new Map();
    for (const o of items) {
      const k = normalizeDiagGroupingKey(o.heading);
      const pr = Number(o.price_inr);
      if (!k || !Number.isFinite(pr) || pr <= 0) continue;
      const prev = baseKeys.get(k);
      if (prev == null || pr < prev) baseKeys.set(k, pr);
    }
    const stubPairs = [
      ["thyrocare", "Thyrocare"],
      ["lucid", "Lucid Diagnostics"],
    ];
    for (const [gk, base] of baseKeys.entries()) {
      for (const [vk, label] of stubPairs) {
        if (hasBrandOfferForGrouping(items, vk, gk)) continue;
        const jitter = stubPriceFromBase(base, vk, gk);
        if (jitter == null) continue;
        const headingHuman = [...items].find((x) => normalizeDiagGroupingKey(x.heading) === gk)?.heading || gk;
        const syntheticId = `stub:${vk}:${hashSeed(["id", vk, gk]).slice(0, 12)}`;
        items.push(
          decorateOffer(
            rowCoreFromParts({
              heading: headingHuman,
              sub: "Illustrative quote for comparison",
              lab_name: label,
              price: jitter,
              mrp: Math.round(jitter * 1.12 * 100) / 100,
              provider: vk,
              packageId: syntheticId,
              dealId: syntheticId,
            }),
            {
              vendor_key: vk,
              vendor_label: label,
              booking_supported: true,
              data_mode: "illustrative_vendor_stub",
              vendor_note:
                "Benchmark quote; you can still place a PaxMed booking — ops will align with the selected lab/vendor.",
            },
          ),
        );
      }
    }
  }

  const flat = dedupeOffers(items);
  const groups = offersIntoGroups(flat);

  const priced = flat.map((x) => Number(x.price_inr)).filter((n) => Number.isFinite(n));
  const min = priced.length ? Math.min(...priced) : null;
  const max = priced.length ? Math.max(...priced) : null;
  let spread_percent = null;
  if (min != null && max != null && max > 0 && min < max) {
    spread_percent = Math.round(((max - min) / max) * 1000) / 10;
  }

  return {
    groups,
    stats: { min_inr: min, max_inr: max, spread_percent },
    meta: {
      partner_enabled: partnerEnabled,
      stub_vendors_enabled: vendorStubsEnabled(),
    },
  };
}
