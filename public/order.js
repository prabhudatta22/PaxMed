import { fetchAndCacheUser, loadCachedUser } from "./authProfile.js";

const $ = (id) => document.getElementById(id);
const ORDER_SUCCESS_KEY = "paxmed_order_success_message_v1";

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function fmtTs(s) {
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" });
}

function parseJsonLoose(v) {
  if (!v) return null;
  if (typeof v === "object") return v;
  try {
    return JSON.parse(v);
  } catch {
    return null;
  }
}

function readId() {
  const params = new URLSearchParams(window.location.search);
  const id = Number(params.get("id"));
  return Number.isFinite(id) && id > 0 ? id : null;
}

function renderAuthNav(user) {
  const logged = Boolean(user && user.role !== "service_provider");
  $("navLogin")?.classList.toggle("hidden", logged);
  $("navProfile")?.classList.toggle("hidden", !logged);
}

async function refreshAuthNav() {
  renderAuthNav(loadCachedUser());
  const fresh = await fetchAndCacheUser();
  renderAuthNav(fresh);
}

function renderTimeline(events) {
  const host = $("orderTimeline");
  if (!host) return;
  if (!events?.length) {
    host.innerHTML = `<p class="muted">No events yet.</p>`;
    return;
  }
  host.innerHTML = events
    .map(
      (e) => `
      <div class="rx-match" style="justify-content: flex-start">
        <div>
          <div class="rx-match-title">${escapeHtml(e.status)}</div>
          <div class="rx-match-sub muted">${escapeHtml(fmtTs(e.created_at))}${e.message ? ` · ${escapeHtml(e.message)}` : ""}</div>
        </div>
      </div>`
    )
    .join("");
}

async function load() {
  const id = readId();
  const title = $("orderTitle");
  const meta = $("orderMeta");
  const status = $("orderStatus");
  const itemsTbody = $("orderItems");
  if (!status || !itemsTbody) return;
  if (!id) {
    status.textContent = "Missing order id.";
    return;
  }
  if (title) title.textContent = `Order #${id}`;
  status.textContent = "Loading…";

  const res = await fetch(`/api/orders/${encodeURIComponent(id)}`, { credentials: "same-origin" });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) {
    const returnTo = `${window.location.pathname}${window.location.search || ""}`;
    status.innerHTML = `Please <a href="/login.html?returnTo=${encodeURIComponent(returnTo)}">log in</a> to view this order.`;
    return;
  }
  if (!res.ok) {
    status.textContent = data.error || `Failed to load (${res.status})`;
    return;
  }

  const o = data.order;
  if (meta) {
    const kind = o.order_kind === "diagnostics" ? "Diagnostics" : "Medicines";
    const providerRef = o.provider_order_ref ? ` · Ref ${o.provider_order_ref}` : "";
    meta.textContent = `${kind} · ${o.status} · ${o.delivery_option}${o.scheduled_for ? ` · scheduled ${fmtTs(o.scheduled_for)}` : ""}${providerRef}`;
  }
  const partnerStatus = data.partner_status?.booking_status ? ` · Partner stage ${data.partner_status.booking_status}` : "";
  let successFlash = "";
  try {
    successFlash = sessionStorage.getItem(ORDER_SUCCESS_KEY) || "";
    if (successFlash) sessionStorage.removeItem(ORDER_SUCCESS_KEY);
  } catch {
    successFlash = "";
  }
  status.textContent = `${successFlash ? `${successFlash} · ` : ""}Status: ${o.status}${partnerStatus}`;

  const payRef = $("orderPaymentRef");
  if (payRef) {
    const hasRz = Boolean(o.razorpay_payment_id || o.razorpay_order_id);
    if (hasRz) {
      payRef.classList.remove("hidden");
      payRef.innerHTML = `
        <div class="rx-match" style="justify-content: flex-start">
          <div>
            <div class="rx-match-title">Prepaid · Razorpay</div>
            <div class="rx-match-sub muted">PaxMed order <strong>#${escapeHtml(String(o.id))}</strong></div>
            <div class="rx-match-sub muted" style="margin-top: 0.35rem">Transaction ID: <code>${escapeHtml(
              String(o.razorpay_payment_id || "—")
            )}</code></div>
            <div class="rx-match-sub muted">Razorpay order: <code>${escapeHtml(String(o.razorpay_order_id || "—"))}</code></div>
          </div>
        </div>`;
    } else {
      const isDiag = o.order_kind === "diagnostics";
      const headline = isDiag ? "Cash on collection" : "Cash on delivery";
      const hint = isDiag
        ? "Pay when your diagnostic sample collection is completed (unless you prepaid online)."
        : "Pay when your medicines are delivered.";
      payRef.classList.remove("hidden");
      payRef.innerHTML = `
        <div class="rx-match" style="justify-content: flex-start">
          <div>
            <div class="rx-match-title">${escapeHtml(headline)}</div>
            <div class="rx-match-sub muted">${escapeHtml(hint)}</div>
            <div class="rx-match-sub muted" style="margin-top: 0.35rem">
              Payment status: <strong>${escapeHtml(String(o.payment_status || "cod"))}</strong>
            </div>
          </div>
        </div>`;
    }
  }

  const addrBox = $("orderAddress");
  if (addrBox) {
    const line1 = String(o.address_line1 || "").trim();
    const pin = String(o.pincode || "").trim();
    if (line1 || pin || o.city || o.state) {
      addrBox.classList.remove("hidden");
      const bits = [
        line1,
        o.address_line2 ? String(o.address_line2).trim() : "",
        o.landmark ? `${String(o.landmark).trim()}` : "",
        [o.city, o.state].filter(Boolean).map((x) => String(x).trim()).join(", ") || "",
        pin ? `PIN ${pin}` : "",
      ].filter(Boolean);
      const title =
        o.order_kind === "diagnostics" ? "Sample collection / service address" : "Delivery address";
      addrBox.innerHTML = `
        <div class="rx-match" style="justify-content: flex-start">
          <div>
            <div class="rx-match-title">${escapeHtml(title)}</div>
            <div class="rx-match-sub muted">${bits.map((b) => escapeHtml(b)).join(" · ")}</div>
          </div>
        </div>`;
    } else {
      addrBox.classList.add("hidden");
      addrBox.innerHTML = "";
    }
  }

  const op = $("orderPrescription");
  if (op) {
    if (o.prescription_file_id) {
      op.classList.remove("hidden");
      const pid = o.prescription_file_id;
      op.innerHTML = `
        <div class="rx-match">
          <div>
            <div class="rx-match-title">Prescription on file</div>
            <div class="rx-match-sub muted">${escapeHtml(o.prescription_filename || "Attachment")} · uploaded ${escapeHtml(
        fmtTs(o.prescription_uploaded_at)
      )}</div>
          </div>
          <a class="btn btn-sm btn-ghost" href="/api/prescriptions/${encodeURIComponent(pid)}/file" target="_blank" rel="noopener">View</a>
        </div>`;
    } else {
      op.classList.add("hidden");
      op.innerHTML = "";
    }
  }

  const dgc = $("orderDiagReport");
  if (dgc) {
    if (
      o.order_kind === "diagnostics" &&
      o.provider_order_ref &&
      !String(o.provider_order_ref).startsWith("LOCAL-")
    ) {
      dgc.classList.remove("hidden");
      dgc.innerHTML = `
        <div class="rx-match" style="justify-content: flex-start">
          <div>
            <div class="rx-match-title">Lab report</div>
            <div class="rx-match-sub muted">
              Fetch the latest verified report from the diagnostics partner into your profile (PDF/images).
              <a href="/profile.html?view=reports" style="margin-left: 0.35rem">View reports</a>
            </div>
          </div>
          <button type="button" class="btn btn-sm btn-primary" id="orderDiagSyncBtn">Pull report</button>
        </div>
        <p class="muted" id="orderDiagSyncStatus" style="margin: 0.4rem 0 0"></p>`;
      $("orderDiagSyncBtn")?.addEventListener("click", async () => {
        const st = $("orderDiagSyncStatus");
        if (st) st.textContent = "Contacting lab…";
        try {
          const r = await fetch(`/api/orders/${encodeURIComponent(String(o.id))}/sync-diagnostic-report`, {
            method: "POST",
            credentials: "same-origin",
            headers: { "Content-Type": "application/json" },
            body: "{}",
          });
          const j = await r.json().catch(() => ({}));
          if (!r.ok) {
            if (st) st.textContent = j.error || `Sync failed (${r.status}).`;
            return;
          }
          const s = j.sync;
          let msg = "Done.";
          if (s?.report_id) {
            msg = `Saved report #${s.report_id}. Open Profile → Diagnostic reports to download.`;
          } else if (s?.skipped) {
            msg = `No file saved (${s.reason || "skipped"}).`;
          } else if (s && typeof s === "object" && s.reason && !s.report_id) {
            msg = String(s.reason);
          }
          if (st) st.textContent = msg;
        } catch (e) {
          if (st) st.textContent = e?.message || "Sync failed.";
        }
      });
    } else {
      dgc.classList.add("hidden");
      dgc.innerHTML = "";
    }
  }

  const items = data.items || [];
  itemsTbody.innerHTML = items
    .map((it) => {
      const m = parseJsonLoose(it.item_meta);
      const diagBits = [
        m?.patient_name ? `Patient: ${m.patient_name}` : "",
        m?.patient_age ? `Age: ${m.patient_age}` : "",
        m?.payment_type ? `Payment: ${String(m.payment_type).toUpperCase()}` : "",
        m?.slot?.label ? `Slot: ${m.slot.label}` : "",
      ]
        .filter(Boolean)
        .join(" · ");
      return `
      <tr>
        <td>${escapeHtml(it.item_label)}${it.strength ? ` <span class="muted">${escapeHtml(it.strength)}</span>` : ""}</td>
        <td class="muted">${escapeHtml(it.quantity_units)}</td>
        <td class="muted">${escapeHtml(it.pharmacy_name || (diagBits || "—"))}</td>
      </tr>`;
    })
    .join("");

  renderTimeline(data.events || []);
}

const returnToOrder = `${window.location.pathname}${window.location.search || ""}`;
$("navLogin")?.setAttribute("href", `/login.html?returnTo=${encodeURIComponent(returnToOrder)}`);

Promise.all([refreshAuthNav(), load()]).catch((e) => {
  const status = $("orderStatus");
  if (status) status.textContent = String(e?.message || e);
});

