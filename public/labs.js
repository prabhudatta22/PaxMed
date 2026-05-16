import { addCartLine, cartLineCount, diagnosticsVendorCanon } from "./cartStore.js";
import { clearCachedUser, fetchAndCacheUser, loadCachedUser } from "./authProfile.js";

const $ = (id) => document.getElementById(id);

const MIN_QUERY_LEN = 2;
const DEBOUNCE_MS = 380;
const SUGGEST_MIN_QUERY_LEN = 2;
const SUGGEST_DEBOUNCE_MS = 180;
const RECENT_KEY = "paxmed_recent_lab_searches_v1";
const RECENT_MAX = 6;
const DIAG_PREPAID_KEY = "paxmed_diag_prepaid_payload_v1";
const ORDER_SUCCESS_FLASH_KEY = "paxmed_order_success_message_v1";
const GEO_STORAGE_KEY = "paxmed_geo_location_v1";

function apiFetch(input, init = {}) {
  return fetch(input, { credentials: "same-origin", ...init });
}

let cities = [];
let selectedCategory = "";
let selectedDiagPackages = new Map();

/** Queued diagnostics test names for multi-compare (`runCompareAll`). */
let compareQueue = [];
/** Tracks how the results panel was loaded (for city/pin/category refresh behavior). */
let lastCompareMode = "none";

let geoCompareTimer = null;

const selectedOfferPickKeys = new Set();

const DEFAULT_METRO_CITIES = [
  { slug: "mumbai", name: "Mumbai", state: "Maharashtra" },
  { slug: "bengaluru", name: "Bengaluru", state: "Karnataka" },
  { slug: "new-delhi", name: "New Delhi", state: "Delhi" },
];

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

function cleanPincode(raw) {
  return String(raw || "")
    .replace(/\D/g, "")
    .slice(0, 6);
}

/** Heading / partner package label for autocomplete rows. */
function diagSuggestionLabel(it) {
  return String(
    it?.heading ??
      it?.name ??
      it?.package_name ??
      it?.product_name ??
      it?.title ??
      it?.test_name ??
      ""
  ).trim();
}

function appendStoredGeoCoords(params) {
  try {
    const raw = sessionStorage.getItem(GEO_STORAGE_KEY);
    if (!raw) return;
    const j = JSON.parse(raw);
    const la = Number(j?.google?.lat);
    const lo = Number(j?.google?.lng);
    if (Number.isFinite(la) && Number.isFinite(lo)) {
      params.set("lat", String(la));
      params.set("lng", String(lo));
    }
  } catch {
    /* ignore */
  }
}

function fmtINR(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return "—";
  return `₹${x.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
}

async function getJson(url, options = {}) {
  const res = await apiFetch(url, options);
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

function localDateInputValue(date = new Date()) {
  const d = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return d.toISOString().slice(0, 10);
}

function toStartOfLocalDayIso(dateInput) {
  const v = String(dateInput || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return null;
  const d = new Date(`${v}T09:00:00`);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

function modalEls() {
  return {
    wrap: $("labPkgModal"),
    closeBtn: $("labPkgModalClose"),
    backdrop: $("labPkgModalBackdrop"),
    title: $("labPkgModalTitle"),
    sub: $("labPkgModalSub"),
    provider: $("labPkgModalProvider"),
    tat: $("labPkgModalTat"),
    price: $("labPkgModalPrice"),
    mrp: $("labPkgModalMrp"),
    tests: $("labPkgModalTests"),
  };
}

function bookModalEls() {
  return {
    wrap: $("labBookModal"),
    backdrop: $("labBookModalBackdrop"),
    closeBtn: $("labBookModalClose"),
    cancelBtn: $("labBookCancel"),
    confirmBtn: $("labBookConfirm"),
    sub: $("labBookModalSub"),
    hint: $("labBookHint"),
    selectedWrap: $("labBookSelectedWrap"),
    total: $("labBookTotal"),
    dateInput: $("labBookDate"),
    paymentSelect: $("labBookPayment"),
  };
}

function pkgKey(pkg) {
  const v = String(pkg?.vendorKey ?? "").trim();
  return `${String(pkg?.dealId || pkg?.packageId || "").trim()}|${v}`;
}

function addSelectedPackage(pkg) {
  const key = pkgKey(pkg);
  if (!key || key === "|") return;
  selectedDiagPackages.set(key, {
    city: pkg.city,
    packageId: String(pkg.packageId || ""),
    dealId: String(pkg.dealId || pkg.packageId || ""),
    packageName: String(pkg.packageName || ""),
    priceInr: Number(pkg.priceInr) || 0,
    mrpInr: pkg.mrpInr == null ? null : Number(pkg.mrpInr),
    vendorKey: String(pkg.vendorKey || ""),
    vendorLabel: String(pkg.vendorLabel || pkg.vendorKey || ""),
    bookingSupported: pkg.bookingSupported !== false,
  });
}

function selectedPackagesList() {
  return [...selectedDiagPackages.values()];
}

function renderBookSelection() {
  const m = bookModalEls();
  if (!m.selectedWrap || !m.total) return;
  const packs = selectedPackagesList();
  if (!packs.length) {
    m.selectedWrap.innerHTML = `<p class="muted">No tests selected.</p>`;
    m.total.textContent = "";
    return;
  }
  m.selectedWrap.innerHTML = packs
    .map(
      (p) => `
      <div class="dx-book-selected-item">
        <span>${escapeHtml(p.vendorLabel ? `${p.vendorLabel} · ` : "")}${escapeHtml(p.packageName)} <span class="muted">(${escapeHtml(
          fmtINR(p.priceInr),
        )})</span></span>
        <button type="button" class="btn btn-sm btn-ghost" data-remove-pkg="${escapeAttr(pkgKey(p))}">Remove</button>
      </div>`
    )
    .join("");
  const total = packs.reduce((s, p) => s + (Number(p.priceInr) || 0), 0);
  m.total.textContent = `Total for ${packs.length} test(s): ${fmtINR(total)}`;
}

function closePackageModal() {
  const m = modalEls();
  if (!m.wrap) return;
  m.wrap.classList.add("hidden");
  m.wrap.setAttribute("aria-hidden", "true");
}

function closeBookModal() {
  const m = bookModalEls();
  if (!m.wrap) return;
  m.wrap.classList.add("hidden");
  m.wrap.setAttribute("aria-hidden", "true");
  pendingBookCtx = null;
  if (m.confirmBtn) m.confirmBtn.disabled = false;
}

function openPackageModal(item) {
  const m = modalEls();
  if (!m.wrap) return;
  const tests = Array.isArray(item.tests_included) ? item.tests_included.slice(0, 15) : [];
  if (m.title) m.title.textContent = item.heading || "Diagnostics package";
  if (m.sub) m.sub.textContent = item.sub_heading || "";
  if (m.provider) m.provider.textContent = item.lab_name || "—";
  if (m.tat) m.tat.textContent = item.report_tat_hours != null ? `${item.report_tat_hours} hrs` : "—";
  if (m.price) m.price.textContent = item.price_inr != null ? fmtINR(item.price_inr) : "—";
  if (m.mrp) m.mrp.textContent = item.mrp_inr != null ? fmtINR(item.mrp_inr) : "—";
  if (m.tests) {
    if (tests.length) {
      m.tests.innerHTML = tests.map((t) => `<li>${escapeHtml(String(t))}</li>`).join("");
    } else {
      m.tests.innerHTML = `<li class="muted">Test list not available for this package.</li>`;
    }
  }
  m.wrap.classList.remove("hidden");
  m.wrap.setAttribute("aria-hidden", "false");
}

let pendingBookCtx = null;
function openBookModal(ctx, { singleTest = true } = {}) {
  if (ctx.bookingSupported === false) {
    setStatus("That vendor listing is estimate-only and cannot be booked here yet.");
    return;
  }
  const m = bookModalEls();
  if (!m.wrap) return;
  if (singleTest) {
    selectedDiagPackages.clear();
  } else {
    const targetCanon = diagnosticsVendorCanon(ctx.vendorKey);
    for (const [key, pkg] of [...selectedDiagPackages.entries()]) {
      if (diagnosticsVendorCanon(pkg.vendorKey) !== targetCanon) selectedDiagPackages.delete(key);
    }
  }
  addSelectedPackage(ctx);
  pendingBookCtx = ctx;
  const minDate = new Date();
  minDate.setDate(minDate.getDate() + 1);
  const min = localDateInputValue(minDate);
  const maxDate = new Date(minDate.getTime());
  maxDate.setDate(maxDate.getDate() + 30);
  const max = localDateInputValue(maxDate);
  const packs = selectedPackagesList();
  if (m.sub) m.sub.textContent = `${packs.length} test(s) selected for scheduled booking`;
  if (m.dateInput) {
    m.dateInput.min = min;
    m.dateInput.max = max;
    m.dateInput.value = min;
  }
  if (m.paymentSelect) m.paymentSelect.value = "cod";
  if (m.hint) {
    const pc = cleanPincode($("labPincode")?.value || "");
    const pinNote =
      pc.length === 6
        ? ""
        : " If you haven't saved an address under Profile yet, fill the Pickup pincode field on this page (6 digits).";
    m.hint.textContent =
      `A reminder will be added automatically before your scheduled sample collection.${pinNote}`;
  }
  renderBookSelection();
  m.wrap.classList.remove("hidden");
  m.wrap.setAttribute("aria-hidden", "false");
}

function initPackageModalHandlers() {
  const m = modalEls();
  if (!m.wrap) return;
  m.closeBtn?.addEventListener("click", () => closePackageModal());
  m.backdrop?.addEventListener("click", () => closePackageModal());
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && m.wrap && !m.wrap.classList.contains("hidden")) closePackageModal();
  });
}

function initBookModalHandlers() {
  const m = bookModalEls();
  if (!m.wrap) return;
  const close = () => closeBookModal();
  m.closeBtn?.addEventListener("click", close);
  m.cancelBtn?.addEventListener("click", close);
  m.backdrop?.addEventListener("click", close);
  m.wrap?.addEventListener("click", (e) => {
    const btn = e.target.closest?.("[data-remove-pkg]");
    if (!btn) return;
    const id = btn.getAttribute("data-remove-pkg") || "";
    if (!id) return;
    selectedDiagPackages.delete(id);
    renderBookSelection();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && m.wrap && !m.wrap.classList.contains("hidden")) closeBookModal();
  });
  m.confirmBtn?.addEventListener("click", async () => {
    const selected = selectedPackagesList();
    if (!selected.length) {
      if (m.hint) m.hint.textContent = "Select at least one test before booking.";
      return;
    }
    const vendorKeys = [
      ...new Set(selected.map((p) => diagnosticsVendorCanon(p.vendorKey)).filter(Boolean)),
    ];
    if (vendorKeys.length > 1) {
      if (m.hint) m.hint.textContent = "Book one diagnostics vendor at a time. Remove other vendors from the list.";
      return;
    }
    const scheduledForIso = toStartOfLocalDayIso(m.dateInput?.value);
    if (!scheduledForIso) {
      if (m.hint) m.hint.textContent = "Please choose a valid future booking date.";
      return;
    }
    const statusEl = $("labStatus");
    m.confirmBtn.disabled = true;
    const bookingPayload = {
      package_id: selected[0].packageId,
      deal_id: selected[0].dealId,
      package_name: selected[0].packageName,
      city: selected[0].city,
      price_inr: selected[0].priceInr,
      mrp_inr: Number.isFinite(selected[0].mrpInr) ? selected[0].mrpInr : null,
      vendor_key: selected[0].vendorKey || "",
      packages: selected.map((p) => ({
        package_id: p.packageId,
        deal_id: p.dealId,
        package_name: p.packageName,
        city: p.city,
        price_inr: p.priceInr,
        mrp_inr: Number.isFinite(p.mrpInr) ? p.mrpInr : null,
        vendor_key: p.vendorKey || "",
      })),
      payment_type: m.paymentSelect?.value || "cod",
      scheduled_for: scheduledForIso,
      collection_pincode: cleanPincode($("labPincode")?.value || ""),
    };
    if (statusEl) statusEl.textContent = "Confirming your booking…";
    try {
      if (bookingPayload.payment_type === "prepaid") {
        localStorage.setItem(DIAG_PREPAID_KEY, JSON.stringify(bookingPayload));
        closeBookModal();
        window.location.assign("/diagnostics-payment.html");
        return;
      }
      const booked = await getJson("/api/orders/diagnostics", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(bookingPayload),
      });
      if (!booked.ok) {
        if (m.hint) m.hint.textContent = booked.data?.error || `Booking failed (${booked.status})`;
        if (statusEl) statusEl.textContent = booked.data?.error || `Booking failed (${booked.status})`;
        m.confirmBtn.disabled = false;
        return;
      }
      const ord = booked.data?.order || {};
      const oid = ord?.id;
      if (oid === undefined || oid === null || oid === "") {
        if (m.hint)
          m.hint.textContent = "Booking succeeded but we could not read the order id. Open Orders from the menu.";
        if (statusEl) statusEl.textContent = booked.data?.error || "Booking response incomplete.";
        m.confirmBtn.disabled = false;
        return;
      }
      try {
        sessionStorage.setItem(ORDER_SUCCESS_FLASH_KEY, "Diagnostics booking confirmed.");
      } catch {
        /* ignore */
      }
      if (statusEl) {
        statusEl.textContent = `Successfully order placed. Order #${ord.id}${
          ord.partner_booking_ref ? ` · Ref ${ord.partner_booking_ref}` : ""
        }`;
      }
      selectedDiagPackages = new Map();
      closeBookModal();
      window.location.assign(`/order.html?id=${encodeURIComponent(String(oid))}`);
    } catch (e) {
      const msg = String(e?.message || e);
      if (m.hint) m.hint.textContent = msg;
      if (statusEl) statusEl.textContent = msg;
      m.confirmBtn.disabled = false;
    }
  });
}

function loadRecent() {
  try {
    const raw = localStorage.getItem(RECENT_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function saveRecent(q) {
  const s = String(q || "").trim();
  if (!s) return;
  const arr = loadRecent().filter((x) => x.toLowerCase() !== s.toLowerCase());
  arr.unshift(s);
  const next = arr.slice(0, RECENT_MAX);
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  } catch {
    /* ignore */
  }
  renderRecent();
}

function renderRecent() {
  const host = document.querySelector('.quick-chips[aria-label="Popular"]');
  if (!host) return;
  const existing = host.querySelector(".recent-chip-group");
  if (existing) existing.remove();
  const recent = loadRecent();
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
      const input = $("labQ");
      if (!input) return;
      input.value = q;
      input.focus();
      void runSearch();
      clearTimeout(suggestTimer);
      suggestTimer = setTimeout(runSuggestSearch, SUGGEST_DEBOUNCE_MS);
    });
    wrap.appendChild(btn);
  });
  host.appendChild(wrap);
}

async function uploadDiagnosticsPrescriptionAndExtract() {
  const fileEl = $("labRxFile");
  const btn = $("labRxUploadBtn");
  const status = $("labRxStatus");
  const out = $("labRxMatches");
  const city = $("labCity")?.value || "";
  if (!fileEl || !btn || !status || !out) return;

  const file = fileEl.files?.[0];
  if (!file) {
    status.textContent = "Choose an image/PDF first.";
    return;
  }
  if (!city) {
    status.textContent = "Choose a city first.";
    return;
  }

  btn.disabled = true;
  status.textContent = "Extracting tests from image…";
  out.classList.add("hidden");
  out.innerHTML = "";

  try {
    const fd = new FormData();
    fd.append("file", file);
    const res = await apiFetch(`/api/labs/prescription/ocr?city=${encodeURIComponent(city)}`, { method: "POST", body: fd });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      status.textContent = data.error || `OCR failed (${res.status})`;
      btn.disabled = false;
      return;
    }
    const matches = data.matches || [];
    if (!matches.length) {
      status.textContent = "No tests confidently matched. Try a clearer photo (printed text works best).";
      btn.disabled = false;
      return;
    }
    status.textContent = `Matched ${matches.length} test(s). Click one to search.`;
    out.innerHTML = matches
      .map((m, idx) => {
        const extra = [m.lab_name ? `Lab: ${m.lab_name}` : "", m.price_inr != null ? fmtINR(m.price_inr) : ""]
          .filter(Boolean)
          .join(" · ");
        const line = m.match_line ? `Matched line: ${m.match_line}` : "";
        return `
          <div class="rx-match">
            <div>
              <div class="rx-match-title">${escapeHtml(m.heading || "")}</div>
              <div class="rx-match-sub muted">${escapeHtml(m.sub_heading || "")}${
                extra ? ` · ${escapeHtml(extra)}` : ""
              }${line ? ` · ${escapeHtml(line)}` : ""}</div>
            </div>
            <button type="button" class="btn btn-sm btn-primary dxrx-pick" data-idx="${idx}">Search</button>
          </div>`;
      })
      .join("");
    out.classList.remove("hidden");
    out.querySelectorAll(".dxrx-pick").forEach((b) => {
      b.addEventListener("click", () => {
        const idx = Number(b.dataset.idx);
        const m = matches[idx];
        if (!m?.heading) return;
        $("labQ").value = String(m.heading);
        closeSuggestions?.();
        runSearch();
      });
    });
  } catch (e) {
    status.textContent = String(e?.message || e);
  } finally {
    btn.disabled = false;
  }
}

function refreshCartBadge() {
  const n = cartLineCount();
  const el = $("cartBadge");
  if (!el) return;
  el.textContent = String(n);
  el.classList.toggle("hidden", n === 0);
}

let currentUser = null;

async function postJson(url, body) {
  const res = await apiFetch(url, {
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
  const ordersEl = $("navOrders");
  const profileEl = $("navProfile");
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
  // Orders are for consumer users only (OTP/Google). Hide for logged-out and service providers.
  const isConsumer = isLogged && u?.role !== "service_provider";
  if (ordersEl) ordersEl.classList.toggle("hidden", !isConsumer);
  if (profileWrapEl) profileWrapEl.classList.toggle("hidden", !isConsumer);
  // Keep bare "Profile" link behavior aligned across pages.
  if (profileEl) profileEl.classList.toggle("hidden", !isConsumer);
  if (profileLogoutEl) profileLogoutEl.classList.toggle("hidden", !isLogged);

  if (!isLogged) {
    userEl.textContent = "";
    if (profileNameEl) profileNameEl.textContent = "Account";
    return;
  }
  userEl.textContent =
    u.role === "service_provider"
      ? `SP · ${u.username || "account"}`
      : u.full_name
        ? `${u.full_name}`
      : u.email
        ? `${u.email}`
      : u.phone_e164
        ? `${u.phone_e164}`
        : "Account";
  if (profileNameEl) profileNameEl.textContent = userEl.textContent;
}

async function refreshAuth() {
  currentUser = loadCachedUser();
  renderAuthNav();
  currentUser = await fetchAndCacheUser();
  renderAuthNav();
}

async function loadCities() {
  try {
    const res = await apiFetch("/api/cities");
    const data = await res.json().catch(() => ({}));
    cities = data.cities || [];
  } catch {
    cities = [];
  }

  if (!Array.isArray(cities) || cities.length === 0) {
    cities = DEFAULT_METRO_CITIES.slice();
  }
  const sel = $("labCity");
  sel.innerHTML = cities
    .map((c) => `<option value="${escapeHtml(c.slug)}">${escapeHtml(c.name)}, ${escapeHtml(c.state)}</option>`)
    .join("");
}

async function loadCategories() {
  const res = await apiFetch("/api/labs/categories");
  const data = await res.json();
  const cats = data.categories || ["PATHOLOGY"];
  $("labCats").innerHTML = cats
    .map((c) => {
      const active = c === selectedCategory ? " active" : "";
      return `<button type="button" class="chip${active}" data-cat="${escapeHtml(c)}">${escapeHtml(c)}</button>`;
    })
    .join("");

  $("labCats").querySelectorAll("button[data-cat]").forEach((b) => {
    b.addEventListener("click", () => {
      const c = b.getAttribute("data-cat") || "";
      selectedCategory = selectedCategory === c ? "" : c;
      loadCategories();
      runSearch();
      clearTimeout(suggestTimer);
      suggestTimer = setTimeout(runSuggestSearch, SUGGEST_DEBOUNCE_MS);
    });
  });
}

function setStatus(msg) {
  $("labStatus").textContent = msg || "";
}

/** Stable key per vendor row for multi-select bulk add-to-cart */
function offerPickKeyFromOffer(off) {
  const pk = String(off.package_id || "");
  const vk = String(off.vendor_key || "");
  const dk = String(off.deal_id || pk);
  return `${pk}|${vk}|${dk}`;
}

function statsFromGroups(groups) {
  const prices = (Array.isArray(groups) ? groups : [])
    .flatMap((g) => (Array.isArray(g?.offers) ? g.offers : []).map((o) => Number(o.price_inr)))
    .filter((n) => Number.isFinite(n));
  if (!prices.length) return { min_inr: NaN, max_inr: NaN, spread_percent: null };
  const min_inr = Math.min(...prices);
  const max_inr = Math.max(...prices);
  const spread_percent =
    max_inr > min_inr ? Math.round(((max_inr - min_inr) / max_inr) * 1000) / 10 : null;
  return { min_inr, max_inr, spread_percent };
}

function renderCompareQueue() {
  const wrap = $("labCompareQueue");
  const btnAll = $("labCompareAllBtn");
  const btnClr = $("labClearQueueBtn");
  if (!wrap) return;
  if (!compareQueue.length) {
    wrap.classList.add("hidden");
    wrap.innerHTML = "";
    if (btnAll) btnAll.disabled = true;
    if (btnClr) btnClr.disabled = true;
    return;
  }
  wrap.classList.remove("hidden");
  if (btnAll) btnAll.disabled = false;
  if (btnClr) btnClr.disabled = false;
  wrap.innerHTML = compareQueue
    .map(
      (q, idx) =>
        `<button type="button" class="chip chip-queue-item" data-rm-queue-idx="${idx}" aria-label="Remove ${escapeAttr(
          q,
        )} from comparison list">${escapeHtml(q)} <span aria-hidden="true">×</span></button>`,
    )
    .join("");
  wrap.querySelectorAll("[data-rm-queue-idx]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const i = Number(btn.getAttribute("data-rm-queue-idx"));
      if (!Number.isFinite(i) || i < 0 || i >= compareQueue.length) return;
      compareQueue.splice(i, 1);
      renderCompareQueue();
      setStatus(compareQueue.length ? `${compareQueue.length} diagnostic test(s) in your list.` : "Comparison list cleared.");
    });
  });
}

function addCurrentTestToCompareQueue() {
  const q = $("labQ").value.trim();
  if (!q || q.length < MIN_QUERY_LEN) {
    setStatus(`Enter at least ${MIN_QUERY_LEN} characters before adding a diagnostic to the list.`);
    return;
  }
  const exists = compareQueue.some((x) => x.toLowerCase() === q.toLowerCase());
  if (!exists) compareQueue.push(q);
  renderCompareQueue();
  setStatus(
    exists
      ? `"${q}" is already in the list. Use Compare all listed tests to refresh prices for every entry.`
      : `Added "${q}" (${compareQueue.length} in list). Use Compare all listed tests to compare every diagnostic at once.`,
  );
}

function scheduleGeoCompareRefresh() {
  clearTimeout(geoCompareTimer);
  geoCompareTimer = setTimeout(() => rerunLastCompare(), DEBOUNCE_MS);
}

function rerunLastCompare() {
  if (lastCompareMode === "multi" && compareQueue.length) {
    void runCompareAll(false);
    return;
  }
  const q = ($("labQ")?.value || "").trim();
  if (lastCompareMode === "single" && q.length >= MIN_QUERY_LEN) runSearch();
}

function refreshBulkBar() {
  const bar = $("labBulkActions");
  const label = $("labBulkPickCount");
  if (!bar || !label) return;
  const n = selectedOfferPickKeys.size;
  bar.classList.toggle("hidden", n === 0);
  label.textContent = n === 0 ? "" : n === 1 ? "1 offer selected — add each row you want." : `${n} offers selected.`;
}

function readBulkPickFromCheckbox(cb) {
  return {
    city: $("labCity")?.value || "",
    packageId: cb.getAttribute("data-package-id") || "",
    dealId: cb.getAttribute("data-deal-id") || "",
    packageName: cb.getAttribute("data-heading") || "",
    priceInr: Number(cb.getAttribute("data-price")),
    mrpRaw: cb.getAttribute("data-mrp"),
    vendorKey: cb.getAttribute("data-vendor-key") || "",
    vendorLabel: cb.getAttribute("data-vendor-label") || "",
    bookingSupported: cb.getAttribute("data-booking") === "1",
  };
}

async function runCompareAll(persistRecent = true) {
  const city = $("labCity").value;
  const pincode = cleanPincode($("labPincode")?.value || "");
  const tests = [...compareQueue];
  if (!tests.length) {
    setStatus("Use Add test to list to queue diagnostics, then Compare all listed tests — or Compare prices for a single search.");
    return;
  }
  if (!city) {
    setStatus("Choose a city before comparing diagnostics.");
    return;
  }

  lastCompareMode = "multi";
  setStatus("Comparing diagnostics…");

  try {
    const results = await Promise.all(
      tests.map(async (q) => {
        const params = new URLSearchParams({ q, city, pincode });
        if (selectedCategory) params.set("category", selectedCategory);
        appendStoredGeoCoords(params);
        const res = await apiFetch(`/api/labs/compare?${params.toString()}`);
        const data = await res.json().catch(() => ({}));
        return { ok: res.ok, status: res.status, q, data };
      }),
    );

    const failedAll = results.length > 0 && results.every((r) => !r.ok);
    if (failedAll) {
      const e0 = results[0];
      setStatus(e0?.data?.error || `Diagnostics compare failed (${e0?.status || "?"})`);
      render([], null);
      return;
    }

    const allGroups = [];
    /** @type {string[]} */
    const failedParts = [];
    for (const r of results) {
      if (!r.ok) {
        failedParts.push(`${r.q} (${r.data?.error || r.status})`);
        continue;
      }
      const gs = r.data?.groups;
      if (Array.isArray(gs)) allGroups.push(...gs);
      if (persistRecent) saveRecent(r.q);
    }

    const stats = statsFromGroups(allGroups);
    let msg = `Compared ${tests.length} diagnostic search(es) · ${city}${selectedCategory ? ` · ${selectedCategory}` : ""}`;
    const mn = Number(stats.min_inr);
    const mx = Number(stats.max_inr);
    if (Number.isFinite(mn) && Number.isFinite(mx) && mx > mn) {
      msg += ` · ₹${Math.round(mn).toLocaleString("en-IN")}–₹${Math.round(mx).toLocaleString("en-IN")}`;
      if (stats.spread_percent != null) msg += ` (~${stats.spread_percent}% spread)`;
    }
    if (failedParts.length) msg += ` · Missing: ${failedParts.join("; ")}`;
    setStatus(msg);

    render(allGroups, stats);
  } catch (e) {
    setStatus(String(e?.message || e));
    render([], null);
  }
}

function canOpenDiagDetail(off) {
  if (String(off?.package_id || "").startsWith("stub:")) return false;
  const vk = String(off?.vendor_key || "");
  return vk === "healthians" || vk === "paxmed_catalog";
}

/** @param {unknown} groups @param {{ min_inr?: unknown; max_inr?: unknown; spread_percent?: unknown } | null | undefined} stats */
function render(groups, stats) {
  const grid = $("labGrid");
  const empty = $("labEmpty");
  selectedOfferPickKeys.clear();

  if (!Array.isArray(groups) || !groups.length) {
    grid.innerHTML = "";
    empty.classList.remove("hidden");
    refreshBulkBar();
    return;
  }
  empty.classList.add("hidden");

  const minAmongAll = groups.flatMap((g) => (g.offers || []).map((o) => Number(o.price_inr))).filter((n) => Number.isFinite(n));
  const globalFloor = minAmongAll.length >= 2 ? Math.min(...minAmongAll) : null;

  grid.innerHTML = groups
    .map((g) => {
      const offers = Array.isArray(g.offers) ? g.offers : [];
      const finite = offers.map((o) => Number(o.price_inr)).filter((n) => Number.isFinite(n));
      const gMin = finite.length >= 2 ? Math.min(...finite) : finite.length === 1 ? finite[0] : null;

      const rows = offers
        .map((off) => {
          const price = Number(off.price_inr);
          const mrp = off.mrp_inr != null ? Number(off.mrp_inr) : null;
          const discFromApi =
            off.discount_pct != null && Number.isFinite(Number(off.discount_pct)) ? Number(off.discount_pct) : null;
          const hasDiscountByMrp = mrp != null && mrp > price && price > 0;
          const hasDiscount = (discFromApi != null && discFromApi > 0.05) || hasDiscountByMrp;
          const pct =
            discFromApi != null && discFromApi > 0
              ? Math.round(discFromApi * 10) / 10
              : hasDiscountByMrp && mrp != null
                ? Math.round(((mrp - price) / mrp) * 1000) / 10
                : null;
          const pk = String(off.package_id || "");
          const dk = String(off.deal_id || pk);
          const book = off.booking_supported !== false;
          const vk = String(off.vendor_key || "");
          const vlab = String(off.vendor_label || off.lab_name || vk || "Vendor");
          const mode = String(off.data_mode || "");
          const badge =
            Number.isFinite(price) && globalFloor != null && price === globalFloor
              ? `<span class="pill pill-deal">Lowest</span>`
              : Number.isFinite(price) && gMin != null && price === gMin && offers.length >= 2
                ? `<span class="pill pill-muted">Best in test</span>`
                : "";
          const bookPill = book
            ? `<span class="pill">Bookable</span>`
            : `<span class="pill pill-muted">Estimate</span>`;

          const detailBtn = canOpenDiagDetail(off)
            ? `<button type="button" class="btn btn-sm btn-ghost" data-cmp-view="${escapeAttr(pk)}">View</button>`
            : "";
          const pickKey = offerPickKeyFromOffer(off);

          return `<tr>
            <td class="lab-pick-cell">
              <input
                type="checkbox"
                class="lab-offer-pick"
                data-cmp-pick="1"
                data-pick-key="${escapeAttr(pickKey)}"
                title="Include in bulk add"
                aria-label="${escapeAttr(`Select ${vlab} for cart`)}"
                data-package-id="${escapeAttr(pk)}"
                data-deal-id="${escapeAttr(dk)}"
                data-heading="${escapeAttr(off.heading || g.heading || "")}"
                data-price="${escapeAttr(price)}"
                data-mrp="${escapeAttr(off.mrp_inr ?? "")}"
                data-vendor-key="${escapeAttr(vk)}"
                data-vendor-label="${escapeAttr(vlab)}"
                data-booking="${book ? "1" : "0"}"
              />
            </td>
            <td>
              <strong>${escapeHtml(vlab)}</strong>
              ${off.vendor_note ? `<div class="muted" style="font-size:0.8rem;margin-top:0.25rem">${escapeHtml(off.vendor_note)}</div>` : ""}
              <div style="margin-top:0.35rem">${badge} ${bookPill}${
                mode && mode !== "partner_api" && mode !== "local_catalog"
                  ? ` <span class="pill pill-muted">${escapeHtml(mode.replace(/_/g, " "))}</span>`
                  : ""
              }</div>
            </td>
            <td class="price-cell">${escapeHtml(fmtINR(price))}</td>
            <td>${hasDiscount && mrp != null ? `<s class="muted">${escapeHtml(fmtINR(mrp))}</s>` : mrp != null ? escapeHtml(fmtINR(mrp)) : "—"}</td>
            <td>${pct != null && pct > 0 ? escapeHtml(String(pct)) + "%" : "—"}</td>
            <td style="white-space:nowrap">
              ${detailBtn}
              <button
                type="button"
                class="btn btn-sm btn-ghost"
                data-cmp-add="1"
                data-package-id="${escapeAttr(pk)}"
                data-deal-id="${escapeAttr(dk)}"
                data-heading="${escapeAttr(off.heading || g.heading || "")}"
                data-price="${escapeAttr(price)}"
                data-mrp="${escapeAttr(off.mrp_inr ?? "")}"
                data-vendor-key="${escapeAttr(vk)}"
                data-vendor-label="${escapeAttr(vlab)}"
                data-booking="${book ? "1" : "0"}"
              >Add</button>
              <button
                type="button"
                class="btn btn-sm btn-primary"
                data-cmp-book="1"
                data-package-id="${escapeAttr(pk)}"
                data-deal-id="${escapeAttr(dk)}"
                data-heading="${escapeAttr(off.heading || g.heading || "")}"
                data-price="${escapeAttr(price)}"
                data-mrp="${escapeAttr(off.mrp_inr ?? "")}"
                data-vendor-key="${escapeAttr(vk)}"
                data-vendor-label="${escapeAttr(vlab)}"
                data-booking="${book ? "1" : "0"}"
              >Book</button>
            </td>
          </tr>`;
        })
        .join("");

      const iconBit = g.icon_url
        ? `<div class="lab-icowrap" style="width:44px;height:44px;margin-right:0.65rem"><img src="${escapeHtml(g.icon_url)}" alt="" loading="lazy"/></div>`
        : `<div class="lab-icowrap" style="width:44px;height:44px;margin-right:0.65rem"><span>🧪</span></div>`;

      return `
      <article class="lab-compare-bundle">
        <div class="lab-compare-bundle-head" style="display:flex;gap:0.75rem;align-items:flex-start;margin-bottom:0.65rem">
          ${iconBit}
          <div>
            <h3 style="margin:0;font-size:1.05rem">${escapeHtml(g.heading)}</h3>
            ${g.sub_heading ? `<p class="muted" style="margin:0.25rem 0 0">${escapeHtml(g.sub_heading)}</p>` : ""}
          </div>
        </div>
        <div class="table-wrap">
          <table class="price-table lab-vendor-table" aria-label="Diagnostics vendor prices">
            <thead><tr><th class="lab-pick-cell"><span class="sr-only">Select for bulk add to cart</span></th><th>Vendor</th><th>Price</th><th>MRP</th><th>% off</th><th></th></tr></thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
      </article>`;
    })
    .join("");

  refreshBulkBar();

  grid.querySelectorAll("button[data-cmp-view]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const packageId = btn.getAttribute("data-cmp-view") || "";
      const city = $("labCity")?.value || "";
      const pincode = cleanPincode($("labPincode")?.value || "");
      if (!packageId || !city) return;
      const out = await getJson(
        `/api/labs/package/${encodeURIComponent(packageId)}?city=${encodeURIComponent(city)}&pincode=${encodeURIComponent(pincode)}`
      );
      if (!out.ok) {
        setStatus(out.data?.error || `Failed to load package details (${out.status})`);
        return;
      }
      const item = out.data?.item || {};
      openPackageModal(item);
    });
  });

  grid.querySelectorAll("button[data-cmp-book]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const city = $("labCity")?.value || "";
      const packageId = btn.getAttribute("data-package-id") || "";
      const dealId = btn.getAttribute("data-deal-id") || packageId;
      const packageName = btn.getAttribute("data-heading") || "";
      const priceInr = Number(btn.getAttribute("data-price"));
      const mrpRaw = btn.getAttribute("data-mrp");
      const mrpInr = mrpRaw === "" || mrpRaw == null ? null : Number(mrpRaw);
      const vendorKey = btn.getAttribute("data-vendor-key") || "";
      const vendorLabel = btn.getAttribute("data-vendor-label") || vendorKey;
      const bookingSupported = btn.getAttribute("data-booking") === "1";
      if (!city || !packageId || !packageName || !Number.isFinite(priceInr)) {
        setStatus(
          "Cannot start booking: choose a city, run Compare prices, then pick a row that shows a price.",
        );
        return;
      }
      if (!bookingSupported) {
        setStatus("That vendor row is estimate-only and cannot be booked from this table.");
        return;
      }
      if (!currentUser) {
        setStatus("Please log in to book diagnostics. Redirecting to sign-in…");
        window.location.assign(`/login.html?returnTo=${encodeURIComponent("/labs.html")}`);
        return;
      }
      openBookModal(
        { city, packageId, dealId, packageName, priceInr, mrpInr, vendorKey, vendorLabel, bookingSupported },
        { singleTest: true },
      );
    });
  });

  grid.querySelectorAll("button[data-cmp-add]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const city = $("labCity")?.value || "";
      const packageId = btn.getAttribute("data-package-id") || "";
      const dealId = btn.getAttribute("data-deal-id") || packageId;
      const packageName = btn.getAttribute("data-heading") || "";
      const priceInr = Number(btn.getAttribute("data-price"));
      const mrpRaw = btn.getAttribute("data-mrp");
      const mrpInr = mrpRaw === "" || mrpRaw == null ? null : Number(mrpRaw);
      const vendorKey = btn.getAttribute("data-vendor-key") || "";
      const vendorLabel = btn.getAttribute("data-vendor-label") || vendorKey;
      const bookingSupported = btn.getAttribute("data-booking") === "1";
      if (!city || !packageId || !packageName || !Number.isFinite(priceInr)) return;
      addSelectedPackage({
        city,
        packageId,
        dealId,
        packageName,
        priceInr,
        mrpInr,
        vendorKey,
        vendorLabel,
        bookingSupported,
      });
      addCartLine({
        source: "diagnostics",
        packageId,
        dealId,
        city,
        vendorKey,
        vendorLabel,
        bookingSupported,
        providerName: vendorLabel,
        medicineLabel: packageName,
        unitPriceInr: priceInr,
        mrpInr: Number.isFinite(mrpInr) ? mrpInr : null,
        quantity: 1,
      });
      refreshCartBadge();
      setStatus(
        `Added ${vendorLabel}: ${packageName}. ${cartLineCount()} cart item(s) · Compare-only rows can be removed before checkout.`,
      );
    });
  });
}

async function runSearch() {
  const q = $("labQ").value.trim();
  const city = $("labCity").value;
  const pincode = cleanPincode($("labPincode")?.value || "");

  if (!q) {
    lastCompareMode = "none";
    selectedOfferPickKeys.clear();
    $("labGrid").innerHTML = "";
    $("labEmpty")?.classList.add("hidden");
    refreshBulkBar();
    setStatus("Enter a diagnostic test (e.g. CBC), then click Compare prices.");
    return;
  }
  if (q.length < MIN_QUERY_LEN) {
    lastCompareMode = "none";
    selectedOfferPickKeys.clear();
    $("labGrid").innerHTML = "";
    $("labEmpty")?.classList.add("hidden");
    refreshBulkBar();
    setStatus(`Enter at least ${MIN_QUERY_LEN} characters, then Compare prices.`);
    return;
  }

  lastCompareMode = "single";
  setStatus("Comparing diagnostics…");
  saveRecent(q);

  const params = new URLSearchParams({ q, city, pincode });
  if (selectedCategory) params.set("category", selectedCategory);
  appendStoredGeoCoords(params);

  try {
    const res = await apiFetch(`/api/labs/compare?${params.toString()}`);
    const data = await res.json();
    if (!res.ok) {
      lastCompareMode = "none";
      setStatus(data.error || `Compare failed (${res.status})`);
      render([], null);
      return;
    }
    const stats = data.stats || {};
    const groups = data.groups || [];
    let msg = `Price compare for "${q}" in ${city}${selectedCategory ? ` · ${selectedCategory}` : ""}`;
    const mn = Number(stats.min_inr);
    const mx = Number(stats.max_inr);
    const sp = stats.spread_percent;
    if (Number.isFinite(mn) && Number.isFinite(mx) && mx > mn) {
      msg += ` · ₹${Math.round(mn).toLocaleString("en-IN")}–₹${Math.round(mx).toLocaleString("en-IN")}`;
      if (sp != null && Number.isFinite(Number(sp))) msg += ` (~${Number(sp)}% spread)`;
    }
    msg += ". Book Healthians listings when configured, or catalog where shown as bookable.";
    setStatus(msg);
    render(groups, stats);
  } catch (e) {
    lastCompareMode = "none";
    setStatus(String(e?.message || e));
    render([], null);
  }
}

function renderIntents(intents) {
  const row = $("labIntentRow");
  if (!row) return;
  if (!Array.isArray(intents) || intents.length === 0) {
    row.classList.add("hidden");
    row.innerHTML = "";
    return;
  }
  row.classList.remove("hidden");
  row.innerHTML = intents
    .slice(0, 6)
    .map((it) => `<button type="button" class="chip" data-intent="${escapeHtml(it.id)}">${escapeHtml(it.label)}</button>`)
    .join("");
  row.querySelectorAll("button[data-intent]").forEach((b) => {
    b.addEventListener("click", () => {
      const label = b.textContent || "";
      const input = $("labQ");
      if (!input) return;
      input.value = label;
      input.focus();
      void runSearch();
    });
  });
}

let intentTimer;
async function refreshIntentHints() {
  const q = $("labQ")?.value?.trim() || "";
  const city = $("labCity")?.value || "";
  const pincode = cleanPincode($("labPincode")?.value || "");
  if (!city || q.length < 2) {
    renderIntents([]);
    return;
  }
  try {
    const res = await apiFetch(
      `/api/labs/intent?q=${encodeURIComponent(q)}&city=${encodeURIComponent(city)}&pincode=${encodeURIComponent(pincode)}`
    );
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      renderIntents([]);
      return;
    }
    renderIntents(data.intents || []);
  } catch {
    renderIntents([]);
  }
}

// --- Autocomplete suggestions (same min length as live search / medicines) ---
let suggestTimer;
/** @type {AbortController | null} */
let suggestAbort = null;
let suggestItems = [];
let suggestActive = -1;

function getSuggestEls() {
  const input = $("labQ");
  const box = $("labQ-suggestions");
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

  const filtered = (Array.isArray(items) ? items : []).filter((it) => diagSuggestionLabel(it));
  if (!filtered.length) {
    closeSuggestions();
    return;
  }

  suggestItems = filtered.slice(0, 10);
  suggestActive = -1;
  openSuggestions();

  const qLower = String(q || "").toLowerCase();
  box.innerHTML = suggestItems
    .map((it, idx) => {
      const id = `labQ-sug-${idx}`;
      const heading = diagSuggestionLabel(it);
      const sub = String(it.sub_heading || "").trim();
      const headingLower = heading.toLowerCase();
      const hitAt = qLower && headingLower.includes(qLower) ? headingLower.indexOf(qLower) : -1;
      const label =
        hitAt >= 0 && qLower.length
          ? `${escapeHtml(heading.slice(0, hitAt))}<mark>${escapeHtml(
              heading.slice(hitAt, hitAt + qLower.length)
            )}</mark>${escapeHtml(heading.slice(hitAt + qLower.length))}`
          : escapeHtml(heading);
      return `
        <div class="suggestion" role="option" id="${escapeAttr(id)}" data-idx="${idx}" aria-selected="false">
          <div class="suggestion-title">${label}</div>
          ${sub ? `<div class="suggestion-sub muted">${escapeHtml(sub)}</div>` : ""}
        </div>`;
    })
    .join("");

  box.querySelectorAll(".suggestion").forEach((row) => {
    row.addEventListener("mousedown", (e) => e.preventDefault());
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
  const it = suggestItems[idx];
  const heading = diagSuggestionLabel(it);
  if (!heading) return;
  input.value = heading;
  closeSuggestions();
  void runSearch();
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
    const suggestParams = new URLSearchParams({ q });
    if (selectedCategory) suggestParams.set("category", selectedCategory);
    const res = await apiFetch(`/api/labs/tests/suggest?${suggestParams.toString()}`, { signal });
    const data = await res.json().catch(() => ({}));
    if (signal.aborted) return;
    let items = Array.isArray(data.items) ? data.items : [];

    // Local catalog empty (e.g. partner-only DB): fall back to priced search when city is set.
    if (!items.length) {
      const city = $("labCity")?.value || "";
      if (city) {
        const p2 = new URLSearchParams({ q, city, pincode: cleanPincode($("labPincode")?.value || "") });
        if (selectedCategory) p2.set("category", selectedCategory);
        appendStoredGeoCoords(p2);
        const res2 = await apiFetch(`/api/labs/search?${p2.toString()}`, { signal });
        const data2 = await res2.json().catch(() => ({}));
        if (signal.aborted) return;
        if (res2.ok && Array.isArray(data2.items)) items = data2.items;
      }
    }

    renderSuggestions(items, q);
  } catch (e) {
    if (e?.name === "AbortError") return;
    closeSuggestions();
  }
}

$("labQ").addEventListener("keydown", (e) => {
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
  const { box } = getSuggestEls();
  if (box && !box.classList.contains("hidden")) {
    const rows = box.querySelectorAll(".suggestion");
    if (rows.length && suggestActive >= 0) {
      e.preventDefault();
      pickSuggestion(suggestActive);
      return;
    }
  }
  e.preventDefault();
  void runSearch();
});

$("labQ").addEventListener("input", () => {
  clearTimeout(intentTimer);
  intentTimer = setTimeout(refreshIntentHints, 220);
  clearTimeout(suggestTimer);
  suggestTimer = setTimeout(runSuggestSearch, SUGGEST_DEBOUNCE_MS);
});

$("labQ").addEventListener("blur", () => setTimeout(() => closeSuggestions(), 180));

$("labCity").addEventListener("change", () => {
  if (($("labQ")?.value || "").trim().length >= SUGGEST_MIN_QUERY_LEN) {
    clearTimeout(suggestTimer);
    suggestTimer = setTimeout(runSuggestSearch, SUGGEST_DEBOUNCE_MS);
  }
  rerunLastCompare();
});
$("labPincode")?.addEventListener("input", (e) => {
  const el = e.currentTarget;
  if (!el) return;
  el.value = cleanPincode(el.value);
  scheduleGeoCompareRefresh();
  if (($("labQ")?.value || "").trim().length >= SUGGEST_MIN_QUERY_LEN) {
    clearTimeout(suggestTimer);
    suggestTimer = setTimeout(runSuggestSearch, SUGGEST_DEBOUNCE_MS);
  }
});

function initLabsDiagnosticsCompareBulk() {
  $("labCompareBtn")?.addEventListener("click", () => runSearch());

  $("labQueueAddBtn")?.addEventListener("click", () => addCurrentTestToCompareQueue());

  $("labCompareAllBtn")?.addEventListener("click", () => runCompareAll(true));

  $("labClearQueueBtn")?.addEventListener("click", () => {
    compareQueue.length = 0;
    renderCompareQueue();
    setStatus("Diagnostics comparison list cleared.");
  });

  const grid = $("labGrid");
  grid?.addEventListener("change", (e) => {
    const t = e.target;
    if (!(t instanceof HTMLInputElement) || !t.matches("input.lab-offer-pick")) return;
    const key = t.getAttribute("data-pick-key") || "";
    if (!key) return;
    if (t.checked) selectedOfferPickKeys.add(key);
    else selectedOfferPickKeys.delete(key);
    refreshBulkBar();
  });

  $("labBulkClearSelBtn")?.addEventListener("click", () => {
    selectedOfferPickKeys.clear();
    $("labGrid")?.querySelectorAll("input.lab-offer-pick:checked").forEach((cb) => {
      cb.checked = false;
    });
    refreshBulkBar();
  });

  $("labBulkAddCartBtn")?.addEventListener("click", () => {
    const rows = $("labGrid")?.querySelectorAll("input.lab-offer-pick:checked");
    if (!rows?.length) return;
    let added = 0;
    rows.forEach((cb) => {
      const a = readBulkPickFromCheckbox(cb);
      if (!a.city || !a.packageId || !a.packageName || !Number.isFinite(a.priceInr)) return;
      const mrpInr = a.mrpRaw === "" || a.mrpRaw == null ? null : Number(a.mrpRaw);
      addSelectedPackage({
        city: a.city,
        packageId: a.packageId,
        dealId: a.dealId || a.packageId,
        packageName: a.packageName,
        priceInr: a.priceInr,
        mrpInr: Number.isFinite(mrpInr) ? mrpInr : null,
        vendorKey: a.vendorKey,
        vendorLabel: a.vendorLabel,
        bookingSupported: a.bookingSupported,
      });
      addCartLine({
        source: "diagnostics",
        packageId: a.packageId,
        dealId: a.dealId || a.packageId,
        city: a.city,
        vendorKey: a.vendorKey,
        vendorLabel: a.vendorLabel,
        bookingSupported: a.bookingSupported,
        providerName: a.vendorLabel,
        medicineLabel: a.packageName,
        unitPriceInr: a.priceInr,
        mrpInr: Number.isFinite(mrpInr) ? mrpInr : null,
        quantity: 1,
      });
      added += 1;
    });
    refreshCartBadge();
    setStatus(
      `Added ${added} diagnostics offer row(s). Cart quantity total: ${cartLineCount()} — compare-only (Estimate) rows are skipped at checkout.`,
    );
    selectedOfferPickKeys.clear();
    rows.forEach((cb) => {
      cb.checked = false;
    });
    refreshBulkBar();
  });

  renderCompareQueue();
}

/** Popular starter chips (“CBC”, “Thyroid”, …) in the side panel — module script replaces the old inline handler. */
function initPopularStarterChips() {
  const host = document.querySelector(".quick-chips[aria-label='Popular']");
  if (!host) return;
  host.querySelectorAll(".chip[data-q]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const q = btn.getAttribute("data-q") || "";
      const input = $("labQ");
      if (!input) return;
      input.value = q;
      input.focus();
      void runSearch();
      clearTimeout(suggestTimer);
      suggestTimer = setTimeout(runSuggestSearch, SUGGEST_DEBOUNCE_MS);
    });
  });
}

async function initLabsPage() {
  await loadCities();
  await refreshAuth();
  await loadCategories();
  refreshCartBadge();
  window.addEventListener("pageshow", () => refreshCartBadge());
  renderRecent();

  $("navLogout")?.addEventListener("click", async (e) => {
    e.preventDefault();
    await postJson("/api/auth/logout", {});
    clearCachedUser();
    currentUser = null;
    renderAuthNav();
  });

  $("navProfileLogout")?.addEventListener("click", async (e) => {
    e.preventDefault();
    await postJson("/api/auth/logout", {});
    clearCachedUser();
    currentUser = null;
    renderAuthNav();
  });

  $("labRxUploadBtn")?.addEventListener("click", () => uploadDiagnosticsPrescriptionAndExtract());
  initPackageModalHandlers();
  initBookModalHandlers();
  initLabsDiagnosticsCompareBulk();
  initPopularStarterChips();

  // Support deep-link from home page: /labs.html?q=...&city=...&category=...
  const params = new URLSearchParams(window.location.search);
  const q0 = (params.get("q") || "").trim();
  const city0 = (params.get("city") || "").trim();
  const pin0 = cleanPincode(params.get("pincode") || "");
  const cat0 = (params.get("category") || "").trim().toUpperCase();
  if (city0 && $("labCity") && [...$("labCity").options].some((o) => o.value === city0)) {
    $("labCity").value = city0;
  }
  if (pin0 && $("labPincode")) {
    $("labPincode").value = pin0;
  }
  if (cat0 === "PATHOLOGY" || cat0 === "RADIOLOGY") {
    selectedCategory = cat0;
    await loadCategories();
  }
  if (q0) {
    $("labQ").value = q0;
    runSearch();
    clearTimeout(suggestTimer);
    suggestTimer = setTimeout(runSuggestSearch, SUGGEST_DEBOUNCE_MS);
  } else {
    setStatus(
      'Enter a diagnostic, pick a starter chip below, then click Compare prices — or queue several tests with "Add test to list" and Compare all listed tests.',
    );
  }
}

initLabsPage().catch((e) => {
  setStatus(String(e?.message || e));
});

