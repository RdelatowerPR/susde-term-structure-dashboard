// ─── EXPRESS API SERVER ─────────────────────────────────────────────────────
// Serves term structure data from local SQLite to the React dashboard.
// Also runs daily auto-sync via node-cron.

import { readFileSync } from "fs";
import { resolve } from "path";
import express from "express";
import cors from "cors";
import cron from "node-cron";
import { db } from "./db.js";
import { fullSync, ingestAllPendleMarkets, ingestEthenaYield, ingestBtcPrices, computeTermSpreads, compute7DayMA } from "./ingest.js";

// Load .env for API keys
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
} catch { /* .env not required */ }

const CG_API_KEY = process.env.COINGECKO_API_KEY;
const CG_BASE = CG_API_KEY ? "https://pro-api.coingecko.com/api/v3" : "https://api.coingecko.com/api/v3";
const CG_HEADERS: Record<string, string> = { Accept: "application/json" };
if (CG_API_KEY) CG_HEADERS["x-cg-pro-api-key"] = CG_API_KEY;

const app = express();
const PORT = 3001;

app.use(cors());
app.use(express.json());

// ─── API ROUTES ─────────────────────────────────────────────────────────────

// GET /api/markets — all known sUSDe markets
app.get("/api/markets", (_req, res) => {
  const markets = db.prepare(`
    SELECT address, chain_id, expiry, name, is_active, first_seen, last_updated
    FROM markets ORDER BY expiry ASC
  `).all();
  res.json(markets);
});

// GET /api/snapshots — daily snapshots (optionally filtered by market or date range)
app.get("/api/snapshots", (req, res) => {
  const { market, from, to } = req.query;
  let sql = "SELECT * FROM daily_snapshots WHERE 1=1";
  const params: any[] = [];
  if (market) { sql += " AND market_addr = ?"; params.push(market); }
  if (from) { sql += " AND date >= ?"; params.push(from); }
  if (to) { sql += " AND date <= ?"; params.push(to); }
  sql += " ORDER BY date ASC, expiry ASC";
  res.json(db.prepare(sql).all(...params));
});

// GET /api/term-structure — the actual multi-maturity curve for a given date
app.get("/api/term-structure", (req, res) => {
  const date = (req.query.date as string) || new Date().toISOString().split("T")[0];

  // Find the closest date with data (on or before requested date)
  const closestDate = db.prepare(`
    SELECT date FROM daily_snapshots WHERE date <= ? ORDER BY date DESC LIMIT 1
  `).get(date) as { date: string } | undefined;

  if (!closestDate) {
    return res.json({ date, maturities: [], termSpread: null });
  }

  // Get all snapshots for that date, one per unique expiry
  const maturities = db.prepare(`
    SELECT
      expiry,
      market_addr,
      AVG(implied_apy) as implied_apy,
      AVG(underlying_apy) as underlying_apy,
      days_to_expiry,
      tvl
    FROM daily_snapshots
    WHERE date = ?
    GROUP BY expiry
    ORDER BY expiry ASC
  `).all(closestDate.date) as {
    expiry: string;
    market_addr: string;
    implied_apy: number;
    underlying_apy: number;
    days_to_expiry: number;
    tvl: number;
  }[];

  // Get term spread if available
  const spread = db.prepare(`
    SELECT * FROM term_spreads WHERE date = ?
  `).get(closestDate.date);

  res.json({
    date: closestDate.date,
    maturities,
    termSpread: spread || null,
  });
});

// GET /api/term-structure/history — term structure curve at multiple dates
app.get("/api/term-structure/history", (_req, res) => {
  // Get all dates with their maturities
  const rows = db.prepare(`
    SELECT
      date,
      expiry,
      AVG(implied_apy) as implied_apy,
      AVG(underlying_apy) as underlying_apy,
      days_to_expiry
    FROM daily_snapshots
    GROUP BY date, expiry
    ORDER BY date ASC, expiry ASC
  `).all();
  res.json(rows);
});

// GET /api/term-spreads — historical term spread time series
app.get("/api/term-spreads", (req, res) => {
  const { from, to } = req.query;
  let sql = "SELECT * FROM term_spreads WHERE 1=1";
  const params: any[] = [];
  if (from) { sql += " AND date >= ?"; params.push(from); }
  if (to) { sql += " AND date <= ?"; params.push(to); }
  sql += " ORDER BY date ASC";
  res.json(db.prepare(sql).all(...params));
});

// GET /api/term-spreads/with-btc — term spread + BTC price joined
app.get("/api/term-spreads/with-btc", (req, res) => {
  const { from, to } = req.query;
  let sql = `
    SELECT
      ts.date,
      ts.term_spread,
      ts.term_spread_7dma,
      ts.front_implied,
      ts.back_implied,
      ts.front_expiry,
      ts.back_expiry,
      ts.underlying_apy,
      ts.num_maturities,
      bp.price as btc_price,
      da.apy as defillama_apy
    FROM term_spreads ts
    LEFT JOIN btc_prices bp ON ts.date = bp.date
    LEFT JOIN defillama_apy da ON ts.date = da.date
    WHERE 1=1
  `;
  const params: any[] = [];
  if (from) { sql += " AND ts.date >= ?"; params.push(from); }
  if (to) { sql += " AND ts.date <= ?"; params.push(to); }
  sql += " ORDER BY ts.date ASC";
  res.json(db.prepare(sql).all(...params));
});

// GET /api/btc-prices — BTC price history
app.get("/api/btc-prices", (req, res) => {
  const { from, to } = req.query;
  let sql = "SELECT * FROM btc_prices WHERE 1=1";
  const params: any[] = [];
  if (from) { sql += " AND date >= ?"; params.push(from); }
  if (to) { sql += " AND date <= ?"; params.push(to); }
  sql += " ORDER BY date ASC";
  res.json(db.prepare(sql).all(...params));
});

// GET /api/defillama — DefiLlama sUSDe history
app.get("/api/defillama", (req, res) => {
  const { from, to } = req.query;
  let sql = "SELECT * FROM defillama_apy WHERE 1=1";
  const params: any[] = [];
  if (from) { sql += " AND date >= ?"; params.push(from); }
  if (to) { sql += " AND date <= ?"; params.push(to); }
  sql += " ORDER BY date ASC";
  res.json(db.prepare(sql).all(...params));
});

// GET /api/ethena — latest Ethena yield
app.get("/api/ethena", (_req, res) => {
  const latest = db.prepare("SELECT * FROM ethena_yields ORDER BY date DESC LIMIT 1").get();
  res.json(latest || null);
});

// GET /api/current — current live Pendle market data (proxied to avoid CORS)
app.get("/api/current", async (_req, res) => {
  try {
    const r = await fetch(
      "https://api-v2.pendle.finance/core/v2/1/markets/0x8dae8ece668cf80d348873f23d456448e8694883/data"
    );
    const data = await r.json();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// GET /api/btc-current — current BTC price
app.get("/api/btc-current", async (_req, res) => {
  try {
    const r = await fetch(
      `${CG_BASE}/simple/price?ids=bitcoin&vs_currencies=usd&include_24hr_change=true`,
      { headers: CG_HEADERS }
    );
    const data = await r.json();
    res.json((data as any).bitcoin);
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// GET /api/stats — database statistics
app.get("/api/stats", (_req, res) => {
  const stats = {
    markets: (db.prepare("SELECT COUNT(*) as c FROM markets").get() as any).c,
    snapshots: (db.prepare("SELECT COUNT(*) as c FROM daily_snapshots").get() as any).c,
    termSpreads: (db.prepare("SELECT COUNT(*) as c FROM term_spreads").get() as any).c,
    btcPrices: (db.prepare("SELECT COUNT(*) as c FROM btc_prices").get() as any).c,
    defiLlama: (db.prepare("SELECT COUNT(*) as c FROM defillama_apy").get() as any).c,
    dateRange: db.prepare(`
      SELECT MIN(date) as earliest, MAX(date) as latest FROM daily_snapshots
    `).get(),
    spreadRange: db.prepare(`
      SELECT MIN(date) as earliest, MAX(date) as latest, MIN(term_spread) as min_spread, MAX(term_spread) as max_spread, AVG(term_spread) as avg_spread
      FROM term_spreads
    `).get(),
    lastSync: db.prepare("SELECT * FROM sync_log ORDER BY id DESC LIMIT 5").all(),
  };
  res.json(stats);
});

// POST /api/sync — trigger a manual sync
app.post("/api/sync", async (_req, res) => {
  try {
    const stats = await fullSync();
    res.json({ status: "ok", stats });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// ─── DAILY CRON ─────────────────────────────────────────────────────────────
// Runs every day at 06:00 UTC (after funding rate settlements)

cron.schedule("0 6 * * *", async () => {
  console.log("\n[CRON] Daily sync triggered at", new Date().toISOString());
  try {
    await fullSync();
    console.log("[CRON] Daily sync completed.");
  } catch (err) {
    console.error("[CRON] Daily sync failed:", err);
  }
});

// ─── START ──────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`\nsUSDe API server running on http://localhost:${PORT}`);
  console.log(`Dashboard should connect to this server for data.\n`);

  // Check if database has data
  const count = (db.prepare("SELECT COUNT(*) as c FROM daily_snapshots").get() as any).c;
  if (count === 0) {
    console.log("Database is empty. Running initial sync...\n");
    fullSync().catch((err) => console.error("Initial sync failed:", err));
  } else {
    console.log(`Database has ${count} snapshots. Ready to serve.`);
    console.log("Daily auto-sync scheduled at 06:00 UTC.\n");
  }
});
