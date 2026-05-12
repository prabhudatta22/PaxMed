import pg from "pg";
import { parse } from "pg-connection-string";
import "dotenv/config";

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  console.warn(
    "PaxMed: DATABASE_URL is not set. Copy .env.example to .env and configure PostgreSQL."
  );
}

function isLocalDatabaseUrl(databaseUrl) {
  if (!databaseUrl) return true;
  const s = String(databaseUrl);
  return s.includes("localhost") || s.includes("127.0.0.1");
}

/**
 * Build Pool config. Important: pg merges `parse(connectionString)` *after* top-level
 * options, so `?sslmode=...` in DATABASE_URL overwrites `ssl: { rejectUnauthorized: false }`.
 * For remote DBs we parse the URL, strip ssl-related fields, then set ssl explicitly.
 */
function buildPoolConfig() {
  const conn = process.env.DATABASE_URL;
  const poolMaxRaw = Number(process.env.PGPOOL_MAX);
  const poolMax = Number.isFinite(poolMaxRaw) && poolMaxRaw >= 2 ? Math.min(200, Math.floor(poolMaxRaw)) : 10;
  const base = { max: poolMax, idleTimeoutMillis: 30_000 };

  if (!conn) return base;

  if (isLocalDatabaseUrl(conn)) {
    return { ...base, connectionString: conn };
  }

  const parsed = parse(conn);
  for (const key of ["ssl", "sslmode", "sslcert", "sslkey", "sslrootcert"]) {
    delete parsed[key];
  }

  return {
    ...base,
    ...parsed,
    ssl: { rejectUnauthorized: false },
  };
}

export const pool = new Pool(buildPoolConfig());
