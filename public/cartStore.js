export const STORAGE_KEY = "paxmed_multi_checkout_v1";
const FALLBACK_SESSION_KEY = "paxmed_multi_checkout_session_v1";

function safeParse(raw) {
  try {
    const j = JSON.parse(raw);
    return Array.isArray(j?.items) ? j.items : [];
  } catch {
    return [];
  }
}

export function getCartItems() {
  if (typeof window === "undefined") return [];
  let items = [];
  try {
    if (typeof localStorage !== "undefined") {
      items = safeParse(localStorage.getItem(STORAGE_KEY));
    }
  } catch {
    items = [];
  }
  if (items.length) return items;
  try {
    if (typeof sessionStorage !== "undefined") {
      return safeParse(sessionStorage.getItem(FALLBACK_SESSION_KEY));
    }
  } catch {
    /* ignore */
  }
  return [];
}

function saveItems(items) {
  const raw = JSON.stringify({ items, updated_at: Date.now() });
  try {
    localStorage.setItem(STORAGE_KEY, raw);
  } catch {
    /* ignore */
  }
  try {
    sessionStorage.setItem(FALLBACK_SESSION_KEY, raw);
  } catch {
    /* ignore */
  }
}

export function cartLineCount() {
  return getCartItems().reduce((s, i) => s + (Number(i.quantity) || 0), 0);
}

function sameCartLine(i, line) {
  if (i.source !== line.source) return false;
  if (line.source === "diagnostics") {
    const vA = String(i.vendorKey ?? "").trim();
    const vB = String(line.vendorKey ?? "").trim();
    return (
      String(i.dealId || i.packageId || "") === String(line.dealId || line.packageId || "") &&
      String(i.city || "").toLowerCase() === String(line.city || "").toLowerCase() &&
      vA === vB
    );
  }
  if (line.source === "local") {
    return (
      Number(i.medicineId) === Number(line.medicineId) &&
      Number(i.pharmacyId) === Number(line.pharmacyId)
    );
  }
  if (String(i.onlineProviderId) !== String(line.onlineProviderId)) return false;
  const midI = Number(i.medicineId);
  const midL = Number(line.medicineId);
  if (midI > 0 && midL > 0 && midI === midL) return true;
  if (midI > 0 || midL > 0) return false;
  const qI = String(i.searchQuery || "").toLowerCase();
  const qL = String(line.searchQuery || "").toLowerCase();
  const labI = String(i.medicineLabel || "").toLowerCase();
  const labL = String(line.medicineLabel || "").toLowerCase();
  return qL.length > 0 && qI === qL && labI === labL;
}

/**
 * @param {object} line — must include source and pricing fields
 */
export function addCartLine(line) {
  const items = getCartItems();
  const qty = Math.max(1, Number(line.quantity) || 1);
  const same = items.find((i) => sameCartLine(i, line));
  if (same) {
    same.quantity = (Number(same.quantity) || 1) + qty;
  } else {
    items.push({
      lineId: `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
      quantity: qty,
      ...line,
    });
  }
  saveItems(items);
}

export function setLineQuantity(lineId, quantity) {
  const q = Math.max(1, Math.floor(Number(quantity) || 1));
  const items = getCartItems().map((i) =>
    i.lineId === lineId ? { ...i, quantity: q } : i
  );
  saveItems(items);
}

export function removeLine(lineId) {
  saveItems(getCartItems().filter((i) => i.lineId !== lineId));
}

export function clearCart() {
  saveItems([]);
}

export function bucketKey(line) {
  if (line.source === "local") return `local:${line.pharmacyId}`;
  if (line.source === "diagnostics") return `diagnostics:${line.city || "unknown"}`;
  return `online:${line.onlineProviderId}`;
}

export function bucketTitle(line) {
  if (line.source === "local") return line.pharmacyName || `Pharmacy #${line.pharmacyId}`;
  if (line.source === "diagnostics") return line.providerName || "Diagnostics";
  return line.onlineLabel || line.onlineProviderId || "Online";
}
