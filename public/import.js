const $ = (id) => document.getElementById(id);

function pretty(obj) {
  return JSON.stringify(obj, null, 2);
}

function downloadBlob({ blob, filename }) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function downloadTemplateXlsx() {
  // Prefer static template (works offline, no CDN). Fallback to in-browser generation.
  try {
    const res = await fetch("/templates/paxmed-pharmacy-price-import-template.xlsx");
    if (res.ok) {
      const blob = await res.blob();
      downloadBlob({ blob, filename: "paxmed-pharmacy-price-import-template.xlsx" });
      return;
    }
  } catch {
    // ignore; fallback below
  }

  // Fallback: generate in browser (requires network to cdn.jsdelivr.net).
  const XLSX = await import("https://cdn.jsdelivr.net/npm/xlsx@0.18.5/+esm");

  const required = [
    "city",
    "state",
    "pharmacy_name",
    "drug_name",
    "strength",
    "form",
    "pack_size",
    "price_inr",
  ];
  const optional = [
    "chain",
    "generic_name",
    "address_line",
    "pincode",
    "lat",
    "lng",
    "mrp_inr",
    "discount_pct",
    "price_type",
    "in_stock",
  ];

  const headers = [...required, ...optional];
  const exampleRow = {
    city: "Mumbai",
    state: "Maharashtra",
    pharmacy_name: "Apollo Pharmacy — Bandra",
    drug_name: "Metformin 500 mg",
    strength: "500 mg",
    form: "tablet",
    pack_size: 10,
    price_inr: 45,
    chain: "Apollo",
    generic_name: "Metformin hydrochloride",
    address_line: "Linking Rd, Bandra West",
    pincode: "400050",
    lat: 19.0596,
    lng: 72.8295,
    mrp_inr: 120,
    discount_pct: 10,
    price_type: "retail",
    in_stock: "true",
  };

  const aoa = [
    headers,
    headers.map((h) => (exampleRow[h] == null ? "" : exampleRow[h])),
  ];

  const ws = XLSX.utils.aoa_to_sheet(aoa);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "prices");

  const arr = XLSX.write(wb, { bookType: "xlsx", type: "array" });
  const blob = new Blob([arr], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
  downloadBlob({ blob, filename: "paxmed-pharmacy-price-import-template.xlsx" });
}

async function downloadLabTemplateXlsx() {
  const res = await fetch("/templates/paxmed-lab-price-import-template.xlsx");
  if (!res.ok) throw new Error("Lab template not found on server");
  const blob = await res.blob();
  downloadBlob({ blob, filename: "paxmed-lab-price-import-template.xlsx" });
}

$("#downloadTemplate").addEventListener("click", async () => {
  $("#out").textContent = "";
  try {
    await downloadTemplateXlsx();
  } catch (e) {
    $("#out").textContent =
      "Failed to generate template. If your network blocks cdn.jsdelivr.net, download SheetJS locally.\n\n" +
      String(e?.message || e);
  }
});

$("#downloadLabTemplate")?.addEventListener("click", async () => {
  $("#out").textContent = "";
  try {
    await downloadLabTemplateXlsx();
  } catch (e) {
    $("#out").textContent = String(e?.message || e);
  }
});

$("#form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const file = $("#file").files?.[0];
  if (!file) return;

  $("#btn").disabled = true;
  $("#out").textContent = "Importing…";

  try {
    const fd = new FormData();
    fd.append("file", file);

    const res = await fetch("/api/import/prices/xlsx", { method: "POST", body: fd });
    const text = await res.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      json = { raw: text };
    }
    $("#out").textContent = pretty({ status: res.status, ...json });
  } catch (err) {
    $("#out").textContent = String(err?.message || err);
  } finally {
    $("#btn").disabled = false;
  }
});

$("#labForm")?.addEventListener("submit", async (e) => {
  e.preventDefault();
  const file = $("#labFile")?.files?.[0];
  if (!file) return;

  $("#labBtn").disabled = true;
  $("#out").textContent = "Importing lab prices…";

  try {
    const fd = new FormData();
    fd.append("file", file);

    const res = await fetch("/api/import/lab-prices/xlsx", { method: "POST", body: fd });
    const text = await res.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      json = { raw: text };
    }
    $("#out").textContent = pretty({ status: res.status, ...json });
  } catch (err) {
    $("#out").textContent = String(err?.message || err);
  } finally {
    $("#labBtn").disabled = false;
  }
});

