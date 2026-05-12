import "dotenv/config";
import { spawn } from "node:child_process";
import net from "node:net";

function run(cmd, args, { env } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, {
      stdio: "inherit",
      shell: false,
      env: { ...process.env, ...(env || {}) },
    });
    p.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${cmd} ${args.join(" ")} exited with code ${code}`));
    });
    p.on("error", reject);
  });
}

function isPortFree(port) {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once("error", () => resolve(false));
    s.once("listening", () => s.close(() => resolve(true)));
    s.listen(port, "0.0.0.0");
  });
}

async function pickPort(start) {
  let port = start;
  for (let i = 0; i < 20; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    if (await isPortFree(port)) return port;
    port += 1;
  }
  return start;
}

async function main() {
  // Local defaults (can be overridden by .env)
  const defaultDbUrl = "postgresql://paxmed:paxmed@localhost:5432/paxmed";
  const dbUrl = process.env.DATABASE_URL || defaultDbUrl;

  const basePort = Number(process.env.PORT) || 3000;
  const port = await pickPort(basePort);

  console.log("Starting local Postgres (docker compose)...");
  await run("docker", ["compose", "up", "-d"]);

  console.log("Running migrations...");
  await run("node", ["server/db/migrate.js"], { env: { DATABASE_URL: dbUrl } });

  console.log("Seeding demo data...");
  await run("node", ["server/db/seed.js"], { env: { DATABASE_URL: dbUrl } });

  console.log(`Starting PaxMed on port ${port}...`);
  await run(
    "node",
    ["--watch", "server/index.js"],
    { env: { DATABASE_URL: dbUrl, PORT: String(port) } }
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

