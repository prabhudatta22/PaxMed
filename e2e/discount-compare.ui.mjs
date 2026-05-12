/**
 * Smoke test: API returns discount_pct + UI shows compare columns (Off MRP, Save vs MRP).
 *
 * Run: node e2e/discount-compare.ui.mjs
 * Requires: Postgres (DATABASE_URL), npm run db:migrate + db:seed recommended.
 */
import { spawn, spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.env.MEDLENS_TEST_PORT || 4031);
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

async function patchDemoMetforminMumbai(client) {
  /** Pharmacy A/B style: same MRP 100, 15% vs 17% off (Apollo id=1, MedPlus id=2, medicine Metformin id=1). */
  await client.query(
    `UPDATE pharmacy_prices
     SET mrp_inr = 100, price_inr = 85, discount_pct = 15
     WHERE pharmacy_id = 1 AND medicine_id = 1 AND price_type = 'retail'`,
  );
  await client.query(
    `UPDATE pharmacy_prices
     SET mrp_inr = 100, price_inr = 83, discount_pct = 17
     WHERE pharmacy_id = 2 AND medicine_id = 1 AND price_type = 'retail'`,
  );
}

async function main() {
  let chromium;
  try {
    ({ chromium } = await import("playwright"));
  } catch {
    console.error("Install Playwright: npm i -D playwright && npx playwright install chromium");
    process.exit(1);
  }

  const mig = spawnSync(process.execPath, ["server/db/migrate.js"], {
    cwd: projectRoot,
    env: { ...process.env, DATABASE_URL },
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (mig.status !== 0) {
    console.error(mig.stderr?.toString() || mig.stdout?.toString());
    throw new Error("db:migrate failed — start Postgres and set DATABASE_URL");
  }
  console.log("DB: migrate applied.");

  let pool = new pg.Pool({ connectionString: DATABASE_URL });
  try {
    const {
      rows: [{ c: priceRows }],
    } = await pool.query(`SELECT COUNT(*)::int AS c FROM pharmacy_prices`);
    await pool.end();
    pool = null;

    if (priceRows === 0) {
      const seed = spawnSync(process.execPath, ["server/db/seed.js"], {
        cwd: projectRoot,
        env: { ...process.env, DATABASE_URL },
        stdio: "inherit",
      });
      if (seed.status !== 0) throw new Error("db:seed failed — check DATABASE_URL");
      console.log("DB: seed applied (was empty).");
    }

    pool = new pg.Pool({ connectionString: DATABASE_URL });
    await patchDemoMetforminMumbai(pool);
    console.log("DB: patched Mumbai Metformin rows (pharmacy 1 & 2) → MRP 100, 15% / 17% off.");
  } finally {
    if (pool) await pool.end();
  }

  const child = spawn("node", ["server/index.js"], {
    cwd: projectRoot,
    env: { ...process.env, PORT: String(PORT), DATABASE_URL, NODE_ENV: "development" },
    stdio: ["ignore", "pipe", "pipe"],
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

    /* ----- API: compare/search ----- */
    const apiRes = await fetch(`${BASE}/api/compare/search?q=metformin&city=mumbai`);
    const apiJson = await apiRes.json();
    if (!apiRes.ok) throw new Error(`compare/search HTTP ${apiRes.status}: ${JSON.stringify(apiJson)}`);

    const offers = apiJson.offers || [];
    const apollo = offers.find((o) => Number(o.pharmacy_id) === 1);
    const medplus = offers.find((o) => Number(o.pharmacy_id) === 2);
    if (!apollo || !medplus) {
      console.error("Offers sample:", offers.slice(0, 5));
      throw new Error("Expected pharmacy_id 1 and 2 in Metformin Mumbai results");
    }
    if (Number(apollo.discount_pct) !== 15) throw new Error(`Apollo discount_pct want 15 got ${apollo.discount_pct}`);
    if (Number(medplus.discount_pct) !== 17) throw new Error(`MedPlus discount_pct want 17 got ${medplus.discount_pct}`);
    if (Number(apollo.price_inr) !== 85 || Number(medplus.price_inr) !== 83) throw new Error("Selling prices mismatch");
    console.log("API OK: discount_pct and prices for pharmacy 1 & 2.");

    /* ----- API: labs/search (field present) ----- */
    const labRes = await fetch(`${BASE}/api/labs/search?q=blood&city=mumbai`);
    const labJson = await labRes.json();
    if (!labRes.ok) throw new Error(`labs/search HTTP ${labRes.status}`);
    const labItems = labJson.items || [];
    if (labItems.length && !Object.prototype.hasOwnProperty.call(labItems[0], "discount_pct")) {
      throw new Error("labs items missing discount_pct key");
    }
    console.log("API OK: labs/search returns discount_pct key.");

    /* ----- UI ----- */
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
    const page = await context.newPage();

    await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await page.locator("#city").selectOption("mumbai");
    await page.locator("#q").fill("Metformin");
    await page.locator("#searchBtn").click();

    await page.locator("#table-wrap:not(.hidden)").waitFor({ state: "visible", timeout: 20_000 });
    await page.locator("#offers tr").first().waitFor({ state: "visible", timeout: 15_000 });

    const thead = await page.locator(".compare-panel thead").innerText();
    if (!/Off MRP/i.test(thead)) throw new Error(`Table header missing Off MRP: ${thead}`);
    if (!/Save vs MRP/i.test(thead)) throw new Error(`Table header missing Save vs MRP: ${thead}`);

    const bodyText = await page.locator("#offers").innerText();
    if (!/15%/i.test(bodyText) || !/17%/i.test(bodyText)) {
      throw new Error(`Expected 15% and 17% in local table body: ${bodyText.slice(0, 800)}`);
    }
    if (!/₹15/i.test(bodyText) || !/₹17/i.test(bodyText)) {
      throw new Error(`Expected rupee saves vs MRP (₹15 / ₹17): ${bodyText.slice(0, 800)}`);
    }

    await browser.close();
    console.log("UI OK: Nearby pharmacies table shows Off MRP, Save vs MRP, 15%/17% and ₹ saves.");

    console.log("\nDiscount compare smoke test: PASSED");
  } catch (e) {
    console.error("Discount compare smoke test: FAILED", e?.message || e);
    process.exitCode = 1;
  } finally {
    kill();
    await sleep(200);
  }
}

main();
