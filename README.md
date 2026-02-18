# sUSDe Term Structure Dashboard

A full-stack dashboard for monitoring the **sUSDe yield term structure** on Pendle V2 and deriving BTC market regime signals, based on the methodology from the Blockworks Research report *"Forecasting Market Regimes with the sUSDe Term Structure"* by Luke Leasure.

**Live:** [susde.raulantonio.xyz](https://susde.raulantonio.xyz)

## What This Does

Ethena's sUSDe token captures yield from a delta-neutral basis trade (long spot BTC/ETH + short perpetual futures). Pendle V2 splits sUSDe into Principal Tokens (PT) and Yield Tokens (YT) at various maturities, creating a forward yield curve. The **term spread** (back-month implied yield minus front-month implied yield) acts as a leading indicator for BTC price regimes:

- **Contango** (spread > 0) — the market expects funding rates to persist or rise. Historically the strongest bullish BTC signal: ~11% of observations, but preceded 80%+ positive 90-day return skew.
- **Flat** (spread near 0) — no directional conviction. Negligible forward signal.
- **Backwardation** (spread < 0) — the market expects funding rate decline. Steep backwardation (< -7.5%) preceded exclusively negative forward BTC returns.

This dashboard collects daily snapshots from every sUSDe Pendle market across Ethereum and Plasma chains, automatically discovers new markets, computes the term spread where overlapping maturities exist, and presents the analysis across six tabs.

## Architecture

```
+-------------------------------------------------+
|                React Frontend                    |
|         (Vite dev server - port 5173)            |
|         (Production: served by Express)          |
|                                                  |
|  Dashboard.tsx  <-  api.ts  <-  /api/* proxy     |
+------------------------+------------------------+
                         | HTTP (proxied in dev)
+------------------------v------------------------+
|              Express API Server                  |
|              (port 3001)                         |
|                                                  |
|  Routes: /api/term-structure                     |
|          /api/term-spreads/with-btc              |
|          /api/markets, /api/snapshots            |
|          /api/btc-prices, /api/defillama         |
|          /api/ethena, /api/current               |
|          /api/btc-current, /api/stats            |
|          POST /api/sync                          |
|                                                  |
|  Cron: daily sync at 06:00 UTC                   |
|  Auto-discovery: new Pendle markets              |
+------------------------+------------------------+
                         | SQLite
+------------------------v------------------------+
|              Local SQLite Database                |
|              (data/susde.db)                      |
|                                                  |
|  Tables: markets, daily_snapshots,               |
|          term_spreads, btc_prices,               |
|          ethena_yields, defillama_apy,            |
|          sync_log                                |
+-------------------------------------------------+
```

In development, the Vite dev server proxies all `/api/*` requests to the Express server. In production, Express serves the built frontend directly from `dist/`.

## Quick Start

### Prerequisites

- **Node.js** v18+ (uses native `fetch`)
- **npm**
- **CoinGecko API key** (optional but recommended — set `COINGECKO_API_KEY` in `.env` for extended BTC price history)

### Install and Run (Development)

```bash
# 1. Clone the repo
git clone https://github.com/RdelatowerPR/susde-term-structure-dashboard.git
cd susde-term-structure-dashboard

# 2. Install dependencies
npm install

# 3. (Optional) Configure CoinGecko API key for extended BTC history
echo "COINGECKO_API_KEY=your-key-here" > .env

# 4. Seed the database (first run - fetches all historical data)
npm run seed

# 5. Start both the API server and React frontend
npm start
```

The dashboard will be available at **http://localhost:5173**.

### Production Deployment

```bash
# Build the frontend
npm run build

# Start production server (serves API + frontend on port 3001)
npm run prod
```

### Available Scripts

| Script | Command | Description |
|--------|---------|-------------|
| `npm start` | `concurrently "npm run server" "npm run dev"` | Start both the Express API server and Vite dev server |
| `npm run server` | `tsx server/index.ts` | Start only the Express API server (port 3001) |
| `npm run dev` | `vite` | Start only the Vite frontend dev server (port 5173) |
| `npm run seed` | `tsx server/ingest.ts` | Run a full data sync (seed or refresh the database) |
| `npm run build` | `tsc -b && vite build` | TypeScript check + production build |
| `npm run prod` | `NODE_ENV=production tsx server/index.ts` | Production server (serves built frontend + API) |

## Deployment (Raspberry Pi)

The dashboard is hosted on a Raspberry Pi behind a Cloudflare Tunnel.

### systemd Services

Two systemd services keep everything running:

| Service | Purpose |
|---------|---------|
| `susde-dashboard.service` | Runs the Node.js production server (`node --import tsx server/index.ts`) |
| `cloudflared-susde.service` | Runs the Cloudflare Tunnel connecting to `susde.raulantonio.xyz` |

Both services are configured with:
- `Restart=always` — auto-restart on crash
- `systemctl enable` — auto-start on boot

### Cloudflare Tunnel Config

The tunnel uses `protocol: http2` (QUIC fails on Pi due to small UDP buffer size). Config lives at `~/.cloudflared/susde-config.yml`:

```yaml
tunnel: <tunnel-uuid>
credentials-file: /home/raulantonio/.cloudflared/<tunnel-uuid>.json
protocol: http2

ingress:
  - hostname: susde.raulantonio.xyz
    service: http://localhost:3001
  - service: http_status:404
```

### Updating the Dashboard

```bash
ssh pi
cd ~/susde-term-structure-dashboard
git pull
npm run build
sudo systemctl restart susde-dashboard
```

## The Database

The local SQLite database (`data/susde.db`) is the backbone of the dashboard. It is **not checked into git** — you generate it locally by running `npm run seed`.

### Why a Local Database?

The Blockworks methodology requires historical term spread data computed from overlapping maturities. This data doesn't exist as a single API endpoint anywhere. The database:

1. **Stores daily snapshots** of implied yield, underlying yield, and TVL for every sUSDe Pendle market (15 known markets across Ethereum and Plasma chains, plus any auto-discovered)
2. **Computes term spreads** on dates where 2+ distinct expiry maturities were active simultaneously (the front-month and back-month implied yields are needed to calculate the spread)
3. **Joins with BTC prices** and DefiLlama APY data so the dashboard can analyze the correlation between term spread and forward BTC returns
4. **Auto-updates daily** via a cron job at 06:00 UTC — the server fetches new data, discovers new markets, and recomputes spreads automatically

### Schema

| Table | Purpose | Typical Row Count |
|-------|---------|-------------------|
| `markets` | All known sUSDe Pendle market addresses and their expiry dates | ~15+ |
| `daily_snapshots` | Per-market per-date yield snapshots (implied APY, underlying APY, TVL) | ~1,700+ |
| `term_spreads` | Computed daily term spread (back implied - front implied) on dates with 2+ maturities | ~690+ |
| `btc_prices` | Daily BTC prices from CoinGecko | ~690+ |
| `defillama_apy` | Historical sUSDe staking APY from DefiLlama | ~728 |
| `ethena_yields` | Latest Ethena protocol/staking yield snapshot | 1+ |
| `sync_log` | Metadata about each ingestion run | varies |

### Auto-Discovery of New Markets

The `discoverNewMarkets()` function runs at the start of every sync cycle. It queries the Pendle API on both **Ethereum (chain 1)** and **Plasma (chain 9745)** for any sUSDe markets not already in the known list. New markets are added to the in-memory list for immediate ingestion — no code changes needed when Pendle lists new maturities.

### The Term Spread Gap — Important Nuance

Term spread requires **2+ active maturities with different expiry dates on the same day**. The 15 known sUSDe markets span from April 2024 through May 2026 across Ethereum and Plasma chains:

- **Ethereum**: 14 markets from 2024-04-25 through 2026-05-07
- **Plasma**: 1 market expiring 2026-04-09 (chain 9745)

When only one maturity exists, the dashboard falls back to an **implied premium** metric (Pendle implied APY minus underlying sUSDe APY) as an approximation. This is shown in the header with the label "Implied Premium" instead of "Term Spread".

As Pendle lists new sUSDe maturities, the auto-discovery system will find and ingest them automatically.

### Refreshing the Database

The database auto-updates daily at 06:00 UTC when the server is running. You can also trigger a manual sync:

```bash
# Via the seed script (runs standalone, then exits)
npm run seed

# Via the API (while the server is running)
curl -X POST http://localhost:3001/api/sync
```

To **completely rebuild** the database from scratch, delete the file and re-seed:

```bash
# Windows
del data\susde.db
npm run seed

# macOS / Linux
rm data/susde.db
npm run seed
```

### CoinGecko API Key

If `COINGECKO_API_KEY` is set in `.env`, the server routes requests to `pro-api.coingecko.com` with the `x-cg-pro-api-key` header, unlocking extended historical BTC price data (beyond the free tier's 365-day limit). Without a key, BTC price history is limited to the most recent year.

## Dashboard Tabs

### Overview
Current term structure curve (multi-maturity if available), regime interpretation (contango/backwardation classification with BTC outlook and probability gauge), and a historical sUSDe APY chart from DefiLlama.

### Term Structure
Detailed multi-maturity yield curve with TVL bars per maturity. Includes a table of each maturity showing expiry, days to expiry, implied APY, underlying APY, and premium. Also shows a table of all tracked markets with their active/expired status.

### Term Spread
The core analysis tab. Historical term spread (back - front) as a color-coded bar chart with the Blockworks report mean (-2.63%) reference line. A dual-axis chart overlaying term spread with BTC price. A histogram of term spread distribution. Summary statistics showing contango/flat/backwardation percentages, mean, and standard deviation.

### BTC Correlation
BTC price vs sUSDe APY time series showing the basis trade profitability cycle. Scatter plot of term spread vs 90-day forward BTC return — the direct visual test of the Blockworks thesis that contango predicts positive forward BTC returns.

### Signal Analysis
Term spread (raw %) overlaid with BTC price on a dual-axis chart. Five horizontal regime bands provide permanent visual context — green zones (contango) at the top, red zones (backwardation) at the bottom — so you can see where the spread sits relative to historical norms. Labeled reference lines at +2%, +0.5%, -0.5%, and -5% mark regime boundaries. Regime breakdown showing the percentage of observations in each regime as visual progress bars. Step-by-step mechanics chain explaining the causal link from Ethena's basis trade to BTC regime signals.

### Decile Analysis
All term spread observations sorted into 10 equal-sized bins. Each decile shows its average spread and average 90-day forward BTC return — replicating the Blockworks report's decile framework. Includes a bar chart of returns by decile and a detailed table with ranges, counts, and averages.

## API Endpoints

All endpoints are served from the Express server on port 3001 (proxied via Vite in dev, served directly in production).

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/markets` | All tracked sUSDe Pendle markets |
| GET | `/api/snapshots?market=&from=&to=` | Daily yield snapshots (filterable) |
| GET | `/api/term-structure?date=` | Multi-maturity curve for a given date (defaults to latest) |
| GET | `/api/term-structure/history` | All snapshots grouped by date and expiry |
| GET | `/api/term-spreads?from=&to=` | Historical term spread time series |
| GET | `/api/term-spreads/with-btc?from=&to=` | Term spread joined with BTC price and DefiLlama APY |
| GET | `/api/btc-prices?from=&to=` | Daily BTC prices |
| GET | `/api/defillama?from=&to=` | DefiLlama sUSDe APY history |
| GET | `/api/ethena` | Latest Ethena yield data |
| GET | `/api/current` | Live Pendle market data (proxied from Pendle API) |
| GET | `/api/btc-current` | Live BTC price (proxied from CoinGecko) |
| GET | `/api/stats` | Database statistics and last sync info |
| POST | `/api/sync` | Trigger a manual full data sync |

## Data Sources

| Source | What | Endpoint |
|--------|------|----------|
| **Pendle V2 API** | Historical implied/underlying APY per market | `api-v2.pendle.finance/core/v2/{chainId}/markets/{addr}/historical-data` |
| **Pendle V2 API** | Live market data (TVL, volume, PT discount) | `api-v2.pendle.finance/core/v2/{chainId}/markets/{addr}/data` |
| **Pendle V2 API** | Market discovery (sUSDe search) | `api-v2.pendle.finance/core/v1/{chainId}/markets?q=sUSDe` |
| **Ethena API** | Protocol yield, staking yield, rolling averages | `ethena.fi/api/yields/protocol-and-staking-yield` |
| **DefiLlama Yields** | Historical sUSDe staking APY | `yields.llama.fi/chart/{pool_id}` |
| **CoinGecko API** | BTC price history and live price | `pro-api.coingecko.com/api/v3/` (with key) or `api.coingecko.com/api/v3/` (free) |

## Project Structure

```
susde-term-structure-dashboard/
  server/
    db.ts            # SQLite schema, prepared statements, database init
    ingest.ts        # Data ingestion, market auto-discovery, term spread computation
    backfill-btc.ts  # Standalone BTC price backfill script
    index.ts         # Express server, API routes, daily cron job, static file serving
    tsconfig.json    # Server-specific TypeScript config
  src/
    components/
      Dashboard.tsx  # Main dashboard component (all 6 tabs, ~2,030 lines)
    services/
      api.ts         # Frontend API client (fetch functions + TypeScript types)
    App.tsx          # Root React component
    main.tsx         # React entry point
  data/
    susde.db         # SQLite database (gitignored, generated via npm run seed)
  dist/              # Production build output (gitignored, generated via npm run build)
  .env               # CoinGecko API key (gitignored)
  vite.config.ts     # Vite config with /api proxy to Express
  package.json
```

## Tech Stack

- **Frontend**: React 19, TypeScript, Recharts 3, Vite 7
- **Backend**: Express 5, better-sqlite3, node-cron, tsx
- **Database**: SQLite (local file, WAL mode for concurrent reads)
- **Hosting**: Raspberry Pi + Cloudflare Tunnel
- **Styling**: Inline styles, Space Grotesk + JetBrains Mono fonts, dark terminal aesthetic

## Methodology Reference

This dashboard implements the analytical framework from:

> **"Forecasting Market Regimes with the sUSDe Term Structure"**
> Luke Leasure, Blockworks Research / 0xResearch

Key findings from the report:
- The sUSDe term spread (back month - front month implied yield) is a stronger predictor of forward BTC returns than the underlying sUSDe APY alone
- Contango (positive spread) was observed in ~11% of readings but preceded positive 90-day return skew 80%+ of the time
- Steep backwardation (spread < -7.5%) was observed in ~8% of readings and preceded exclusively negative forward BTC returns
- The historical mean spread is approximately -2.63% with a standard deviation of ~3.5%
