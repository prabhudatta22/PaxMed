import assert from "node:assert/strict";
import test from "node:test";

import { isLoadTestRouteEnabled } from "../server/routes/loadTest.js";

test("load-test session route is disabled in production even with token", () => {
  assert.equal(
    isLoadTestRouteEnabled({
      LOAD_TEST_TOKEN: "long-random-token",
      NODE_ENV: "production",
    }),
    false
  );
});

test("load-test session route is enabled outside production when token is set", () => {
  assert.equal(
    isLoadTestRouteEnabled({
      LOAD_TEST_TOKEN: "long-random-token",
      NODE_ENV: "test",
    }),
    true
  );
});

test("load-test session route is disabled without token", () => {
  assert.equal(
    isLoadTestRouteEnabled({
      LOAD_TEST_TOKEN: "",
      NODE_ENV: "test",
    }),
    false
  );
});
