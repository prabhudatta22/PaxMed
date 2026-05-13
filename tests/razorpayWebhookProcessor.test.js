import assert from "node:assert/strict";
import test, { after } from "node:test";

import { pool } from "../server/db/pool.js";
import { processVerifiedRazorpayWebhook } from "../server/payments/razorpayWebhookProcessor.js";

after(async () => {
  await pool.end();
});

test("payment.failed webhook does not match orders by Razorpay order id alone", async () => {
  const originalQuery = pool.query.bind(pool);
  const queries = [];

  pool.query = async (sql, params = []) => {
    queries.push({ sql, params });
    if (sql.includes("INSERT INTO razorpay_webhook_events")) {
      return { rows: [{ id: 1 }] };
    }
    if (sql.includes("UPDATE orders")) {
      assert.match(sql, /razorpay_payment_id\s+IS\s+NULL/i);
      assert.match(sql, /btrim\(razorpay_payment_id\)\s+=\s+''/i);
      assert.match(sql, /razorpay_payment_id\s+=\s+\$1/i);
      assert.deepEqual(params, ["pay_failed_attempt", "order_shared"]);
      return { rows: [] };
    }
    if (sql.includes("UPDATE razorpay_webhook_events")) {
      return { rows: [] };
    }
    throw new Error(`Unexpected query: ${sql}`);
  };

  try {
    const out = await processVerifiedRazorpayWebhook({
      id: "evt_failed_attempt",
      event: "payment.failed",
      payload: {
        payment: {
          entity: {
            id: "pay_failed_attempt",
            order_id: "order_shared",
          },
        },
      },
    });

    assert.equal(out.ok, true);
    assert.equal(out.matched_order_id, null);
    assert.equal(queries.filter((q) => q.sql.includes("UPDATE orders")).length, 1);
  } finally {
    pool.query = originalQuery;
  }
});

test("unprocessed duplicate Razorpay webhook is retried", async () => {
  const originalQuery = pool.query.bind(pool);
  const queries = [];

  pool.query = async (sql, params = []) => {
    queries.push({ sql, params });
    if (sql.includes("INSERT INTO razorpay_webhook_events")) {
      return { rows: [] };
    }
    if (sql.includes("SELECT id, processed_ok, order_link_id")) {
      assert.deepEqual(params, ["evt_retry"]);
      return { rows: [{ id: 7, processed_ok: false, order_link_id: null }] };
    }
    if (sql.includes("UPDATE orders")) {
      assert.deepEqual(params, ["pay_retry", "order_retry"]);
      return { rows: [{ id: 42 }] };
    }
    if (sql.includes("UPDATE razorpay_webhook_events")) {
      assert.deepEqual(params, [7, true, 42, null]);
      return { rows: [] };
    }
    throw new Error(`Unexpected query: ${sql}`);
  };

  try {
    const out = await processVerifiedRazorpayWebhook({
      id: "evt_retry",
      event: "payment.captured",
      payload: {
        payment: {
          entity: {
            id: "pay_retry",
            order_id: "order_retry",
          },
        },
      },
    });

    assert.equal(out.ok, true);
    assert.equal(out.matched_order_id, 42);
    assert.equal(queries.filter((q) => q.sql.includes("UPDATE orders")).length, 1);
  } finally {
    pool.query = originalQuery;
  }
});

test("processed duplicate Razorpay webhook skips reconciliation", async () => {
  const originalQuery = pool.query.bind(pool);
  const queries = [];

  pool.query = async (sql, params = []) => {
    queries.push({ sql, params });
    if (sql.includes("INSERT INTO razorpay_webhook_events")) {
      return { rows: [] };
    }
    if (sql.includes("SELECT id, processed_ok, order_link_id")) {
      assert.deepEqual(params, ["evt_done"]);
      return { rows: [{ id: 8, processed_ok: true, order_link_id: 44 }] };
    }
    throw new Error(`Unexpected query: ${sql}`);
  };

  try {
    const out = await processVerifiedRazorpayWebhook({
      id: "evt_done",
      event: "payment.captured",
      payload: {
        payment: {
          entity: {
            id: "pay_done",
            order_id: "order_done",
          },
        },
      },
    });

    assert.equal(out.ok, true);
    assert.equal(out.duplicate, true);
    assert.equal(out.matched_order_id, 44);
    assert.equal(queries.filter((q) => q.sql.includes("UPDATE orders")).length, 0);
  } finally {
    pool.query = originalQuery;
  }
});
