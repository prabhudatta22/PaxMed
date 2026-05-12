import { removeLine } from "./cartStore.js";
import { fetchAndCacheUser, loadCachedUser } from "./authProfile.js";
import {
  loadRazorpayScript,
  fetchRazorpayStatus,
  createRazorpayServerOrder,
  totalInrFromPackages,
} from "./diagnosticsRazorpay.js";

const $ = (id) => document.getElementById(id);
const DIAG_PREPAID_KEY = "paxmed_diag_prepaid_payload_v1";
const ORDER_SUCCESS_KEY = "paxmed_order_success_message_v1";

function fmtINR(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return "—";
  return `₹${x.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
}

function esc(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function loadPending() {
  try {
    const raw = localStorage.getItem(DIAG_PREPAID_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw);
    if (!Array.isArray(data?.packages) || !data.packages.length) return null;
    return data;
  } catch {
    return null;
  }
}

async function placePrepaidOrder(pending, rz) {
  const status = $("dxPayStatus");
  const btn = $("dxPayBtn");
  const payload = {
    ...pending,
    payment_type: "prepaid",
    razorpay_order_id: rz.razorpay_order_id,
    razorpay_payment_id: rz.razorpay_payment_id,
    razorpay_signature: rz.razorpay_signature,
  };
  const res = await fetch("/api/orders/diagnostics", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "same-origin",
    body: JSON.stringify(payload),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data?.error || `Payment/booking failed (${res.status})`);
  }
  localStorage.removeItem(DIAG_PREPAID_KEY);
  const lineIds = Array.isArray(pending?.cart_line_ids) ? pending.cart_line_ids : [];
  lineIds.forEach((id) => removeLine(id));
  const id = data?.order?.id;
  try {
    sessionStorage.setItem(ORDER_SUCCESS_KEY, "Successfully order placed");
  } catch {
    /* ignore */
  }
  status.textContent = `Order #${id} · Transaction ${rz.razorpay_payment_id}. Redirecting…`;
  btn.disabled = true;
  setTimeout(() => {
    window.location.assign(`/order.html?id=${encodeURIComponent(id)}`);
  }, 900);
}

async function startRazorpayCheckout(pending) {
  const status = $("dxPayStatus");
  const btn = $("dxPayBtn");
  const totalInr = totalInrFromPackages(pending.packages);
  if (!(totalInr > 0)) {
    status.textContent = "Invalid total amount.";
    return;
  }
  btn.disabled = true;
  status.textContent = "Opening Razorpay…";
  try {
    await loadRazorpayScript();
    const st = await fetchRazorpayStatus();
    if (!st.configured || !st.key_id) {
      status.innerHTML =
        "Razorpay is not configured. Use <a href=\"/checkout.html\">Cart</a> with <strong>Cash on collection</strong>, or set keys in <code>.env</code>.";
      btn.disabled = false;
      return;
    }
    const ord = await createRazorpayServerOrder(totalInr);
    const user = (await fetchAndCacheUser()) || loadCachedUser();
    let handlerDone = false;
    const options = {
      key: ord.key_id,
      amount: String(ord.amount),
      currency: ord.currency || "INR",
      order_id: ord.order_id,
      name: "PaxMed",
      description: `Diagnostics · ${pending.packages.length} test(s)`,
      theme: { color: "#0f766e" },
      handler(response) {
        handlerDone = true;
        void (async () => {
          status.textContent = "Verifying payment and confirming booking…";
          try {
            await placePrepaidOrder(pending, {
              razorpay_order_id: response.razorpay_order_id,
              razorpay_payment_id: response.razorpay_payment_id,
              razorpay_signature: response.razorpay_signature,
            });
          } catch (e) {
            status.textContent = String(e?.message || e);
            btn.disabled = false;
          }
        })();
      },
      modal: {
        ondismiss() {
          if (!handlerDone) {
            status.textContent = "Payment window closed. Try again when ready.";
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
    const rzp = new window.Razorpay(options);
    rzp.open();
    status.textContent = `Total payable: ${fmtINR(totalInr)} · complete payment in the Razorpay window.`;
  } catch (e) {
    status.textContent = String(e?.message || e);
    btn.disabled = false;
  }
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

async function init() {
  const returnTo = `${window.location.pathname}${window.location.search || ""}`;
  $("navLogin")?.setAttribute("href", `/login.html?returnTo=${encodeURIComponent(returnTo)}`);

  const pending = loadPending();
  const status = $("dxPayStatus");
  const summary = $("dxPaySummary");
  if (!pending) {
    status.innerHTML = `No pending prepaid payload. Prepaid checkout runs on <a href="/checkout.html">Cart</a> when you choose <strong>Prepaid</strong>.`;
    $("dxPayBtn")?.setAttribute("disabled", "true");
    return;
  }

  summary.innerHTML = pending.packages
    .map(
      (p) => `
      <div class="rx-match">
        <div>
          <div class="rx-match-title">${esc(p.package_name || "Package")}</div>
          <div class="rx-match-sub muted">${esc(p.deal_id || p.package_id || "")}</div>
        </div>
        <strong>${esc(fmtINR(p.price_inr))}</strong>
      </div>`
    )
    .join("");

  const rz = await fetchRazorpayStatus();
  if (!rz.configured) {
    status.innerHTML = `Total: ${fmtINR(totalInrFromPackages(pending.packages))} · <strong>Razorpay not configured</strong>. Complete prepaid from <a href="/checkout.html">Cart</a> after setting keys, or use COD.`;
    $("dxPayBtn")?.setAttribute("disabled", "true");
    return;
  }
  status.textContent = `Total payable: ${fmtINR(totalInrFromPackages(pending.packages))} · Scheduled: ${new Date(pending.scheduled_for).toLocaleString("en-IN")}`;

  $("dxPayBtn")?.addEventListener("click", () => startRazorpayCheckout(pending));
}

refreshAuthNav().catch(() => {});
init().catch((e) => {
  const st = $("dxPayStatus");
  if (st) st.textContent = String(e?.message || e);
});
