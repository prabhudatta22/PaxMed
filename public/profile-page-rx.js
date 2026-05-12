import { $, setStatus, loadPrescriptionsList } from "./profileSectionCore.js";

async function refreshList() {
  await loadPrescriptionsList(refreshList);
}

async function init() {
  $("rxProfileUpload")?.addEventListener("change", async (ev) => {
    const f = ev.target?.files?.[0];
    if (!f) return;
    setStatus("rxStatus", "Uploading…");
    const fd = new FormData();
    fd.append("file", f);
    const res = await fetch("/api/prescriptions", { method: "POST", body: fd, credentials: "same-origin" });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      setStatus("rxStatus", data.error || "Upload failed");
      return;
    }
    ev.target.value = "";
    setStatus("rxStatus", "Saved.");
    await refreshList();
    window.parent?.postMessage({ type: "paxmed-profile-embed-changed" }, "*");
  });

  await refreshList();
}

init().catch((e) => setStatus("rxStatus", String(e?.message || e)));
