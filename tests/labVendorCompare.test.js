import test from "node:test";
import assert from "node:assert/strict";
import {
  labsCompareBundles,
  normalizeDiagGroupingKey,
} from "../server/integrations/labVendorCompare.js";

test("normalizeDiagGroupingKey collapses punctuation and case", () => {
  assert.equal(
    normalizeDiagGroupingKey("  CBC (Complete Blood Count)  "),
    normalizeDiagGroupingKey("cbc complete blood count"),
  );
});

test("illustrative vendor stub rows remain estimate-only", async () => {
  const prevStubEnv = process.env.DIAG_VENDOR_STUB_QUOTES;
  const prevB2bEnabled = process.env.DIAG_B2B_ENABLED;
  const prevThyrocareBase = process.env.THYROCARE_PARTNER_API_BASE;
  const prevLucidBase = process.env.LUCID_PARTNER_API_BASE;
  process.env.DIAG_B2B_ENABLED = "false";
  process.env.DIAG_VENDOR_STUB_QUOTES = "true";
  delete process.env.THYROCARE_PARTNER_API_BASE;
  delete process.env.LUCID_PARTNER_API_BASE;
  try {
    const pool = {
      async query() {
        return {
          rows: [
            {
              id: 101,
              heading: "CBC Complete Blood Count",
              sub_heading: "",
              category: "PATHOLOGY",
              icon_url: null,
              slug: "cbc",
              report_tat_hours: 24,
              home_collection: true,
              lab_name: "Tata 1mg",
              price_inr: 299,
              mrp_inr: 499,
              discount_pct: 40,
            },
          ],
        };
      },
    };

    const bundle = await labsCompareBundles(pool, {
      q: "cbc",
      citySlug: "mumbai",
      pincode: "400001",
      category: "PATHOLOGY",
    });

    const offers = bundle.groups.flatMap((g) => g.offers);
    const catalog = offers.find((o) => o.data_mode === "local_catalog");
    const stubs = offers.filter((o) => o.data_mode === "illustrative_vendor_stub");

    assert.equal(catalog?.booking_supported, true);
    assert.equal(stubs.length, 2);
    assert.ok(stubs.every((o) => o.booking_supported === false));
  } finally {
    if (prevStubEnv == null) delete process.env.DIAG_VENDOR_STUB_QUOTES;
    else process.env.DIAG_VENDOR_STUB_QUOTES = prevStubEnv;
    if (prevB2bEnabled == null) delete process.env.DIAG_B2B_ENABLED;
    else process.env.DIAG_B2B_ENABLED = prevB2bEnabled;
    if (prevThyrocareBase == null) delete process.env.THYROCARE_PARTNER_API_BASE;
    else process.env.THYROCARE_PARTNER_API_BASE = prevThyrocareBase;
    if (prevLucidBase == null) delete process.env.LUCID_PARTNER_API_BASE;
    else process.env.LUCID_PARTNER_API_BASE = prevLucidBase;
  }
});
