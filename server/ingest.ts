// ─── DATA INGESTION ─────────────────────────────────────────────────────────
// Fetches data from all sources and stores in local SQLite.
// Run once to seed, then daily via cron.

import { readFileSync } from "fs";
import { resolve } from "path";
import {
  db,
  upsertMarket,
  upsertSnapshot,
  upsertTermSpread,
  upsertBtcPrice,
  upsertEthenaYield,
  upsertDefiLlamaApy,
  insertSyncLog,
} from "./db.js";

// Load .env for API keys
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
    // .env not found — keys might be in environment already
  }
}
loadEnv();

const CG_API_KEY = process.env.COINGECKO_API_KEY;
// Use Pro API if key available, otherwise fall back to free
const CG_BASE = CG_API_KEY
  ? "https://pro-api.coingecko.com/api/v3"
  : "https://api.coingecko.com/api/v3";
const CG_HEADERS: Record<string, string> = { Accept: "application/json" };
if (CG_API_KEY) CG_HEADERS["x-cg-pro-api-key"] = CG_API_KEY;

const PENDLE_BASE = "https://api-v2.pendle.finance/core";
const CHAIN_ID = 1;

// All known sUSDe market addresses on Ethereum mainnet
const SUSDE_MARKETS: { address: string; expiry: string }[] = [
  { address: "0x8f7627bd46b30e296aa3aabe1df9bfac10920b6e", expiry: "2024-04-25" },
  { address: "0x93a82f3873e5b4ff81902663c43286d662f6721c", expiry: "2024-09-26" },
  { address: "0xd1d7d99764f8a52aff007b7831cc02748b2013b5", expiry: "2024-09-26" },
  { address: "0xbbf399db59a845066aafce9ae55e68c505fa97b7", expiry: "2024-10-24" },
  { address: "0xa0ab94debb3cc9a7ea77f3205ba4ab23276fed08", expiry: "2024-12-26" },
  { address: "0xcdd26eb5eb2ce0f203a84553853667ae69ca29ce", expiry: "2025-03-27" },
  { address: "0x8dae8ece668cf80d348873f23d456448e8694883", expiry: "2026-05-07" },
];

// ─── FETCH HELPERS ──────────────────────────────────────────────────────────

async function fetchJSON<T>(url: string): Promise<T> {
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json() as Promise<T>;
}

async function fetchCoinGecko<T>(path: string): Promise<T> {
  const url = `${CG_BASE}${path}`;
  const res = await fetch(url, { headers: CG_HEADERS });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json() as Promise<T>;
}

function daysBetween(a: string, b: string): number {
  return Math.round((new Date(b).getTime() - new Date(a).getTime()) / 86400000);
}

// ─── PENDLE INGESTION ───────────────────────────────────────────────────────

interface PendleHistEntry {
  timestamp: string;
  impliedApy: number;
  underlyingApy: number;
  maxApy: number;
  baseApy: number;
  tvl: number;
}

export async function ingestPendleMarket(market: { address: string; expiry: string }) {
  const { address, expiry } = market;
  console.log(`  Fetching Pendle history for ${address} (exp: ${expiry})...`);

  // Register market
  const isActive = new Date(expiry) > new Date();
  upsertMarket.run({
    address,
    chainId: CHAIN_ID,
    expiry,
    name: "sUSDe",
    isActive: isActive ? 1 : 0,
  });

  try {
    const resp = await fetchJSON<{ results: PendleHistEntry[] }>(
      `${PENDLE_BASE}/v2/${CHAIN_ID}/markets/${address}/historical-data?time_frame=day`
    );
    const entries = resp.results || [];

    if (entries.length === 0) {
      console.log(`    No historical data found.`);
      return 0;
    }

    const insertMany = db.transaction((rows: PendleHistEntry[]) => {
      for (const e of rows) {
        const date = e.timestamp.split("T")[0];
        upsertSnapshot.run({
          date,
          marketAddr: address,
          expiry,
          impliedApy: e.impliedApy,
          underlyingApy: e.underlyingApy,
          maxApy: e.maxApy,
          baseApy: e.baseApy,
          tvl: e.tvl,
          daysToExpiry: daysBetween(date, expiry),
        });
      }
    });

    insertMany(entries);
    console.log(`    Inserted ${entries.length} snapshots.`);
    return entries.length;
  } catch (err) {
    console.error(`    Error: ${err instanceof Error ? err.message : err}`);
    return 0;
  }
}

export async function ingestAllPendleMarkets() {
  console.log("=== Ingesting Pendle sUSDe markets ===");
  let total = 0;
  for (const market of SUSDE_MARKETS) {
    const count = await ingestPendleMarket(market);
    total += count;
    // Rate limit: wait 200ms between requests
    await new Promise((r) => setTimeout(r, 200));
  }
  insertSyncLog.run({ source: "pendle", records: total, status: "ok", error: null });
  console.log(`  Total Pendle snapshots: ${total}`);
  return total;
}

// ─── TERM SPREAD COMPUTATION ────────────────────────────────────────────────

export function computeTermSpreads() {
  console.log("=== Computing term spreads ===");

  // Get all dates that have ≥2 distinct expiry markets
  const dates = db.prepare(`
    SELECT date, COUNT(DISTINCT expiry) as num_expiries
    FROM daily_snapshots
    GROUP BY date
    HAVING num_expiries >= 2
    ORDER BY date
  `).all() as { date: string; num_expiries: number }[];

  console.log(`  Found ${dates.length} dates with ≥2 maturities.`);

  const computeMany = db.transaction((datesToProcess: { date: string; num_expiries: number }[]) => {
    for (const { date, num_expiries } of datesToProcess) {
      // Get all snapshots for this date, sorted by expiry (nearest first)
      const snapshots = db.prepare(`
        SELECT market_addr, expiry, implied_apy, underlying_apy, days_to_expiry
        FROM daily_snapshots
        WHERE date = ? AND days_to_expiry > 0
        ORDER BY expiry ASC
      `).all(date) as {
        market_addr: string;
        expiry: string;
        implied_apy: number;
        underlying_apy: number;
        days_to_expiry: number;
      }[];

      if (snapshots.length < 2) continue;

      // Get unique expiries, pick front (nearest) and back (furthest)
      const uniqueExpiries = [...new Set(snapshots.map((s) => s.expiry))].sort();
      if (uniqueExpiries.length < 2) continue;

      const frontExpiry = uniqueExpiries[0];
      const backExpiry = uniqueExpiries[uniqueExpiries.length - 1];

      // Pick the snapshot for each (if multiple markets share same expiry, average them)
      const frontSnaps = snapshots.filter((s) => s.expiry === frontExpiry);
      const backSnaps = snapshots.filter((s) => s.expiry === backExpiry);

      const frontImplied = frontSnaps.reduce((sum, s) => sum + s.implied_apy, 0) / frontSnaps.length;
      const backImplied = backSnaps.reduce((sum, s) => sum + s.implied_apy, 0) / backSnaps.length;
      const termSpread = backImplied - frontImplied;
      const underlyingApy = frontSnaps[0].underlying_apy;

      upsertTermSpread.run({
        date,
        frontAddr: frontSnaps[0].market_addr,
        frontExpiry,
        frontImplied,
        backAddr: backSnaps[0].market_addr,
        backExpiry,
        backImplied,
        termSpread,
        underlyingApy,
        numMaturities: uniqueExpiries.length,
      });
    }
  });

  computeMany(dates);
  const count = db.prepare("SELECT COUNT(*) as c FROM term_spreads").get() as { c: number };
  console.log(`  Term spread records: ${count.c}`);
  return count.c;
}

// ─── DEFILLAMA INGESTION ────────────────────────────────────────────────────

export async function ingestDefiLlama() {
  console.log("=== Ingesting DefiLlama sUSDe APY ===");
  const POOL_ID = "66985a81-9c51-46ca-9977-42b4fe7bc6df";
  try {
    const resp = await fetchJSON<{ data: { timestamp: string; apy: number; tvlUsd: number }[] }>(
      `https://yields.llama.fi/chart/${POOL_ID}`
    );
    const entries = resp.data || [];

    const insertMany = db.transaction((rows: typeof entries) => {
      for (const e of rows) {
        upsertDefiLlamaApy.run({
          date: e.timestamp.split("T")[0],
          apy: e.apy,
          tvlUsd: e.tvlUsd,
        });
      }
    });

    insertMany(entries);
    insertSyncLog.run({ source: "defillama", records: entries.length, status: "ok", error: null });
    console.log(`  Inserted ${entries.length} DefiLlama records.`);
    return entries.length;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    insertSyncLog.run({ source: "defillama", records: 0, status: "error", error: msg });
    console.error(`  Error: ${msg}`);
    return 0;
  }
}

// ─── BTC PRICE INGESTION ────────────────────────────────────────────────────

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

export async function ingestBtcPrices() {
  console.log(`=== Ingesting BTC prices (CoinGecko ${CG_API_KEY ? "Pro" : "Free"}) ===`);
  let totalInserted = 0;

  try {
    // 1. Fetch recent 365 days
    console.log("  Fetching recent 365 days...");
    const resp = await fetchCoinGecko<{ prices: [number, number][] }>(
      "/coins/bitcoin/market_chart?vs_currency=usd&days=365"
    );
    const recentPrices = resp.prices || [];
    totalInserted += insertBtcPrices(recentPrices);
    console.log(`    Got ${recentPrices.length} recent prices.`);
  } catch (err) {
    console.error(`  Error fetching recent prices: ${err instanceof Error ? err.message : err}`);
  }

  // 2. Backfill historical data to cover term spread period (2024-01-01 onwards)
  //    With Pro key: /market_chart/range is available and supports long ranges.
  //    Without Pro key: this will fail gracefully and skip.
  const backfillRanges = [
    { from: "2024-01-01", to: "2024-04-01" },
    { from: "2024-04-01", to: "2024-07-01" },
    { from: "2024-07-01", to: "2024-10-01" },
    { from: "2024-10-01", to: "2025-01-01" },
    { from: "2025-01-01", to: "2025-04-01" },
  ];

  for (const range of backfillRanges) {
    try {
      // Check if we already have data for this range
      const existing = db.prepare(
        "SELECT COUNT(*) as c FROM btc_prices WHERE date >= ? AND date <= ?"
      ).get(range.from, range.to) as { c: number };

      if (existing.c > 60) {
        console.log(`  Skipping ${range.from} → ${range.to} (already have ${existing.c} rows)`);
        continue;
      }

      const fromTs = Math.floor(new Date(range.from).getTime() / 1000);
      const toTs = Math.floor(new Date(range.to).getTime() / 1000);

      console.log(`  Backfilling ${range.from} → ${range.to}...`);
      const resp = await fetchCoinGecko<{ prices: [number, number][] }>(
        `/coins/bitcoin/market_chart/range?vs_currency=usd&from=${fromTs}&to=${toTs}`
      );
      const prices = resp.prices || [];
      totalInserted += insertBtcPrices(prices);
      console.log(`    Got ${prices.length} prices.`);

      // Rate limit
      await new Promise((r) => setTimeout(r, 500));
    } catch (err) {
      console.error(`  Error backfilling ${range.from}→${range.to}: ${err instanceof Error ? err.message : err}`);
    }
  }

  insertSyncLog.run({ source: "coingecko", records: totalInserted, status: "ok", error: null });
  console.log(`  Total BTC price records inserted: ${totalInserted}`);
  return totalInserted;
}

// ─── ETHENA YIELD INGESTION ─────────────────────────────────────────────────

export async function ingestEthenaYield() {
  console.log("=== Ingesting Ethena yield ===");
  try {
    const resp = await fetchJSON<{
      protocolYield: { value: number };
      stakingYield: { value: number };
      avg30dSusdeYield: { value: number };
      avg90dSusdeYield: { value: number };
      avgSusdeYieldFromInception: { value: number };
    }>("https://ethena.fi/api/yields/protocol-and-staking-yield");

    const today = new Date().toISOString().split("T")[0];
    upsertEthenaYield.run({
      date: today,
      protocolYield: resp.protocolYield.value,
      stakingYield: resp.stakingYield.value,
      avg30d: resp.avg30dSusdeYield.value,
      avg90d: resp.avg90dSusdeYield.value,
      avgInception: resp.avgSusdeYieldFromInception.value,
    });

    insertSyncLog.run({ source: "ethena", records: 1, status: "ok", error: null });
    console.log(`  Saved Ethena yield for ${today}.`);
    return 1;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    insertSyncLog.run({ source: "ethena", records: 0, status: "error", error: msg });
    console.error(`  Error: ${msg}`);
    return 0;
  }
}

// ─── FULL SYNC ──────────────────────────────────────────────────────────────

export async function fullSync() {
  console.log("\n╔══════════════════════════════════════════╗");
  console.log("║    sUSDe Term Structure — Data Sync      ║");
  console.log("╚══════════════════════════════════════════╝\n");

  const t0 = Date.now();

  await ingestAllPendleMarkets();
  await ingestDefiLlama();
  await ingestBtcPrices();
  await ingestEthenaYield();
  computeTermSpreads();

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`\nSync complete in ${elapsed}s.`);

  // Print summary
  const stats = {
    markets: (db.prepare("SELECT COUNT(*) as c FROM markets").get() as { c: number }).c,
    snapshots: (db.prepare("SELECT COUNT(*) as c FROM daily_snapshots").get() as { c: number }).c,
    termSpreads: (db.prepare("SELECT COUNT(*) as c FROM term_spreads").get() as { c: number }).c,
    btcPrices: (db.prepare("SELECT COUNT(*) as c FROM btc_prices").get() as { c: number }).c,
    defiLlama: (db.prepare("SELECT COUNT(*) as c FROM defillama_apy").get() as { c: number }).c,
    ethenaYields: (db.prepare("SELECT COUNT(*) as c FROM ethena_yields").get() as { c: number }).c,
  };
  console.log("\nDatabase totals:", stats);

  return stats;
}

// If run directly, do a full sync
if (process.argv[1]?.endsWith("ingest.ts") || process.argv[1]?.endsWith("ingest.js")) {
  fullSync().then(() => {
    db.close();
    process.exit(0);
  }).catch((err) => {
    console.error("Fatal sync error:", err);
    db.close();
    process.exit(1);
  });
}
