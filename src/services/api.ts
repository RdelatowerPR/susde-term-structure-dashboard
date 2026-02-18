// ─── API SERVICE LAYER ──────────────────────────────────────────────────────
// Fetches data from the local Express server (port 3001, proxied via Vite)
// which serves from the local SQLite database.

async function fetchJSON<T>(url: string): Promise<T> {
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText} for ${url}`);
  return res.json();
}

// ─── TYPES ──────────────────────────────────────────────────────────────────

export interface Market {
  address: string;
  chain_id: number;
  expiry: string;
  name: string;
  is_active: number;
  first_seen: string;
  last_updated: string;
}

export interface DailySnapshot {
  date: string;
  market_addr: string;
  expiry: string;
  implied_apy: number;
  underlying_apy: number;
  max_apy: number;
  base_apy: number;
  tvl: number;
  days_to_expiry: number;
}

export interface TermSpread {
  date: string;
  front_addr: string;
  front_expiry: string;
  front_implied: number;
  back_addr: string;
  back_expiry: string;
  back_implied: number;
  term_spread: number;
  term_spread_7dma: number | null;
  underlying_apy: number;
  num_maturities: number;
  regime: string | null;
  btc_outlook: string | null;
  prob_positive_90d: number | null;
}

export interface TermSpreadWithBtc extends TermSpread {
  btc_price: number | null;
  defillama_apy: number | null;
}

export interface TermStructurePoint {
  expiry: string;
  market_addr: string;
  implied_apy: number;
  underlying_apy: number;
  days_to_expiry: number;
  tvl: number;
}

export interface TermStructure {
  date: string;
  maturities: TermStructurePoint[];
  termSpread: TermSpread | null;
}

export interface PendleMarketData {
  timestamp: string;
  liquidity: { usd: number; acc: number };
  totalTvl: { usd: number };
  tradingVolume: { usd: number };
  underlyingInterestApy: number;
  underlyingApy: number;
  impliedApy: number;
  ptDiscount: number;
  [key: string]: unknown;
}

export interface BtcPrice {
  date: string;
  price: number;
  change_24h: number | null;
}

export interface BtcCurrent {
  usd: number;
  usd_24h_change?: number;
}

export interface DefiLlamaEntry {
  date: string;
  apy: number;
  tvl_usd: number;
}

export interface EthenaYield {
  date: string;
  protocol_yield: number;
  staking_yield: number;
  avg_30d: number;
  avg_90d: number;
  avg_inception: number;
}

export interface DbStats {
  markets: number;
  snapshots: number;
  termSpreads: number;
  btcPrices: number;
  defiLlama: number;
  dateRange: { earliest: string; latest: string };
  spreadRange: { earliest: string; latest: string; min_spread: number; max_spread: number; avg_spread: number };
  lastSync: { run_at: string; source: string; records: number; status: string }[];
}

// ─── TERM STRUCTURE ─────────────────────────────────────────────────────────

export async function fetchTermStructure(date?: string): Promise<TermStructure> {
  const url = date ? `/api/term-structure?date=${date}` : "/api/term-structure";
  return fetchJSON<TermStructure>(url);
}

export async function fetchTermStructureHistory(): Promise<DailySnapshot[]> {
  return fetchJSON<DailySnapshot[]>("/api/term-structure/history");
}

// ─── TERM SPREADS ───────────────────────────────────────────────────────────

export async function fetchTermSpreads(): Promise<TermSpread[]> {
  return fetchJSON<TermSpread[]>("/api/term-spreads");
}

export async function fetchTermSpreadsWithBtc(): Promise<TermSpreadWithBtc[]> {
  return fetchJSON<TermSpreadWithBtc[]>("/api/term-spreads/with-btc");
}

// ─── MARKETS ────────────────────────────────────────────────────────────────

export async function fetchMarkets(): Promise<Market[]> {
  return fetchJSON<Market[]>("/api/markets");
}

// ─── CURRENT LIVE DATA ──────────────────────────────────────────────────────

export async function fetchCurrentPendle(): Promise<PendleMarketData> {
  return fetchJSON<PendleMarketData>("/api/current");
}

export async function fetchCurrentBtc(): Promise<BtcCurrent> {
  return fetchJSON<BtcCurrent>("/api/btc-current");
}

// ─── HISTORICAL DATA ────────────────────────────────────────────────────────

export async function fetchBtcPrices(): Promise<BtcPrice[]> {
  return fetchJSON<BtcPrice[]>("/api/btc-prices");
}

export async function fetchDefiLlama(): Promise<DefiLlamaEntry[]> {
  return fetchJSON<DefiLlamaEntry[]>("/api/defillama");
}

export async function fetchEthena(): Promise<EthenaYield | null> {
  return fetchJSON<EthenaYield | null>("/api/ethena");
}

export async function fetchStats(): Promise<DbStats> {
  return fetchJSON<DbStats>("/api/stats");
}

// ─── COMBINED FETCH ─────────────────────────────────────────────────────────

export interface DashboardData {
  termStructure: TermStructure;
  termSpreadsWithBtc: TermSpreadWithBtc[];
  btcPrices: BtcPrice[];
  currentPendle: PendleMarketData | null;
  currentBtc: BtcCurrent | null;
  ethena: EthenaYield | null;
  defiLlama: DefiLlamaEntry[];
  markets: Market[];
  stats: DbStats | null;
  lastUpdated: Date;
}

export async function fetchAllDashboardData(): Promise<DashboardData> {
  const [
    termStructureRes,
    termSpreadsRes,
    btcPricesRes,
    currentPendleRes,
    currentBtcRes,
    ethenaRes,
    defiLlamaRes,
    marketsRes,
    statsRes,
  ] = await Promise.allSettled([
    fetchTermStructure(),
    fetchTermSpreadsWithBtc(),
    fetchBtcPrices(),
    fetchCurrentPendle(),
    fetchCurrentBtc(),
    fetchEthena(),
    fetchDefiLlama(),
    fetchMarkets(),
    fetchStats(),
  ]);

  return {
    termStructure: termStructureRes.status === "fulfilled" ? termStructureRes.value : { date: "", maturities: [], termSpread: null },
    termSpreadsWithBtc: termSpreadsRes.status === "fulfilled" ? termSpreadsRes.value : [],
    btcPrices: btcPricesRes.status === "fulfilled" ? btcPricesRes.value : [],
    currentPendle: currentPendleRes.status === "fulfilled" ? currentPendleRes.value : null,
    currentBtc: currentBtcRes.status === "fulfilled" ? currentBtcRes.value : null,
    ethena: ethenaRes.status === "fulfilled" ? ethenaRes.value : null,
    defiLlama: defiLlamaRes.status === "fulfilled" ? defiLlamaRes.value : [],
    markets: marketsRes.status === "fulfilled" ? marketsRes.value : [],
    stats: statsRes.status === "fulfilled" ? statsRes.value : null,
    lastUpdated: new Date(),
  };
}
