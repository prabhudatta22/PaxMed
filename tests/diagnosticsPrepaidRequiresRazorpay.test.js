import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";

import express from "express";

import ordersRouter from "../server/routes/orders.js";
import { pool } from "../server/db/pool.js";

async function postJson(app, path, body) {
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  try {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
  } finally {
    await new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  }
}

test("diagnostics prepaid booking requires Razorpay when Razorpay is not configured", async () => {
  const originalQuery = pool.query;
  const originalKeyId = process.env.RAZORPAY_KEY_ID;
  const originalKeySecret = process.env.RAZORPAY_KEY_SECRET;
  delete process.env.RAZORPAY_KEY_ID;
  delete process.env.RAZORPAY_KEY_SECRET;
  pool.query = async () => ({ rows: [] });

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = {
      id: 123,
      role: "user",
      full_name: "Test Patient",
      phone_e164: "+919999999999",
    };
    next();
  });
  app.use("/api/orders", ordersRouter);

  try {
    const result = await postJson(app, "/api/orders/diagnostics", {
      payment_type: "prepaid",
      payment_meta: {},
      scheduled_for: new Date(Date.now() + 60 * 60_000).toISOString(),
      packages: [
        {
          package_id: "cbc",
          deal_id: "cbc",
          package_name: "CBC",
          city: "mumbai",
          price_inr: 499,
        },
      ],
      patient: { name: "Test Patient", phone: "+919999999999" },
    });

    assert.equal(result.status, 400);
    assert.equal(result.body.error, "Razorpay is not configured - choose Cash on delivery.");
  } finally {
    pool.query = originalQuery;
    if (originalKeyId === undefined) delete process.env.RAZORPAY_KEY_ID;
    else process.env.RAZORPAY_KEY_ID = originalKeyId;
    if (originalKeySecret === undefined) delete process.env.RAZORPAY_KEY_SECRET;
    else process.env.RAZORPAY_KEY_SECRET = originalKeySecret;
  }
});
