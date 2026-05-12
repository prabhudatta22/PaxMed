import assert from "node:assert/strict";
import test from "node:test";

import { beginRazorpayPaymentOrderGuard } from "../server/routes/orders.js";

function fakeClient({ duplicateRows = [] } = {}) {
  const queries = [];
  return {
    queries,
    async query(sql, params) {
      queries.push({ sql, params });
      if (String(sql).includes("FROM orders WHERE razorpay_payment_id")) {
        return { rows: duplicateRows };
      }
      return { rows: [] };
    },
  };
}

test("payment guard serializes by Razorpay payment id before duplicate check", async () => {
  const client = fakeClient();
  const result = await beginRazorpayPaymentOrderGuard(client, "pay_123");

  assert.deepEqual(result, { guarded: true, duplicate: false });
  assert.equal(client.queries[0].sql, "BEGIN");
  assert.match(client.queries[1].sql, /pg_advisory_xact_lock/);
  assert.deepEqual(client.queries[1].params, ["pay_123"]);
  assert.match(client.queries[2].sql, /FROM orders WHERE razorpay_payment_id/);
  assert.deepEqual(client.queries[2].params, ["pay_123"]);
  assert.equal(client.queries.some((q) => q.sql === "ROLLBACK"), false);
});

test("payment guard rolls back and reports duplicate payment", async () => {
  const client = fakeClient({ duplicateRows: [{ id: 42 }] });
  const result = await beginRazorpayPaymentOrderGuard(client, " pay_123 ");

  assert.deepEqual(result, { guarded: true, duplicate: true, orderId: 42 });
  assert.deepEqual(
    client.queries.map((q) => q.sql),
    [
      "BEGIN",
      "SELECT pg_advisory_xact_lock(220582, hashtext($1::text))",
      "SELECT id FROM orders WHERE razorpay_payment_id = $1 LIMIT 1",
      "ROLLBACK",
    ]
  );
  assert.deepEqual(client.queries[1].params, ["pay_123"]);
  assert.deepEqual(client.queries[2].params, ["pay_123"]);
});
