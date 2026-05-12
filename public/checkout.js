import {
  getCartItems,
  setLineQuantity,
  removeLine,
  clearCart,
  bucketKey,
  bucketTitle,
} from "./cartStore.js";
import { fetchAndCacheUser, loadCachedUser, clearCachedUser } from "./authProfile.js";
import {
  loadRazorpayScript,
  fetchRazorpayStatus,
  createRazorpayServerOrder,
  totalInrFromPackages,
} from "./diagnosticsRazorpay.js";

const $ = (id) => document.getElementById(id);
const ORDER_SUCCESS_KEY = "paxmed_order_success_message_v1";
const PRESCRIPTION_LS = "paxmed_checkout_prescription_id";

let rxCheckoutWired = false;
let rxPreviewUrl = null;

function getSelectedPrescriptionId() {
  const sel = $("rxCheckoutSelect");
  if (!sel || !sel.value) return null;
  const n = Number(sel.value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function releaseRxPreview() {
  if (rxPreviewUrl) {
    try {
      URL.revokeObjectURL(rxPreviewUrl);
    } catch {
      /* ignore */
    }
    rxPreviewUrl = null;
  }
}

async function updateRxCheckoutPreview() {
  const host = $("rxCheckoutPreview");
  if (!host) return;
  releaseRxPreview();
  host.innerHTML = "";
  const id = getSelectedPrescriptionId();
  if (!id) return;
  const res = await fetch(`/api/prescriptions/${encodeURIComponent(id)}/file`, { credentials: "same-origin" });
  if (!res.ok) {
    host.innerHTML = `<p class="muted">Could not load preview.</p>`;
    return;
  }
  const blob = await res.blob();
  const mime = blob.type || "application/octet-stream";
  if (mime.includes("pdf")) {
    host.innerHTML = `<a class="btn btn-sm btn-ghost" href="/api/prescriptions/${encodeURIComponent(id)}/file" target="_blank" rel="noopener">Open PDF</a>`;
    return;
  }
  rxPreviewUrl = URL.createObjectURL(blob);
  host.innerHTML = `<img src="${rxPreviewUrl}" alt="Prescription preview" style="max-width: 100%; max-height: 220px; border-radius: 8px; object-fit: contain" />`;
}

async function refreshPrescriptionCheckoutPanel() {
  const panel = $("prescriptionCheckoutPanel");
  const st = $("rxCheckoutStatus");
  if (!panel) return;
  if (!rxCheckoutWired) {
    rxCheckoutWired = true;
    $("rxCheckoutUpload")?.addEventListener("change", onRxCheckoutUpload);
    $("rxCheckoutSelect")?.addEventListener("change", async () => {
      const v = $("rxCheckoutSelect")?.value || "";
      try {
        if (v) localStorage.setItem(PRESCRIPTION_LS, v);
        else localStorage.removeItem(PRESCRIPTION_LS);
      } catch {
        /* ignore */
      }
      await updateRxCheckoutPreview();
    });
  }

  const user = await fetchMe();
  if (!user || user.role === "service_provider") {
    panel.classList.add("hidden");
    return;
  }
  panel.classList.remove("hidden");
  if (st) st.textContent = "";

  const res = await fetch("/api/prescriptions", { credentials: "same-origin" });
  const data = await res.json().catch(() => ({}));
  const list = data.prescriptions || [];
  const sel = $("rxCheckoutSelect");
  if (!sel) return;
  let saved = "";
  try {
    saved = localStorage.getItem(PRESCRIPTION_LS) || "";
  } catch {
    saved = "";
  }
  sel.innerHTML = `<option value="">— None selected —</option>${list
    .map(
      (p) =>
        `<option value="${escapeHtml(String(p.id))}">#${escapeHtml(String(p.id))} · ${escapeHtml(
          p.original_filename || p.mime_type || "file"
        )} · ${escapeHtml(fmtTs(p.created_at))}</option>`
    )
    .join("")}`;
  if (saved && list.some((p) => String(p.id) === saved)) sel.value = saved;
  else if (list.length) sel.value = String(list[0].id);
  try {
    if (sel.value) localStorage.setItem(PRESCRIPTION_LS, sel.value);
  } catch {
    /* ignore */
  }
  await updateRxCheckoutPreview();
}

async function onRxCheckoutUpload(ev) {
  const input = ev.target;
  const file = input?.files?.[0];
  const st = $("rxCheckoutStatus");
  if (!file) return;
  if (st) st.textContent = "Uploading…";
  const fd = new FormData();
  fd.append("file", file);
  const res = await fetch("/api/prescriptions", { method: "POST", body: fd, credentials: "same-origin" });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (st) st.textContent = data.error || `Upload failed (${res.status})`;
    return;
  }
  if (st) st.textContent = "Saved. You can attach it to your order below.";
  input.value = "";
  const id = data.prescription?.id;
  if (id) {
    try {
      localStorage.setItem(PRESCRIPTION_LS, String(id));
    } catch {
      /* ignore */
    }
  }
  await refreshPrescriptionCheckoutPanel();
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function fmt(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return "—";
  return x.toLocaleString("en-IN", { maximumFractionDigits: 2 });
}

function fmtTs(s) {
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" });
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

function cleanCheckoutPin(raw) {
  return String(raw ?? "")
    .replace(/\D/g, "")
    .slice(0, 6);
}

function isDiagnosticsEstimateLine(L) {
  return Boolean(L?.source === "diagnostics" && (L.bookingSupported === false || L.booking_supported === false));
}

function syncDiagPrepaidHint() {
  const hint = $("diagPrepaidHint");
  const pay = $("diagPaymentType");
  const badge = $("razorpayTrustBadge");
  if (!pay) return;
  const prepaid = pay.value === "prepaid";
  if (hint) hint.classList.toggle("hidden", !prepaid);
  if (badge) badge.classList.toggle("hidden", !prepaid);
}

function syncDeliveryPaymentHint() {
  const hint = $("deliveryPrepaidHint");
  const pay = $("deliveryPaymentType");
  if (!hint || !pay) return;
  hint.classList.toggle("hidden", pay.value !== "prepaid");
}

function checkoutReturnPath() {
  return `${window.location.pathname}${window.location.search || ""}` || "/checkout.html";
}

function checkoutLoginHref() {
  return `/login.html?returnTo=${encodeURIComponent(checkoutReturnPath())}`;
}

function wireCheckoutLoginLinks() {
  const h = checkoutLoginHref();
  $("loginToOrderLink")?.setAttribute("href", h);
  $("navLogin")?.setAttribute("href", h);
  $("checkoutAuthLoginBtn")?.setAttribute("href", h);
}

/** Clears stale client session and redirects when an order API rejects auth. */
function redirectToCheckoutLoginFromOrderResponse(res) {
  if (res.status !== 401) return false;
  clearCachedUser();
  wireCheckoutLoginLinks();
  window.location.assign(checkoutLoginHref());
  return true;
}

function isCheckoutConsumer(user) {
  return Boolean(user && user.role !== "service_provider");
}

async function ensureLoggedInConsumer() {
  const user = await fetchAndCacheUser();
  if (isCheckoutConsumer(user)) return user;
  wireCheckoutLoginLinks();
  window.location.assign(checkoutLoginHref());
  return null;
}

function medicineDeliveryFeeInr(deliveryOption) {
  const opt = String(deliveryOption || "normal");
  switch (opt) {
    case "express_60":
      return 49;
    case "express_4_6":
      return 29;
    case "same_day":
      return 19;
    case "normal":
    default:
      return 0;
  }
}

function totalMedicineDeliveryInr(lines, deliveryOption) {
  const fee = medicineDeliveryFeeInr(deliveryOption);
  const sub = (lines || []).reduce((s, L) => {
    const q = Math.max(1, Math.floor(Number(L.quantity) || 1));
    return s + (Number(L.unitPriceInr) || 0) * q;
  }, 0);
  return sub + fee;
}

function updateCheckoutAuthBanner(user) {
  const banner = $("checkoutAuthBanner");
  if (!banner) return;
  const items = getCartItems();
  const needs =
    items.length > 0 &&
    !isCheckoutConsumer(user) &&
    (onlyLocalItems(items).length > 0 || onlyDiagnosticsItems(items).length > 0);
  banner.classList.toggle("hidden", !needs);
}

function removeLinesById(lineIds) {
  const ids = new Set((lineIds || []).map((x) => String(x)));
  if (!ids.size) return;
  const lines = getCartItems();
  lines.forEach((L) => {
    if (ids.has(String(L.lineId))) removeLine(L.lineId);
  });
}

async function placeDiagnosticsOrder() {
  const statusEl = $("diagnosticsStatus");
  const btn = $("placeDiagnosticsBtn");
  if (!statusEl || !btn) return;

  let lines = onlyDiagnosticsItems(getCartItems());
  if (!lines.length) {
    statusEl.textContent = "No diagnostics tests in cart.";
    return;
  }

  const estimateLines = lines.filter(isDiagnosticsEstimateLine);
  lines = lines.filter((L) => !isDiagnosticsEstimateLine(L));

  if (estimateLines.length) {
    removeLinesById(estimateLines.map((L) => L.lineId));
    render();
    if (!lines.length) {
      statusEl.textContent =
        "Removed benchmark-only diagnostics (shown for price compare, not booking). Go to Diagnostics, add rows labelled Bookable, then return here for Cash on collection.";
      return;
    }
    statusEl.textContent = `Skipped ${estimateLines.length} benchmark/estimate vendor line(s); booking ${lines.length} bookable test line(s).`;
  }

  const vendorKeys = [...new Set(lines.map((L) => String(L.vendorKey || "").trim()).filter(Boolean))];
  if (vendorKeys.length > 1) {
    statusEl.textContent =
      "Cart mixes diagnostics vendors. Remove extra vendors or place one booking per vendor (start with one provider).";
    return;
  }
  const hasH = lines.some((L) => L.vendorKey === "healthians");
  const hasCat = lines.some((L) => L.vendorKey === "paxmed_catalog");
  if (hasH && hasCat) {
    statusEl.textContent =
      "Do not mix Healthians and catalogue diagnostics in one cart. Remove one vendor’s lines or book separately.";
    return;
  }

  const citySet = new Set(lines.map((L) => String(L.city || "").trim().toLowerCase()).filter(Boolean));
  if (citySet.size !== 1) {
    statusEl.textContent = "Diagnostics booking supports one city per order. Remove mixed-city tests and retry.";
    return;
  }

  const scheduledForIso = toStartOfLocalDayIso($("diagDate")?.value);
  if (!scheduledForIso) {
    statusEl.textContent = "Please choose a valid future booking date.";
    return;
  }

  const paymentType = $("diagPaymentType")?.value === "prepaid" ? "prepaid" : "cod";
  const packages = [];
  lines.forEach((L) => {
    const qty = Math.max(1, Number(L.quantity) || 1);
    for (let i = 0; i < qty; i += 1) {
      packages.push({
        package_id: String(L.packageId || ""),
        deal_id: String(L.dealId || L.packageId || ""),
        package_name: String(L.medicineLabel || "Diagnostics package"),
        city: String(L.city || ""),
        price_inr: Number(L.unitPriceInr) || 0,
        mrp_inr: L.mrpInr == null ? null : Number(L.mrpInr),
      });
    }
  });
  const prescId = getSelectedPrescriptionId();
  const payload = {
    package_id: packages[0].package_id,
    deal_id: packages[0].deal_id,
    package_name: packages[0].package_name,
    city: packages[0].city,
    price_inr: packages[0].price_inr,
    mrp_inr: packages[0].mrp_inr,
    packages,
    payment_type: paymentType,
    scheduled_for: scheduledForIso,
    cart_line_ids: lines.map((L) => L.lineId),
  };
  if (prescId) payload.prescription_id = prescId;

  const collectionPin = cleanCheckoutPin($("diagPincode")?.value || $("addrPin")?.value || "");
  if (collectionPin) payload.collection_pincode = collectionPin;

  if (!payload.package_id || !payload.city || !Number.isFinite(payload.price_inr) || payload.price_inr <= 0) {
    statusEl.textContent = "Diagnostics cart item is incomplete. Re-add the test and retry.";
    return;
  }

  const user = await ensureLoggedInConsumer();
  if (!user) return;

  if (paymentType === "prepaid") {
    $("diagPaySuccess")?.classList.add("hidden");
    btn.disabled = true;
    statusEl.textContent = "Preparing Razorpay checkout…";
    try {
      const rz = await fetchRazorpayStatus();
      if (!rz.configured) {
        statusEl.innerHTML =
          "Razorpay is not configured on the server. Add <code>RAZORPAY_KEY_ID</code> and <code>RAZORPAY_KEY_SECRET</code> to <code>.env</code> and restart, or choose <strong>Cash on collection</strong>.";
        btn.disabled = false;
        return;
      }
      await loadRazorpayScript();
      const totalInr = totalInrFromPackages(packages);
      if (!(totalInr > 0)) {
        statusEl.textContent = "Invalid cart total.";
        btn.disabled = false;
        return;
      }
      const ord = await createRazorpayServerOrder(totalInr);
      let handlerDone = false;
      const options = {
        key: ord.key_id,
        amount: String(ord.amount),
        currency: ord.currency || "INR",
        order_id: ord.order_id,
        name: "PaxMed",
        description: `Diagnostics · ${packages.length} test(s)`,
        theme: { color: "#0f766e" },
        handler(response) {
          handlerDone = true;
          void (async () => {
            statusEl.textContent = "Verifying payment and confirming booking…";
            try {
              const res = await fetch("/api/orders/diagnostics", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                credentials: "same-origin",
                body: JSON.stringify({
                  ...payload,
                  payment_type: "prepaid",
                  razorpay_order_id: response.razorpay_order_id,
                  razorpay_payment_id: response.razorpay_payment_id,
                  razorpay_signature: response.razorpay_signature,
                }),
              });
              const data = await res.json().catch(() => ({}));
              if (!res.ok) {
                if (redirectToCheckoutLoginFromOrderResponse(res)) return;
                statusEl.textContent = data.error || `Booking failed (${res.status})`;
                btn.disabled = false;
                return;
              }
              removeLinesById(payload.cart_line_ids);
              const o = data.order;
              const oid = o?.id;
              const tid = response.razorpay_payment_id || o?.razorpay_payment_id;
              const rzOid = response.razorpay_order_id || o?.razorpay_order_id;
              $("diagPaySuccess")?.classList.remove("hidden");
              const elOrder = $("diagSuccessOrderId");
              const elTxn = $("diagSuccessTxnId");
              const elRz = $("diagSuccessRzOrderId");
              if (elOrder) elOrder.textContent = String(oid ?? "—");
              if (elTxn) elTxn.textContent = String(tid ?? "—");
              if (elRz) elRz.textContent = String(rzOid ?? "—");
              const link = $("diagSuccessViewOrder");
              if (link && oid) link.href = `/order.html?id=${encodeURIComponent(oid)}`;
              statusEl.textContent = "Booking confirmed. Details below.";
              $("diagPaySuccess")?.scrollIntoView({ behavior: "smooth", block: "nearest" });
              try {
                sessionStorage.setItem(ORDER_SUCCESS_KEY, "Order placed successfully");
              } catch {
                /* ignore */
              }
            } catch (e) {
              statusEl.textContent = String(e?.message || e);
            } finally {
              btn.disabled = false;
              render();
            }
          })();
        },
        modal: {
          ondismiss() {
            if (!handlerDone) {
              statusEl.textContent = "Payment window closed. Choose Prepaid and try again, or pick Cash on collection.";
              btn.disabled = false;
            }
          },
        },
      };
      if (user?.phone_e164 || user?.email) {
        options.prefill = {};
        if (user.phone_e164) options.prefill.contact = user.phone_e164;
        if (user.email) options.prefill.email = user.email;
      }
      statusEl.textContent = `Total ₹${fmt(totalInr)} — complete payment in the Razorpay window.`;
      const rzp = new window.Razorpay(options);
      rzp.open();
    } catch (e) {
      statusEl.textContent = String(e?.message || e);
      btn.disabled = false;
    }
    return;
  }

  btn.disabled = true;
  statusEl.textContent = "Booking diagnostics order…";
  let navigatedAway = false;
  try {
    const res = await fetch("/api/orders/diagnostics", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      credentials: "same-origin",
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      if (redirectToCheckoutLoginFromOrderResponse(res)) return;
      statusEl.textContent = data.error || `Diagnostics booking failed (${res.status})`;
      return;
    }
    removeLinesById(payload.cart_line_ids);
    const id = data?.order?.id;
    if (id === undefined || id === null || id === "") {
      statusEl.textContent = "Booking succeeded but order id was missing. Check Orders from the menu.";
      return;
    }
    try {
      sessionStorage.setItem(
        ORDER_SUCCESS_KEY,
        paymentType === "prepaid"
          ? "Diagnostics booking confirmed (prepaid)"
          : "Diagnostics booking confirmed — cash on collection",
      );
    } catch {
      /* ignore */
    }
    statusEl.textContent = "Opening your order…";
    navigatedAway = true;
    window.location.assign(`/order.html?id=${encodeURIComponent(String(id))}`);
  } catch (e) {
    statusEl.textContent = String(e?.message || e);
  } finally {
    if (!navigatedAway) btn.disabled = false;
  }
}

function groupItems(items) {
  const map = new Map();
  for (const line of items) {
    const k = bucketKey(line);
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(line);
  }
  return map;
}

function uniqueOpenUrls(lines) {
  const seen = new Set();
  const out = [];
  for (const L of lines) {
    const u = L.checkoutUrl;
    if (!u || seen.has(u)) continue;
    seen.add(u);
    out.push(u);
  }
  return out;
}

async function fetchMe() {
  const cached = loadCachedUser();
  if (cached) return cached;
  return fetchAndCacheUser();
}

function renderAuthNav(user) {
  const logged = Boolean(user && user.role !== "service_provider");
  $("navLogin")?.classList.toggle("hidden", logged);
  $("navProfile")?.classList.toggle("hidden", !logged);
  $("navOrders")?.classList.toggle("hidden", !logged);
}

async function refreshAuthNav() {
  renderAuthNav(loadCachedUser());
  const fresh = await fetchAndCacheUser();
  renderAuthNav(fresh);
}

function onlyLocalItems(items) {
  return (items || []).filter((x) => x && x.source === "local");
}

function renderDoseTable(lines) {
  const host = $("doseRows");
  if (!host) return;
  if (!lines.length) {
    host.innerHTML = `<p class="muted">Add at least one <strong>local pharmacy</strong> item to place a delivery order.</p>`;
    return;
  }
  host.innerHTML = `
    <table class="price-table">
      <thead>
        <tr>
          <th>Medicine</th>
          <th>Qty</th>
          <th>Tablets / day</th>
        </tr>
      </thead>
      <tbody>
        ${lines
          .map(
            (L) => `
          <tr>
            <td>${escapeHtml(L.medicineLabel)}${L.strength ? ` <span class="muted">${escapeHtml(L.strength)}</span>` : ""}</td>
            <td class="muted">${Number(L.quantity) || 1}</td>
            <td><input class="qty-input dose-input" type="number" min="0.25" step="0.25" data-line-id="${escapeHtml(
              L.lineId
            )}" placeholder="e.g. 2" /></td>
          </tr>`
          )
          .join("")}
      </tbody>
    </table>`;
}

function collectDoseByLineId() {
  const map = new Map();
  document.querySelectorAll(".dose-input[data-line-id]").forEach((inp) => {
    const id = inp.getAttribute("data-line-id");
    const v = inp.value;
    if (!id) return;
    const n = v == null || v === "" ? null : Number(v);
    if (n != null && (!Number.isFinite(n) || n <= 0)) return;
    map.set(id, n);
  });
  return map;
}

async function placeDeliveryOrder() {
  const statusEl = $("deliveryStatus");
  const btn = $("placeOrderBtn");
  if (!statusEl || !btn) return;

  const items = onlyLocalItems(getCartItems());
  if (!items.length) {
    statusEl.textContent =
      "Your cart has no local pharmacy items — use Add on a Nearby pharmacies or Online retailer row labelled local DB, then return here.";
    return;
  }

  const user = await ensureLoggedInConsumer();
  if (!user) return;

  const addr1 = $("addr1")?.value?.trim() || "";
  if (!addr1) {
    statusEl.textContent = "Address line is required.";
    return;
  }

  const paymentTypeEarly = $("deliveryPaymentType")?.value === "prepaid" ? "prepaid" : "cod";
  if (paymentTypeEarly === "cod") {
    const pin = cleanCheckoutPin($("addrPin")?.value || "");
    if (pin.length !== 6) {
      statusEl.textContent = "Cash on delivery requires a valid 6-digit PIN code.";
      return;
    }
  }

  const doseMap = collectDoseByLineId();
  const delivery_option = $("deliveryOption")?.value || "normal";
  const paymentType = $("deliveryPaymentType")?.value === "prepaid" ? "prepaid" : "cod";

  const prescId = getSelectedPrescriptionId();
  const basePayload = {
    payment_type: paymentType,
    delivery_option,
    address: {
      address_line1: addr1,
      landmark: $("landmark")?.value?.trim() || "",
      city: $("addrCity")?.value?.trim() || "",
      pincode: cleanCheckoutPin($("addrPin")?.value || ""),
    },
    items: items.map((L) => ({
      source: "local",
      pharmacyId: L.pharmacyId,
      medicineId: L.medicineId,
      medicineLabel: L.medicineLabel,
      strength: L.strength || "",
      form: L.form || "",
      pack_size: L.packSize ?? L.pack_size ?? null,
      quantity: Number(L.quantity) || 1,
      unitPriceInr: Number(L.unitPriceInr) || 0,
      mrpInr: L.mrpInr ?? null,
      tablets_per_day: doseMap.get(L.lineId) ?? null,
    })),
  };
  if (prescId) basePayload.prescription_id = prescId;

  if (paymentType === "prepaid") {
    btn.disabled = true;
    statusEl.textContent = "Preparing Razorpay checkout…";
    try {
      const rz = await fetchRazorpayStatus();
      if (!rz.configured) {
        statusEl.innerHTML =
          "Razorpay is not configured on the server. Add <code>RAZORPAY_KEY_ID</code> and <code>RAZORPAY_KEY_SECRET</code> to <code>.env</code> and restart, or choose <strong>Cash on delivery</strong>.";
        btn.disabled = false;
        return;
      }
      await loadRazorpayScript();
      const totalInr = totalMedicineDeliveryInr(items, delivery_option);
      if (!(totalInr > 0)) {
        statusEl.textContent = "Invalid cart total.";
        btn.disabled = false;
        return;
      }
      const ord = await createRazorpayServerOrder(totalInr);
      let handlerDone = false;
      const options = {
        key: ord.key_id,
        amount: String(ord.amount),
        currency: ord.currency || "INR",
        order_id: ord.order_id,
        name: "PaxMed",
        description: `Medicine delivery · ${items.length} line(s)`,
        theme: { color: "#0f766e" },
        handler(response) {
          handlerDone = true;
          void (async () => {
            statusEl.textContent = "Verifying payment and placing order…";
            try {
              const res = await fetch("/api/orders", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                credentials: "same-origin",
                body: JSON.stringify({
                  ...basePayload,
                  payment_type: "prepaid",
                  razorpay_order_id: response.razorpay_order_id,
                  razorpay_payment_id: response.razorpay_payment_id,
                  razorpay_signature: response.razorpay_signature,
                }),
              });
              const data = await res.json().catch(() => ({}));
              if (!res.ok) {
                if (redirectToCheckoutLoginFromOrderResponse(res)) return;
                statusEl.textContent = data.error || `Order failed (${res.status})`;
                btn.disabled = false;
                return;
              }
              const id = data.order?.id;
              if (id === undefined || id === null || id === "") {
                statusEl.textContent = "Payment verified but order id missing. Check Orders.";
                btn.disabled = false;
                return;
              }
              removeLinesById(items.map((L) => L.lineId));
              try {
                sessionStorage.setItem(ORDER_SUCCESS_KEY, "Medicine order placed (prepaid)");
              } catch {
                /* ignore */
              }
              window.location.assign(`/order.html?id=${encodeURIComponent(String(id))}`);
            } catch (e) {
              statusEl.textContent = String(e?.message || e);
            } finally {
              btn.disabled = false;
            }
          })();
        },
        modal: {
          ondismiss() {
            if (!handlerDone) {
              statusEl.textContent =
                "Payment window closed. Try Pay online again or choose Cash on delivery.";
              btn.disabled = false;
            }
          },
        },
      };
      if (user?.phone_e164 || user?.email) {
        options.prefill = {};
        if (user.phone_e164) options.prefill.contact = user.phone_e164;
        if (user.email) options.prefill.email = user.email;
      }
      statusEl.textContent = `Total ₹${fmt(totalInr)} (items + delivery fee) — complete payment in the Razorpay window.`;
      const rzp = new window.Razorpay(options);
      rzp.open();
    } catch (e) {
      statusEl.textContent = String(e?.message || e);
      btn.disabled = false;
    }
    return;
  }

  btn.disabled = true;
  statusEl.textContent = "Placing order…";

  let navigatedAway = false;
  try {
    const res = await fetch("/api/orders", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(basePayload),
      credentials: "same-origin",
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      if (redirectToCheckoutLoginFromOrderResponse(res)) return;
      statusEl.textContent = data.error || `Order failed (${res.status})`;
      return;
    }
    const id = data.order?.id;
    if (id === undefined || id === null || id === "") {
      statusEl.textContent = "Order placed but we could not read the order id. Open Orders from the menu.";
      return;
    }
    removeLinesById(items.map((L) => L.lineId));
    try {
      sessionStorage.setItem(
        ORDER_SUCCESS_KEY,
        paymentType === "prepaid"
          ? "Medicine order placed (prepaid)"
          : "Medicine order placed — cash on delivery",
      );
    } catch {
      /* ignore */
    }
    statusEl.textContent = "Order placed. Opening details…";
    navigatedAway = true;
    window.location.assign(`/order.html?id=${encodeURIComponent(String(id))}`);
  } catch (e) {
    statusEl.textContent = String(e?.message || e);
  } finally {
    if (!navigatedAway) btn.disabled = false;
  }
}

function render() {
  const items = getCartItems();
  const empty = $("empty-state");
  const main = $("cart-main");
  if (!items.length) {
    empty.classList.remove("hidden");
    main.classList.add("hidden");
    return;
  }
  empty.classList.add("hidden");
  main.classList.remove("hidden");

  const groups = groupItems(items);
  let grand = 0;

  $("buckets").innerHTML = Array.from(groups.entries())
    .map(([key, lines]) => {
      const sub = lines.reduce(
        (s, L) => s + (Number(L.unitPriceInr) || 0) * (Number(L.quantity) || 1),
        0
      );
      grand += sub;
      const title = bucketTitle(lines[0]);
      const src = lines[0].source;
      const urls = uniqueOpenUrls(lines);

      const rows = lines
        .map(
          (L) => `
        <tr>
          <td>${escapeHtml(L.medicineLabel)}${L.strength ? ` <span class="muted">${escapeHtml(L.strength)}</span>` : ""}${
            L.source === "diagnostics" && isDiagnosticsEstimateLine(L)
              ? ` <span class="pill pill-muted" title="Skipped at checkout — add a Bookable vendor on Diagnostics instead">Estimate</span>`
              : ""
          }</td>
          <td>
            ${
              L.source === "diagnostics"
                ? `<span class="muted">${Number(L.quantity) || 1}</span>`
                : `<input type="number" min="1" max="99" class="qty-input" data-id="${escapeHtml(L.lineId)}" value="${Number(
                    L.quantity
                  )}" />`
            }
          </td>
          <td class="price-cell">₹${fmt(L.unitPriceInr)}</td>
          <td class="price-cell">₹${fmt((Number(L.unitPriceInr) || 0) * (Number(L.quantity) || 1))}</td>
          <td>${
            L.checkoutUrl
              ? `<a href="${escapeHtml(L.checkoutUrl)}" target="_blank" rel="noopener noreferrer">Open</a>`
              : `<span class="muted">Booked on checkout</span>`
          }</td>
          <td><button type="button" class="btn btn-sm remove-line" data-id="${escapeHtml(L.lineId)}">Remove</button></td>
        </tr>`
        )
        .join("");

      return `
      <section class="panel checkout-bucket" style="margin-top: 1rem" data-bucket-key="${escapeHtml(key)}">
        <div class="online-head">
          <h3 style="margin: 0; font-size: 1.1rem">${escapeHtml(title)} <span class="muted">(${escapeHtml(src)})</span></h3>
          ${
            urls.length
              ? `<button type="button" class="btn btn-sm open-bucket-btn">
            Open this ${src === "local" ? "location" : "retailer"}
          </button>`
              : ""
          }
        </div>
        <p class="muted" style="margin: 0.4rem 0 0.75rem">${
          src === "diagnostics"
            ? "Diagnostics item(s) stay in cart until booking/payment completes."
            : `${urls.length} unique link(s) for this bucket.`
        }</p>
        <div class="table-wrap">
          <table class="price-table">
            <thead>
              <tr>
                <th>Medicine</th>
                <th>Qty</th>
                <th>Unit</th>
                <th>Line total</th>
                <th>Link</th>
                <th></th>
              </tr>
            </thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
        <p class="muted" style="margin-top: 0.75rem">Subtotal: <strong class="price-cell">₹${fmt(sub)}</strong></p>
      </section>`;
    })
    .join("");

  $("grandStats").innerHTML = `<span>Pharmacy / retailer groups: <strong>${groups.size}</strong></span>
    <span>Lines: <strong>${items.length}</strong></span>
    <span>Estimated total: <strong>₹${fmt(grand)}</strong></span>`;

  $("buckets").querySelectorAll(".qty-input").forEach((inp) => {
    inp.addEventListener("change", () => {
      setLineQuantity(inp.dataset.id, inp.value);
      render();
    });
  });
  $("buckets").querySelectorAll(".remove-line").forEach((btn) => {
    btn.addEventListener("click", () => {
      removeLine(btn.dataset.id);
      render();
    });
  });
  $("buckets").querySelectorAll(".open-bucket-btn").forEach((btn) => {
    const section = btn.closest(".checkout-bucket");
    const k = section?.getAttribute("data-bucket-key");
    const lines = k ? groups.get(k) || [] : [];
    const urls = uniqueOpenUrls(lines);
    btn.addEventListener("click", () => {
      urls.forEach((u, i) => {
        setTimeout(() => window.open(u, "_blank", "noopener,noreferrer"), i * 450);
      });
    });
  });

  // Home delivery panel
  const locals = onlyLocalItems(items);
  const pob = $("placeOrderBtn");
  if (pob) pob.disabled = locals.length === 0;
  renderDoseTable(locals);
  const diagPanel = $("diagnosticsPanel");
  const diagDate = $("diagDate");
  const diagPay = $("diagPaymentType");
  const diagLines = onlyDiagnosticsItems(items);
  if (diagPanel) diagPanel.classList.toggle("hidden", diagLines.length === 0);
  if (diagDate) {
    const minDate = new Date();
    minDate.setDate(minDate.getDate() + 1);
    const maxDate = new Date(minDate.getTime());
    maxDate.setDate(maxDate.getDate() + 30);
    diagDate.min = localDateInputValue(minDate);
    diagDate.max = localDateInputValue(maxDate);
    if (!diagDate.value || diagDate.value < diagDate.min || diagDate.value > diagDate.max) {
      diagDate.value = diagDate.min;
    }
  }
  if (diagPay && !diagPay.value) diagPay.value = "cod";
  syncDiagPrepaidHint();
  syncDeliveryPaymentHint();

  void fetchMe().then((u) => updateCheckoutAuthBanner(u));

  void refreshPrescriptionCheckoutPanel();
}

$("clearBtn")?.addEventListener("click", () => {
  if (confirm("Remove all items from the cart?")) {
    clearCart();
    render();
  }
});

$("openAllBtn")?.addEventListener("click", () => {
  const items = getCartItems();
  const urls = uniqueOpenUrls(items);
  urls.forEach((u, i) => {
    setTimeout(() => window.open(u, "_blank", "noopener,noreferrer"), i * 450);
  });
});

render();

wireCheckoutLoginLinks();
Promise.all([refreshAuthNav(), fetchMe()]).then(([, u]) => {
  const loginLink = $("loginToOrderLink");
  if (loginLink) loginLink.classList.toggle("hidden", Boolean(isCheckoutConsumer(u)));
  updateCheckoutAuthBanner(u);
});
$("placeOrderBtn")?.addEventListener("click", () => placeDeliveryOrder());
$("placeDiagnosticsBtn")?.addEventListener("click", () => placeDiagnosticsOrder());
$("diagPincode")?.addEventListener("input", (e) => {
  const el = e.target;
  if (!el || el.type === undefined) return;
  el.value = cleanCheckoutPin(el.value);
});
$("addrPin")?.addEventListener("input", (e) => {
  const el = e.target;
  if (!el) return;
  el.value = cleanCheckoutPin(el.value);
});
$("diagPaymentType")?.addEventListener("change", syncDiagPrepaidHint);
$("deliveryPaymentType")?.addEventListener("change", syncDeliveryPaymentHint);
syncDiagPrepaidHint();
syncDeliveryPaymentHint();
