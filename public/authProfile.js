const AUTH_PROFILE_KEY = "paxmed_auth_profile_v1";

function normalizeUser(user) {
  if (!user || typeof user !== "object") return null;
  return {
    id: user.id ?? null,
    role: user.role || "user",
    username: user.username || null,
    full_name: user.full_name || null,
    gender: user.gender || null,
    phone_e164: user.phone_e164 || null,
    email: user.email || null,
    session_id: user.session_id || null,
  };
}

export function loadCachedUser() {
  try {
    const raw = localStorage.getItem(AUTH_PROFILE_KEY);
    if (!raw) return null;
    return normalizeUser(JSON.parse(raw));
  } catch {
    return null;
  }
}

export function cacheUser(user) {
  const normalized = normalizeUser(user);
  if (!normalized) {
    clearCachedUser();
    return null;
  }
  try {
    localStorage.setItem(AUTH_PROFILE_KEY, JSON.stringify(normalized));
  } catch {
    // Ignore storage quota/private mode errors.
  }
  return normalized;
}

export function clearCachedUser() {
  try {
    localStorage.removeItem(AUTH_PROFILE_KEY);
  } catch {
    // Ignore storage failures.
  }
}

export async function fetchAndCacheUser() {
  try {
    const res = await fetch("/api/auth/me", { credentials: "same-origin" });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data?.user) {
      if (res.status === 401) clearCachedUser();
      return null;
    }
    return cacheUser(data.user);
  } catch {
    return loadCachedUser();
  }
}

