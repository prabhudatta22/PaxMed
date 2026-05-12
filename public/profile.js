import { cacheUser, clearCachedUser, fetchAndCacheUser, loadCachedUser } from "./authProfile.js";
import { loadDiagnosticReportsInto } from "./profile-page-reports.js";
import { $, request, setStatus } from "./profileSectionCore.js";

let profileData = null;
/** When false, profile form body is collapsed (e.g. after opening another sidebar section). */
let profileDetailsCardExpanded = true;

const PROFILE_VIEWS = ["details", "abha", "rx", "reports", "addresses", "payments"];
/** Profile sections rendered in an iframe (Diagnostic reports stays in top-level DOM so session cookies attach to API calls). */
const IFRAME_EMBED_VIEWS = ["abha", "rx", "addresses", "payments"];
const EMBED_PAGE_SRC = {
  abha: "/profile-page-abha.html",
  rx: "/profile-page-rx.html",
  addresses: "/profile-page-addresses.html",
  payments: "/profile-page-payments.html",
};

const VIEW_LABELS = {
  details: "Profile details",
  abha: "ABHA (Health ID)",
  rx: "Prescriptions",
  reports: "Diagnostic reports",
  addresses: "Saved addresses",
  payments: "Saved payment methods",
};

const LEGACY_HASH_TO_VIEW = {
  "#profileCard": "details",
  "#abhaCard": "abha",
  "#rxCard": "rx",
  "#diagReportsCard": "reports",
  "#addressCard": "addresses",
  "#paymentCard": "payments",
};

function profileViewHref(view) {
  return `/profile.html?view=${encodeURIComponent(view)}`;
}

function getProfileView() {
  const params = new URLSearchParams(window.location.search);
  const q = params.get("view");
  if (q && PROFILE_VIEWS.includes(q)) return q;
  const fromHash = LEGACY_HASH_TO_VIEW[window.location.hash];
  if (fromHash) return fromHash;
  return "details";
}

function syncCanonicalProfileUrl() {
  const params = new URLSearchParams(window.location.search);
  if (params.get("view")) return;
  const v = LEGACY_HASH_TO_VIEW[window.location.hash];
  if (!v) return;
  history.replaceState({}, "", profileViewHref(v));
}

async function loadReportsPanelNow() {
  const mount = $("profileViewReports");
  if (!mount) return;
  const ok = await loadProfile();
  if (!ok) return;
  const hint =
    profileData?.profile != null
      ? { id: profileData.profile.id, phone_e164: profileData.profile.phone_e164 ?? null }
      : null;
  await loadDiagnosticReportsInto({
    wrap: mount.querySelector("[data-diagnostic-reports-wrap]"),
    status: mount.querySelector("[data-diagnostic-reports-status]"),
    seedReports: profileData?.diagnostic_reports,
    profileReportsLoadError: profileData?.diagnostic_reports_load_error ?? null,
    profileHint: hint,
  });
}

function applyProfileView(view) {
  const v = PROFILE_VIEWS.includes(view) ? view : "details";
  const isIframeEmbed = IFRAME_EMBED_VIEWS.includes(v);
  const isReportsInline = v === "reports";

  document.querySelectorAll("[data-profile-view-panel]").forEach((el) => {
    const panel = el.getAttribute("data-profile-view-panel");
    let on = false;
    if (panel === "details") on = v === "details" || v === "reports";
    else if (panel === "embed") on = isIframeEmbed;
    else if (panel === "reports") on = isReportsInline;
    el.hidden = !on;
    el.setAttribute("aria-hidden", on ? "false" : "true");
  });

  document.querySelectorAll("a.profile-side-link[data-profile-view]").forEach((a) => {
    a.classList.toggle("is-active", a.getAttribute("data-profile-view") === v);
  });

  const bc = $("profileBreadcrumb");
  if (bc) bc.textContent = `Account › ${VIEW_LABELS[v]}`;
  document.title = `PaxMed — ${VIEW_LABELS[v]}`;

  const frame = $("profileSectionFrame");
  if (frame && isIframeEmbed) {
    const nextSrc = EMBED_PAGE_SRC[v];
    if (frame.dataset.embedSrc !== nextSrc) {
      frame.src = nextSrc;
      frame.dataset.embedSrc = nextSrc;
    }
  }

  if (isReportsInline) {
    void loadReportsPanelNow();
  }

  if (v !== "details") {
    profileDetailsCardExpanded = false;
  }
  syncProfileDetailsCardDom();

  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      scrollActiveProfileSectionIntoView(v);
    });
  });
}

function scrollActiveProfileSectionIntoView(view) {
  const v = PROFILE_VIEWS.includes(view) ? view : "details";
  let target = null;
  if (v === "details") target = $("profileCard");
  else if (IFRAME_EMBED_VIEWS.includes(v)) target = $("profileViewEmbed");
  else if (v === "reports") target = $("profileCard");
  if (!target) return;
  const instant = window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches;
  target.scrollIntoView({ behavior: instant ? "auto" : "smooth", block: "start" });
}

function syncProfileDetailsCardDom() {
  const body = $("profileDetailsBody");
  const btn = $("profileDetailsToggle");
  if (!body || !btn) return;
  body.hidden = !profileDetailsCardExpanded;
  btn.setAttribute("aria-expanded", profileDetailsCardExpanded ? "true" : "false");
  btn.textContent = profileDetailsCardExpanded ? "Hide form" : "Show form";
}

function wireProfileDetailsToggle() {
  $("profileDetailsToggle")?.addEventListener("click", () => {
    profileDetailsCardExpanded = !profileDetailsCardExpanded;
    syncProfileDetailsCardDom();
  });
}

function wireProfileViewNav() {
  document.querySelectorAll("a.profile-side-link[data-profile-view]").forEach((a) => {
    a.addEventListener("click", (e) => {
      e.preventDefault();
      const view = a.getAttribute("data-profile-view");
      if (!view || !PROFILE_VIEWS.includes(view)) return;
      history.pushState({ view }, "", profileViewHref(view));
      if (view === "details") {
        profileDetailsCardExpanded = true;
      }
      applyProfileView(view);
    });
  });
  window.addEventListener("popstate", () => {
    applyProfileView(getProfileView());
  });
}

function renderNav(user) {
  const navUser = $("navUser");
  const navLogin = $("navLogin");
  const navLogout = $("navLogout");
  const navProfile = $("navProfile");
  const logged = Boolean(user);
  navLogin?.classList.toggle("hidden", logged);
  navLogout?.classList.toggle("hidden", !logged);
  navUser?.classList.add("hidden");
  if (navUser) navUser.textContent = "";
  navProfile?.classList.toggle("hidden", !logged);
}

function fillBasicForm(profile) {
  const pfName = $("pfName");
  if (pfName) pfName.value = profile?.full_name || "";
  const pfGender = $("pfGender");
  if (pfGender) pfGender.value = profile?.gender || "";
  const pfPhone = $("pfPhone");
  if (pfPhone) pfPhone.value = profile?.phone_e164 || "";
  const pfEmail = $("pfEmail");
  if (pfEmail) pfEmail.value = profile?.email || "";
  const dobEl = $("pfDob");
  if (dobEl) {
    const d = profile?.date_of_birth;
    dobEl.value = d ? String(d).slice(0, 10) : "";
  }
  const p = $("profileNamePreview");
  if (p) p.textContent = profile?.full_name || profile?.email || profile?.phone_e164 || "User";
}

async function loadProfile() {
  const r = await request("/api/profile");
  if (r.status === 401) {
    clearCachedUser();
    window.location.assign("/login.html");
    return false;
  }
  if (!r.ok) {
    setStatus("profileStatus", r.data?.error || "Failed to load profile");
    return false;
  }
  profileData = r.data;
  fillBasicForm(r.data.profile);

  if (r.data?.profile) {
    cacheUser({
      ...(loadCachedUser() || {}),
      ...r.data.profile,
      role: "user",
    });
    renderNav(loadCachedUser());
  }
  return true;
}

async function saveBasicProfile(e) {
  e.preventDefault();
  const payload = {
    full_name: $("pfName").value.trim(),
    gender: $("pfGender").value,
    email: $("pfEmail").value.trim(),
    date_of_birth: $("pfDob")?.value?.trim() || null,
  };
  const r = await request("/api/profile/basic", { method: "PUT", body: JSON.stringify(payload) });
  if (!r.ok) {
    setStatus("profileStatus", r.data?.error || "Failed to save profile");
    return;
  }
  setStatus("profileStatus", "Profile updated.");
  const saved = r.data?.profile;
  if (saved) {
    fillBasicForm(saved);
    cacheUser({
      ...(loadCachedUser() || {}),
      ...saved,
      role: "user",
    });
    renderNav(loadCachedUser());
  }
  await loadProfile();
}

async function init() {
  const sp = new URLSearchParams(window.location.search);
  if (sp.get("view") === "orders") {
    window.location.replace("/orders.html");
    return;
  }
  if (window.location.hash === "#orderCard") {
    window.location.replace("/orders.html");
    return;
  }

  syncCanonicalProfileUrl();

  renderNav(loadCachedUser());
  const fresh = await fetchAndCacheUser();
  renderNav(fresh);

  const loaded = await loadProfile();
  if (!loaded) return;

  wireProfileViewNav();

  window.addEventListener("message", (ev) => {
    try {
      if (ev.origin !== window.location.origin) return;
    } catch {
      return;
    }
    if (ev.data?.type === "paxmed-profile-embed-changed") {
      void loadProfile();
    }
  });

  $("basicProfileForm")?.addEventListener("submit", saveBasicProfile);
  wireProfileDetailsToggle();
  $("navLogout")?.addEventListener("click", async (e) => {
    e.preventDefault();
    await request("/api/auth/logout", { method: "POST", body: "{}" });
    clearCachedUser();
    window.location.assign("/login.html");
  });

  applyProfileView(getProfileView());
}

init().catch((e) => setStatus("profileStatus", String(e?.message || e)));
