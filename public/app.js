import { addCartLine, cartLineCount, STORAGE_KEY } from "./cartStore.js";
import { clearCachedUser, fetchAndCacheUser, loadCachedUser } from "./authProfile.js";

const $ = (id) => document.getElementById(id);

const SEARCH_DEBOUNCE_MS = 420;
const MIN_QUERY_LEN = 2;
const SUGGEST_MIN_QUERY_LEN = 3;
const SUGGEST_DEBOUNCE_MS = 180;
const NORMALIZE_MIN_LEN = 3;

function refreshCartBadge() {
  const n = cartLineCount();
  const el = $("cartBadge");
  if (!el) return;
  el.textContent = String(n);
  el.classList.toggle("hidden", n === 0);
}

let cities = [];
/** For purchase-reminder deep link only — set when local results show exactly one medicine */
let selectedMedicine = null;
let loggedIn = false;
let currentUser = null;
/** @type {{ provider_id: string, label: string, search_url: string, price_inr?: number } | null} */
let selectedOnlineOffer = null;

/** @type {AbortController | null} */
let compareAbort = null;

/** @type {AbortController | null} */
let rxReviewBatchAbort = null;

let liveQuery = "";

const GEO_STORAGE_KEY = "paxmed_geo_location_v1";
const RECENT_SEARCH_KEY = "paxmed_recent_searches_v1";
const RECENT_MAX = 6;
const COMPARE_SORT_STORAGE_KEY = "paxmed_compare_sort_v1";
const COMPARE_RADIUS_STORAGE_KEY = "paxmed_compare_radius_km_v1";

const DEFAULT_METRO_CITIES = [
  { slug: "mumbai", name: "Mumbai", state: "Maharashtra" },
  { slug: "bengaluru", name: "Bengaluru", state: "Karnataka" },
  { slug: "new-delhi", name: "New Delhi", state: "Delhi" },
];

function setCityOptions(sel, list) {
  if (!sel) return;
  sel.innerHTML = (list || [])
    .map(
      (c) =>
        `<option value="${escapeAttr(c.slug)}">${escapeHtml(c.name)}, ${escapeHtml(c.state || "")}</option>`
    )
    .join("");
}

async function loadCities() {
  const sel = $("city");
  try {
    const res = await fetch("/api/cities");
    const data = await res.json().catch(() => ({}));
    cities = data.cities || [];
  } catch {
    cities = [];
  }

  if (!Array.isArray(cities) || cities.length === 0) {
    cities = DEFAULT_METRO_CITIES.slice();
  }

  setCityOptions(sel, cities);
  restoreGeoFromSession();
  initCompareRankControls();
  if (!loadGeoState()?.google) maybeAutoLocateFromPermission();
}

function saveGeoState(google, matched_city) {
  try {
    sessionStorage.setItem(
      GEO_STORAGE_KEY,
      JSON.stringify({
        google,
        matched_city: matched_city
          ? { slug: matched_city.slug, name: matched_city.name, state: matched_city.state }
          : null,
      })
    );
  } catch {
    /* ignore quota / private mode */
  }
}

function loadGeoState() {
  try {
    const raw = sessionStorage.getItem(GEO_STORAGE_KEY);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function renderLocationDetail(google, matched_city) {
  const el = $("locationDetail");
  if (!el) return;
  if (!google?.formatted_address) {
    el.classList.add("hidden");
    el.innerHTML = "";
    return;
  }
  el.classList.remove("hidden");
  const metaParts = [google.locality, google.administrative_area_level_1, google.country].filter(Boolean);
  const pin = google.postal_code ? `PIN ${escapeHtml(google.postal_code)}` : "";
  const matchHtml = matched_city
    ? `<span class="muted">Local demo prices: <strong>${escapeHtml(matched_city.name)}</strong> (${escapeHtml(
        matched_city.state || ""
      )})</span>`
    : `<span class="muted">No demo city matched this address — choose the closest city in the list.</span>`;
  const ll =
    google.lat != null && google.lng != null
      ? `${Number(google.lat).toFixed(5)}, ${Number(google.lng).toFixed(5)}`
      : "";
  el.innerHTML = `
    <div class="location-line-primary">${escapeHtml(google.formatted_address)}</div>
    <div class="location-meta muted">
      ${escapeHtml(metaParts.join(" · "))}${pin ? ` · ${escapeHtml(pin)}` : ""}
      ${ll ? `<br/>Coordinates: ${escapeHtml(ll)}` : ""}
    </div>
    <div class="location-meta" style="margin-top: 0.4rem">${matchHtml}</div>`;
}

function applyGeocodeResponse(body) {
  const { google, matched_city } = body;
  const sel = $("city");
  if (matched_city && sel) {
    const ok = [...sel.options].some((o) => o.value === matched_city.slug);
    if (ok) sel.value = matched_city.slug;
  }
  if (google) {
    const pinEl = $("pincode");
    if (pinEl && google.postal_code) {
      const d = String(google.postal_code).replace(/\D/g, "").slice(0, 6);
      if (d.length === 6 && !pinEl.value.trim()) pinEl.value = d;
    }
    renderLocationDetail(google, matched_city);
    saveGeoState(google, matched_city);
  }
}

/** 6-digit PIN for database-backed “Online retailers” compare (input or geocoded). */
function getComparePincode() {
  const raw = $("pincode")?.value?.trim() || "";
  const digits = raw.replace(/\D/g, "").slice(0, 6);
  if (digits.length === 6) return digits;
  const geoPin = loadGeoState()?.google?.postal_code;
  if (geoPin) {
    const d = String(geoPin).replace(/\D/g, "").slice(0, 6);
    if (d.length === 6) return d;
  }
  return "";
}

function mapsUrlFromDbOffer(o) {
  const mapsQuery = [o.address_line, o.pincode, o.city_name, o.pharmacy_name].filter(Boolean).join(" ");
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(mapsQuery)}`;
}

/** Show partner-stated discount %, or derive from MRP vs price when present. */
function formatOfferDiscountPct(o) {
  if (o == null) return "—";
  if (o.discount_pct != null && Number.isFinite(Number(o.discount_pct)) && Number(o.discount_pct) > 0) {
    const d = Number(o.discount_pct);
    return d % 1 < 0.05 ? `${Math.round(d)}%` : `${d.toFixed(1)}%`;
  }
  if (o.mrp_inr != null && o.price_inr != null) {
    const m = Number(o.mrp_inr);
    const p = Number(o.price_inr);
    if (Number.isFinite(m) && Number.isFinite(p) && m > 0 && p <= m * 1.001) {
      const im = (1 - p / m) * 100;
      if (im > 0.25) return im % 1 < 0.05 ? `${Math.round(im)}%` : `${Math.round(im * 10) / 10}%`;
    }
  }
  return "—";
}

/** Numeric discount % off MRP (stored or derived). */
function numericDiscountPctFromOffer(o) {
  if (o == null) return null;
  if (o.discount_pct != null && Number.isFinite(Number(o.discount_pct)) && Number(o.discount_pct) >= 0) {
    return Number(o.discount_pct);
  }
  const m = Number(o.mrp_inr);
  const p = Number(o.price_inr);
  if (Number.isFinite(m) && m > 0 && Number.isFinite(p) && p >= 0 && p <= m * 1.001) {
    return Math.round((1 - p / m) * 100000) / 1000;
  }
  return null;
}

/** Rupees saved vs MRP for one listing (MRP − selling price). */
function rupeesSaveVsMrp(o) {
  const m = Number(o?.mrp_inr);
  const p = Number(o?.price_inr);
  if (!Number.isFinite(m) || m <= 0 || !Number.isFinite(p)) return null;
  const s = m - p;
  return s > 0.005 ? s : null;
}

function formatSaveVsMrpCell(o) {
  const s = rupeesSaveVsMrp(o);
  return s == null ? "—" : `<strong>₹${fmt(s)}</strong>`;
}

/** Subtitle when user picks a DB listing (discount + save vs MRP). */
function selectionSavingsPhrase(p) {
  const disc = numericDiscountPctFromOffer(p);
  const save = rupeesSaveVsMrp(p);
  const parts = [];
  if (disc != null && disc > 0) parts.push(`${disc % 1 < 0.05 ? Math.round(disc) : disc.toFixed(1)}% off MRP`);
  if (save != null) parts.push(`save ₹${fmt(save)} vs MRP`);
  return parts.length ? ` · ${parts.join(" · ")}` : "";
}

/** lat/lng + optional sort_by + radius_km for /api/compare/* */
function getMedicineCompareGeoAndRankQuery() {
  const g = loadGeoState()?.google;
  const la = Number(g?.lat);
  const lo = Number(g?.lng);
  const hasCoords = Number.isFinite(la) && Number.isFinite(lo);
  let s = "";
  if (hasCoords) {
    s += `&lat=${encodeURIComponent(la)}&lng=${encodeURIComponent(lo)}`;
  }
  const sortVal = ($("compareSortBy")?.value || "nearest").toString();
  if (sortVal === "price") s += "&sort_by=price";
  const radRaw = ($("compareRadiusKm")?.value || "default").toString();
  if (hasCoords && radRaw && radRaw !== "default") {
    const n = Number(radRaw);
    if (Number.isFinite(n) && n > 0 && n <= 500) s += `&radius_km=${encodeURIComponent(n)}`;
  }
  return s;
}

function initCompareRankControls() {
  const sortSel = $("compareSortBy");
  const radSel = $("compareRadiusKm");
  if (sortSel) {
    try {
      const v = sessionStorage.getItem(COMPARE_SORT_STORAGE_KEY);
      if (v === "price" || v === "nearest") sortSel.value = v;
    } catch {
      /* ignore */
    }
    sortSel.addEventListener("change", () => {
      try {
        sessionStorage.setItem(COMPARE_SORT_STORAGE_KEY, sortSel.value);
      } catch {
        /* ignore */
      }
      clearTimeout(searchTimer);
      runRealtimeSearch();
    });
  }
  if (radSel) {
    try {
      const v = sessionStorage.getItem(COMPARE_RADIUS_STORAGE_KEY);
      if (v && [...radSel.options].some((o) => o.value === v)) radSel.value = v;
    } catch {
      /* ignore */
    }
    radSel.addEventListener("change", () => {
      try {
        sessionStorage.setItem(COMPARE_RADIUS_STORAGE_KEY, radSel.value);
      } catch {
        /* ignore */
      }
      clearTimeout(searchTimer);
      runRealtimeSearch();
    });
  }
}

function formatDistanceKm(d) {
  if (d == null || !Number.isFinite(Number(d))) return "—";
  const x = Number(d);
  if (x < 10 && x !== Math.round(x)) return `${x.toFixed(1)} km`;
  return `${Math.round(x)} km`;
}

/** Map /api/compare/by-pincode JSON into the shape expected by renderOnlineTable */
function dbCompareResponseToOnlineShape(data) {
  const offers = data.offers || [];
  const prices = offers.map((o) => Number(o.price_inr)).filter((n) => Number.isFinite(n));
  const min = prices.length ? Math.min(...prices) : null;
  const max = prices.length ? Math.max(...prices) : null;
  let spread_percent = null;
  if (min != null && max != null && max > 0 && min < max) {
    spread_percent = Math.round(((max - min) / max) * 1000) / 10;
  }
  const stats =
    data.stats && (data.stats.min_inr != null || data.stats.max_inr != null)
      ? data.stats
      : { min_inr: min, max_inr: max, spread_percent };

  return {
    source: "db",
    filter_label: data.filter_label || "",
    parallel_ms: 0,
    stats,
    providers: offers.map((o) => ({
      provider_id: `db-${o.pharmacy_id}-${o.price_id}`,
      label: o.chain ? `${o.pharmacy_name} (${o.chain})` : o.pharmacy_name,
      ok: true,
      price_inr: o.price_inr,
      mrp_inr: o.mrp_inr,
      product_title: `${o.display_name} · ${o.strength || ""}`.trim(),
      search_url: mapsUrlFromDbOffer(o),
      website: mapsUrlFromDbOffer(o),
      data_mode: "local_db",
      discount_pct: o.discount_pct != null ? Number(o.discount_pct) : null,
      pharmacy_id: o.pharmacy_id,
      medicine_id: o.medicine_id,
      address_line: o.address_line,
      pincode: o.pincode,
      city_name: o.city_name,
      pharmacy_name: o.pharmacy_name,
      chain: o.chain,
      display_name: o.display_name,
      strength: o.strength,
      distance_km: o.distance_km != null && Number.isFinite(Number(o.distance_km)) ? Number(o.distance_km) : null,
    })),
  };
}

function restoreGeoFromSession() {
  const saved = loadGeoState();
  if (!saved?.google) return;
  renderLocationDetail(saved.google, saved.matched_city);
  if (saved.matched_city?.slug) {
    const sel = $("city");
    if (sel && [...sel.options].some((o) => o.value === saved.matched_city.slug)) {
      sel.value = saved.matched_city.slug;
    }
  }
}

async function reverseGeocodeCoords(latitude, longitude) {
  const res = await fetch(
    `/api/geocode/reverse?lat=${encodeURIComponent(latitude)}&lng=${encodeURIComponent(longitude)}`
  );
  const data = await res.json();
  if (!res.ok) {
    const msg = data.error || data.hint || `Geocoding failed (${res.status})`;
    throw new Error(msg);
  }
  return data;
}

function useBrowserLocation() {
  const btn = $("useLocationBtn");
  const hint = $("locationHint");
  if (!navigator.geolocation) {
    if (hint) hint.textContent = "Geolocation is not supported in this browser.";
    return;
  }
  if (btn) btn.disabled = true;
  if (hint) hint.textContent = "Getting your location…";

  navigator.geolocation.getCurrentPosition(
    async (pos) => {
      try {
        if (hint) hint.textContent = "Looking up address with Google…";
        const { latitude, longitude } = pos.coords;
        const data = await reverseGeocodeCoords(latitude, longitude);
        applyGeocodeResponse(data);
        if (hint) hint.textContent = "";
        if (btn) btn.disabled = false;
        runRealtimeSearch();
      } catch (e) {
        if (hint) hint.textContent = String(e?.message || e);
        if (btn) btn.disabled = false;
      }
    },
    (err) => {
      if (hint) {
        hint.textContent =
          err.code === 1
            ? "Location blocked. Allow location for this site in browser settings, or pick a city below."
            : `Location unavailable (${err.message || err.code}). Pick a city below.`;
      }
      if (btn) btn.disabled = false;
    },
    { enableHighAccuracy: true, timeout: 18000, maximumAge: 300_000 }
  );
}

/** If the user already granted geolocation, refresh address without an extra permission prompt */
function maybeAutoLocateFromPermission() {
  if (!navigator.geolocation || !navigator.permissions?.query) return;
  navigator.permissions
    .query({ name: "geolocation" })
    .then((p) => {
      if (p.state !== "granted") return;
      const hint = $("locationHint");
      if (hint) hint.textContent = "Refreshing location…";
      navigator.geolocation.getCurrentPosition(
        async (pos) => {
          try {
            const { latitude, longitude } = pos.coords;
            const data = await reverseGeocodeCoords(latitude, longitude);
            applyGeocodeResponse(data);
            if (hint) hint.textContent = "";
            runRealtimeSearch();
          } catch (e) {
            if (hint) hint.textContent = String(e?.message || e);
          }
        },
        () => {
          if (hint) hint.textContent = "";
        },
        { enableHighAccuracy: true, timeout: 15000, maximumAge: 300_000 }
      );
    })
    .catch(() => {});
}

$("useLocationBtn")?.addEventListener("click", () => useBrowserLocation());

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function escapeAttr(s) {
  return escapeHtml(s).replace(/'/g, "&#39;");
}

function loadRecentSearches() {
  try {
    const raw = localStorage.getItem(RECENT_SEARCH_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function saveRecentSearch(q) {
  const s = String(q || "").trim();
  if (!s) return;
  const arr = loadRecentSearches().filter((x) => x.toLowerCase() !== s.toLowerCase());
  arr.unshift(s);
  const next = arr.slice(0, RECENT_MAX);
  try {
    localStorage.setItem(RECENT_SEARCH_KEY, JSON.stringify(next));
  } catch {
    /* ignore */
  }
  renderRecentChips();
}

function renderRecentChips() {
  const host = document.querySelector('.quick-chips[aria-label="Quick searches"]');
  if (!host) return;
  const existing = host.querySelector(".recent-chip-group");
  if (existing) existing.remove();
  const recent = loadRecentSearches();
  if (!recent.length) return;
  const wrap = document.createElement("div");
  wrap.className = "recent-chip-group";
  wrap.style.display = "contents";
  recent.slice(0, 4).forEach((q) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "chip";
    btn.textContent = q;
    btn.addEventListener("click", () => {
      const input = $("q");
      if (!input) return;
      input.value = q;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.focus();
    });
    wrap.appendChild(btn);
  });
  host.appendChild(wrap);
}

function medicineLabelFromMatch(m) {
  if (!m) return "";
  const parts = [m.display_name, m.strength].map((x) => String(x || "").trim()).filter(Boolean);
  return parts.join(" ").trim();
}

async function normalizeMedicineSearchQuery(rawQ) {
  let q = String(rawQ ?? "").trim();
  if (!q) return "";
  if (q.length >= NORMALIZE_MIN_LEN) {
    try {
      const normRes = await fetch(`/api/normalize?q=${encodeURIComponent(q)}`);
      const norm = await normRes.json().catch(() => null);
      if (norm?.normalized && typeof norm.normalized === "string") {
        const nq = norm.normalized.trim();
        if (nq) q = nq;
      }
    } catch {
      /* ignore normalization failures */
    }
  }
  return q;
}

async function fetchMedicineCompareBundle(rawQuery, signal) {
  const q = await normalizeMedicineSearchQuery(rawQuery);
  if (!q) return { q: "", shaped: null, localOffers: [] };

  const city = $("city")?.value || "";
  const pin = getComparePincode();
  const pinParam = pin ? `&pincode=${encodeURIComponent(pin)}` : "";
  const compareExtras = getMedicineCompareGeoAndRankQuery();
  const dbRetailersUrl = `/api/compare/by-pincode?q=${encodeURIComponent(q)}&city=${encodeURIComponent(city)}${pinParam}${compareExtras}`;
  const localUrl = `/api/compare/search?q=${encodeURIComponent(q)}&city=${encodeURIComponent(city)}${compareExtras}`;

  const [dbRes, localRes] = await Promise.all([fetch(dbRetailersUrl, { signal }), fetch(localUrl, { signal })]);

  if (signal.aborted) return { q, shaped: null, localOffers: [] };

  let shaped = null;
  if (dbRes.ok) {
    const dbData = await dbRes.json().catch(() => ({}));
    if (signal.aborted) return { q, shaped: null, localOffers: [] };
    shaped = dbData.source === "db" ? dbCompareResponseToOnlineShape(dbData) : dbData;
  }

  let localOffers = [];
  if (localRes.ok) {
    const localData = await localRes.json().catch(() => ({}));
    if (!signal.aborted) localOffers = localData.offers || [];
  }

  return { q, shaped, localOffers };
}

function cheapestLocalDemoOffer(offers) {
  let best = null;
  let bestP = Infinity;
  for (const o of offers || []) {
    const p = Number(o.price_inr);
    if (!Number.isFinite(p)) continue;
    if (p < bestP) {
      bestP = p;
      best = o;
    }
  }
  return best;
}

/**
 * Mirrors manual “Add”: demo local pharmacies first, then pilot DB pharmacies, then online retailers.
 */
function addCartLineFromMedicineLookup(localOffers, shaped, queryForCart, qty) {
  const citySlug = $("city")?.value || "";
  const qwant = Math.max(1, Math.floor(Number(qty) || 1));

  const lo = cheapestLocalDemoOffer(localOffers || []);
  if (lo && Number.isFinite(Number(lo.price_inr))) {
    const mapsQuery = [lo.address_line, lo.pincode, lo.city_name, lo.pharmacy_name].filter(Boolean).join(" ");
    const checkoutUrl = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(mapsQuery)}`;
    addCartLine({
      source: "local",
      medicineId: lo.medicine_id,
      medicineLabel: lo.display_name,
      strength: lo.strength,
      unitPriceInr: Number(lo.price_inr),
      mrpInr: lo.mrp_inr != null ? Number(lo.mrp_inr) : null,
      pharmacyId: lo.pharmacy_id,
      pharmacyName: lo.pharmacy_name,
      pharmacyAddress: lo.address_line,
      pharmacyPincode: lo.pincode,
      citySlug,
      checkoutUrl,
      quantity: qwant,
    });
    return true;
  }

  const providers = shaped?.providers || [];

  /** @type {typeof providers[number] | null} */
  let bestPilot = null;
  let bestPilotP = Infinity;
  for (const p of providers) {
    if (!p.ok || p.data_mode !== "local_db") continue;
    const checkoutUrl = p.search_url || p.website;
    if (!checkoutUrl) continue;
    const pr = Number(p.price_inr);
    if (!Number.isFinite(pr)) continue;
    if (pr < bestPilotP) {
      bestPilotP = pr;
      bestPilot = p;
    }
  }
  if (!bestPilot) {
    for (const p of providers) {
      if (!p.ok || p.data_mode !== "local_db") continue;
      const checkoutUrl = p.search_url || p.website;
      if (!checkoutUrl) continue;
      bestPilot = p;
      break;
    }
  }
  if (bestPilot) {
    const checkoutUrl = bestPilot.search_url || bestPilot.website;
    if (!checkoutUrl) return false;
    addCartLine({
      source: "local",
      medicineId: bestPilot.medicine_id,
      medicineLabel: bestPilot.display_name,
      strength: bestPilot.strength || "",
      unitPriceInr: bestPilot.price_inr != null ? Number(bestPilot.price_inr) : 0,
      mrpInr: bestPilot.mrp_inr != null ? Number(bestPilot.mrp_inr) : null,
      pharmacyId: bestPilot.pharmacy_id,
      pharmacyName: bestPilot.pharmacy_name,
      pharmacyAddress: bestPilot.address_line,
      pharmacyPincode: bestPilot.pincode,
      citySlug,
      checkoutUrl,
      quantity: qwant,
    });
    return true;
  }

  /** @type {typeof providers[number] | null} */
  let bestRetail = null;
  let bestRetailP = Infinity;
  for (const p of providers) {
    if (!p.ok || p.data_mode === "local_db") continue;
    const checkoutUrl = p.search_url || p.website;
    if (!checkoutUrl) continue;
    const pr = p.price_inr != null ? Number(p.price_inr) : NaN;
    if (!Number.isFinite(pr)) continue;
    if (pr < bestRetailP) {
      bestRetailP = pr;
      bestRetail = p;
    }
  }
  if (!bestRetail) {
    for (const p of providers) {
      if (!p.ok || p.data_mode === "local_db") continue;
      const checkoutUrl = p.search_url || p.website;
      if (!checkoutUrl) continue;
      bestRetail = p;
      break;
    }
  }
  if (!bestRetail) return false;

  const checkoutUrl = bestRetail.search_url || bestRetail.website;
  if (!checkoutUrl) return false;
  const label = (bestRetail.product_title || queryForCart || "").trim();
  addCartLine({
    source: "online",
    medicineId: 0,
    medicineLabel: label,
    strength: "",
    searchQuery: queryForCart,
    unitPriceInr: bestRetail.price_inr != null ? Number(bestRetail.price_inr) : 0,
    mrpInr: bestRetail.mrp_inr != null ? Number(bestRetail.mrp_inr) : null,
    onlineProviderId: bestRetail.provider_id,
    onlineLabel: bestRetail.label,
    checkoutUrl,
    quantity: qwant,
  });
  return true;
}

function appendRxReviewRow(rowsHost, name, qty) {
  const row = document.createElement("div");
  row.className = "rx-review-row";
  row.innerHTML = `
    <label><span>Medicine</span><input type="text" class="rx-row-name" autocomplete="off" spellcheck="false" /></label>
    <label><span>Qty</span><input type="number" class="rx-row-qty" min="1" step="1" /></label>
    <button type="button" class="btn btn-sm btn-ghost rx-row-remove">Remove</button>`;
  const nameInp = row.querySelector(".rx-row-name");
  const qtyInp = row.querySelector(".rx-row-qty");
  if (nameInp) nameInp.value = name;
  if (qtyInp) qtyInp.value = String(Math.max(1, Math.floor(Number(qty) || 1)));
  row.querySelector(".rx-row-remove")?.addEventListener("click", () => {
    const siblings = rowsHost.querySelectorAll(".rx-review-row");
    if (siblings.length <= 1) return;
    row.remove();
  });
  rowsHost.appendChild(row);
}

function closeRxReviewModal() {
  if (rxReviewBatchAbort) {
    rxReviewBatchAbort.abort();
    rxReviewBatchAbort = null;
  }
  const modal = $("rxReviewModal");
  if (modal) modal.classList.add("hidden");
  const busy = $("rxReviewBusy");
  const err = $("rxReviewError");
  const confirmBtn = $("rxReviewConfirm");
  if (busy) {
    busy.classList.add("hidden");
    busy.textContent = "";
  }
  if (err) {
    err.classList.add("hidden");
    err.textContent = "";
  }
  if (confirmBtn) confirmBtn.disabled = false;
}

function openRxReviewModalAfterOcr(ocrText, matches) {
  const modal = $("rxReviewModal");
  const rowsEl = $("rxReviewRows");
  const introEl = $("rxReviewIntro");
  const ocrWrap = $("rxReviewOcrWrap");
  const ocrPre = $("rxReviewOcrText");
  if (!modal || !rowsEl || !introEl) return;

  if (rxReviewBatchAbort) {
    rxReviewBatchAbort.abort();
    rxReviewBatchAbort = null;
  }

  rowsEl.innerHTML = "";
  const list = Array.isArray(matches) ? matches : [];

  if (list.length > 0) {
    introEl.textContent =
      `${list.length} medicine(s) from your upload. Adjust names if needed—we search using your PIN and city settings, pick the cheapest available listing per line, then add it to cart.`;
    for (const m of list) {
      appendRxReviewRow(rowsEl, medicineLabelFromMatch(m), 1);
    }
  } else {
    introEl.textContent =
      "We could not confidently match catalogue medicines from this scan. Enter each medicine below (printed text works best) or tune the OCR text references in “Show extracted text”.";
    appendRxReviewRow(rowsEl, "", 1);
  }

  const t = String(ocrText || "").trim();
  if (ocrWrap && ocrPre) {
    if (t) {
      ocrWrap.classList.remove("hidden");
      ocrPre.textContent = t;
    } else {
      ocrWrap.classList.add("hidden");
      ocrPre.textContent = "";
    }
  }

  modal.classList.remove("hidden");
  const focusRow = rowsEl.querySelector(".rx-row-name");
  if (focusRow && typeof focusRow.focus === "function") focusRow.focus();
}

async function confirmRxReviewAndAddToCart() {
  const rowsHost = $("rxReviewRows");
  const busy = $("rxReviewBusy");
  const errEl = $("rxReviewError");
  const confirmBtn = $("rxReviewConfirm");
  if (!rowsHost || !busy || !errEl || !confirmBtn) return;

  errEl.classList.add("hidden");
  errEl.textContent = "";

  /** @type {{ name: string, qty: number }[]} */
  const entries = [];
  for (const row of rowsHost.querySelectorAll(".rx-review-row")) {
    const name = row.querySelector(".rx-row-name")?.value?.trim() || "";
    const qtyRaw = row.querySelector(".rx-row-qty")?.value;
    const qty = Math.max(1, Math.floor(Number(qtyRaw) || 1));
    if (name) entries.push({ name, qty });
  }
  if (!entries.length) {
    errEl.textContent = "Enter at least one medicine name.";
    errEl.classList.remove("hidden");
    return;
  }

  const ac = new AbortController();
  rxReviewBatchAbort = ac;
  confirmBtn.disabled = true;
  busy.textContent = `Adding items (0/${entries.length})…`;
  busy.classList.remove("hidden");

  const skipped = [];
  const successfulQueries = [];

  try {
    for (let i = 0; i < entries.length; i++) {
      const { name, qty } = entries[i];
      busy.textContent = `Searching (${i + 1}/${entries.length}): ${name}…`;
      try {
        const { q, shaped, localOffers } = await fetchMedicineCompareBundle(name, ac.signal);
        if (ac.signal.aborted) return;
        if (!q || q.length < MIN_QUERY_LEN) {
          skipped.push(`${name}: need at least ${MIN_QUERY_LEN} characters after normalization.`);
          continue;
        }
        const ok = addCartLineFromMedicineLookup(localOffers, shaped, q, qty);
        if (ok) successfulQueries.push(q);
        else skipped.push(`${name}: no price listing for your city/PIN combo.`);
      } catch (e) {
        if (e?.name === "AbortError") return;
        skipped.push(`${name}: ${String(e?.message || e)}`);
      }
    }
  } finally {
    busy.classList.add("hidden");
    busy.textContent = "";
    confirmBtn.disabled = false;
    rxReviewBatchAbort = null;
  }

  if (ac.signal.aborted) return;

  refreshCartBadge();
  const statusRx = $("rxStatus");
  const addedCount = successfulQueries.length;
  if (statusRx) {
    if (skipped.length === 0) {
      statusRx.textContent =
        addedCount === 1
          ? "Added the prescription item to cart. Open Cart to finish checkout."
          : `Added ${addedCount} prescription items to cart. Open Cart to finish checkout.`;
    } else {
      statusRx.textContent =
        addedCount > 0
          ? `Added ${addedCount} item(s); ${skipped.length} could not be matched. ${skipped.slice(0, 2).join(" ")}`
          : `No items added. ${skipped.slice(0, 2).join(" ")}${skipped.length > 2 ? " …" : ""}`;
    }
  }

  closeRxReviewModal();

  const lastQ = successfulQueries.length ? successfulQueries[successfulQueries.length - 1] : null;
  if (lastQ) {
    const qEl = $("q");
    if (qEl) {
      closeSuggestions?.();
      qEl.value = lastQ;
      runRealtimeSearch();
    }
  }
}

function initRxReviewModal() {
  const modal = $("rxReviewModal");
  if (!modal) return;

  modal.addEventListener("click", (ev) => {
    if ((ev.target && ev.target.closest && ev.target.closest("[data-rx-dismiss]"))) {
      closeRxReviewModal();
    }
  });

  document.addEventListener("keydown", (ev) => {
    if (ev.key !== "Escape") return;
    if (modal.classList.contains("hidden")) return;
    closeRxReviewModal();
  });

  $("rxReviewAddRow")?.addEventListener("click", () => {
    const wrap = $("rxReviewRows");
    if (!wrap) return;
    appendRxReviewRow(wrap, "", 1);
    const lst = [...wrap.querySelectorAll(".rx-row-name")];
    lst[lst.length - 1]?.focus?.();
  });

  $("rxReviewConfirm")?.addEventListener("click", () => {
    confirmRxReviewAndAddToCart();
  });
}

async function uploadPrescriptionAndExtract() {
  const fileEl = $("rxFile");
  const btn = $("rxUploadBtn");
  const status = $("rxStatus");
  if (!fileEl || !btn || !status) return;

  const file = fileEl.files?.[0];
  if (!file) {
    status.textContent = "Choose an image/PDF first.";
    return;
  }

  btn.disabled = true;
  status.textContent = "Extracting text from upload…";

  try {
    const fd = new FormData();
    fd.append("file", file);
    const res = await fetch("/api/prescription/ocr", { method: "POST", body: fd });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      status.textContent = data.error || `OCR failed (${res.status})`;
      return;
    }
    const matches = data.matches || [];
    const txt = String(data.text || "").trim();

    if (!txt && matches.length === 0) {
      status.textContent = "No OCR text extracted. Try a clearer photo.";
      return;
    }

    if (matches.length > 0) {
      status.textContent = `${matches.length} medicine(s) recognised. Review names in the pop-up before adding to cart.`;
    } else {
      status.textContent =
        "No catalogue matches from this OCR. Edit lines in the pop-up—we still search live by what you enter.";
    }

    openRxReviewModalAfterOcr(txt, matches);
  } catch (e) {
    status.textContent = String(e?.message || e);
  } finally {
    btn.disabled = false;
  }
}


function syncReminderMedicineFromOffers(offers) {
  const ids = new Set(
    (offers || []).map((o) => o.medicine_id).filter((id) => id != null && Number(id) > 0)
  );
  if (ids.size !== 1) {
    selectedMedicine = null;
    updateReminderHint();
    return;
  }
  const id = [...ids][0];
  const row = offers.find((o) => Number(o.medicine_id) === Number(id));
  if (!row) {
    selectedMedicine = null;
    updateReminderHint();
    return;
  }
  selectedMedicine = {
    id: Number(row.medicine_id),
    display_name: row.display_name,
    strength: row.strength,
  };
  updateReminderHint();
}

let searchTimer;
$("q").addEventListener("input", () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(runRealtimeSearch, SEARCH_DEBOUNCE_MS);
});

// --- Autocomplete suggestions (3+ chars) ---
let suggestTimer;
/** @type {AbortController | null} */
let suggestAbort = null;
let suggestItems = [];
let suggestActive = -1;

function getSuggestEls() {
  const input = $("q");
  const box = $("q-suggestions");
  return { input, box };
}

function closeSuggestions() {
  const { input, box } = getSuggestEls();
  if (!input || !box) return;
  box.classList.add("hidden");
  box.innerHTML = "";
  input.setAttribute("aria-expanded", "false");
  input.removeAttribute("aria-activedescendant");
  suggestItems = [];
  suggestActive = -1;
}

function openSuggestions() {
  const { input, box } = getSuggestEls();
  if (!input || !box) return;
  box.classList.remove("hidden");
  input.setAttribute("aria-expanded", "true");
}

function renderSuggestions(items, q) {
  const { input, box } = getSuggestEls();
  if (!input || !box) return;

  if (!Array.isArray(items) || items.length === 0) {
    closeSuggestions();
    return;
  }

  suggestItems = items;
  suggestActive = -1;
  openSuggestions();

  const qLower = String(q || "").toLowerCase();
  box.innerHTML = items
    .slice(0, 10)
    .map((m, idx) => {
      const id = `q-sug-${idx}`;
      const name = String(m.display_name || m.generic_name || "").trim();
      const strength = String(m.strength || "").trim();
      const form = String(m.form || "").trim();
      const extra = [strength, form].filter(Boolean).join(" · ");
      const nameLower = name.toLowerCase();
      const hitAt = qLower && nameLower.includes(qLower) ? nameLower.indexOf(qLower) : -1;
      const label =
        hitAt >= 0 && qLower.length
          ? `${escapeHtml(name.slice(0, hitAt))}<mark>${escapeHtml(
              name.slice(hitAt, hitAt + qLower.length)
            )}</mark>${escapeHtml(name.slice(hitAt + qLower.length))}`
          : escapeHtml(name);
      return `
        <div class="suggestion" role="option" id="${escapeAttr(id)}" data-idx="${idx}" aria-selected="false">
          <div class="suggestion-title">${label}</div>
          ${extra ? `<div class="suggestion-sub muted">${escapeHtml(extra)}</div>` : ""}
        </div>`;
    })
    .join("");

  box.querySelectorAll(".suggestion").forEach((row) => {
    row.addEventListener("mousedown", (e) => {
      // Prevent input blur before we handle selection.
      e.preventDefault();
    });
    row.addEventListener("click", () => {
      const idx = Number(row.dataset.idx);
      pickSuggestion(idx);
    });
  });
}

function setActiveSuggestion(nextIdx) {
  const { input, box } = getSuggestEls();
  if (!input || !box) return;
  const rows = [...box.querySelectorAll(".suggestion")];
  if (!rows.length) return;

  suggestActive = Math.max(0, Math.min(nextIdx, rows.length - 1));
  rows.forEach((el, i) => el.setAttribute("aria-selected", i === suggestActive ? "true" : "false"));
  const activeEl = rows[suggestActive];
  if (activeEl?.id) input.setAttribute("aria-activedescendant", activeEl.id);
  activeEl?.scrollIntoView?.({ block: "nearest" });
}

function pickSuggestion(idx) {
  const { input } = getSuggestEls();
  if (!input) return;
  const item = suggestItems[idx];
  const name = String(item?.display_name || item?.generic_name || "").trim();
  if (!name) return;
  input.value = name;
  closeSuggestions();
  clearTimeout(searchTimer);
  runRealtimeSearch();
}

async function runSuggestSearch() {
  const { input } = getSuggestEls();
  if (!input) return;
  const q = input.value.trim();

  if (!q || q.length < SUGGEST_MIN_QUERY_LEN) {
    closeSuggestions();
    return;
  }

  if (suggestAbort) suggestAbort.abort();
  suggestAbort = new AbortController();
  const signal = suggestAbort.signal;

  try {
    const res = await fetch(`/api/medicines/search?q=${encodeURIComponent(q)}`, { signal });
    const data = await res.json().catch(() => ({}));
    if (signal.aborted) return;
    renderSuggestions(data.medicines || [], q);
  } catch (e) {
    if (e?.name === "AbortError") return;
    closeSuggestions();
  }
}

$("q").addEventListener("keydown", (e) => {
  // Suggestion list keyboard controls
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    const { box } = getSuggestEls();
    if (!box || box.classList.contains("hidden")) return;
    e.preventDefault();
    const delta = e.key === "ArrowDown" ? 1 : -1;
    setActiveSuggestion((suggestActive < 0 ? -1 : suggestActive) + delta);
    return;
  }
  if (e.key === "Escape") {
    const { box } = getSuggestEls();
    if (box && !box.classList.contains("hidden")) {
      e.preventDefault();
      closeSuggestions();
      return;
    }
  }
  if (e.key !== "Enter") return;
  e.preventDefault();

  // If a suggestion is active, pick it; otherwise do normal search.
  const { box } = getSuggestEls();
  if (box && !box.classList.contains("hidden")) {
    const rows = box.querySelectorAll(".suggestion");
    if (rows.length && suggestActive >= 0) {
      pickSuggestion(suggestActive);
      return;
    }
  }

  clearTimeout(searchTimer);
  runRealtimeSearch();
});

// Debounced suggestion fetch (independent from live search)
$("q").addEventListener("input", () => {
  clearTimeout(suggestTimer);
  suggestTimer = setTimeout(runSuggestSearch, SUGGEST_DEBOUNCE_MS);
});

// Close suggestions when focus leaves the input
$("q").addEventListener("blur", () => {
  // Delay so click selection can run first.
  setTimeout(() => closeSuggestions(), 120);
});

$("searchBtn")?.addEventListener("click", () => {
  clearTimeout(searchTimer);
  runRealtimeSearch();
});

$("rxUploadBtn")?.addEventListener("click", () => uploadPrescriptionAndExtract());

$("city").addEventListener("change", () => {
  runRealtimeSearch();
});

$("pincode")?.addEventListener("input", () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(runRealtimeSearch, SEARCH_DEBOUNCE_MS);
});

function abortPendingSearch() {
  if (compareAbort) {
    compareAbort.abort();
    compareAbort = null;
  }
}

async function runRealtimeSearch() {
  let q = $("q").value.trim();
  liveQuery = q;
  const city = $("city").value;
  const statusEl = $("search-status");

  abortPendingSearch();

  if (!q) {
    statusEl.textContent = "";
    resetLocalPanel();
    resetOnlinePanel();
    selectedMedicine = null;
    updateReminderHint();
    return;
  }

  if (q.length < MIN_QUERY_LEN) {
    statusEl.textContent = `Enter at least ${MIN_QUERY_LEN} characters to run a live search.`;
    resetLocalPanel();
    resetOnlinePanel();
    selectedMedicine = null;
    updateReminderHint();
    return;
  }

  // Optional AI/rules normalization (best-effort, non-blocking)
  if (q.length >= NORMALIZE_MIN_LEN) {
    try {
      const normRes = await fetch(`/api/normalize?q=${encodeURIComponent(q)}`);
      const norm = await normRes.json().catch(() => null);
      if (norm?.normalized && typeof norm.normalized === "string") {
        const nq = norm.normalized.trim();
        if (nq && nq !== q) {
          q = nq;
          $("q").value = nq;
          liveQuery = nq;
        }
      }
    } catch {
      /* ignore normalization failures */
    }
  }

  compareAbort = new AbortController();
  const signal = compareAbort.signal;
  statusEl.textContent = "Searching database (by PIN / city) and local demo pharmacies…";
  saveRecentSearch(q);

  const pin = getComparePincode();
  const pinParam = pin ? `&pincode=${encodeURIComponent(pin)}` : "";
  const compareExtras = getMedicineCompareGeoAndRankQuery();
  const dbRetailersUrl = `/api/compare/by-pincode?q=${encodeURIComponent(q)}&city=${encodeURIComponent(city)}${pinParam}${compareExtras}`;
  const localUrl = `/api/compare/search?q=${encodeURIComponent(q)}&city=${encodeURIComponent(city)}${compareExtras}`;

  try {
    const [dbRes, localRes] = await Promise.all([fetch(dbRetailersUrl, { signal }), fetch(localUrl, { signal })]);

    if (signal.aborted) return;

    if (dbRes.ok) {
      const dbData = await dbRes.json();
      if (signal.aborted) return;
      const shaped = dbData.source === "db" ? dbCompareResponseToOnlineShape(dbData) : dbData;
      renderOnlineTable(shaped, q);
    } else {
      const errBody = await dbRes.json().catch(() => ({}));
      if (signal.aborted) return;
      $("online-stats")?.classList.add("hidden");
      $("online-table-wrap")?.classList.add("hidden");
      $("online-checkout")?.classList.add("hidden");
      $("online-rows").innerHTML = "";
      $("online-status").textContent = errBody.error || `Database compare failed (${dbRes.status})`;
    }

    if (localRes.ok) {
      const localData = await localRes.json();
      if (signal.aborted) return;
      renderLocalTable(localData.offers || [], city, q, null);
      syncReminderMedicineFromOffers(localData.offers || []);
    } else {
      const errBody = await localRes.json().catch(() => ({}));
      if (signal.aborted) return;
      renderLocalTable([], city, q, errBody.error || `Local search failed (${localRes.status})`);
      selectedMedicine = null;
      updateReminderHint();
    }

    const pinNote = pin ? ` · PIN ${pin}` : "";
    const hasCoords = compareExtras.includes("lat=");
    const sortPrice = ($("compareSortBy")?.value || "nearest") === "price";
    let rankNote = "";
    if (hasCoords && sortPrice) rankNote = " · rankings: cheapest first (coordinates still used for distance column)";
    else if (hasCoords) rankNote = " · rankings: nearest first where pharmacy coordinates exist";
    else if (sortPrice) rankNote = " · rankings: lowest price (no saved coordinates — same as default SQL order)";
    statusEl.textContent = `Results for “${q}” in ${city}${pinNote}${rankNote}. Online retailers: pilot DB. Local: city-wide search.`;
  } catch (e) {
    if (e?.name === "AbortError") return;
    statusEl.textContent = String(e?.message || e);
  }
}

function resetLocalPanel() {
  const stats = $("stats");
  const tableWrap = $("table-wrap");
  const empty = $("empty");
  const tbody = $("offers");
  $("selection").textContent = "Type a medicine name to search local listings (pilot data).";
  stats.classList.add("hidden");
  tableWrap.classList.add("hidden");
  empty.classList.add("hidden");
  tbody.innerHTML = "";
}

function resetOnlinePanel() {
  const section = $("online-section");
  const status = $("online-status");
  const wrap = $("online-table-wrap");
  const statsEl = $("online-stats");
  const tbody = $("online-rows");
  const checkout = $("online-checkout");
  const openBtn = $("online-open-btn");
  const selLabel = $("online-selected-label");
  if (!section) return;
  status.textContent = "";
  wrap.classList.add("hidden");
  checkout.classList.add("hidden");
  statsEl.classList.add("hidden");
  tbody.innerHTML = "";
  selectedOnlineOffer = null;
  openBtn.disabled = true;
  selLabel.textContent = "";
  if (openBtn) openBtn.textContent = "Continue on selected site";
  const hintEl = openBtn?.nextElementSibling;
  if (hintEl?.classList?.contains("hint")) {
    hintEl.textContent = "Opens the retailer search in a new tab.";
  }
}

function renderLocalTable(offers, city, q, errorMsg) {
  const stats = $("stats");
  const tableWrap = $("table-wrap");
  const empty = $("empty");
  const tbody = $("offers");

  $("selection").innerHTML = `Local matches for <strong>${escapeHtml(q)}</strong> in <strong>${escapeHtml(
    city
  )}</strong> (pilot data).`;

  if (errorMsg) {
    stats.classList.add("hidden");
    tableWrap.classList.add("hidden");
    empty.classList.remove("hidden");
    empty.textContent = errorMsg;
    tbody.innerHTML = "";
    return;
  }

  if (!offers.length) {
    stats.classList.add("hidden");
    tableWrap.classList.add("hidden");
    empty.classList.remove("hidden");
    empty.textContent = `No local listings match “${q}” in ${city}. Try another spelling or city.`;
    tbody.innerHTML = "";
    return;
  }

  empty.classList.add("hidden");
  stats.classList.remove("hidden");
  tableWrap.classList.remove("hidden");

  const priceNums = offers.map((o) => Number(o.price_inr)).filter((n) => Number.isFinite(n));
  const minPrice = priceNums.length ? Math.min(...priceNums) : null;
  const maxPrice = priceNums.length ? Math.max(...priceNums) : null;
  const discPcts = offers.map(numericDiscountPctFromOffer).filter((n) => n != null && n > 0);
  const maxDiscPct = discPcts.length ? Math.max(...discPcts) : null;
  const statParts = [
    `<span><strong>${offers.length}</strong> listing(s)</span>`,
    minPrice != null ? `<span>Lowest: <strong>₹${fmt(minPrice)}</strong></span>` : "",
  ];
  if (maxDiscPct != null) {
    statParts.push(
      `<span>Best discount: <strong>${maxDiscPct % 1 < 0.05 ? Math.round(maxDiscPct) : maxDiscPct.toFixed(1)}%</strong> off MRP</span>`,
    );
  }
  if (
    minPrice != null &&
    maxPrice != null &&
    offers.length >= 2 &&
    maxPrice > minPrice
  ) {
    statParts.push(
      `<span>Pick lowest vs highest: <strong>₹${fmt(maxPrice - minPrice)}</strong> extra savings</span>`,
    );
  }
  stats.innerHTML = statParts.filter(Boolean).join(" ");

  tbody.innerHTML = offers
    .map((o, idx) => {
      const best = Number(o.price_inr) === minPrice;
      const med = `${escapeHtml(o.display_name)} · ${escapeHtml(o.strength || "")}`;
      const disc = formatOfferDiscountPct(o);
      const saveCell = formatSaveVsMrpCell(o);
      const distCell = escapeHtml(formatDistanceKm(o.distance_km));
      return `
      <tr class="${best ? "best" : ""}">
        <td>${escapeHtml(o.pharmacy_name)}${o.chain ? ` <span class="muted">(${escapeHtml(o.chain)})</span>` : ""}${best ? ` <span class="pill pill-muted" style="margin-left:0.25rem">Best price</span>` : ""}</td>
        <td class="muted">${distCell}</td>
        <td class="muted">${med}</td>
        <td class="price-cell">₹${fmt(o.price_inr)}</td>
        <td class="muted">${o.mrp_inr != null ? `₹${fmt(o.mrp_inr)}` : "—"}</td>
        <td class="muted">${disc === "—" ? "—" : `<strong>${escapeHtml(disc)}</strong> off MRP`}</td>
        <td class="muted">${saveCell}</td>
        <td class="muted">${escapeHtml(o.address_line || "")}${o.pincode ? ` · ${escapeHtml(o.pincode)}` : ""}</td>
        <td><button type="button" class="btn btn-sm add-local-cart" data-offer-idx="${idx}">Add</button></td>
      </tr>`;
    })
    .join("");

  tbody.querySelectorAll(".add-local-cart").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      const idx = Number(btn.dataset.offerIdx);
      const o = offers[idx];
      if (!o) return;
      const mapsQuery = [o.address_line, o.pincode, o.city_name, o.pharmacy_name].filter(Boolean).join(" ");
      const checkoutUrl = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(mapsQuery)}`;
      addCartLine({
        source: "local",
        medicineId: o.medicine_id,
        medicineLabel: o.display_name,
        strength: o.strength,
        unitPriceInr: Number(o.price_inr),
        mrpInr: o.mrp_inr != null ? Number(o.mrp_inr) : null,
        pharmacyId: o.pharmacy_id,
        pharmacyName: o.pharmacy_name,
        pharmacyAddress: o.address_line,
        pharmacyPincode: o.pincode,
        citySlug: city,
        checkoutUrl,
      });
      refreshCartBadge();
    });
  });
}

function renderOnlineTable(data, q) {
  const status = $("online-status");
  const wrap = $("online-table-wrap");
  const statsEl = $("online-stats");
  const tbody = $("online-rows");
  const checkout = $("online-checkout");
  const openBtn = $("online-open-btn");
  const selLabel = $("online-selected-label");
  const isDbSource = data.source === "db";

  if (openBtn) {
    openBtn.textContent = isDbSource ? "Open in Maps" : "Continue on selected site";
  }
  const hintEl = openBtn?.nextElementSibling;
  if (hintEl?.classList?.contains("hint")) {
    hintEl.textContent = isDbSource
      ? "Opens Google Maps for the selected pharmacy."
      : "Opens the retailer search in a new tab.";
  }

  const providers = data.providers || [];
  if (!providers.length) {
    statsEl.classList.add("hidden");
    wrap.classList.add("hidden");
    checkout.classList.add("hidden");
    tbody.innerHTML = "";
    selectedOnlineOffer = null;
    if (openBtn) openBtn.disabled = true;
    selLabel.textContent = "";
    status.textContent = isDbSource
      ? `No database matches for “${q}” (${data.filter_label || "try another PIN or city"}).`
      : "No retailer rows to display.";
    return;
  }

  const anyOk = providers.some((p) => p.ok);
  const anyGeo = isDbSource && providers.some((p) => p.distance_km != null && Number.isFinite(Number(p.distance_km)));
  status.textContent = isDbSource
    ? `Pilot database · ${data.filter_label || "compare"}. ${providers.filter((p) => p.ok).length} listing(s).${
        anyGeo ? " Distance uses your saved location when pharmacy coordinates are available." : ""
      }`
    : `Parallel fetch completed in ${data.parallel_ms ?? "—"} ms.${
        anyOk
          ? ""
          : " No partner APIs returned prices — configure .env (see README) or set ONLINE_USE_ILLUSTRATIVE_FALLBACK=true for demo numbers."
      }`;

  const s = data.stats || {};
  const spread =
    s.spread_percent != null
      ? `<span>Spread: <strong>${s.spread_percent}%</strong></span>`
      : "";
  const lowLbl = isDbSource ? "Lowest" : "Lowest (est.)";
  const highLbl = isDbSource ? "Highest" : "Highest (est.)";
  const dbHintParts = [];
  if (isDbSource && providers.length >= 1) {
    const discs = providers
      .filter((x) => x.ok)
      .map(numericDiscountPctFromOffer)
      .filter((n) => n != null && n > 0);
    const maxD = discs.length ? Math.max(...discs) : null;
    if (maxD != null) {
      dbHintParts.push(
        `<span>Best discount: <strong>${maxD % 1 < 0.05 ? Math.round(maxD) : maxD.toFixed(1)}%</strong> off MRP</span>`,
      );
    }
    const okPrices = providers.filter((x) => x.ok && x.price_inr != null).map((x) => Number(x.price_inr));
    if (okPrices.length >= 2) {
      const mn = Math.min(...okPrices);
      const mx = Math.max(...okPrices);
      if (mx > mn) {
        dbHintParts.push(`<span>Cheapest vs priciest listing: <strong>₹${fmt(mx - mn)}</strong></span>`);
      }
    }
  }
  const dbCompareHint = dbHintParts.join(" ");
  statsEl.innerHTML = `
    <span>${lowLbl}: <strong>₹${fmt(s.min_inr)}</strong></span>
    <span>${highLbl}: <strong>₹${fmt(s.max_inr)}</strong></span>
    ${spread}
    ${dbCompareHint}
  `;
  statsEl.classList.remove("hidden");

  let bestId = null;
  let minP = Infinity;
  for (const p of providers) {
    if (p.ok && p.price_inr != null && Number(p.price_inr) < minP) {
      minP = Number(p.price_inr);
      bestId = p.provider_id;
    }
  }

  tbody.innerHTML = providers
    .map((p, pidx) => {
      const ok = p.ok;
      const id = escapeAttr(p.provider_id || "");
      const checked = ok && p.provider_id === bestId ? " checked" : "";
      const priceCell = ok ? `₹${escapeHtml(fmt(p.price_inr))}` : "—";
      const mrpCell = ok && p.mrp_inr != null ? `₹${escapeHtml(fmt(p.mrp_inr))}` : "—";
      const discStr = ok && isDbSource ? formatOfferDiscountPct(p) : "—";
      const discCell = discStr === "—" ? "—" : `<strong>${escapeHtml(discStr)}</strong> off MRP`;
      const saveCell =
        ok && isDbSource ? formatSaveVsMrpCell(p) : "—";
      const url = escapeAttr(p.search_url || p.website || "#");
      const err = !ok ? ` <span class="muted">(${escapeHtml(p.error || "error")})</span>` : "";
      const canAdd = Boolean(p.search_url || p.website);
      const title = p.product_title ? escapeHtml(p.product_title) : `<span class="muted">—</span>`;
      const openLabel = isDbSource ? "Map" : "Open site";
      const distCell =
        isDbSource && p.distance_km != null && Number.isFinite(Number(p.distance_km))
          ? escapeHtml(formatDistanceKm(p.distance_km))
          : "—";
      const bestPill =
        ok && isDbSource && bestId === p.provider_id && providers.filter((x) => x.ok).length > 1
          ? ` <span class="pill pill-muted">Best price</span>`
          : "";
      return `
      <tr>
        <td><input type="radio" name="online-pick" value="${id}"${checked} /></td>
        <td>${escapeHtml(p.label || p.provider_id)}${bestPill}${err}</td>
        <td class="muted">${title}</td>
        <td class="muted">${distCell}</td>
        <td class="price-cell">${priceCell}</td>
        <td class="muted">${mrpCell}</td>
        <td class="muted">${discCell}</td>
        <td class="muted">${saveCell}</td>
        <td><a href="${url}" target="_blank" rel="noopener noreferrer">${escapeHtml(openLabel)}</a></td>
        <td><button type="button" class="btn btn-sm add-online-cart" data-pidx="${pidx}"${
          canAdd ? "" : " disabled"
        }>Add</button></td>
      </tr>`;
    })
    .join("");

  wrap.classList.remove("hidden");

  function syncFromRadio(radio) {
    if (!radio) {
      selectedOnlineOffer = null;
      openBtn.disabled = true;
      selLabel.textContent = "";
      return;
    }
    const id = radio.value;
    const row = providers.find((x) => x.provider_id === id);
    if (!row || !row.search_url) {
      selectedOnlineOffer = null;
      openBtn.disabled = true;
      return;
    }
    selectedOnlineOffer = {
      provider_id: row.provider_id,
      label: row.label,
      search_url: row.search_url,
      price_inr: row.price_inr,
    };
    openBtn.disabled = false;
    selLabel.textContent = `Selected: ${row.label}${
      row.price_inr != null ? ` — ₹${fmt(row.price_inr)}${isDbSource ? "" : " (est.)"}` : ""
    }${isDbSource ? selectionSavingsPhrase(row) : ""}`;
  }

  const firstChecked = tbody.querySelector('input[name="online-pick"]:checked');
  syncFromRadio(firstChecked || tbody.querySelector('input[name="online-pick"]'));

  tbody.querySelectorAll('input[name="online-pick"]').forEach((radio) => {
    radio.addEventListener("change", () => syncFromRadio(radio));
  });

  openBtn.onclick = () => {
    if (!selectedOnlineOffer?.search_url) return;
    window.open(selectedOnlineOffer.search_url, "_blank", "noopener,noreferrer");
  };

  tbody.querySelectorAll(".add-online-cart").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      const idx = Number(btn.dataset.pidx);
      const p = providers[idx];
      if (!p) return;
      const checkoutUrl = p.search_url || p.website;
      if (!checkoutUrl) return;
      const citySlug = $("city")?.value || "";
      if (p.data_mode === "local_db") {
        addCartLine({
          source: "local",
          medicineId: p.medicine_id,
          medicineLabel: p.display_name,
          strength: p.strength || "",
          unitPriceInr: Number(p.price_inr),
          mrpInr: p.mrp_inr != null ? Number(p.mrp_inr) : null,
          pharmacyId: p.pharmacy_id,
          pharmacyName: p.pharmacy_name,
          pharmacyAddress: p.address_line,
          pharmacyPincode: p.pincode,
          citySlug: citySlug,
          checkoutUrl,
        });
      } else {
        const label = (p.product_title || q).trim();
        addCartLine({
          source: "online",
          medicineId: 0,
          medicineLabel: label,
          strength: "",
          searchQuery: q,
          unitPriceInr: p.price_inr != null ? Number(p.price_inr) : 0,
          mrpInr: p.mrp_inr != null ? Number(p.mrp_inr) : null,
          onlineProviderId: p.provider_id,
          onlineLabel: p.label,
          checkoutUrl,
        });
      }
      refreshCartBadge();
    });
  });

  checkout.classList.remove("hidden");
}

function fmt(n) {
  if (n == null || Number.isNaN(Number(n))) return "—";
  return Number(n).toLocaleString("en-IN", { minimumFractionDigits: 0, maximumFractionDigits: 2 });
}

async function postJson(url, body) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body || {}),
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

function renderAuthNav() {
  const userEl = $("navUser");
  const loginEl = $("navLogin");
  const logoutEl = $("navLogout");
  const importEl = $("navImport");
  const ordersEl = $("navOrders");
  const profileWrapEl = $("navProfileWrap");
  const profileNameEl = $("navProfileName");
  const profileLogoutEl = $("navProfileLogout");
  if (!userEl || !loginEl || !logoutEl) return;

  const u = currentUser;
  const isLogged = Boolean(u);
  loginEl.classList.toggle("hidden", isLogged);
  // Keep standalone logout hidden; logout is shown under Profile menu.
  logoutEl.classList.add("hidden");
  // Keep standalone user badge hidden; name is shown inside Profile dropdown.
  userEl.classList.add("hidden");
  if (importEl) importEl.classList.toggle("hidden", !(isLogged && u?.role === "service_provider"));
  // Orders are for consumer users only (OTP/Google). Hide for logged-out and service providers.
  if (ordersEl) ordersEl.classList.toggle("hidden", !(isLogged && u?.role !== "service_provider"));
  if (profileWrapEl) profileWrapEl.classList.toggle("hidden", !(isLogged && u?.role !== "service_provider"));
  if (profileLogoutEl) profileLogoutEl.classList.toggle("hidden", !isLogged);

  if (!isLogged) {
    userEl.textContent = "";
    if (profileNameEl) profileNameEl.textContent = "Account";
    return;
  }

  const label =
    u.role === "service_provider"
      ? `SP · ${u.username || "account"}`
      : u.full_name
        ? `${u.full_name}`
      : u.email
        ? `${u.email}`
      : u.phone_e164
        ? `${u.phone_e164}`
        : "Account";
  userEl.textContent = label;
  if (profileNameEl) profileNameEl.textContent = label;
}

async function refreshAuth() {
  // Render immediately from local cache, then refresh from server.
  currentUser = loadCachedUser();
  loggedIn = Boolean(currentUser);
  renderAuthNav();
  currentUser = await fetchAndCacheUser();
  loggedIn = Boolean(currentUser);
  renderAuthNav();
}

function updateReminderHint() {
  const el = $("reminderHint");
  const link = $("reminderLink");
  if (!el || !link) return;
  if (!selectedMedicine || !loggedIn) {
    el.classList.add("hidden");
    return;
  }
  el.classList.remove("hidden");
  const label = encodeURIComponent(selectedMedicine.display_name);
  const mid = selectedMedicine.id;
  link.href = `/reminders.html?medicine_id=${mid}&medicine_label=${label}`;
}

window.addEventListener("storage", (e) => {
  if (e.key === STORAGE_KEY) refreshCartBadge();
});
window.addEventListener("pageshow", () => {
  refreshCartBadge();
});

// Logout from header (user + service provider)
$("navLogout")?.addEventListener("click", async (e) => {
  e.preventDefault();
  await postJson("/api/auth/logout", {});
  clearCachedUser();
  currentUser = null;
  loggedIn = false;
  renderAuthNav();
  updateReminderHint();
});

$("navProfileLogout")?.addEventListener("click", async (e) => {
  e.preventDefault();
  await postJson("/api/auth/logout", {});
  clearCachedUser();
  currentUser = null;
  loggedIn = false;
  renderAuthNav();
  updateReminderHint();
});

Promise.all([loadCities(), refreshAuth()])
  .then(() => updateReminderHint())
  .then(() => refreshCartBadge())
  .then(() => renderRecentChips())
  .then(() => initRxReviewModal())
  .catch(console.error);
