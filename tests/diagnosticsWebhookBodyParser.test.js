import assert from "node:assert/strict";
import test from "node:test";

import { pool } from "../server/db/pool.js";
import { createApp } from "../server/index.js";

function listen(app) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => resolve(server));
    server.once("error", reject);
  });
}

test("diagnostics webhook receives parsed JSON body in the real app", async () => {
  const originalSecret = process.env.DIAGNOSTICS_WEBHOOK_SECRET;
  const originalQuery = pool.query.bind(pool);
  const secret = "diagnostics-webhook-secret-123";
  const queries = [];
  let server;

  process.env.DIAGNOSTICS_WEBHOOK_SECRET = secret;
  pool.query = async (sql, params = []) => {
    queries.push({ sql, params });
    if (sql.includes("CREATE TABLE IF NOT EXISTS user_diagnostic_reports")) {
      return { rows: [] };
    }
    if (sql.includes("FROM orders") && sql.includes("provider_order_ref")) {
      assert.deepEqual(params, ["BK-123"]);
      return { rows: [{ id: 7, user_id: 42 }] };
    }
    throw new Error(`Unexpected query: ${sql}`);
  };

  try {
    server = await listen(createApp());
    const { port } = server.address();
    const res = await fetch(`http://127.0.0.1:${port}/webhook/diagnostics`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-diagnostics-webhook-secret": secret,
      },
      body: JSON.stringify({ booking_id: "BK-123" }),
    });
    const body = await res.json();

    assert.equal(res.status, 200);
    assert.equal(body.matched_orders, 1);
    assert.equal(body.results[0].order_id, 7);
    assert.equal(body.results[0].sync.reason, "partner_disabled");
    assert.ok(queries.some((q) => q.params[0] === "BK-123"));
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    pool.query = originalQuery;
    if (originalSecret === undefined) {
      delete process.env.DIAGNOSTICS_WEBHOOK_SECRET;
    } else {
      process.env.DIAGNOSTICS_WEBHOOK_SECRET = originalSecret;
    }
    await pool.end();
  }
});
