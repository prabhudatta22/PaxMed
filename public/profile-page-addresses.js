import { $, request, setStatus, renderAddresses } from "./profileSectionCore.js";

let profileSnapshot = null;

async function reloadAddresses() {
  const r = await request("/api/profile");
  if (r.status === 401) {
    window.top.location.assign("/login.html");
    return;
  }
  if (!r.ok) {
    setStatus("addressStatus", r.data?.error || "Failed to load addresses");
    return;
  }
  profileSnapshot = r.data;
  renderAddresses(r.data.addresses || [], reloadAddresses);
}

function displayName() {
  return (
    profileSnapshot?.profile?.full_name?.trim() ||
    profileSnapshot?.profile?.email?.trim() ||
    profileSnapshot?.profile?.phone_e164?.trim() ||
    ""
  );
}

async function saveManualAddress(e) {
  e.preventDefault();
  const payload = {
    label: $("addrLabel").value.trim(),
    name: displayName(),
    address_line1: $("addrLine1").value.trim(),
    landmark: $("addrLandmark").value.trim(),
    city: $("addrCity").value.trim(),
    state: $("addrState").value.trim(),
    pincode: $("addrPin").value.trim(),
    is_default: !(profileSnapshot?.addresses || []).length,
  };
  const r = await request("/api/profile/addresses", { method: "POST", body: JSON.stringify(payload) });
  if (!r.ok) {
    setStatus("addressStatus", r.data?.error || "Failed to save address");
    return;
  }
  setStatus("addressStatus", "Address saved.");
  $("addressForm")?.reset();
  await reloadAddresses();
  window.parent?.postMessage({ type: "paxmed-profile-embed-changed" }, "*");
}

async function saveCurrentLocationAddress() {
  const hintEl = $("addressStatus");
  if (!navigator.geolocation) {
    setStatus("addressStatus", "Geolocation is not supported in this browser.");
    return;
  }
  setStatus("addressStatus", "Reading current location…");
  navigator.geolocation.getCurrentPosition(
    async (pos) => {
      try {
        const lat = pos.coords.latitude;
        const lng = pos.coords.longitude;
        const geo = await request(`/api/geocode/reverse?lat=${encodeURIComponent(lat)}&lng=${encodeURIComponent(lng)}`, {
          method: "GET",
        });
        if (!geo.ok || !geo.data?.google) {
          setStatus("addressStatus", geo.data?.error || "Could not resolve address from location.");
          return;
        }
        const g = geo.data.google;
        const payload = {
          label: "Current location",
          name: displayName(),
          address_line1: g.formatted_address || `${lat}, ${lng}`,
          city: g.locality || g.administrative_area_level_2 || "",
          state: g.administrative_area_level_1 || "",
          pincode: g.postal_code || "",
          lat,
          lng,
          is_default: true,
        };
        const save = await request("/api/profile/addresses", { method: "POST", body: JSON.stringify(payload) });
        if (!save.ok) {
          setStatus("addressStatus", save.data?.error || "Failed to save current location address");
          return;
        }
        setStatus("addressStatus", "Current location saved as default address.");
        await reloadAddresses();
        window.parent?.postMessage({ type: "paxmed-profile-embed-changed" }, "*");
      } catch (err) {
        setStatus("addressStatus", String(err?.message || err));
      }
    },
    (err) => {
      if (!hintEl) return;
      hintEl.textContent =
        err.code === 1
          ? "Location blocked. Allow location for this site and try again."
          : `Location unavailable (${err.message || err.code}).`;
    },
    { enableHighAccuracy: true, timeout: 15000, maximumAge: 300000 },
  );
}

async function init() {
  $("addressForm")?.addEventListener("submit", saveManualAddress);
  $("useLocationAddressBtn")?.addEventListener("click", saveCurrentLocationAddress);
  await reloadAddresses();
}

init().catch((e) => setStatus("addressStatus", String(e?.message || e)));
