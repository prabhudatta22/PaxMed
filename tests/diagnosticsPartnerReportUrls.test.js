import assert from "node:assert/strict";
import test from "node:test";
import { extractDiagnosticsReportContext } from "../server/diagnostics/partnerReportSync.js";
import { extractReportUrlsFromCustomerReportData } from "../server/integrations/diagnosticsPartner.js";

test("extractReportUrls collects https URLs from nested and flat shapes", () => {
  const u = "https://cdn.example.com/r1.pdf";
  assert.deepEqual(
    extractReportUrlsFromCustomerReportData({
      report_url: u,
    }),
    [u],
  );
  assert.deepEqual(
    extractReportUrlsFromCustomerReportData({
      data: { report_url: u, cgm_report_url: "https://cdn.example.com/cgm.pdf" },
    }),
    [u, "https://cdn.example.com/cgm.pdf"],
  );
});

test("extractReportUrls ignores non-https and empty strings", () => {
  assert.deepEqual(
    extractReportUrlsFromCustomerReportData({
      report_url: "http://insecure.example.com/x.pdf",
    }),
    [],
  );
  assert.deepEqual(extractReportUrlsFromCustomerReportData({ report_url: "" }), []);
});

test("extractDiagnosticsReportContext supports pre-rebrand medlens payloads", () => {
  const ctx = extractDiagnosticsReportContext({
    user_id: 99,
    provider_order_ref: "fallback-ref",
    provider_payload: {
      medlens: {
        partner_booking_id: "legacy-booking",
        vendor_booking_id: "legacy-vendor-booking",
        vendor_billing_user_id: "medlens-99",
        vendor_customer_id: "cust-legacy",
      },
    },
  });

  assert.equal(ctx.partner_booking_id, "legacy-booking");
  assert.equal(ctx.vendor_booking_id, "legacy-vendor-booking");
  assert.equal(ctx.vendor_billing_user_id, "medlens-99");
  assert.equal(ctx.vendor_customer_id, "cust-legacy");
  assert.equal(ctx.legacy, undefined);
});
