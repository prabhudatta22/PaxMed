import { Router } from "express";
import { pool } from "../db/pool.js";
import bcrypt from "bcryptjs";
import {
  generateOtpCode,
  hashOtp,
  normalizeIndiaPhoneToE164,
  randomSessionId,
} from "../auth/phone.js";
import { createProviderSession, deleteProviderSession } from "../auth/providerSessions.js";
import { exchangeCodeForToken, fetchGoogleUserInfo, googleAuthUrl, googleEnabled, newState } from "../auth/google.js";

const router = Router();
const DUMMY_OTP_PHONE = "+919100946364";
const DUMMY_OTP_CODE = "12345";

function safeInternalRedirectPath(raw, fallback = "/") {
  const s = String(raw || "").trim();
  if (!s.startsWith("/")) return fallback;
  if (s.startsWith("//")) return fallback;
  if (/[\0\r\n]/.test(s)) return fallback;
  return s;
}

function otpPepper() {
  return process.env.OTP_PEPPER || "dev-only-pepper-change-me";
}

async function issueUserSession(res, user) {
  const sid = randomSessionId();
  const days = Number(process.env.SESSION_DAYS || 30);
  const expiresAt = new Date(Date.now() + days * 24 * 60 * 60_000).toISOString();
  await pool.query(
    `INSERT INTO sessions (id, user_id, expires_at) VALUES ($1, $2, $3)`,
    [sid, user.id, expiresAt]
  );

  res.cookie("sid", sid, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    expires: new Date(expiresAt),
  });
}

router.post("/request-otp", async (req, res) => {
  const phoneE164 = normalizeIndiaPhoneToE164(req.body?.phone);
  if (!phoneE164) return res.status(400).json({ error: "Invalid phone number (India only)" });

  // Basic rate limit: max 5 per 10 minutes per phone
  const { rows: recent } = await pool.query(
    `SELECT COUNT(*)::int AS c
     FROM otp_codes
     WHERE phone_e164 = $1 AND created_at > now() - interval '10 minutes'`,
    [phoneE164]
  );
  if (recent[0]?.c >= 5) return res.status(429).json({ error: "Too many OTP requests. Try later." });

  const code = phoneE164 === DUMMY_OTP_PHONE ? DUMMY_OTP_CODE : generateOtpCode();
  const codeHash = hashOtp({ phoneE164, code, pepper: otpPepper() });
  const expiresMinutes = Number(process.env.OTP_EXPIRES_MINUTES || 5);
  const expiresAt = new Date(Date.now() + expiresMinutes * 60_000).toISOString();

  await pool.query(
    `INSERT INTO otp_codes (phone_e164, code_hash, expires_at, ip, user_agent)
     VALUES ($1, $2, $3, $4, $5)`,
    [phoneE164, codeHash, expiresAt, req.ip, req.header("user-agent") || null]
  );

  // Delivery: for now (MVP) we don't integrate SMS provider.
  // In production, send via SMS/WhatsApp and NEVER return the OTP.
  const isProd = process.env.NODE_ENV === "production";

  res.json({
    ok: true,
    phone: phoneE164,
    expires_minutes: expiresMinutes,
    dev_otp: isProd ? undefined : code,
    delivery: isProd ? "sms_pending" : "dev_returned",
  });
});

router.post("/verify-otp", async (req, res) => {
  const phoneE164 = normalizeIndiaPhoneToE164(req.body?.phone);
  const code = String(req.body?.code || "").trim();
  if (!phoneE164) return res.status(400).json({ error: "Invalid phone number (India only)" });
  const isDummyOtp = phoneE164 === DUMMY_OTP_PHONE && code === DUMMY_OTP_CODE;
  if (!isDummyOtp && !/^\d{6}$/.test(code)) return res.status(400).json({ error: "Invalid OTP" });

  if (isDummyOtp) {
    const userRes = await pool.query(
      `INSERT INTO users (phone_e164, last_login_at)
       VALUES ($1, now())
       ON CONFLICT (phone_e164) DO UPDATE SET last_login_at = now()
       RETURNING id, phone_e164`,
      [phoneE164]
    );
    const user = userRes.rows[0];
    await issueUserSession(res, user);
    return res.json({ ok: true, user: { id: user.id, phone_e164: user.phone_e164 }, auth: "dummy_otp" });
  }

  const codeHash = hashOtp({ phoneE164, code, pepper: otpPepper() });

  const { rows } = await pool.query(
    `SELECT id, expires_at, consumed_at
     FROM otp_codes
     WHERE phone_e164 = $1 AND code_hash = $2 AND purpose = 'login'
     ORDER BY created_at DESC
     LIMIT 1`,
    [phoneE164, codeHash]
  );
  if (!rows.length) return res.status(401).json({ error: "Incorrect OTP" });

  const otp = rows[0];
  if (otp.consumed_at) return res.status(401).json({ error: "OTP already used" });
  if (new Date(otp.expires_at).getTime() < Date.now()) return res.status(401).json({ error: "OTP expired" });

  await pool.query(`UPDATE otp_codes SET consumed_at = now() WHERE id = $1`, [otp.id]);

  const userRes = await pool.query(
    `INSERT INTO users (phone_e164, last_login_at)
     VALUES ($1, now())
     ON CONFLICT (phone_e164) DO UPDATE SET last_login_at = now()
     RETURNING id, phone_e164`,
    [phoneE164]
  );
  const user = userRes.rows[0];

  await issueUserSession(res, user);

  res.json({ ok: true, user: { id: user.id, phone_e164: user.phone_e164 } });
});

router.post("/login", async (req, res) => {
  const username = String(req.body?.username || "").trim();
  const password = String(req.body?.password || "").trim();

  if (!username || !password) return res.status(400).json({ error: "Username and password are required" });

  const { rows } = await pool.query(
    `SELECT id, username, password_hash, active
     FROM service_provider_users
     WHERE lower(username) = lower($1)
     LIMIT 1`,
    [username]
  );
  if (!rows.length) return res.status(401).json({ error: "Invalid credentials" });
  const u = rows[0];
  if (!u.active) return res.status(403).json({ error: "Account disabled" });

  const ok = bcrypt.compareSync(password, u.password_hash);
  if (!ok) return res.status(401).json({ error: "Invalid credentials" });

  await pool.query(`UPDATE service_provider_users SET last_login_at = now() WHERE id = $1`, [u.id]);

  let sid;
  let ttlSeconds;
  try {
    const s = await createProviderSession({ providerUserId: u.id, username: u.username });
    sid = s.sid;
    ttlSeconds = s.ttlSeconds;
  } catch (e) {
    return res.status(503).json({
      error: "Login temporarily unavailable",
      detail: String(e?.message || e),
      hint: "Redis must be running and REDIS_URL must be set",
    });
  }
  res.cookie("sid", sid, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: ttlSeconds * 1000,
  });

  return res.json({ ok: true, user: { id: `sp:${u.id}`, username: u.username, role: "service_provider" } });
});

router.post("/logout", async (req, res) => {
  const sid = req.cookies?.sid;
  if (sid) {
    await deleteProviderSession(sid).catch(() => {});
    await pool.query(`UPDATE sessions SET revoked_at = now() WHERE id = $1`, [sid]).catch(() => {});
  }
  res.clearCookie("sid");
  res.json({ ok: true });
});

router.get("/me", async (req, res) => {
  res.json({ user: req.user || null });
});

// --- Google OAuth (Gmail login) ---
router.get("/google/start", async (req, res) => {
  if (!googleEnabled()) return res.status(503).json({ error: "Google login is not configured" });
  const state = newState();
  // Store state in short-lived cookie (MVP). In production: server-side store.
  res.cookie("gstate", state, { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", maxAge: 10 * 60_000 });
  const returnTo = safeInternalRedirectPath(req.query?.returnTo, "");
  if (returnTo) {
    res.cookie("greturn", returnTo, {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      maxAge: 10 * 60_000,
    });
  } else {
    res.clearCookie("greturn");
  }
  res.redirect(googleAuthUrl(state));
});

router.get("/google/callback", async (req, res) => {
  if (!googleEnabled()) return res.status(503).send("Google login not configured");
  const code = String(req.query.code || "");
  const state = String(req.query.state || "");
  const cookieState = req.cookies?.gstate;
  if (!code) return res.status(400).send("Missing code");
  if (!state || !cookieState || state !== cookieState) return res.status(400).send("Invalid state");
  res.clearCookie("gstate");

  try {
    const token = await exchangeCodeForToken(code);
    const info = await fetchGoogleUserInfo(token.access_token);
    const sub = String(info.sub || "");
    const email = info.email ? String(info.email).toLowerCase() : null;
    if (!sub) throw new Error("Missing Google subject");
    if (!email) throw new Error("Google account has no email");

    // Find or create user mapped to google sub
    const existing = await pool.query(
      `SELECT u.id, u.phone_e164
       FROM oauth_identities oi
       JOIN users u ON u.id = oi.user_id
       WHERE oi.provider = 'google' AND oi.provider_subject = $1
       LIMIT 1`,
      [sub]
    );
    let userId;
    if (existing.rows.length) {
      userId = existing.rows[0].id;
    } else {
      // Production-safe: create user by email (phone may be null).
      const ures = await pool.query(
        `INSERT INTO users (email, last_login_at)
         VALUES ($1, now())
         ON CONFLICT ((lower(email))) DO UPDATE SET last_login_at = now()
         RETURNING id`,
        [email]
      );
      userId = ures.rows[0].id;
      await pool.query(
        `INSERT INTO oauth_identities (provider, provider_subject, email, user_id)
         VALUES ('google', $1, $2, $3)`,
        [sub, email, userId]
      );
    }

    const sid = randomSessionId();
    const days = Number(process.env.SESSION_DAYS || 30);
    const expiresAt = new Date(Date.now() + days * 24 * 60 * 60_000).toISOString();
    await pool.query(`INSERT INTO sessions (id, user_id, expires_at) VALUES ($1, $2, $3)`, [sid, userId, expiresAt]);

    res.cookie("sid", sid, {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      expires: new Date(expiresAt),
    });

    const returnCookie = req.cookies?.greturn;
    res.clearCookie("greturn");
    const dest = safeInternalRedirectPath(returnCookie, "/index.html");
    return res.redirect(dest);
  } catch (e) {
    return res.status(500).send(`Google login failed: ${String(e?.message || e)}`);
  }
});

export default router;

