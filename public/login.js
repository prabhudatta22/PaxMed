import { cacheUser, clearCachedUser } from "./authProfile.js";
const $ = (id) => document.getElementById(id);

/** Same-origin path only; used after login / OAuth. */
function safeReturnToPath(raw) {
  const s = String(raw || "").trim();
  if (!s.startsWith("/")) return "";
  if (s.startsWith("//")) return "";
  if (/[\0\r\n]/.test(s)) return "";
  return s;
}

function postLoginDestination() {
  try {
    const p = new URLSearchParams(window.location.search).get("returnTo");
    return safeReturnToPath(p) || "/index.html";
  } catch {
    return "/index.html";
  }
}

function pretty(x) {
  return JSON.stringify(x, null, 2);
}

function setStatus(msg) {
  const el = $("loginStatus");
  if (!el) return;
  el.textContent = msg || "";
}

function showVerifyStep() {
  const panel = $("verifyPanel");
  if (!panel) return;
  panel.classList.remove("is-hidden");
}

function hideVerifyStep() {
  const panel = $("verifyPanel");
  if (!panel) return;
  panel.classList.add("is-hidden");
}

function setMode(mode) {
  const provider = mode === "provider";
  $("passwordPanel")?.classList.toggle("is-hidden", !provider);
  $("requestPanel")?.classList.toggle("is-hidden", provider);
  if (provider) hideVerifyStep();

  // clear outputs when switching modes
  if ($("passOut")) $("passOut").textContent = "";
  if ($("reqOut")) $("reqOut").textContent = "";
  if ($("verOut")) $("verOut").textContent = "";
  setStatus(provider ? "Service Provider mode" : "User mode");
}

function syncGoogleButtonForMode() {
  const btn = $("googleLoginBtn");
  if (!btn) return;
  const mode = $("loginMode")?.value || "user";
  btn.classList.toggle("is-hidden", mode === "provider");
}

async function post(url, body) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text };
  }
  return { ok: res.ok, status: res.status, json };
}

async function get(url) {
  const res = await fetch(url, { method: "GET" });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text };
  }
  return { ok: res.ok, status: res.status, json };
}

const modeSel = $("loginMode");
if (modeSel) {
  modeSel.addEventListener("change", () => setMode(modeSel.value));
  setMode(modeSel.value || "user");
} else {
  setMode("user");
}

syncGoogleButtonForMode();
modeSel?.addEventListener("change", syncGoogleButtonForMode);

(function wireGoogleReturnTo() {
  const btn = $("googleLoginBtn");
  if (!btn) return;
  const dest = safeReturnToPath(new URLSearchParams(window.location.search).get("returnTo"));
  btn.setAttribute("href", dest ? `/api/auth/google/start?returnTo=${encodeURIComponent(dest)}` : "/api/auth/google/start");
})();

async function handleProviderLogin(e) {
  e?.preventDefault?.();
  try {
    setStatus("Logging in…");
    $("passOut").textContent = "";
    const btn = $("passwordLogin");
    if (btn) btn.disabled = true;

    const username = $("username")?.value || "";
    const password = $("password")?.value || "";
    const r = await post("/api/auth/login", { username, password });
    if (!r.ok) {
      setStatus("");
      $("passOut").textContent = r.json?.error || `Login failed (${r.status})`;
      if (btn) btn.disabled = false;
      return;
    }
    const me = await get("/api/auth/me");
    if (!me.ok || !me.json?.user) {
      setStatus("");
      $("passOut").textContent = "Login succeeded, but session was not detected. Please refresh and try again.";
      if (btn) btn.disabled = false;
      return;
    }
    setStatus("");
    cacheUser(me.json.user);
    $("passOut").textContent = "Logged in successfully. Redirecting…";
    if (btn) btn.disabled = false;
    window.location.assign(postLoginDestination());
  } catch (e) {
    setStatus("");
    if ($("passOut")) $("passOut").textContent = String(e?.message || e);
    $("passwordLogin") && ($("passwordLogin").disabled = false);
  }
}

$("providerForm")?.addEventListener("submit", handleProviderLogin);
$("passwordLogin")?.addEventListener("click", handleProviderLogin);

async function handleOtpRequest(e) {
  e?.preventDefault?.();
  try {
    $("reqOut").textContent = "Sending…";
    hideVerifyStep();
    const btn = $("request");
    if (btn) btn.disabled = true;
    const phone = $("phone").value;
    const r = await post("/api/auth/request-otp", { phone });
    if (!r.ok) {
      $("reqOut").textContent = r.json?.error || `OTP request failed (${r.status})`;
      if (btn) btn.disabled = false;
      return;
    }
    $("reqOut").textContent = "OTP sent successfully. Enter the code to continue.";
    showVerifyStep();
    $("code")?.focus?.();
    if (btn) btn.disabled = false;
  } catch (e) {
    $("reqOut").textContent = String(e?.message || e);
    $("request") && ($("request").disabled = false);
  }
}

$("otpRequestForm")?.addEventListener("submit", handleOtpRequest);
$("request")?.addEventListener("click", handleOtpRequest);

async function handleOtpVerify(e) {
  e?.preventDefault?.();
  try {
    $("verOut").textContent = "Verifying…";
    const btn = $("verify");
    if (btn) btn.disabled = true;
    const phone = $("phone").value;
    const code = $("code").value;
    const r = await post("/api/auth/verify-otp", { phone, code });
    if (!r.ok) {
      $("verOut").textContent = r.json?.error || `OTP verify failed (${r.status})`;
      if (btn) btn.disabled = false;
      return;
    }
    $("verOut").textContent = "Verified. Signing you in…";
    if (r.ok) {
      const me = await get("/api/auth/me");
      if (me.ok && me.json?.user) {
        cacheUser(me.json.user);
        window.location.assign(postLoginDestination());
        return;
      }
    }
    if (btn) btn.disabled = false;
  } catch (e) {
    $("verOut").textContent = String(e?.message || e);
    $("verify") && ($("verify").disabled = false);
  }
}

$("otpVerifyForm")?.addEventListener("submit", handleOtpVerify);
$("verify")?.addEventListener("click", handleOtpVerify);

$("logout")?.addEventListener("click", async () => {
  try {
    $("verOut").textContent = "Logging out…";
    const btn = $("logout");
    if (btn) btn.disabled = true;
    const r = await post("/api/auth/logout", {});
    clearCachedUser();
    $("verOut").textContent = pretty({ status: r.status, ...r.json });
    if (btn) btn.disabled = false;
  } catch (e) {
    $("verOut").textContent = String(e?.message || e);
    $("logout") && ($("logout").disabled = false);
  }
});

window.addEventListener("error", (e) => {
  const msg = e?.message || "Script error";
  if ($("passOut")) $("passOut").textContent = `Error: ${msg}`;
});

window.addEventListener("unhandledrejection", (e) => {
  const msg = e?.reason?.message || String(e?.reason || "Unhandled promise rejection");
  if ($("passOut")) $("passOut").textContent = `Error: ${msg}`;
});

