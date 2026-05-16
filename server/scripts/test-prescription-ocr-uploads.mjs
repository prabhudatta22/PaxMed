/**
 * Offline test: OCR + medicine matching on files in uploads/prescriptions/
 *
 * Usage: node server/scripts/test-prescription-ocr-uploads.mjs
 * Requires: DATABASE_URL (see .env), dependencies installed (tesseract.js).
 */
import "dotenv/config";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { pool } from "../db/pool.js";
import { ocrImageBytes } from "../ocr/ocr.js";
import { matchMedicinesFromText } from "../prescription/parse.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../..");
const PRESCRIPTION_DIR = path.join(ROOT, "uploads", "prescriptions");

const IMAGE_EXT = new Set([".webp", ".jpeg", ".jpg", ".png", ".gif"]);

async function main() {
  let entries;
  try {
    entries = await readdir(PRESCRIPTION_DIR);
  } catch (e) {
    console.error("Cannot read uploads/prescriptions:", e?.message || e);
    process.exit(1);
  }

  const files = entries
    .filter((name) => IMAGE_EXT.has(path.extname(name).toLowerCase()))
    .sort();

  if (!files.length) {
    console.log(`No images found in ${PRESCRIPTION_DIR}`);
    process.exit(0);
  }

  for (const name of files) {
    const filePath = path.join(PRESCRIPTION_DIR, name);
    const buf = await readFile(filePath);

    console.log("");
    console.log("=".repeat(72));
    console.log(name, `(${buf.length} bytes)`);
    console.log("-".repeat(72));

    try {
      const started = Date.now();
      const text = await ocrImageBytes(buf);
      const elapsedOcr = Date.now() - started;
      console.log(`OCR OK in ${elapsedOcr} ms — chars: ${text.length}`);

      const mStarted = Date.now();
      const matches = await matchMedicinesFromText(text, { limitItems: 15 });
      const elapsedMatch = Date.now() - mStarted;
      console.log(`Match OK in ${elapsedMatch} ms — hits: ${matches.length}`);

      if (matches.length) {
        for (const m of matches) {
          console.log(
            `  · ${m.display_name} (${m.strength || "—"})  score=${Number(m.score).toFixed(4)}  line="${String(m.match_line).slice(0, 80)}"`,
          );
        }
      }

      console.log("");
      console.log("--- OCR text preview (900 chars max) ---");
      console.log(text.slice(0, 900));
    } catch (e) {
      console.error("FAILED:", e?.message || e);
    }
  }
}

main().finally(() => pool.end().catch(() => {}));
