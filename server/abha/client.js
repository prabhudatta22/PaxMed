import crypto from "node:crypto";
import { maskHealthIdNumber } from "./validate.js";

/** off | stub | live */
export function getAbhaIntegrationMode() {
  const m = String(process.env.ABHA_INTEGRATION_MODE || "").trim().toLowerCase();
  if (m === "live" || m === "stub" || m === "off") return m;
  if (String(process.env.ABDM_CLIENT_ID || "").trim() && String(process.env.ABDM_CLIENT_SECRET || "").trim()) {
    return "live";
  }
  return "stub";
}

/**
 * Pull demographic profile from ABDM / Health ID APIs.
 * `stub`: deterministic demo profile for integration testing (no network).
 * `live`: placeholder HTTP call — extend with gateway token + signed requests per ABDM docs.
 */
export async function fetchAbhaDemographics({ identifier }) {
  const mode = getAbhaIntegrationMode();
  if (mode === "off") {
    throw new Error("ABHA integration is disabled (set ABHA_INTEGRATION_MODE=stub or configure ABDM credentials)");
  }
  if (mode === "stub") {
    const key = identifier.kind === "number" ? identifier.value : identifier.value;
    const h = crypto.createHash("sha256").update(key).digest("hex").slice(0, 8);
    return {
      source: "stub",
      full_name: `ABHA User ${h}`,
      email: `abha.${h}@example.in`,
      gender: "other",
      date_of_birth: "1990-01-15",
      address: {
        label: "ABHA registered address",
        address_line1: `${h.toUpperCase()} Demo Street, ABHA Registry`,
        address_line2: null,
        landmark: "Stub mode",
        city: "Bengaluru",
        state: "Karnataka",
        pincode: "560001",
      },
      masked_display: identifier.kind === "number" ? maskHealthIdNumber(identifier.value) : `${identifier.value.slice(0, 3)}***`,
    };
  }

  const base = String(process.env.ABDM_HEALTH_ID_API_BASE || "https://healthidsbx.abdm.gov.in/api").replace(/\/$/, "");
  const path = String(process.env.ABDM_PROFILE_FETCH_PATH || "/v2/account/profile");
  const url = `${base}${path.startsWith("/") ? path : `/${path}`}`;
  const token = String(process.env.ABDM_ACCESS_TOKEN || "").trim();
  if (!token) {
    throw new Error("Live ABHA mode requires ABDM_ACCESS_TOKEN (or implement gateway token flow)");
  }
  const res = await fetch(url, {
    method: "GET",
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${token}`,
      "X-HIP-ID": String(process.env.ABDM_HIP_ID || "").trim(),
    },
  });
  const text = await res.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }
  if (!res.ok) {
    throw new Error(data?.message || data?.error || `ABDM profile fetch failed (${res.status})`);
  }
  return {
    source: "live",
    full_name: String(data.name || data.fullName || "").trim() || null,
    email: String(data.email || "").trim() || null,
    gender: String(data.gender || "").toLowerCase() || null,
    date_of_birth: data.dob || data.dateOfBirth || null,
    address: null,
    masked_display: data.healthIdNumber || data.abhaNumber || "—",
    raw: data,
  };
}

/**
 * Push PaxMed profile changes to ABDM (Health ID update).
 * Extend with real endpoint + signing when in live mode.
 */
export async function pushAbhaDemographics({ identifier }, paxmedProfile) {
  const mode = getAbhaIntegrationMode();
  if (mode === "off") return { ok: false, skipped: true, reason: "off" };
  if (mode === "stub") {
    return { ok: true, source: "stub", echoed: paxmedProfile };
  }
  const base = String(process.env.ABDM_HEALTH_ID_API_BASE || "https://healthidsbx.abdm.gov.in/api").replace(/\/$/, "");
  const path = String(process.env.ABDM_PROFILE_UPDATE_PATH || "/v2/account/profile");
  const url = `${base}${path.startsWith("/") ? path : `/${path}`}`;
  const token = String(process.env.ABDM_ACCESS_TOKEN || "").trim();
  if (!token) throw new Error("Live ABHA push requires ABDM_ACCESS_TOKEN");
  const res = await fetch(url, {
    method: "PUT",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(paxmedProfile),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(t || `ABDM profile update failed (${res.status})`);
  }
  return { ok: true, source: "live" };
}
