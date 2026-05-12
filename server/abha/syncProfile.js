import { fetchAbhaDemographics, pushAbhaDemographics } from "./client.js";
import { ensureAbhaSchema } from "./schema.js";

function mapGenderToDb(g) {
  const v = String(g || "").toLowerCase();
  if (v === "male" || v === "m") return "male";
  if (v === "female" || v === "f") return "female";
  if (v === "other" || v === "o") return "other";
  return null;
}

/**
 * ABHA wins on conflict: overwrite PaxMed user + default address from ABHA demographics.
 */
export async function applyAbhaDemographicsToUser(client, userId, demo) {
  const fullName = demo.full_name ? String(demo.full_name).trim() : null;
  const email = demo.email ? String(demo.email).trim().toLowerCase() : null;
  const gender = mapGenderToDb(demo.gender);
  const dob = demo.date_of_birth ? String(demo.date_of_birth).trim() : null;

  await client.query(
    `UPDATE users
     SET full_name = COALESCE($2, full_name),
         email = COALESCE($3, email),
         gender = COALESCE($4, gender),
         date_of_birth = COALESCE($5::date, date_of_birth)
     WHERE id = $1`,
    [userId, fullName, email, gender, dob],
  );

  const addr = demo.address;
  if (addr && (addr.address_line1 || addr.city || addr.pincode)) {
    await client.query(`UPDATE user_addresses SET is_default = false WHERE user_id = $1`, [userId]);
    await client.query(
      `INSERT INTO user_addresses
        (user_id, label, address_line1, address_line2, landmark, city, state, pincode, is_default, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, true, now(), now())`,
      [
        userId,
        String(addr.label || "Registered address").slice(0, 120),
        String(addr.address_line1 || "").slice(0, 240),
        addr.address_line2 ? String(addr.address_line2).slice(0, 240) : null,
        addr.landmark ? String(addr.landmark).slice(0, 120) : null,
        String(addr.city || "").slice(0, 120),
        String(addr.state || "").slice(0, 120),
        String(addr.pincode || "").replace(/\D/g, "").slice(0, 10),
      ],
    );
  }
}

export async function syncFromAbha(pool, userId, identifier) {
  const demo = await fetchAbhaDemographics({ identifier });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await applyAbhaDemographicsToUser(client, userId, demo);
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
  return demo;
}

export async function buildAbhaPushPayload(pool, userId) {
  const { rows: u } = await pool.query(
    `SELECT
       to_jsonb(users) ->> 'full_name' AS full_name,
       to_jsonb(users) ->> 'email' AS email,
       to_jsonb(users) ->> 'gender' AS gender,
       (users.date_of_birth)::text AS date_of_birth
     FROM users
     WHERE id = $1
     LIMIT 1`,
    [userId],
  );
  const ur = u[0] || {};
  let dob = null;
  if (ur.date_of_birth != null && String(ur.date_of_birth).trim()) {
    dob = String(ur.date_of_birth).trim().slice(0, 10);
  }
  const { rows: ar } = await pool.query(
    `SELECT address_line1, address_line2, landmark, city, state, pincode
     FROM user_addresses
     WHERE user_id = $1 AND is_default = true
     ORDER BY COALESCE(updated_at, created_at) DESC, id DESC
     LIMIT 1`,
    [userId],
  );
  const addr = ar[0];
  return {
    full_name: ur.full_name || null,
    email: ur.email || null,
    gender: ur.gender || null,
    date_of_birth: dob,
    address: addr
      ? {
          address_line1: addr.address_line1,
          address_line2: addr.address_line2,
          landmark: addr.landmark,
          city: addr.city,
          state: addr.state,
          pincode: addr.pincode,
        }
      : null,
  };
}

/**
 * When ABHA is linked, push the latest PaxMed profile (and default address) to ABDM.
 * `overrides` are merged on top of the DB snapshot (e.g. immediately after a profile PUT).
 */
export async function mergeAndPushAbhaForUser(pool, userId, overrides = {}) {
  await ensureAbhaSchema();
  const row = await loadAbhaLink(pool, userId);
  if (!row) return { skipped: true, reason: "not_linked" };
  const identifier = identifierFromLinkRow(row);
  if (!identifier) return { skipped: true, reason: "invalid_link" };
  const base = await buildAbhaPushPayload(pool, userId);
  const payload = {
    ...base,
    ...overrides,
    address: overrides.address != null ? overrides.address : base.address,
  };
  const out = await pushAbhaDemographics({ identifier }, payload);
  await pool.query(`UPDATE abha_link SET last_sync_at = now(), updated_at = now() WHERE user_id = $1`, [userId]);
  return out;
}

export async function loadAbhaLink(pool, userId) {
  const { rows } = await pool.query(`SELECT * FROM abha_link WHERE user_id = $1`, [userId]);
  return rows[0] || null;
}

export function identifierFromLinkRow(row) {
  if (!row) return null;
  const raw = String(row.health_id_number || "").trim();
  if (raw.includes("@")) return { kind: "phr", value: raw.toLowerCase() };
  return { kind: "number", value: raw.replace(/\D/g, "") };
}
