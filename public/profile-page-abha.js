import { $, request, setStatus, renderAbhaSection } from "./profileSectionCore.js";

async function reloadAbhaFromProfile() {
  const r = await request("/api/profile");
  if (r.status === 401) {
    window.top.location.assign("/login.html");
    return;
  }
  if (r.ok) renderAbhaSection(r.data?.abha || { linked: false });
}

async function init() {
  const st = await request("/api/abha/status");
  if (st.ok && st.data?.mode === "off") {
    setStatus("abhaStatus", "ABHA integration is turned off on this server.");
    $("abhaInitOtpBtn")?.setAttribute("disabled", "disabled");
  }

  $("abhaInitOtpBtn")?.addEventListener("click", async () => {
    const raw = $("abhaIdentifierInput")?.value?.trim() || "";
    if (!raw) {
      setStatus("abhaStatus", "Enter your 14-digit ABHA number or PHR address first.");
      return;
    }
    setStatus("abhaStatus", "Requesting OTP…");
    const r = await request("/api/abha/aadhaar/initiate", {
      method: "POST",
      body: JSON.stringify({ health_id: raw }),
    });
    if (!r.ok) {
      setStatus("abhaStatus", r.data?.error || "Could not start verification.");
      return;
    }
    $("abhaTxnId").value = r.data.txn_id || "";
    $("abhaOtpPanel")?.classList.remove("hidden");
    setStatus("abhaStatus", r.data.message || "Enter the OTP you received.");
  });

  $("abhaCompleteBtn")?.addEventListener("click", async () => {
    const txn_id = $("abhaTxnId")?.value?.trim();
    const otp = $("abhaOtpInput")?.value?.trim() || "";
    if (!txn_id || !otp) {
      setStatus("abhaStatus", "OTP and session are required.");
      return;
    }
    setStatus("abhaStatus", "Verifying…");
    const r = await request("/api/abha/aadhaar/complete", {
      method: "POST",
      body: JSON.stringify({ txn_id, otp }),
    });
    if (!r.ok) {
      setStatus("abhaStatus", r.data?.error || "Verification failed.");
      return;
    }
    setStatus("abhaStatus", r.data.message || "ABHA linked. Profile updated from ABHA.");
    await reloadAbhaFromProfile();
    window.parent?.postMessage({ type: "paxmed-profile-embed-changed" }, "*");
  });

  $("abhaSyncFromBtn")?.addEventListener("click", async () => {
    setStatus("abhaStatus", "Syncing from ABHA…");
    const r = await request("/api/abha/sync-from-abha", { method: "POST", body: "{}" });
    if (!r.ok) {
      setStatus("abhaStatus", r.data?.error || "Sync failed.");
      return;
    }
    setStatus("abhaStatus", r.data.message || "Synced.");
    await reloadAbhaFromProfile();
    window.parent?.postMessage({ type: "paxmed-profile-embed-changed" }, "*");
  });

  await reloadAbhaFromProfile();
}

init().catch((e) => setStatus("abhaStatus", String(e?.message || e)));
