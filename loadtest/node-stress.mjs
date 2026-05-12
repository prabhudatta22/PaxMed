#!/usr/bin/env node
/**
 * Lightweight load generator (no k6). Example:
 *
 * BASE_URL=http://127.0.0.1:3000 LOAD_TEST_TOKEN=secret \
 * SEARCH_CONCURRENCY=80 BOOK_CONCURRENCY=40 SEARCH_REQUESTS=2000 BOOK_USERS=400 \
 *   node loadtest/node-stress.mjs
 */
import process from "node:process";

const BASE = process.env.BASE_URL || "http://127.0.0.1:3000";
const TOKEN = String(process.env.LOAD_TEST_TOKEN || "").trim();

const SEARCH_REQUESTS = Math.max(0, Number(process.env.SEARCH_REQUESTS || 1200));
const BOOK_USERS = Math.max(0, Number(process.env.BOOK_USERS || 200));
const SEARCH_CONCURRENCY = Math.max(1, Number(process.env.SEARCH_CONCURRENCY || 50));
const BOOK_CONCURRENCY = Math.max(1, Number(process.env.BOOK_CONCURRENCY || 20));
const MED_OFFSET = Number(process.env.MED_USER_INDEX_OFFSET || 10_000_000);

if (BOOK_USERS > 0 && !TOKEN) {
  console.error("Set LOAD_TEST_TOKEN (same as server) when BOOK_USERS > 0.");
  process.exit(1);
}

async function fetchWithCookieJar(method, path, jar, opts = {}) {
  const cookieHdr = jar.get() ? `sid=${jar.get()}` : "";
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      ...(cookieHdr ? { Cookie: cookieHdr } : {}),
      ...opts.headers,
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const cookies = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [];
  for (const line of cookies) {
    const m = line.match(/\bsid=([^;]+)/);
    if (m) jar.set(m[1]);
  }
  const raw = res.headers.get("set-cookie");
  if (raw && cookies.length === 0) {
    const m = raw.match(/\bsid=([^;]+)/);
    if (m) jar.set(m[1]);
  }
  const txt = await res.text();
  let data = {};
  try {
    data = txt ? JSON.parse(txt) : {};
  } catch {
    data = {};
  }
  return { status: res.status, data };
}

function makeJar() {
  let sid = "";
  return {
    get() {
      return sid;
    },
    set(v) {
      sid = v;
    },
  };
}

async function runPool(n, concurrency, worker) {
  let next = 0;
  const results = [];
  async function runner() {
    while (next < n) {
      const i = next++;
      results[i] = await worker(i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, n) }, runner));
  return results;
}

/** Nearest-rank percentile (p ∈ [0,100]) on sorted ascending array. */
function percentileFromSorted(sorted, p) {
  const n = sorted.length;
  if (!n) return null;
  const clamped = Math.min(100, Math.max(0, p));
  const k = Math.ceil((clamped / 100) * n) - 1;
  return sorted[Math.min(Math.max(0, k), n - 1)];
}

function pct(arr, p) {
  if (!arr.length) return null;
  return percentileFromSorted([...arr].sort((a, b) => a - b), p);
}

console.log(`PaxMed node stress → ${BASE}`);

const searchLat = [];
let searchOk = 0;
await runPool(SEARCH_REQUESTS, SEARCH_CONCURRENCY, async (i) => {
  const t0 = Date.now();
  let path = `/api/labs/search?q=cbc&city=mumbai`;
  if (i % 3 === 1) path = `/api/medicines/search?q=metro`;
  if (i % 3 === 2) path = `/api/compare/search?q=metformin&city=mumbai`;
  const r = await fetch(`${BASE}${path}`, { headers: { Accept: "application/json" } });
  await r.text();
  searchLat.push(Date.now() - t0);
  if (r.status === 200) searchOk += 1;
  return r.status === 200;
});

console.log(
  `Search: ${SEARCH_REQUESTS} reqs · ${searchOk} ok (${((100 * searchOk) / SEARCH_REQUESTS).toFixed(1)}%) · latency ms p50=${pct(searchLat, 50)} p95=${pct(searchLat, 95)} max=${pct(searchLat, 100)}`
);

const bookLatDiag = [];
const bookLatMed = [];
const bookOk = await runPool(BOOK_USERS, BOOK_CONCURRENCY, async (k) => {
  const vu = k + 1;
  const j1 = makeJar();

  let t0 = Date.now();
  let r = await fetchWithCookieJar("POST", "/api/load-test/session", j1, {
    body: { token: TOKEN, user_index: vu },
  });
  if (r.status !== 200) return { diag: false, med: false };

  const patientPhone = `+91${6000000000 + vu}`;
  const sched = new Date(Date.now() + 5 * 86400000).toISOString();
  r = await fetchWithCookieJar("POST", "/api/orders/diagnostics", j1, {
    body: {
      package_id: "1",
      deal_id: "1",
      package_name: "CBC (Complete Blood Count)",
      city: "mumbai",
      price_inr: 299,
      mrp_inr: 350,
      payment_type: "cod",
      scheduled_for: sched,
      patient: { name: `NodeDiag${vu}`, phone: patientPhone, age: 30, gender: "male" },
    },
  });
  bookLatDiag.push(Date.now() - t0);
  const diagOk = r.status === 201 || r.status === 502;

  const j2 = makeJar();
  t0 = Date.now();
  r = await fetchWithCookieJar("POST", "/api/load-test/session", j2, {
    body: { token: TOKEN, user_index: MED_OFFSET + vu },
  });
  if (r.status !== 200) return { diag: diagOk, med: false };

  r = await fetchWithCookieJar("POST", "/api/orders", j2, {
    body: {
      delivery_option: "normal",
      address: {
        address_line1: `${vu} Node Med Lane`,
        city: "Mumbai",
        state: "Maharashtra",
        pincode: "400050",
      },
      items: [
        {
          pharmacyId: 1,
          medicineId: 1,
          medicineLabel: "Metformin 500 mg",
          unitPriceInr: 45,
          quantity: 1,
          strength: "500 mg",
          form: "tablet",
          pack_size: 10,
        },
      ],
    },
  });
  bookLatMed.push(Date.now() - t0);
  const medOk = r.status === 201;
  return { diag: diagOk, med: medOk };
});

const dOk = bookOk.filter((x) => x?.diag).length;
const mOk = bookOk.filter((x) => x?.med).length;
if (BOOK_USERS > 0) {
  console.log(`Bookings: ${BOOK_USERS} users · diag ${dOk} ok · med ${mOk} ok`);
  console.log(
    `  diag wall ms p50=${pct(bookLatDiag, 50)} p95=${pct(bookLatDiag, 95)} · med wall ms p50=${pct(bookLatMed, 50)} p95=${pct(bookLatMed, 95)}`
  );
}
