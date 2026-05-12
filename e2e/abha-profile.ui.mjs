/**
 * Browser UI smoke test: login → profile → ABHA link (stub OTP) → refresh from ABHA.
 *
 * Prerequisites: Postgres reachable (e.g. docker compose up -d db && npm run db:migrate).
 * Run: npm run test:ui-abha
 *
 * First run may need: npx playwright install chromium
 */
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

const PORT = Number(process.env.MEDLENS_TEST_PORT || 4022);
const BASE = `http://127.0.0.1:${PORT}`;
const DATABASE_URL =
  process.env.DATABASE_URL || "postgresql://paxmed:paxmed@127.0.0.1:5432/paxmed";

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitForServer(url, timeoutMs = 45_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { redirect: "manual" });
      if (res.status < 500) return;
    } catch {
      /* ignore */
    }
    await sleep(250);
  }
  throw new Error(`Server did not become ready: ${url}`);
}

async function main() {
  let chromium;
  try {
    ({ chromium } = await import("playwright"));
  } catch {
    console.error("Install Playwright: npm i -D playwright && npx playwright install chromium");
    process.exit(1);
  }

  const phone = `9${String(100000000 + (Math.floor(Math.random() * 899999999) % 899999999)).padStart(9, "0")}`;

  const child = spawn("node", ["server/index.js"], {
    cwd: projectRoot,
    env: {
      ...process.env,
      PORT: String(PORT),
      DATABASE_URL,
      ABHA_INTEGRATION_MODE: "stub",
      NODE_ENV: "development",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stderr = "";
  child.stderr?.on("data", (c) => {
    stderr += String(c);
  });

  const kill = () => {
    try {
      child.kill("SIGTERM");
    } catch {
      /* ignore */
    }
  };
  process.on("exit", kill);

  try {
    await waitForServer(`${BASE}/`);

    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
    const page = await context.newPage();

    const otpResponse = page.waitForResponse(
      (res) => res.url().includes("/api/auth/request-otp") && res.request().method() === "POST",
    );

    await page.goto(`${BASE}/login.html?returnTo=${encodeURIComponent("/profile.html?view=abha")}`, {
      waitUntil: "domcontentloaded",
    });

    await page.locator("#phone").fill(phone);
    await page.locator("#request").click();
    const resp = await otpResponse;
    const otpJson = await resp.json();
    const otpCode = String(otpJson.dev_otp || "").trim();
    if (!/^\d{5,6}$/.test(otpCode)) {
      throw new Error(`Expected dev_otp in request-otp response, got: ${JSON.stringify(otpJson)}`);
    }

    await page.locator("#code").fill(otpCode);
    await page.locator("#verify").click();
    await page.waitForURL(/profile\.html/, { timeout: 30_000 });

    const frame = page.frameLocator("#profileSectionFrame");
    await frame.locator("#abhaIdentifierInput").waitFor({ state: "visible", timeout: 20_000 });

    const abhaInit = page.waitForResponse(
      (r) => r.url().includes("/api/abha/aadhaar/initiate") && r.request().method() === "POST",
    );
    await frame.locator("#abhaIdentifierInput").fill("91001010101010");
    await frame.locator("#abhaInitOtpBtn").click();
    const initBody = await (await abhaInit).json();
    if (!initBody.txn_id) throw new Error(`initiate failed: ${JSON.stringify(initBody)}`);

    await frame.locator("#abhaOtpPanel").waitFor({ state: "visible", timeout: 10_000 });
    await frame.locator("#abhaOtpInput").fill("123456");
    const complete = page.waitForResponse(
      (r) => r.url().includes("/api/abha/aadhaar/complete") && r.request().method() === "POST",
    );
    await frame.locator("#abhaCompleteBtn").click();
    const completeRes = await complete;
    if (!completeRes.ok()) {
      throw new Error(`complete HTTP ${completeRes.status()}: ${await completeRes.text()}`);
    }
    const completeJson = await completeRes.json();
    if (!completeJson.linked) throw new Error(`complete body: ${JSON.stringify(completeJson)}`);

    await frame.locator("#abhaLinkedPanel").waitFor({ state: "visible", timeout: 15_000 });

    const masked = await frame.locator("#abhaMaskedDisplay").innerText();
    if (!masked.includes("*")) {
      throw new Error(`Expected masked ABHA in UI, got: ${masked}`);
    }

    const sync = page.waitForResponse(
      (r) => r.url().includes("/api/abha/sync-from-abha") && r.request().method() === "POST",
    );
    await frame.locator("#abhaSyncFromBtn").click();
    const syncRes = await sync;
    if (!syncRes.ok()) throw new Error(`sync-from-abha failed: ${await syncRes.text()}`);

    await page.locator('a.profile-side-link[data-profile-view="details"]').click();
    await page.locator("#pfName").waitFor({ state: "visible" });
    const nameVal = await page.locator("#pfName").inputValue();
    if (!nameVal.includes("ABHA User")) {
      throw new Error(`Expected stub ABHA name on profile form, got: ${nameVal}`);
    }

    await browser.close();
    console.log("UI ABHA smoke test: OK", { phone, masked: masked.trim(), profileName: nameVal });
  } catch (e) {
    console.error("UI ABHA smoke test: FAIL", e?.message || e);
    if (stderr) console.error("--- server stderr (tail) ---\n", stderr.slice(-2000));
    process.exitCode = 1;
  } finally {
    kill();
    await sleep(200);
  }
}

main();
