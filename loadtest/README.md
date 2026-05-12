# Load and stress testing (PaxMed)

These tools hammer **real HTTP routes**:

| Traffic | Routes |
|---------|--------|
| Diagnostics search | `GET /api/labs/search` |
| Medicine search | `GET /api/medicines/search`, `GET /api/compare/search` |
| Diagnostics booking | `POST /api/load-test/session` → `POST /api/orders/diagnostics` |
| Medicine booking | `POST /api/load-test/session` → `POST /api/orders` |

## 1. Enable synthetic users (required for bookings only)

On the server, set a long random **`LOAD_TEST_TOKEN`** in `.env` and restart. This exposes **`POST /api/load-test/session`**, which creates a consumer user (`+916000XXXXXXX`), a Mumbai address row, and a session cookie (`sid`).

**Remove `LOAD_TEST_TOKEN` when you finish testing.** The server prints a warning if it is set while `NODE_ENV=production`.

## 2. Right-size Postgres pool

The app defaults to **`PGPOOL_MAX=10`**. Under load, raise it—but **never above** your Postgres / pooler limit.

**Neon (and similar) “session” poolers** often cap at a small **pool size** (for example 15). If the server logs **`EMAXCONNSESSION` max clients reached**, set **`PGPOOL_MAX`** a few **below** that cap (e.g. `12`), and keep **`SEARCH_CONCURRENCY`** / **`BOOK_CONCURRENCY`** in the same ballpark so you do not queue thousands of requests on a tiny pool.

Stay **below** Postgres `max_connections` (and below PgBouncer pool size if you use one).

## 3. k6 (recommended for 10k+ VUs)

Install [k6](https://k6.io/docs/get-started/installation/), then:

```bash
# Terminal A
export LOAD_TEST_TOKEN='your-secret'
export PGPOOL_MAX=96
npm run dev

# Terminal B
export LOAD_TEST_TOKEN='your-secret'
export BASE_URL=http://127.0.0.1:3000
# ~10k “users” sustained on bookings (heavy — tune OS + Postgres too):
export SEARCH_VUS=2000 BOOK_VUS=10000 DURATION=4m
k6 run loadtest/k6/paxmed-stress.js
```

- **`SEARCH_VUS`**: concurrency for labs + medicine/compare search (four scenarios total; see script).
- **`BOOK_VUS`**: concurrent **virtual users** placing orders (diagnostics COD + medicine delivery run in parallel scenarios).
- **`MED_USER_INDEX_OFFSET`**: optional; keeps medicine booking synthetic users disjoint from diagnostics users (default `10000000`).

At **BOOK_VUS=10000** you normally need a strong k6 machine, Postgres tuned for concurrency, **`PGPOOL_MAX` ~ pool cap**, and `max_connections` on the DB raised accordingly. Expect timeouts if the DB or CPU is saturated — that **is** a valid stress outcome.

Diagnostics runs against **local** catalog when **`DIAG_B2B_ENABLED` is not `true`** — avoid pointing load at partner APIs unless intentional.

## 4. Node runner (lighter, no k6)

Uses `fetch`; good for sanity checks:

```bash
BASE_URL=http://127.0.0.1:3000 LOAD_TEST_TOKEN=secret \
  SEARCH_REQUESTS=3000 SEARCH_CONCURRENCY=100 \
  BOOK_USERS=600 BOOK_CONCURRENCY=60 \
  node loadtest/node-stress.mjs
```

## NPM scripts

- `npm run loadtest:k6` — wraps `k6 run loadtest/k6/paxmed-stress.js`
- `npm run loadtest:node` — runs `node loadtest/node-stress.mjs`
