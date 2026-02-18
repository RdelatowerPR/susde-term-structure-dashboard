// ─── LOCAL SQLITE DATABASE ──────────────────────────────────────────────────
// Stores daily snapshots of every sUSDe Pendle maturity for term structure analysis.
// Schema designed for term spread computation: back_month_implied − front_month_implied

import Database from "better-sqlite3";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, "..", "data", "susde.db");

// Ensure data directory exists
import fs from "fs";
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);

// Enable WAL mode for better concurrent access
db.pragma("journal_mode = WAL");

// ─── SCHEMA ─────────────────────────────────────────────────────────────────

db.exec(`
  -- All known sUSDe Pendle markets (each maturity = a row)
  CREATE TABLE IF NOT EXISTS markets (
    address       TEXT PRIMARY KEY,
    chain_id      INTEGER NOT NULL DEFAULT 1,
    expiry        TEXT NOT NULL,           -- ISO date of maturity
    name          TEXT NOT NULL DEFAULT 'sUSDe',
    is_active     INTEGER NOT NULL DEFAULT 1,
    first_seen    TEXT NOT NULL DEFAULT (date('now')),
    last_updated  TEXT
  );

  -- Daily yield snapshots per maturity
  CREATE TABLE IF NOT EXISTS daily_snapshots (
    date          TEXT NOT NULL,            -- ISO date (YYYY-MM-DD)
    market_addr   TEXT NOT NULL,
    expiry        TEXT NOT NULL,            -- denormalized for fast queries
    implied_apy   REAL NOT NULL,            -- Pendle implied APY (decimal, e.g. 0.05 = 5%)
    underlying_apy REAL NOT NULL,           -- underlying sUSDe APY
    max_apy       REAL,
    base_apy      REAL,
    tvl           REAL,                     -- USD TVL
    days_to_expiry INTEGER,                 -- computed: expiry - date
    PRIMARY KEY (date, market_addr)
  );

  -- Computed daily term spread (requires ≥2 active maturities, or 0 for single-maturity)
  CREATE TABLE IF NOT EXISTS term_spreads (
    date            TEXT NOT NULL,
    front_addr      TEXT NOT NULL,           -- nearest-expiry market
    front_expiry    TEXT NOT NULL,
    front_implied   REAL NOT NULL,
    back_addr       TEXT NOT NULL,           -- furthest-expiry market (same as front if single)
    back_expiry     TEXT NOT NULL,
    back_implied    REAL NOT NULL,
    term_spread     REAL NOT NULL,           -- back_implied - front_implied (in decimal)
    term_spread_7dma REAL,                   -- 7-day moving average of term_spread (Blockworks methodology)
    underlying_apy  REAL,                    -- underlying on that date
    num_maturities  INTEGER NOT NULL DEFAULT 2,
    PRIMARY KEY (date)
  );

  -- BTC price snapshots (daily)
  CREATE TABLE IF NOT EXISTS btc_prices (
    date    TEXT PRIMARY KEY,
    price   REAL NOT NULL,
    change_24h REAL
  );

  -- Ethena yield snapshots
  CREATE TABLE IF NOT EXISTS ethena_yields (
    date              TEXT PRIMARY KEY,
    protocol_yield    REAL,
    staking_yield     REAL,
    avg_30d           REAL,
    avg_90d           REAL,
    avg_inception     REAL
  );

  -- DefiLlama sUSDe daily APY
  CREATE TABLE IF NOT EXISTS defillama_apy (
    date    TEXT PRIMARY KEY,
    apy     REAL NOT NULL,
    tvl_usd REAL
  );

  -- Metadata / run log
  CREATE TABLE IF NOT EXISTS sync_log (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    run_at      TEXT NOT NULL DEFAULT (datetime('now')),
    source      TEXT NOT NULL,
    records     INTEGER NOT NULL DEFAULT 0,
    status      TEXT NOT NULL DEFAULT 'ok',
    error       TEXT
  );

  -- Indexes for fast queries
  CREATE INDEX IF NOT EXISTS idx_snapshots_date ON daily_snapshots(date);
  CREATE INDEX IF NOT EXISTS idx_snapshots_expiry ON daily_snapshots(expiry);
  CREATE INDEX IF NOT EXISTS idx_snapshots_market ON daily_snapshots(market_addr);
  CREATE INDEX IF NOT EXISTS idx_spreads_date ON term_spreads(date);
`);

// ─── SCHEMA MIGRATIONS ──────────────────────────────────────────────────────
// Add regime classification columns (idempotent — safe to re-run)
for (const col of ["regime TEXT", "btc_outlook TEXT", "prob_positive_90d REAL"]) {
  try {
    db.exec(`ALTER TABLE term_spreads ADD COLUMN ${col}`);
  } catch {
    // Column already exists — no-op
  }
}

// ─── PREPARED STATEMENTS ────────────────────────────────────────────────────

const upsertMarket = db.prepare(`
  INSERT INTO markets (address, chain_id, expiry, name, is_active, last_updated)
  VALUES (@address, @chainId, @expiry, @name, @isActive, datetime('now'))
  ON CONFLICT(address) DO UPDATE SET
    is_active = @isActive,
    last_updated = datetime('now')
`);

const upsertSnapshot = db.prepare(`
  INSERT INTO daily_snapshots (date, market_addr, expiry, implied_apy, underlying_apy, max_apy, base_apy, tvl, days_to_expiry)
  VALUES (@date, @marketAddr, @expiry, @impliedApy, @underlyingApy, @maxApy, @baseApy, @tvl, @daysToExpiry)
  ON CONFLICT(date, market_addr) DO UPDATE SET
    implied_apy = @impliedApy,
    underlying_apy = @underlyingApy,
    max_apy = @maxApy,
    base_apy = @baseApy,
    tvl = @tvl,
    days_to_expiry = @daysToExpiry
`);

const upsertTermSpread = db.prepare(`
  INSERT INTO term_spreads (date, front_addr, front_expiry, front_implied, back_addr, back_expiry, back_implied, term_spread, term_spread_7dma, underlying_apy, num_maturities)
  VALUES (@date, @frontAddr, @frontExpiry, @frontImplied, @backAddr, @backExpiry, @backImplied, @termSpread, NULL, @underlyingApy, @numMaturities)
  ON CONFLICT(date) DO UPDATE SET
    front_addr = @frontAddr,
    front_expiry = @frontExpiry,
    front_implied = @frontImplied,
    back_addr = @backAddr,
    back_expiry = @backExpiry,
    back_implied = @backImplied,
    term_spread = @termSpread,
    underlying_apy = @underlyingApy,
    num_maturities = @numMaturities
`);

const updateTermSpread7dma = db.prepare(`
  UPDATE term_spreads SET term_spread_7dma = @termSpread7dma WHERE date = @date
`);

const updateRegime = db.prepare(`
  UPDATE term_spreads
  SET regime = @regime, btc_outlook = @btcOutlook, prob_positive_90d = @probPositive90d
  WHERE date = @date
`);

const upsertBtcPrice = db.prepare(`
  INSERT INTO btc_prices (date, price, change_24h)
  VALUES (@date, @price, @change24h)
  ON CONFLICT(date) DO UPDATE SET price = @price, change_24h = @change24h
`);

const upsertEthenaYield = db.prepare(`
  INSERT INTO ethena_yields (date, protocol_yield, staking_yield, avg_30d, avg_90d, avg_inception)
  VALUES (@date, @protocolYield, @stakingYield, @avg30d, @avg90d, @avgInception)
  ON CONFLICT(date) DO UPDATE SET
    protocol_yield = @protocolYield, staking_yield = @stakingYield,
    avg_30d = @avg30d, avg_90d = @avg90d, avg_inception = @avgInception
`);

const upsertDefiLlamaApy = db.prepare(`
  INSERT INTO defillama_apy (date, apy, tvl_usd)
  VALUES (@date, @apy, @tvlUsd)
  ON CONFLICT(date) DO UPDATE SET apy = @apy, tvl_usd = @tvlUsd
`);

const insertSyncLog = db.prepare(`
  INSERT INTO sync_log (source, records, status, error) VALUES (@source, @records, @status, @error)
`);

// ─── EXPORTS ────────────────────────────────────────────────────────────────

export {
  db,
  upsertMarket,
  upsertSnapshot,
  upsertTermSpread,
  updateTermSpread7dma,
  updateRegime,
  upsertBtcPrice,
  upsertEthenaYield,
  upsertDefiLlamaApy,
  insertSyncLog,
};

export default db;
