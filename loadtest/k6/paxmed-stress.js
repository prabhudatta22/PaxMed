/**
 * Grafana k6 stress test: diagnostics search, medicine/compare search,
 * authenticated diagnostics COD bookings, medicine home-delivery bookings.
 *
 * Requires PaxMed API + Postgres. Bookings require:
 *   export LOAD_TEST_TOKEN=<same as server .env LOAD_TEST_TOKEN>
 *
 * Typical:
 *   PGPOOL_MAX=80 DATABASE_URL=... LOAD_TEST_TOKEN=dev-secret-token npm run dev
 *   BASE_URL=http://127.0.0.1:3000 LOAD_TEST_TOKEN=dev-secret-token \
 *     SEARCH_VUS=500 BOOK_VUS=2500 DURATION=3m k6 run loadtest/k6/paxmed-stress.js
 *
 * ~10k booking VUs each scenario: BOOK_VUS=10000 — needs substantial k6 host RAM,
 * Postgres max_connections + PGPOOL_MAX (e.g. 80–150), optional PgBouncer.
 */
import http from "k6/http";
import { check } from "k6";

const BASE = __ENV.BASE_URL || "http://127.0.0.1:3000";
const TOKEN = __ENV.LOAD_TEST_TOKEN || "";

const SEARCH_VUS = Number(__ENV.SEARCH_VUS || 250);
const BOOK_VUS = Number(__ENV.BOOK_VUS || 250);
const DURATION = __ENV.DURATION || "2m";

/** Separate user_index space for medicine bookings vs diagnostics */
const MED_USER_INDEX_OFFSET = Number(__ENV.MED_USER_INDEX_OFFSET || 10_000_000);

export function setup() {
  if (!TOKEN) {
    throw new Error("Set LOAD_TEST_TOKEN for k6 (must match server LOAD_TEST_TOKEN)");
  }
}

export const options = {
  discardResponseBodies: true,
  scenarios: {
    diagnostics_search: {
      executor: "constant-vus",
      vus: SEARCH_VUS,
      duration: DURATION,
      gracefulStop: "45s",
      exec: "diagSearch",
      startTime: "0s",
    },
    medicine_search_compare: {
      executor: "constant-vus",
      vus: SEARCH_VUS,
      duration: DURATION,
      gracefulStop: "45s",
      exec: "medSearchCompare",
      startTime: "0s",
    },
    diagnostics_bookings: {
      executor: "constant-vus",
      vus: BOOK_VUS,
      duration: DURATION,
      gracefulStop: "90s",
      exec: "diagBook",
      startTime: "0s",
    },
    medicine_orders: {
      executor: "constant-vus",
      vus: BOOK_VUS,
      duration: DURATION,
      gracefulStop: "90s",
      exec: "medBook",
      startTime: "0s",
    },
  },
  thresholds: {
    http_req_failed: ["rate<0.35"],
    http_req_duration: ["p(95)<12000"],
  },
};

export function diagSearch() {
  const r = http.get(`${BASE}/api/labs/search?q=cbc&city=mumbai`, { tags: { name: "labs_search" } });
  check(r, { "labs 200": (x) => x.status === 200 });
}

export function medSearchCompare() {
  let r = http.get(`${BASE}/api/medicines/search?q=metro`, { tags: { name: "medicines_search" } });
  check(r, { "medicines 200": (x) => x.status === 200 });
  r = http.get(`${BASE}/api/compare/search?q=metformin&city=mumbai`, {
    tags: { name: "compare_search" },
  });
  check(r, { "compare 200": (x) => x.status === 200 });
}

let diagJar;

export function diagBook() {
  if (!diagJar) diagJar = http.cookieJar();

  if (__ITER === 0) {
    const r0 = http.post(
      `${BASE}/api/load-test/session`,
      JSON.stringify({ token: TOKEN, user_index: __VU }),
      { jar: diagJar, headers: { "Content-Type": "application/json" }, tags: { name: "session_diag" } }
    );
    check(r0, { "diag session 200": (x) => x.status === 200 });
    if (r0.status !== 200) return;
  }

  const patientPhone = `+91${6000000000 + Number(__VU)}`;
  const sched = new Date(Date.now() + 5 * 86400000).toISOString();

  const r1 = http.post(
    `${BASE}/api/orders/diagnostics`,
    JSON.stringify({
      package_id: "1",
      deal_id: "1",
      package_name: "CBC (Complete Blood Count)",
      city: "mumbai",
      price_inr: 299,
      mrp_inr: 350,
      payment_type: "cod",
      scheduled_for: sched,
      patient: {
        name: `K6Diag${__VU}`,
        phone: patientPhone,
        age: 31,
        gender: "male",
      },
    }),
    {
      jar: diagJar,
      headers: { "Content-Type": "application/json" },
      tags: { name: "diagnostics_booking" },
    }
  );

  check(r1, {
    "diag 201": (x) => x.status === 201,
    "diag partner/backpressure": (x) => x.status === 502 || x.status === 400 || x.status === 429,
  });
}

let medJar;

export function medBook() {
  if (!medJar) medJar = http.cookieJar();

  if (__ITER === 0) {
    const userIndex = MED_USER_INDEX_OFFSET + Number(__VU);
    const r0 = http.post(
      `${BASE}/api/load-test/session`,
      JSON.stringify({ token: TOKEN, user_index: userIndex }),
      { jar: medJar, headers: { "Content-Type": "application/json" }, tags: { name: "session_med" } }
    );
    check(r0, { "med session 200": (x) => x.status === 200 });
    if (r0.status !== 200) return;
  }

  const r1 = http.post(
    `${BASE}/api/orders`,
    JSON.stringify({
      delivery_option: "normal",
      address: {
        address_line1: `${__VU} Med Stress Rd`,
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
    }),
    {
      jar: medJar,
      headers: { "Content-Type": "application/json" },
      tags: { name: "medicine_order" },
    }
  );
  check(r1, { "med 201": (x) => x.status === 201 });
}
