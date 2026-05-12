import { $, request, setStatus, renderPaymentMethods } from "./profileSectionCore.js";

let profileSnapshot = null;

async function reloadPayments() {
  const r = await request("/api/profile");
  if (r.status === 401) {
    window.top.location.assign("/login.html");
    return;
  }
  if (!r.ok) {
    setStatus("paymentStatus", r.data?.error || "Failed to load payment methods");
    return;
  }
  profileSnapshot = r.data;
  renderPaymentMethods(r.data.payment_methods || [], reloadPayments);
}

async function saveUpi(e) {
  e.preventDefault();
  const payload = {
    method_type: "upi",
    upi_id: $("upiId").value.trim(),
    label: $("upiLabel").value.trim(),
    is_default: !(profileSnapshot?.payment_methods || []).length,
  };
  const r = await request("/api/profile/payment-methods", { method: "POST", body: JSON.stringify(payload) });
  if (!r.ok) return setStatus("paymentStatus", r.data?.error || "Failed to save UPI method");
  setStatus("paymentStatus", "UPI method saved.");
  $("upiForm")?.reset();
  await reloadPayments();
  window.parent?.postMessage({ type: "paxmed-profile-embed-changed" }, "*");
}

async function saveCard(e) {
  e.preventDefault();
  const payload = {
    method_type: "card",
    card_last4: $("cardLast4").value.trim(),
    card_network: $("cardNetwork").value.trim(),
    card_holder_name: $("cardHolder").value.trim(),
    label: $("cardLabel").value.trim(),
    is_default: !(profileSnapshot?.payment_methods || []).length,
  };
  const r = await request("/api/profile/payment-methods", { method: "POST", body: JSON.stringify(payload) });
  if (!r.ok) return setStatus("paymentStatus", r.data?.error || "Failed to save card method");
  setStatus("paymentStatus", "Card method saved.");
  $("cardForm")?.reset();
  await reloadPayments();
  window.parent?.postMessage({ type: "paxmed-profile-embed-changed" }, "*");
}

async function init() {
  $("upiForm")?.addEventListener("submit", saveUpi);
  $("cardForm")?.addEventListener("submit", saveCard);
  await reloadPayments();
}

init().catch((e) => setStatus("paymentStatus", String(e?.message || e)));
