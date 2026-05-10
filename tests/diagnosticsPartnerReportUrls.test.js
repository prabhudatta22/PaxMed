import assert from "node:assert/strict";
import test from "node:test";
import { extractReportUrlsFromCustomerReportData } from "../server/integrations/diagnosticsPartner.js";
import { fetchReportFromUrl } from "../server/diagnostics/partnerReportSync.js";

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

test("fetchReportFromUrl rejects oversized content-length before buffering", async () => {
  const originalFetch = globalThis.fetch;
  const originalMax = process.env.DIAGNOSTIC_REPORT_MAX_BYTES;
  process.env.DIAGNOSTIC_REPORT_MAX_BYTES = "2048";
  let readerRequested = false;
  globalThis.fetch = async () => ({
    ok: true,
    url: "https://cdn.example.com/report.pdf",
    headers: {
      get(name) {
        const key = String(name).toLowerCase();
        if (key === "content-type") return "application/pdf";
        if (key === "content-length") return "2049";
        return null;
      },
    },
    body: {
      getReader() {
        readerRequested = true;
        return {
          read: async () => ({ done: true }),
          cancel: async () => {},
          releaseLock: () => {},
        };
      },
    },
  });

  try {
    await assert.rejects(
      () => fetchReportFromUrl("https://cdn.example.com/report.pdf", { timeoutMs: 1000 }),
      /Report body too large/
    );
    assert.equal(readerRequested, false);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalMax == null) delete process.env.DIAGNOSTIC_REPORT_MAX_BYTES;
    else process.env.DIAGNOSTIC_REPORT_MAX_BYTES = originalMax;
  }
});

test("fetchReportFromUrl stops streaming once body exceeds report size limit", async () => {
  const originalFetch = globalThis.fetch;
  const originalMax = process.env.DIAGNOSTIC_REPORT_MAX_BYTES;
  process.env.DIAGNOSTIC_REPORT_MAX_BYTES = "2048";
  globalThis.fetch = async () => ({
    ok: true,
    url: "https://cdn.example.com/report.pdf",
    headers: {
      get(name) {
        return String(name).toLowerCase() === "content-type" ? "application/pdf" : null;
      },
    },
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(1500));
        controller.enqueue(new Uint8Array(700));
        controller.close();
      },
    }),
  });

  try {
    await assert.rejects(
      () => fetchReportFromUrl("https://cdn.example.com/report.pdf", { timeoutMs: 1000 }),
      /Report body too large/
    );
  } finally {
    globalThis.fetch = originalFetch;
    if (originalMax == null) delete process.env.DIAGNOSTIC_REPORT_MAX_BYTES;
    else process.env.DIAGNOSTIC_REPORT_MAX_BYTES = originalMax;
  }
});
