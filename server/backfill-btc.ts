// ─── BTC PRICE BACKFILL ─────────────────────────────────────────────────────
// Standalone script to backfill BTC price data for the 2024 period
// that overlaps with term spread data. Uses CoinGecko Pro API.
//
// Requires .env file with COINGECKO_API_KEY=your-key
//
// Usage: npx tsx server/backfill-btc.ts

import { readFileSync } from "fs";
import { resolve } from "path";
import { db, upsertBtcPrice } from "./db.js";

// Load .env manually (no dotenv dependency needed)
function loadEnv() {
  try {
    const envPath = resolve(import.meta.dirname ?? ".", "../.env");
    const content = readFileSync(envPath, "utf-8");
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIdx = trimmed.indexOf("=");
      if (eqIdx === -1) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      const val = trimmed.slice(eqIdx + 1).trim();
      if (!process.env[key]) process.env[key] = val;
    }
  } catch {
    // .env not found, that's ok — key might be in environment already
  }
}
loadEnv();

const API_KEY = process.env.COINGECKO_API_KEY;
if (!API_KEY) {
  console.error("ERROR: COINGECKO_API_KEY not found in .env or environment.");
  console.error("Create a .env file in the project root with: COINGECKO_API_KEY=your-key");
  process.exit(1);
}

// CoinGecko Pro API endpoint + key header
const CG_BASE = "https://pro-api.coingecko.com/api/v3";
const CG_HEADERS: Record<string, string> = {
  Accept: "application/json",
  "x-cg-pro-api-key": API_KEY,
};

async function fetchCG<T>(url: string): Promise<T> {
  const res = await fetch(url, { headers: CG_HEADERS });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status} for ${url}: ${body.slice(0, 300)}`);
  }
  return res.json() as Promise<T>;
}

function insertBtcPrices(prices: [number, number][]): number {
  const insertMany = db.transaction((rows: [number, number][]) => {
    for (const [ts, price] of rows) {
      const d = new Date(ts);
      const date = d.toISOString().split("T")[0];
      upsertBtcPrice.run({ date, price, change24h: null });
    }
  });
  insertMany(prices);
  return prices.length;
}

async function main() {
  console.log("\n╔══════════════════════════════════════════╗");
  console.log("║  BTC Price Backfill (CoinGecko Pro API)  ║");
  console.log("╚══════════════════════════════════════════╝\n");

  // Check current state
  const current = db.prepare(
    "SELECT COUNT(*) as c, MIN(date) as earliest, MAX(date) as latest FROM btc_prices"
  ).get() as { c: number; earliest: string | null; latest: string | null };
  console.log(`Current BTC prices: ${current.c} rows, ${current.earliest} → ${current.latest}`);

  const spreadRange = db.prepare(
    "SELECT MIN(date) as earliest, MAX(date) as latest FROM term_spreads"
  ).get() as { earliest: string | null; latest: string | null };
  console.log(`Term spread range:  ${spreadRange.earliest} → ${spreadRange.latest}`);

  // Check overlap before
  if (spreadRange.earliest && spreadRange.latest) {
    const overlap = db.prepare(
      "SELECT COUNT(*) as c FROM term_spreads ts INNER JOIN btc_prices bp ON ts.date = bp.date"
    ).get() as { c: number };
    console.log(`Current overlap:    ${overlap.c} of 206 term spreads have BTC price data\n`);
  }

  // Backfill in ~90-day chunks from 2024-01-01 to 2025-04-01
  // CoinGecko Pro /market_chart/range supports long ranges, but we chunk for reliability
  const backfillRanges = [
    { from: "2024-01-01", to: "2024-04-01" },
    { from: "2024-04-01", to: "2024-07-01" },
    { from: "2024-07-01", to: "2024-10-01" },
    { from: "2024-10-01", to: "2025-01-01" },
    { from: "2025-01-01", to: "2025-04-01" },
  ];

  let totalInserted = 0;

  for (const range of backfillRanges) {
    // Check if we already have data for this range
    const existing = db.prepare(
      "SELECT COUNT(*) as c FROM btc_prices WHERE date >= ? AND date <= ?"
    ).get(range.from, range.to) as { c: number };

    if (existing.c > 85) {
      console.log(`Skipping ${range.from} → ${range.to} (already have ${existing.c} rows)`);
      continue;
    }

    const fromTs = Math.floor(new Date(range.from).getTime() / 1000);
    const toTs = Math.floor(new Date(range.to).getTime() / 1000);

    console.log(`Fetching ${range.from} → ${range.to}...`);
    try {
      const resp = await fetchCG<{ prices: [number, number][] }>(
        `${CG_BASE}/coins/bitcoin/market_chart/range?vs_currency=usd&from=${fromTs}&to=${toTs}`
      );
      const prices = resp.prices || [];
      const count = insertBtcPrices(prices);
      totalInserted += count;
      console.log(`  Inserted ${count} prices.`);
    } catch (err) {
      console.error(`  Error: ${err instanceof Error ? err.message : err}`);
    }

    // Rate limit: 500ms between requests
    await new Promise((r) => setTimeout(r, 500));
  }

  console.log(`\nTotal new prices inserted: ${totalInserted}`);

  // Verify after backfill
  const afterTotal = db.prepare(
    "SELECT COUNT(*) as c, MIN(date) as earliest, MAX(date) as latest FROM btc_prices"
  ).get() as { c: number; earliest: string; latest: string };
  const afterOverlap = db.prepare(
    "SELECT COUNT(*) as c FROM term_spreads ts INNER JOIN btc_prices bp ON ts.date = bp.date"
  ).get() as { c: number };

  console.log(`\nAfter backfill:`);
  console.log(`  BTC prices: ${afterTotal.c} rows, ${afterTotal.earliest} → ${afterTotal.latest}`);
  console.log(`  Overlap with term spreads: ${afterOverlap.c} of 206`);

  db.close();
}

main().catch((err) => {
  console.error("Fatal error:", err);
  db.close();
  process.exit(1);
});
