import crypto from "node:crypto";

const DEFAULT_TIMEOUT_MS = 15000;

function getEnv(name, fallback = "") {
  return String(process.env[name] || fallback).trim();
}

function toNum(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function ensureArray(v) {
  return Array.isArray(v) ? v : [];
}

function pickFirst(obj, paths) {
  for (const path of paths) {
    const keys = path.split(".");
    let cur = obj;
    for (const key of keys) {
      if (cur == null || typeof cur !== "object" || !(key in cur)) {
        cur = undefined;
        break;
      }
      cur = cur[key];
    }
    if (cur !== undefined && cur !== null && cur !== "") return cur;
  }
  return null;
}

function makeUrl(path, query = null) {
  const base = getEnv("DIAG_B2B_BASE_URL");
  if (!base) throw new Error("Diagnostics B2B base URL is not configured");
  const url = new URL(path, base.endsWith("/") ? base : `${base}/`);
  if (query && typeof query === "object") {
    Object.entries(query).forEach(([k, v]) => {
      if (v !== undefined && v !== null && String(v) !== "") url.searchParams.set(k, String(v));
    });
  }
  return url.toString();
}

function isEnabled() {
  return getEnv("DIAG_B2B_ENABLED", "false").toLowerCase() === "true";
}

function isoDateYYYYMMDD(date = new Date()) {
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}

let tokenCache = {
  token: null,
  expiresAt: 0,
};

function buildPath(endpointPath) {
  const clean = String(endpointPath || "").replace(/^\/+|\/+$/g, "");
  const partner = getEnv("DIAG_B2B_PARTNER_NAME");
  if (!partner) return clean;
  return `${partner}/${clean}`;
}

function parseJSONBody(res, fallback = {}) {
  return res.json().catch(() => fallback);
}

function assertPartnerSuccess(data, fallbackMessage = "Partner API failed") {
  if (data && typeof data === "object") {
    const status = pickFirst(data, ["status", "success"]);
    const code = String(pickFirst(data, ["resCode", "code"]) || "");
    if (status === false || code === "RES0002" || code === "RES0003" || code === "RES0004" || code === "RES0006") {
      const msg = pickFirst(data, ["message", "error", "detail"]) || fallbackMessage;
      throw new Error(String(msg));
    }
  }
}

async function httpRequest(path, { method = "POST", query = null, body = null, token = null, headers = {} } = {}) {
  const timeoutMs = Number(getEnv("DIAG_B2B_TIMEOUT_MS", String(DEFAULT_TIMEOUT_MS))) || DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  const mergedHeaders = { Accept: "application/json", ...headers };
  if (body != null && !mergedHeaders["Content-Type"]) mergedHeaders["Content-Type"] = "application/json";

  if (token) {
    mergedHeaders.Authorization = `Bearer ${token}`;
  }

  try {
    const res = await fetch(makeUrl(buildPath(path), query), {
      method,
      headers: mergedHeaders,
      body: body == null ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
    const data = await parseJSONBody(res, {});
    if (!res.ok) {
      const msg = pickFirst(data, ["message", "error", "detail"]) || `Partner API request failed (${res.status})`;
      throw new Error(String(msg));
    }
    return data;
  } finally {
    clearTimeout(t);
  }
}

function authPath() {
  return getEnv("DIAG_B2B_AUTH_PATH", "getAccessToken");
}

function productsPath() {
  return getEnv("DIAG_B2B_PRODUCTS_PATH", "getPartnerProducts");
}

function serviceabilityPath() {
  return getEnv("DIAG_B2B_SERVICEABILITY_PATH", "checkServiceabilityByLocation_v2");
}

function slotsPath() {
  return getEnv("DIAG_B2B_SLOTS_PATH", "getSlotsByLocation");
}

function freezeSlotPath() {
  return getEnv("DIAG_B2B_FREEZE_SLOT_PATH", "freezeSlot_v1");
}

function createBookingPath() {
  return getEnv("DIAG_B2B_CREATE_BOOKING_PATH", "createBooking_v3");
}

function bookingStatusPath() {
  return getEnv("DIAG_B2B_BOOKING_STATUS_PATH", "getBookingStatus");
}

function customerReportPath() {
  return getEnv("DIAG_B2B_CUSTOMER_REPORT_PATH", "getCustomerReport_v2");
}

async function getAccessToken() {
  const now = Date.now();
  if (tokenCache.token && tokenCache.expiresAt > now + 30_000) return tokenCache.token;

  const method = getEnv("DIAG_B2B_AUTH_METHOD", "GET").toUpperCase();
  const user = getEnv("DIAG_B2B_API_KEY");
  const pass = getEnv("DIAG_B2B_API_SECRET");
  if (!user || !pass) {
    throw new Error("Diagnostics credentials missing: set DIAG_B2B_API_KEY and DIAG_B2B_API_SECRET");
  }
  const basic = Buffer.from(`${user}:${pass}`).toString("base64");
  const data = await httpRequest(authPath(), {
    method,
    headers: { Authorization: `Basic ${basic}` },
  });
  assertPartnerSuccess(data, "Failed to get diagnostics access token");
  const token = pickFirst(data, [
    "access_token",
    "token",
    "data.access_token",
    "data.token",
    "result.access_token",
    "result.token",
  ]);
  if (!token) throw new Error("Partner token was not found in auth response");
  const expiresInSec = Number(pickFirst(data, ["expires_in", "data.expires_in", "ttl", "data.ttl"]) || 3600);
  tokenCache = {
    token: String(token),
    expiresAt: Date.now() + Math.max(60, expiresInSec) * 1000,
  };
  return tokenCache.token;
}

function normalizePackage(item) {
  const name = pickFirst(item, ["test_name", "name", "package_name", "product_name", "heading", "title"]);
  const dealId = pickFirst(item, ["deal_id"]);
  const productType = String(pickFirst(item, ["product_type"]) || "package");
  const productTypeId = pickFirst(item, ["product_type_id"]);
  const id = dealId || (productTypeId ? `${productType}_${productTypeId}` : null);
  if (!id || !name) return null;
  return {
    package_id: String(id),
    deal_id: String(id),
    product_type: productType,
    product_type_id: productTypeId != null ? String(productTypeId) : "",
    heading: String(name),
    sub_heading: String(pickFirst(item, ["sub_heading", "description", "short_desc", "subtitle"]) || ""),
    category: String(pickFirst(item, ["test_type", "category", "type"]) || "PATHOLOGY").toUpperCase(),
    slug: String(pickFirst(item, ["slug", "url_path"]) || ""),
    report_tat_hours: toNum(pickFirst(item, ["report_tat_hours", "tat", "turnaround_hours"])),
    home_collection: Boolean(
      pickFirst(item, ["home_collection", "is_home_collection", "homeCollection"]) ?? true
    ),
    lab_name: String(
      pickFirst(item, ["lab_name", "provider_name", "partner_name"]) || getEnv("DIAG_B2B_PROVIDER_NAME", "Healthians")
    ),
    price_inr: toNum(pickFirst(item, ["price_inr", "offer_price", "price", "selling_price"])),
    mrp_inr: toNum(pickFirst(item, ["mrp_inr", "mrp", "list_price"])),
    city_id: pickFirst(item, ["city_id"]) ? String(pickFirst(item, ["city_id"])) : null,
    city_name: String(pickFirst(item, ["city_name"]) || ""),
    tests_included: ensureArray(pickFirst(item, ["tests", "test_list", "included_tests"])).map((x) => String(x)),
    raw: item,
  };
}

/** Map normalized partner package to the public lab row shape shared by `/api/labs/search` and compare APIs. */
export function mapPartnerPackageToLabRow(pkg) {
  return {
    id: pkg.package_id,
    heading: pkg.heading,
    sub_heading: pkg.sub_heading,
    category: pkg.category || "PATHOLOGY",
    icon_url: null,
    slug: pkg.slug || "",
    report_tat_hours: pkg.report_tat_hours,
    home_collection: pkg.home_collection !== false,
    lab_name: pkg.lab_name || getEnv("DIAG_B2B_PROVIDER_NAME", "Healthians"),
    price_inr: pkg.price_inr,
    mrp_inr: pkg.mrp_inr,
    discount_pct: pkg.discount_pct ?? null,
    provider: "healthians",
    package_id: pkg.package_id,
    deal_id: pkg.deal_id || pkg.package_id,
    product_type: pkg.product_type || "",
    product_type_id: pkg.product_type_id || "",
    city_id: pkg.city_id || null,
    city_name: pkg.city_name || "",
    tests_included: pkg.tests_included || [],
  };
}

function normalizeProductType(category = "") {
  const c = String(category || "").trim().toUpperCase();
  if (c === "RADIOLOGY") return "radiology";
  return "pathology";
}

export async function searchPartnerPackages({ query, city, category, pincode, lat, lng } = {}) {
  if (!isEnabled()) return { enabled: false, packages: [] };
  const zip = String(pincode || getEnv("DIAG_B2B_DEFAULT_PINCODE") || "").trim();
  if (!zip) throw new Error("Diagnostics search requires pincode (or DIAG_B2B_DEFAULT_PINCODE)");

  const token = await getAccessToken();
  const method = getEnv("DIAG_B2B_PRODUCTS_METHOD", "POST").toUpperCase();
  const payload = {
    zipcode: zip,
    product_type: String(getEnv("DIAG_B2B_PRODUCT_TYPE", "") || ""),
    product_type_id: "",
    start: String(getEnv("DIAG_B2B_PRODUCTS_START", "0") || "0"),
    limit: String(getEnv("DIAG_B2B_PRODUCTS_LIMIT", "60") || "60"),
    test_type: normalizeProductType(category),
    client_id: getEnv("DIAG_B2B_CLIENT_ID", ""),
  };
  const la = lat != null ? Number(lat) : NaN;
  const lo = lng != null ? Number(lng) : NaN;
  if (Number.isFinite(la) && Number.isFinite(lo)) {
    payload.lat = String(la);
    payload.long = String(lo);
  }
  const data = await httpRequest(productsPath(), {
    method,
    body: method === "GET" ? null : payload,
    query: method === "GET" ? payload : null,
    token,
  });
  assertPartnerSuccess(data, "Failed to fetch diagnostics packages");
  const rawList = pickFirst(data, ["data", "products", "packages", "data.products", "data.packages", "result"]);
  const q = String(query || "").trim().toLowerCase();
  const list = ensureArray(rawList)
    .map(normalizePackage)
    .filter(Boolean)
    .filter((item) => {
      if (!q) return true;
      const text = `${item.heading} ${item.sub_heading} ${item.deal_id}`.toLowerCase();
      return text.includes(q);
    });
  return { enabled: true, packages: list };
}

export async function getPartnerPackageDetails({ packageId, city, pincode, category = "", lat, lng } = {}) {
  if (!isEnabled()) return null;
  const latLngOpts =
    lat != null && lng != null && Number.isFinite(Number(lat)) && Number.isFinite(Number(lng))
      ? { lat: Number(lat), lng: Number(lng) }
      : {};
  const { packages } = await searchPartnerPackages({
    query: "",
    city,
    category,
    pincode,
    ...latLngOpts,
  });
  return (
    packages.find((p) => p.package_id === String(packageId) || p.deal_id === String(packageId)) ||
    packages.find((p) => p.product_type_id === String(packageId)) ||
    null
  );
}

function normalizeSlot(slot) {
  const slotId = pickFirst(slot, ["slot_id", "stm_id", "id", "slotCode", "code"]);
  const label = pickFirst(slot, ["slot_label", "label", "time", "window"]);
  return slotId
    ? {
        slot_id: String(slotId),
        label: String(label || `${pickFirst(slot, ["slot_time"]) || ""}-${pickFirst(slot, ["end_time"]) || ""}`),
        date: String(pickFirst(slot, ["date", "slot_date"]) || ""),
        city_id: pickFirst(slot, ["city_id"]) ? String(pickFirst(slot, ["city_id"])) : null,
        state_id: pickFirst(slot, ["state_id"]) ? String(pickFirst(slot, ["state_id"])) : null,
        slot_time: String(pickFirst(slot, ["slot_time"]) || ""),
        end_time: String(pickFirst(slot, ["end_time"]) || ""),
        raw: slot,
      }
    : null;
}

async function checkServiceability({ city, pincode, lat, lng }, token) {
  const method = getEnv("DIAG_B2B_SERVICEABILITY_METHOD", "POST").toUpperCase();
  const payload = {
    zipcode: pincode,
    lat: String(lat || getEnv("DIAG_B2B_DEFAULT_LAT", "")),
    long: String(lng || getEnv("DIAG_B2B_DEFAULT_LONG", "")),
    is_ppmc_booking: 0,
  };
  const data = await httpRequest(serviceabilityPath(), {
    method,
    body: method === "GET" ? null : payload,
    query: method === "GET" ? payload : null,
    token,
  });
  assertPartnerSuccess(data, "Serviceability check failed");
  const zoneId = pickFirst(data, ["data.zone_id", "zone_id"]);
  if (!zoneId) throw new Error("No zone_id in serviceability response");
  const ok = pickFirst(data, ["is_serviceable", "serviceable", "status"]);
  if (ok === false) throw new Error("Location is not serviceable for diagnostics booking");
  return data;
}

async function fetchSlots({ pincode, date, zoneId, lat, lng, totalAmount, dealIds, femalePatient = false }, token) {
  const method = getEnv("DIAG_B2B_SLOTS_METHOD", "POST").toUpperCase();
  const payload = {
    zipcode: pincode,
    slot_date: date,
    zone_id: String(zoneId),
    lat: String(lat || getEnv("DIAG_B2B_DEFAULT_LAT", "")),
    long: String(lng || getEnv("DIAG_B2B_DEFAULT_LONG", "")),
    get_ppmc_slots: 0,
    has_female_patient: femalePatient ? 1 : 0,
    amount: Math.max(0, Math.round(Number(totalAmount) || 0)),
    package: [{ deal_id: dealIds.map((d) => String(d)) }],
  };
  const data = await httpRequest(slotsPath(), {
    method,
    body: method === "GET" ? null : payload,
    query: method === "GET" ? payload : null,
    token,
  });
  assertPartnerSuccess(data, "Failed to fetch diagnostics slots");
  const rawSlots = pickFirst(data, ["slots", "data.slots", "data", "result"]);
  const slots = ensureArray(rawSlots).map(normalizeSlot).filter(Boolean);
  if (!slots.length) throw new Error("No slots available for selected location/date");
  return { raw: data, slots };
}

async function freezeSlot({ slot, vendorBillingUserId }, token) {
  if (!slot?.slot_id) return null;
  const method = getEnv("DIAG_B2B_FREEZE_SLOT_METHOD", "POST").toUpperCase();
  const payload = {
    slot_id: slot.slot_id,
    vendor_billing_user_id: vendorBillingUserId,
  };
  const data = await httpRequest(freezeSlotPath(), {
    method,
    body: method === "GET" ? null : payload,
    query: method === "GET" ? payload : null,
    token,
  });
  assertPartnerSuccess(data, "Failed to freeze slot");
  const freezeRef = pickFirst(data, ["data.slot_id", "slot_id"]);
  return {
    freeze_id: freezeRef ? String(freezeRef) : null,
    raw: data,
  };
}

function toMF(gender = "") {
  const g = String(gender || "").trim().toLowerCase();
  return g.startsWith("f") ? "F" : "M";
}

/** 10-digit Indian mobile for partner APIs (handles +91 / leading 0). */
export function toPartnerCallingNumber(phone) {
  const d = String(phone ?? "").replace(/\D/g, "");
  if (!d) return "";
  if (d.length === 10) return d;
  if (d.length === 11 && d.startsWith("0")) return d.slice(1);
  if (d.length >= 12 && d.startsWith("91")) {
    const tail = d.slice(2);
    if (tail.length === 10) return tail;
  }
  if (d.length > 10) return d.slice(-10);
  return d;
}

function computeChecksum(rawBody) {
  const staticValue = getEnv("DIAG_B2B_CHECKSUM_STATIC");
  if (staticValue) return staticValue;
  const secret = getEnv("DIAG_B2B_CHECKSUM_SECRET");
  if (!secret) return "";
  const mode = getEnv("DIAG_B2B_CHECKSUM_MODE", "sha256_body_secret");
  if (mode === "sha256_body") {
    return crypto.createHash("sha256").update(rawBody).digest("hex");
  }
  if (mode === "sha256_secret_body") {
    return crypto.createHash("sha256").update(`${secret}${rawBody}`).digest("hex");
  }
  return crypto.createHash("sha256").update(`${rawBody}${secret}`).digest("hex");
}

function bookingPayload({
  packageItems,
  customer,
  address,
  paymentType,
  slot,
  zoneId,
  vendorBookingId,
  vendorBillingUserId,
  discountedPrice,
  cityId,
  stateId,
}) {
  const genderMF = toMF(customer.gender);
  const callingNumber = toPartnerCallingNumber(customer.phone);
  const zipcode = String(address.pincode || "").replace(/[^\d]/g, "").slice(0, 6);
  const lat = address.lat != null ? String(address.lat) : getEnv("DIAG_B2B_DEFAULT_LAT", "");
  const lng = address.lng != null ? String(address.lng) : getEnv("DIAG_B2B_DEFAULT_LONG", "");
  return {
    customer: [
      {
        customer_id: customer.vendor_user_id,
        customer_name: customer.name,
        relation: "self",
        age: customer.age,
        gender: genderMF,
        contact_number: callingNumber,
        email: customer.email,
        application_number: customer.application_number || "",
        customer_remarks: customer.customer_remarks || "",
      },
    ],
    slot: {
      slot_id: slot?.slot_id || "",
    },
    package: [{ deal_id: packageItems.map((p) => String(p.deal_id || p.package_id)) }],
    customer_calling_number: callingNumber,
    billing_cust_name: customer.name,
    gender: genderMF,
    mobile: callingNumber,
    email: customer.email || "",
    state: Number(stateId || getEnv("DIAG_B2B_DEFAULT_STATE_ID", "0")) || 0,
    cityId: Number(cityId || getEnv("DIAG_B2B_DEFAULT_CITY_ID", "0")) || 0,
    sub_locality: address.locality || address.address_line2 || address.address_line1 || "",
    latitude: lat,
    longitude: lng,
    address: address.address_line1 || "",
    zipcode,
    landmark: address.landmark || "",
    altmobile: customer.altmobile || "",
    altemail: customer.altemail || "",
    hard_copy: 0,
    vendor_booking_id: vendorBookingId,
    vendor_billing_user_id: vendorBillingUserId,
    payment_option: paymentType,
    discounted_price: Math.max(0, Math.round(Number(discountedPrice) || 0)),
    zone_id: Number(zoneId || 0),
    client_id: getEnv("DIAG_B2B_CLIENT_ID", ""),
    is_ppmc_booking: 0,
  };
}

export async function createPartnerDiagnosticsBooking({
  packageItems,
  customer,
  address,
  city,
  paymentType = "cod",
  preferredDate = null,
}) {
  if (!isEnabled()) throw new Error("Diagnostics partner integration is disabled");
  const token = await getAccessToken();
  const items = Array.isArray(packageItems) ? packageItems : [];
  const dealIds = items
    .map((p) => String(p?.deal_id || p?.package_id || "").trim())
    .filter(Boolean);
  if (!dealIds.length) throw new Error("At least one partner deal_id is required for diagnostics booking");
  const totalAmount = items.reduce((s, p) => s + (Number(p?.price_inr) || 0), 0);
  const pincode = String(address.pincode || getEnv("DIAG_B2B_DEFAULT_PINCODE", "")).trim();
  if (!pincode) throw new Error("Pincode is required for diagnostics booking");
  const serviceability = await checkServiceability({ city, pincode, lat: address.lat, lng: address.lng }, token);
  const zoneId = pickFirst(serviceability, ["data.zone_id", "zone_id"]);
  const today = isoDateYYYYMMDD();
  const scheduleDate = preferredDate ? isoDateYYYYMMDD(new Date(preferredDate)) : today;
  const { slots } = await fetchSlots(
    {
      pincode,
      date: scheduleDate,
      zoneId,
      lat: address.lat,
      lng: address.lng,
      totalAmount,
      dealIds,
      femalePatient: toMF(customer.gender) === "F",
    },
    token
  );
  const slot = slots[0] || null;
  const vendorBillingUserId = String(customer.vendor_user_id || "").trim();
  const freezeRef = slot ? await freezeSlot({ slot, vendorBillingUserId }, token) : null;
  const selectedSlot = freezeRef?.freeze_id ? { ...slot, slot_id: freezeRef.freeze_id } : slot;
  const vendorBookingId = `MLDX-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
  const payload = bookingPayload({
    packageItems: items,
    customer,
    address,
    paymentType,
    slot: selectedSlot,
    zoneId,
    vendorBookingId,
    vendorBillingUserId,
    discountedPrice: totalAmount,
    cityId: selectedSlot?.city_id || items[0]?.city_id,
    stateId: selectedSlot?.state_id || null,
  });
  const rawPayload = JSON.stringify(payload);
  const checksum = computeChecksum(rawPayload);
  const method = getEnv("DIAG_B2B_CREATE_BOOKING_METHOD", "POST").toUpperCase();
  const data = await httpRequest(createBookingPath(), {
    method,
    body: method === "GET" ? null : payload,
    query: method === "GET" ? payload : null,
    token,
    headers: checksum ? { "X-Checksum": checksum } : {},
  });
  assertPartnerSuccess(data, "Diagnostics booking failed");

  const bookingRef = pickFirst(data, [
    "booking_id",
    "bookingId",
    "order_id",
    "data.booking_id",
    "data.order_id",
    "result.booking_id",
  ]);
  const custArr = ensureArray(pickFirst(data, ["data.customer", "customer"]));
  const c0 = custArr[0] || {};
  const vendorCustomerResp =
    c0.vendor_customer_id != null && String(c0.vendor_customer_id).trim()
      ? String(c0.vendor_customer_id).trim()
      : c0.customer_id != null && String(c0.customer_id).trim()
        ? String(c0.customer_id).trim()
        : pickFirst(data, ["data.vendor_customer_id", "vendor_customer_id"]) != null
          ? String(pickFirst(data, ["data.vendor_customer_id", "vendor_customer_id"]))
          : null;

  return {
    booking_ref: bookingRef ? String(bookingRef) : "",
    vendor_booking_id: vendorBookingId,
    vendor_billing_user_id: vendorBillingUserId,
    vendor_customer_id: vendorCustomerResp,
    slot: selectedSlot,
    freeze_ref: freezeRef?.freeze_id || null,
    zone_id: zoneId ? String(zoneId) : null,
    checksum_used: Boolean(checksum),
    provider_response: data,
  };
}

export async function getPartnerBookingStatus({ bookingId }) {
  if (!isEnabled()) return null;
  if (!bookingId) return null;
  const token = await getAccessToken();
  const data = await httpRequest(bookingStatusPath(), {
    method: "POST",
    body: { booking_id: String(bookingId) },
    token,
  });
  assertPartnerSuccess(data, "Unable to fetch partner booking status");
  return {
    booking_id: pickFirst(data, ["data.booking_id", "booking_id"]) || String(bookingId),
    booking_status: pickFirst(data, ["data.booking_status", "booking_status"]) || "",
    customer: ensureArray(pickFirst(data, ["data.customer", "customer"])),
    raw: data,
  };
}

export function extractReportUrlsFromCustomerReportData(data) {
  const cand = [];
  const paths = ["data.report_url", "report_url", "data.cgm_report_url", "cgm_report_url", "data.full_report_url"];
  for (const p of paths) {
    const u = pickFirst(data, [p]);
    const s = u != null ? String(u).trim() : "";
    if (s.startsWith("https://")) cand.push(s);
  }
  return cand;
}

/**
 * Healthians-style customer report lookup (requires booking + vendor identifiers from createBooking payload).
 */
export async function getPartnerCustomerReport({
  bookingId,
  vendorBillingUserId,
  vendorCustomerId,
  allowPartial = 1,
} = {}) {
  if (!isEnabled()) throw new Error("Diagnostics partner integration is disabled");
  const bid = String(bookingId || "").trim();
  const vb = String(vendorBillingUserId || "").trim();
  const vc = String(vendorCustomerId || "").trim();
  if (!bid || !vb || !vc) {
    throw new Error("getCustomerReport requires booking_id, vendor_billing_user_id, vendor_customer_id");
  }
  const token = await getAccessToken();
  const method = getEnv("DIAG_B2B_CUSTOMER_REPORT_METHOD", "POST").toUpperCase();
  const payload = {
    booking_id: bid,
    vendor_billing_user_id: vb,
    vendor_customer_id: vc,
    allow_partial_report: Number(allowPartial) ? 1 : 0,
  };
  const data = await httpRequest(customerReportPath(), {
    method,
    body: method === "GET" ? null : payload,
    query: method === "GET" ? payload : null,
    token,
  });
  assertPartnerSuccess(data, "Unable to fetch partner customer report");
  return { raw: data, urls: extractReportUrlsFromCustomerReportData(data) };
}

export function isDiagnosticsPartnerEnabled() {
  return isEnabled();
}

