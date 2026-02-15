import { useState, useEffect, useCallback, useMemo } from "react";
import {
  Line, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, ReferenceLine, Area, AreaChart,
  BarChart, Bar, Cell, ScatterChart, Scatter, ComposedChart,
} from "recharts";
import {
  fetchAllDashboardData,
  type DashboardData,
  type TermSpreadWithBtc,
} from "../services/api";

// ─── CONSTANTS ──────────────────────────────────────────────────────────────
const REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours

// Historical mean from Blockworks report: mean term spread ~ -2.63%
const HISTORICAL_MEAN_SPREAD = -2.63;
const _HISTORICAL_STD_SPREAD = 3.5; // approximate 1σ (kept for reference)

// ─── CURVE SHAPE & REGIME INTERPRETATION ────────────────────────────────────
// Based on the Blockworks Research report: "Forecasting Market Regimes with the sUSDe Term Structure"
//
// With multi-maturity data, the term spread is:
//   term_spread = back_month_implied_apy − front_month_implied_apy
//
// Contango  (spread > 0): back > front → market expects rising/persistent funding → bullish BTC
// Flat      (spread ≈ 0): no strong directional bias
// Backwardation (spread < 0): back < front → market expects declining funding → bearish BTC
//
// When only 1 maturity is available, the spread is 0 per Blockworks methodology
// (no signal can be extracted from a single maturity — regime is NEUTRAL).
// The report uses a 7-day moving average of the term spread for regime classification.

interface CurveInterpretation {
  shape: string;
  description: string;
  shapeColor: string;
  regime: string;
  regimeColor: string;
  spreadValue: number;
  spreadType: "term_spread_7dma" | "term_spread" | "single_maturity";
  probPositive90d: number;
  btcOutlook: string;
  btcOutlookColor: string;
}

function interpretTermSpread(
  spreadPct: number,
  spreadType: "term_spread_7dma" | "term_spread" | "single_maturity",
): CurveInterpretation {
  // Term spread thresholds (in percentage points)
  // Using Blockworks report framework: mean ~ -2.63%, σ ~ 3.5%

  // Single maturity → no signal, force NEUTRAL
  if (spreadType === "single_maturity") {
    return {
      shape: "SINGLE MATURITY",
      shapeColor: "#6e7681",
      description: "Only one sUSDe maturity is currently active on Pendle. Per the Blockworks methodology, a term spread requires two or more simultaneous markets with different expiry dates. The spread is recorded as zero — no directional signal can be extracted.",
      regime: "NO SIGNAL",
      regimeColor: "#6e7681",
      spreadValue: 0,
      spreadType: "single_maturity",
      probPositive90d: 50,
      btcOutlook: "No signal — single maturity cannot produce a term spread",
      btcOutlookColor: "#6e7681",
    };
  }

  const isSmoothed = spreadType === "term_spread_7dma";

  let shape: string, shapeColor: string, description: string;
  if (spreadPct > 2) {
    shape = "STEEP CONTANGO";
    shapeColor = "#00ff88";
    description = "The back-month implied yield is sharply above the front-month. The forward curve slopes steeply upward — strong conviction that funding rates will remain elevated or increase. Historically the most reliable bullish BTC signal: contango (~11% of observations) preceded 80%+ positive 90d return skew.";
  } else if (spreadPct > 0.5) {
    shape = "CONTANGO";
    shapeColor = "#66ffaa";
    description = "The back-month implied yield prices above the front-month — a forward-upsloping curve. The market expects funding rates to persist or rise. Contango has been the strongest bullish indicator for BTC forward returns.";
  } else if (spreadPct > -0.5) {
    shape = "FLAT";
    shapeColor = "#ffd866";
    description = "The term structure is approximately flat — no strong directional conviction on future funding rates. This is a transition zone: the middle of the distribution produces negligible signal for forward BTC returns.";
  } else if (spreadPct > -5) {
    shape = "BACKWARDATION";
    shapeColor = "#ff9944";
    description = "The back-month implied yield is below the front-month — an inverted curve. The market expects funding rates to decline from current levels. This is the most common regime historically, centered around the mean spread.";
  } else {
    shape = "STEEP BACKWARDATION";
    shapeColor = "#ff5544";
    description = "The term structure is deeply inverted. The market expects a substantial decline in funding rates. Steep backwardation (<−7.5% in the report) was observed in ~8% of readings and preceded exclusively negative forward BTC return skew.";
  }

  if (isSmoothed) {
    description += " (Based on 7-day moving average per Blockworks methodology.)";
  }

  let regime: string, regimeColor: string, btcOutlook: string, btcOutlookColor: string;
  if (spreadPct > 2) {
    regime = "STRONGLY BULLISH";
    regimeColor = "#00ff88";
    btcOutlook = "Strong positive skew expected over 90-120d";
    btcOutlookColor = "#00ff88";
  } else if (spreadPct > 0.5) {
    regime = "BULLISH";
    regimeColor = "#66ffaa";
    btcOutlook = "Positive return skew likely over 90d";
    btcOutlookColor = "#66ffaa";
  } else if (spreadPct > -0.5) {
    regime = "NEUTRAL";
    regimeColor = "#ffd866";
    btcOutlook = "Negligible signal — near coin-flip probability";
    btcOutlookColor = "#ffd866";
  } else if (spreadPct > -5) {
    regime = "MILDLY BEARISH";
    regimeColor = "#ff9944";
    btcOutlook = "Slightly negative skew, but within normal range";
    btcOutlookColor = "#ff9944";
  } else {
    regime = "BEARISH";
    regimeColor = "#ff5544";
    btcOutlook = "Negative return skew expected — drawdown risk elevated";
    btcOutlookColor = "#ff5544";
  }

  const probPositive90d = Math.max(5, Math.min(95, 50 + spreadPct * 8));

  return {
    shape, shapeColor, description, regime, regimeColor,
    spreadValue: Math.round(spreadPct * 100) / 100,
    spreadType,
    probPositive90d: Math.round(probPositive90d * 10) / 10,
    btcOutlook, btcOutlookColor,
  };
}

// ─── DECILE ANALYSIS ────────────────────────────────────────────────────────

interface DecileRow {
  decile: number;
  range: string;
  count: number;
  avgSpread: number;
  avgBtcReturn90d: number | null;
  color: string;
}

function computeDeciles(
  spreadsWithBtc: TermSpreadWithBtc[],
  btcPriceMap: Map<string, number>,
): DecileRow[] {
  if (spreadsWithBtc.length < 20) return [];

  const sorted = [...spreadsWithBtc].sort((a, b) => a.term_spread - b.term_spread);
  const n = sorted.length;
  const decileSize = Math.floor(n / 10);
  const rows: DecileRow[] = [];

  // Helper: find BTC price on or near a date (±3 days)
  function findBtcPrice(dateStr: string): number | null {
    const exact = btcPriceMap.get(dateStr);
    if (exact != null) return exact;
    // Try nearby dates (±1, ±2, ±3)
    const d = new Date(dateStr);
    for (let offset = 1; offset <= 3; offset++) {
      for (const dir of [1, -1]) {
        const nd = new Date(d);
        nd.setDate(nd.getDate() + offset * dir);
        const key = nd.toISOString().split("T")[0];
        const price = btcPriceMap.get(key);
        if (price != null) return price;
      }
    }
    return null;
  }

  for (let d = 0; d < 10; d++) {
    const start = d * decileSize;
    const end = d === 9 ? n : (d + 1) * decileSize;
    const slice = sorted.slice(start, end);

    const avgSpread = slice.reduce((s, r) => s + r.term_spread, 0) / slice.length;

    // Compute avg 90d forward BTC return for this decile using the full BTC price map
    let avgReturn: number | null = null;
    const returns: number[] = [];
    for (const row of slice) {
      const currentPrice = row.btc_price ?? findBtcPrice(row.date);
      if (currentPrice == null || currentPrice <= 0) continue;

      const futureDate = new Date(row.date);
      futureDate.setDate(futureDate.getDate() + 90);
      const futureDateStr = futureDate.toISOString().split("T")[0];
      const futurePrice = findBtcPrice(futureDateStr);
      if (futurePrice != null) {
        returns.push(((futurePrice - currentPrice) / currentPrice) * 100);
      }
    }
    if (returns.length > 0) {
      avgReturn = returns.reduce((a, b) => a + b, 0) / returns.length;
    }

    const hue = d * 12; // red→green
    rows.push({
      decile: d + 1,
      range: `${(slice[0].term_spread * 100).toFixed(1)}% to ${(slice[slice.length - 1].term_spread * 100).toFixed(1)}%`,
      count: slice.length,
      avgSpread: avgSpread * 100,
      avgBtcReturn90d: avgReturn,
      color: `hsl(${hue}, 70%, 55%)`,
    });
  }
  return rows;
}

// ─── COMPONENTS ─────────────────────────────────────────────────────────────

const MetricCard = ({
  label, value, sub, color = "#00ff88", large,
}: {
  label: string; value: string; sub?: string; color?: string; large?: boolean;
}) => (
  <div style={{
    background: "linear-gradient(135deg, #0d1117 0%, #161b22 100%)",
    border: "1px solid #21262d",
    borderRadius: 6,
    padding: large ? "16px 20px" : "12px 16px",
    flex: 1,
    minWidth: large ? 200 : 140,
  }}>
    <div style={{
      color: "#8b949e", fontSize: "0.65rem", textTransform: "uppercase",
      letterSpacing: "0.08em", marginBottom: 4,
      fontFamily: "'JetBrains Mono', monospace",
    }}>
      {label}
    </div>
    <div style={{
      color, fontSize: large ? "1.8rem" : "1.3rem", fontWeight: 700,
      fontFamily: "'Space Grotesk', sans-serif", lineHeight: 1.1,
      textShadow: `0 0 20px ${color}30`,
    }}>
      {value}
    </div>
    {sub && (
      <div style={{
        color: "#6e7681", fontSize: "0.6rem", marginTop: 3,
        fontFamily: "'JetBrains Mono', monospace",
      }}>
        {sub}
      </div>
    )}
  </div>
);

const SectionHeader = ({
  icon, title, subtitle,
}: {
  icon: string; title: string; subtitle?: string;
}) => (
  <div style={{ marginBottom: 16 }}>
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <span style={{ fontSize: "1.1rem" }}>{icon}</span>
      <span style={{
        color: "#e6edf3", fontSize: "0.95rem", fontWeight: 600,
        fontFamily: "'Space Grotesk', sans-serif", letterSpacing: "-0.01em",
      }}>
        {title}
      </span>
    </div>
    {subtitle && (
      <div style={{
        color: "#6e7681", fontSize: "0.65rem", marginTop: 3, marginLeft: 28,
        fontFamily: "'JetBrains Mono', monospace",
      }}>
        {subtitle}
      </div>
    )}
  </div>
);

const CustomTooltip = ({
  active, payload, label,
}: {
  active?: boolean;
  payload?: Array<{ color: string; name: string; value: number; unit?: string }>;
  label?: string;
}) => {
  if (!active || !payload?.length) return null;
  return (
    <div style={{
      background: "#161b22ee", border: "1px solid #30363d",
      borderRadius: 6, padding: "10px 14px",
      fontFamily: "'JetBrains Mono', monospace", fontSize: "0.65rem",
    }}>
      <div style={{ color: "#e6edf3", marginBottom: 6, fontWeight: 600 }}>{label}</div>
      {payload.map((p, i) => (
        <div key={i} style={{ color: p.color, marginBottom: 2 }}>
          {p.name}: {typeof p.value === "number" ? p.value.toFixed(2) : p.value}{p.unit || ""}
        </div>
      ))}
    </div>
  );
};

const LoadingSpinner = () => (
  <div style={{
    display: "flex", alignItems: "center", justifyContent: "center",
    height: 300, color: "#6e7681", fontSize: "0.75rem",
    fontFamily: "'JetBrains Mono', monospace",
  }}>
    <div style={{ textAlign: "center" }}>
      <div style={{
        width: 24, height: 24, border: "2px solid #21262d",
        borderTopColor: "#388bfd", borderRadius: "50%",
        animation: "spin 1s linear infinite",
        margin: "0 auto 12px",
      }} />
      Loading live data...
    </div>
  </div>
);

const ErrorBanner = ({ errors }: { errors: string[] }) => {
  if (!errors.length) return null;
  return (
    <div style={{
      background: "#ff554410", border: "1px solid #ff554430",
      borderRadius: 6, padding: "10px 16px", marginBottom: 16,
      fontFamily: "'JetBrains Mono', monospace", fontSize: "0.6rem", color: "#ff9988",
    }}>
      {errors.map((e, i) => <div key={i}>{e}</div>)}
    </div>
  );
};

// ─── MAIN DASHBOARD ─────────────────────────────────────────────────────────

export default function SUSDEDashboard() {
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [errors, setErrors] = useState<string[]>([]);
  const [activeTab, setActiveTab] = useState("overview");
  const [animateIn, setAnimateIn] = useState(false);

  const loadData = useCallback(async () => {
    try {
      const result = await fetchAllDashboardData();
      setData(result);

      const errs: string[] = [];
      if (!result.termStructure.maturities.length) errs.push("No term structure data available");
      if (!result.termSpreadsWithBtc.length) errs.push("No term spread history available");
      if (!result.currentPendle) errs.push("Failed to fetch live Pendle market data");
      if (!result.currentBtc) errs.push("Failed to fetch live BTC price");
      if (!result.defiLlama.length) errs.push("Failed to fetch DefiLlama history");
      setErrors(errs);
    } catch (err) {
      setErrors([`Fatal error: ${err instanceof Error ? err.message : String(err)}`]);
    } finally {
      setLoading(false);
      setTimeout(() => setAnimateIn(true), 100);
    }
  }, []);

  useEffect(() => {
    loadData();
    const interval = setInterval(loadData, REFRESH_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [loadData]);

  // ── Current metrics from live Pendle data ──
  const impliedApy = data?.currentPendle
    ? data.currentPendle.impliedApy * 100
    : null;
  const underlyingApy = data?.currentPendle
    ? data.currentPendle.underlyingInterestApy * 100
    : null;

  // Determine spread value and type for regime classification
  // Priority: 7dma > raw term spread > single maturity (0)
  const latestSpread = data?.termStructure?.termSpread;
  const hasMultiMaturity = latestSpread != null && latestSpread.num_maturities >= 2;
  const has7dma = latestSpread != null && latestSpread.term_spread_7dma != null;

  let spreadValue: number | null = null;
  let spreadType: "term_spread_7dma" | "term_spread" | "single_maturity" = "single_maturity";

  if (hasMultiMaturity && has7dma) {
    spreadValue = latestSpread.term_spread_7dma! * 100;
    spreadType = "term_spread_7dma";
  } else if (hasMultiMaturity) {
    spreadValue = latestSpread.term_spread * 100;
    spreadType = "term_spread";
  } else if (latestSpread != null) {
    // Single maturity — spread is 0 per Blockworks methodology
    spreadValue = 0;
    spreadType = "single_maturity";
  }

  const curve = spreadValue !== null
    ? interpretTermSpread(spreadValue, spreadType)
    : null;

  const tvl = data?.currentPendle ? data.currentPendle.totalTvl.usd : null;
  const volume = data?.currentPendle ? data.currentPendle.tradingVolume.usd : null;
  const ptDiscount = data?.currentPendle ? data.currentPendle.ptDiscount * 100 : null;

  // ── BTC price lookup map (all dates, not just term spread dates) ──
  const btcPriceMap = useMemo(() => {
    const map = new Map<string, number>();
    if (data?.btcPrices) {
      for (const bp of data.btcPrices) {
        map.set(bp.date, bp.price);
      }
    }
    // Also add any BTC prices from the term spread join
    if (data?.termSpreadsWithBtc) {
      for (const r of data.termSpreadsWithBtc) {
        if (r.btc_price != null && !map.has(r.date)) {
          map.set(r.date, r.btc_price);
        }
      }
    }
    return map;
  }, [data?.btcPrices, data?.termSpreadsWithBtc]);

  // ── Computed analytics ──
  const deciles = useMemo(() =>
    data?.termSpreadsWithBtc.length ? computeDeciles(data.termSpreadsWithBtc, btcPriceMap) : [],
    [data?.termSpreadsWithBtc, btcPriceMap]
  );

  // Spread statistics
  const spreadStats = useMemo(() => {
    if (!data?.termSpreadsWithBtc.length) return null;
    const spreads = data.termSpreadsWithBtc.map(r => r.term_spread * 100);
    const mean = spreads.reduce((a, b) => a + b, 0) / spreads.length;
    const std = Math.sqrt(spreads.reduce((a, b) => a + (b - mean) ** 2, 0) / spreads.length);
    const contango = spreads.filter(s => s > 0.5).length;
    const flat = spreads.filter(s => s >= -0.5 && s <= 0.5).length;
    const backwardation = spreads.filter(s => s < -0.5).length;
    return { mean, std, min: Math.min(...spreads), max: Math.max(...spreads), contango, flat, backwardation, total: spreads.length };
  }, [data?.termSpreadsWithBtc]);

  const premiumColor = curve?.shapeColor ?? "#6e7681";

  const tabs = [
    { key: "overview", label: "OVERVIEW" },
    { key: "termstructure", label: "TERM STRUCTURE" },
    { key: "spread", label: "TERM SPREAD" },
    { key: "btc", label: "BTC CORRELATION" },
    { key: "prediction", label: "VOL PREDICTION" },
    { key: "decile", label: "DECILE ANALYSIS" },
  ];

  if (loading && !data) {
    return (
      <div style={{
        background: "#0d1117", color: "#e6edf3", minHeight: "100vh",
        display: "flex", alignItems: "center", justifyContent: "center",
        fontFamily: "'Space Grotesk', sans-serif",
      }}>
        <LoadingSpinner />
      </div>
    );
  }

  return (
    <div style={{
      background: "#0d1117", color: "#e6edf3", minHeight: "100vh",
      fontFamily: "'Space Grotesk', -apple-system, sans-serif",
      overflow: "hidden",
    }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@300;400;500;600;700&family=JetBrains+Mono:wght@300;400;500;600&display=swap');
        * { box-sizing: border-box; margin: 0; padding: 0; }
        ::-webkit-scrollbar { width: 6px; }
        ::-webkit-scrollbar-track { background: #0d1117; }
        ::-webkit-scrollbar-thumb { background: #21262d; border-radius: 3px; }
        @keyframes fadeSlideUp {
          from { opacity: 0; transform: translateY(12px); }
          to { opacity: 1; transform: translateY(0); }
        }
        @keyframes pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.6; }
        }
        @keyframes spin {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }
        .animate-in { animation: fadeSlideUp 0.5s ease-out forwards; }
        .tab-btn {
          transition: all 0.2s ease; cursor: pointer;
          border: none; background: transparent; color: #6e7681;
          padding: 8px 16px; font-size: 0.65rem; letter-spacing: 0.1em;
          font-family: 'JetBrains Mono', monospace; font-weight: 500;
          border-bottom: 2px solid transparent;
        }
        .tab-btn:hover { color: #e6edf3; }
        .tab-btn.active { color: #388bfd; border-bottom-color: #388bfd; }
        .recharts-cartesian-grid-horizontal line,
        .recharts-cartesian-grid-vertical line { stroke: #21262d !important; }
      `}</style>

      {/* Scanline overlay */}
      <div style={{
        position: "fixed", top: 0, left: 0, right: 0, bottom: 0,
        background: "repeating-linear-gradient(0deg, transparent, transparent 2px, #00ff8802 2px, #00ff8802 4px)",
        pointerEvents: "none", zIndex: 1000,
      }} />

      {/* ─── HEADER ─── */}
      <div style={{
        borderBottom: "1px solid #21262d", padding: "16px 24px",
        background: "linear-gradient(180deg, #161b22 0%, #0d1117 100%)",
        position: "relative",
      }}>
        <div style={{
          position: "absolute", top: 0, left: 0, right: 0, height: 1,
          background: "linear-gradient(90deg, transparent, #388bfd40, #00ff8840, transparent)",
        }} />
        <div style={{
          display: "flex", justifyContent: "space-between",
          alignItems: "flex-start", flexWrap: "wrap", gap: 12,
        }}>
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <div style={{
                width: 8, height: 8, borderRadius: "50%",
                background: premiumColor,
                boxShadow: `0 0 8px ${premiumColor}`,
                animation: "pulse 2s ease-in-out infinite",
              }} />
              <span style={{ fontSize: "1.15rem", fontWeight: 700, letterSpacing: "-0.02em" }}>
                sUSDe Term Structure Monitor
              </span>
              <span style={{
                fontSize: "0.55rem", color: "#388bfd", fontFamily: "'JetBrains Mono', monospace",
                padding: "2px 6px", background: "#388bfd15", borderRadius: 3, border: "1px solid #388bfd30",
              }}>
                LIVE
              </span>
              {data?.stats && (
                <span style={{
                  fontSize: "0.5rem", color: "#6e7681", fontFamily: "'JetBrains Mono', monospace",
                  padding: "2px 6px", background: "#21262d", borderRadius: 3,
                }}>
                  {data.stats.snapshots} snapshots · {data.stats.termSpreads} spreads · {data.stats.markets} markets
                </span>
              )}
            </div>
            <div style={{
              color: "#6e7681", fontSize: "0.6rem", marginTop: 4, marginLeft: 18,
              fontFamily: "'JetBrains Mono', monospace",
            }}>
              Pendle V2 · Ethereum Mainnet · Ethena Delta-Neutral Basis · Multi-Maturity
            </div>
            <div style={{
              color: "#484f58", fontSize: "0.55rem", marginTop: 2, marginLeft: 18,
              fontFamily: "'JetBrains Mono', monospace",
            }}>
              Last updated: {data?.lastUpdated.toLocaleTimeString() ?? "—"}
              {" · "}Auto-refresh: daily
              {data?.stats?.dateRange ? ` · Data: ${data.stats.dateRange.earliest} → ${data.stats.dateRange.latest}` : ""}
            </div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            {data?.currentBtc && (
              <div style={{
                display: "flex", alignItems: "center", gap: 6, padding: "6px 12px",
                background: "#161b22", borderRadius: 6, border: "1px solid #21262d",
              }}>
                <span style={{ color: "#ffd866", fontSize: "0.65rem", fontWeight: 600, fontFamily: "'JetBrains Mono', monospace" }}>
                  BTC ${data.currentBtc.usd.toLocaleString()}
                </span>
                {data.currentBtc.usd_24h_change !== undefined && (
                  <span style={{
                    color: data.currentBtc.usd_24h_change >= 0 ? "#00ff88" : "#ff5544",
                    fontSize: "0.55rem", fontFamily: "'JetBrains Mono', monospace",
                  }}>
                    {data.currentBtc.usd_24h_change >= 0 ? "+" : ""}{data.currentBtc.usd_24h_change.toFixed(1)}%
                  </span>
                )}
              </div>
            )}
            {curve && (
              <>
                <div style={{
                  display: "flex", alignItems: "center", gap: 6, padding: "6px 12px",
                  background: "#161b22", borderRadius: 6, border: `1px solid ${curve.shapeColor}30`,
                }}>
                  <div style={{ width: 6, height: 6, borderRadius: "50%", background: curve.shapeColor }} />
                  <span style={{
                    color: curve.shapeColor, fontSize: "0.7rem", fontWeight: 600,
                    fontFamily: "'JetBrains Mono', monospace",
                  }}>
                    {curve.shape}
                  </span>
                </div>
                <div style={{
                  display: "flex", alignItems: "center", gap: 6, padding: "6px 12px",
                  background: "#161b22", borderRadius: 6, border: `1px solid ${curve.regimeColor}30`,
                }}>
                  <span style={{
                    color: curve.regimeColor, fontSize: "0.6rem", fontWeight: 500,
                    fontFamily: "'JetBrains Mono', monospace",
                  }}>
                    BTC: {curve.regime}
                  </span>
                </div>
              </>
            )}
          </div>
        </div>
      </div>

      <div style={{ padding: "20px 24px", maxWidth: 1400, margin: "0 auto" }}>
        <ErrorBanner errors={errors} />

        {/* ─── TOP METRICS ─── */}
        <div
          className={animateIn ? "animate-in" : ""}
          style={{ display: "flex", gap: 12, marginBottom: 20, flexWrap: "wrap", opacity: animateIn ? 1 : 0 }}
        >
          <MetricCard
            label={curve?.spreadType === "single_maturity" ? "Curve Shape" : "Term Spread (7dMA)"}
            value={curve?.shape ?? "—"}
            sub={curve ? `${curve.spreadType === "single_maturity" ? "Single maturity — no signal" : `Spread: ${curve.spreadValue > 0 ? "+" : ""}${curve.spreadValue.toFixed(2)}%`}` : ""}
            color={curve?.shapeColor ?? "#6e7681"}
            large
          />
          <MetricCard
            label="Implied APY (Pendle)"
            value={impliedApy !== null ? `${impliedApy.toFixed(2)}%` : "—"}
            sub={data?.termStructure.maturities.length
              ? `${data.termStructure.maturities.length} maturit${data.termStructure.maturities.length === 1 ? "y" : "ies"} on ${data.termStructure.date}`
              : "May 2026 active"}
            color="#388bfd"
          />
          <MetricCard
            label="Underlying sUSDe APY"
            value={underlyingApy !== null ? `${underlyingApy.toFixed(2)}%` : "—"}
            sub={data?.ethena ? `Ethena staking: ${data.ethena.staking_yield.toFixed(2)}%` : ""}
            color="#ffd866"
          />
          <MetricCard
            label="PT Discount"
            value={ptDiscount !== null ? `${ptDiscount.toFixed(2)}%` : "—"}
            sub="Principal Token discount"
            color="#a371f7"
          />
          <MetricCard
            label="BTC Regime Signal"
            value={curve?.regime ?? "—"}
            sub={curve ? `P(+90d) = ${curve.probPositive90d}%` : ""}
            color={curve?.regimeColor ?? "#6e7681"}
            large
          />
          <MetricCard
            label="Total TVL"
            value={tvl !== null ? `$${(tvl / 1e6).toFixed(1)}M` : "—"}
            sub={volume ? `24h Vol: $${(volume / 1e6).toFixed(1)}M` : ""}
            color="#00ff88"
          />
        </div>

        {/* ─── ETHENA YIELD CARDS ─── */}
        {data?.ethena && (
          <div style={{
            display: "flex", gap: 12, marginBottom: 20, flexWrap: "wrap",
          }}>
            {[
              { label: "Protocol Yield", value: data.ethena.protocol_yield, color: "#388bfd" },
              { label: "Staking Yield", value: data.ethena.staking_yield, color: "#00ff88" },
              { label: "30d Avg sUSDe", value: data.ethena.avg_30d, color: "#ffd866" },
              { label: "90d Avg sUSDe", value: data.ethena.avg_90d, color: "#a371f7" },
              { label: "Since Inception", value: data.ethena.avg_inception, color: "#f778ba" },
            ].map((item) => (
              <div key={item.label} style={{
                background: "#161b22", border: "1px solid #21262d", borderRadius: 6,
                padding: "8px 14px", flex: 1, minWidth: 120,
              }}>
                <div style={{
                  color: "#6e7681", fontSize: "0.55rem", textTransform: "uppercase",
                  letterSpacing: "0.05em", fontFamily: "'JetBrains Mono', monospace",
                }}>
                  {item.label}
                </div>
                <div style={{
                  color: item.color, fontSize: "1rem", fontWeight: 700, marginTop: 2,
                }}>
                  {item.value.toFixed(2)}%
                </div>
              </div>
            ))}
          </div>
        )}

        {/* ─── TABS ─── */}
        <div style={{ borderBottom: "1px solid #21262d", marginBottom: 20, display: "flex", gap: 0, overflowX: "auto" }}>
          {tabs.map((tab) => (
            <button
              key={tab.key}
              className={`tab-btn ${activeTab === tab.key ? "active" : ""}`}
              onClick={() => setActiveTab(tab.key)}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {/* ─── TAB: OVERVIEW ─── */}
        {activeTab === "overview" && (
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 20 }}>
            {/* Current Term Structure Curve */}
            <div style={{
              background: "#161b22", border: "1px solid #21262d",
              borderRadius: 8, padding: 20,
            }}>
              <SectionHeader
                icon="📈"
                title="Current Term Structure Curve"
                subtitle={`Multi-maturity implied yields as of ${data?.termStructure.date ?? "—"}`}
              />
              {data?.termStructure.maturities.length ? (
                <ResponsiveContainer width="100%" height={300}>
                  <ComposedChart
                    data={data.termStructure.maturities.map((m) => ({
                      expiry: m.expiry,
                      daysToExpiry: m.days_to_expiry,
                      label: `${m.expiry.slice(5)} (${m.days_to_expiry}d)`,
                      implied: m.implied_apy * 100,
                      underlying: m.underlying_apy * 100,
                    }))}
                    margin={{ top: 10, right: 20, bottom: 30, left: 0 }}
                  >
                    <CartesianGrid strokeDasharray="3 3" stroke="#21262d" />
                    <XAxis
                      dataKey="label"
                      tick={{ fill: "#6e7681", fontSize: 9, fontFamily: "'JetBrains Mono'" }}
                      axisLine={{ stroke: "#21262d" }}
                      angle={-20}
                      textAnchor="end"
                    />
                    <YAxis
                      tick={{ fill: "#6e7681", fontSize: 10, fontFamily: "'JetBrains Mono'" }}
                      axisLine={{ stroke: "#21262d" }}
                      unit="%"
                    />
                    <Tooltip content={<CustomTooltip />} />
                    <Area type="monotone" dataKey="implied" fill="#388bfd10" stroke="none" />
                    <Line
                      type="monotone" dataKey="implied" stroke="#388bfd"
                      strokeWidth={2.5} dot={{ r: 5, fill: "#388bfd", stroke: "#0d1117", strokeWidth: 2 }}
                      name="Implied APY" unit="%"
                    />
                    <Line
                      type="monotone" dataKey="underlying" stroke="#ffd866"
                      strokeWidth={1.5} dot={{ r: 3, fill: "#ffd866" }}
                      name="Underlying APY" unit="%"
                      strokeDasharray="5 5"
                    />
                  </ComposedChart>
                </ResponsiveContainer>
              ) : (
                <div style={{ color: "#6e7681", fontSize: "0.7rem", textAlign: "center", padding: 40 }}>
                  No multi-maturity data for the latest date.
                  <br />Only 1 active sUSDe market currently exists on Pendle.
                </div>
              )}
            </div>

            {/* Curve Interpretation */}
            <div style={{
              background: "#161b22", border: "1px solid #21262d",
              borderRadius: 8, padding: 20,
            }}>
              <SectionHeader
                icon="🔬"
                title="Regime Interpretation"
                subtitle="Contango / backwardation analysis based on Blockworks methodology"
              />
              <div style={{ fontSize: "0.72rem", lineHeight: 1.7, color: "#c9d1d9" }}>
                {curve && (
                  <div style={{
                    padding: "12px 16px", borderRadius: 6, marginBottom: 12,
                    background: `${curve.shapeColor}08`, border: `1px solid ${curve.shapeColor}20`,
                  }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
                      <div style={{
                        padding: "3px 10px", borderRadius: 4,
                        background: `${curve.shapeColor}18`, border: `1px solid ${curve.shapeColor}40`,
                        color: curve.shapeColor, fontWeight: 700, fontSize: "0.75rem",
                        fontFamily: "'JetBrains Mono', monospace",
                      }}>
                        {curve.shape}
                      </div>
                      <span style={{ color: "#6e7681", fontSize: "0.6rem", fontFamily: "'JetBrains Mono', monospace" }}>
                        {curve.spreadType === "term_spread_7dma" ? "7dMA Spread" : curve.spreadType === "term_spread" ? "Term Spread" : "Single Maturity"}: {curve.spreadValue > 0 ? "+" : ""}{curve.spreadValue.toFixed(2)}%
                      </span>
                    </div>
                    <div style={{ color: "#8b949e", fontSize: "0.65rem", lineHeight: 1.6 }}>
                      {curve.description}
                    </div>
                  </div>
                )}

                {curve && (
                  <div style={{
                    padding: "12px 16px", borderRadius: 6, marginBottom: 12,
                    background: `${curve.regimeColor}08`, border: `1px solid ${curve.regimeColor}20`,
                  }}>
                    <div style={{ color: "#e6edf3", fontWeight: 600, fontSize: "0.7rem", marginBottom: 4 }}>
                      BTC Regime Signal: <span style={{ color: curve.regimeColor }}>{curve.regime}</span>
                    </div>
                    <div style={{ color: curve.btcOutlookColor, fontSize: "0.63rem", fontFamily: "'JetBrains Mono', monospace" }}>
                      {curve.btcOutlook}
                    </div>
                    <div style={{
                      marginTop: 8, display: "flex", alignItems: "center", gap: 8,
                    }}>
                      <div style={{ color: "#6e7681", fontSize: "0.58rem", fontFamily: "'JetBrains Mono', monospace" }}>
                        P(positive 90d return):
                      </div>
                      <div style={{
                        flex: 1, height: 14, background: "#0d1117", borderRadius: 7,
                        overflow: "hidden", border: "1px solid #21262d", position: "relative",
                      }}>
                        <div style={{
                          position: "absolute", top: 0, left: 0, bottom: 0,
                          width: `${curve.probPositive90d}%`,
                          background: `linear-gradient(90deg, #ff5544, #ffd866, #00ff88)`,
                          borderRadius: 7, transition: "width 0.8s ease",
                        }} />
                        <div style={{
                          position: "absolute", top: "50%", left: "50%",
                          transform: "translate(-50%, -50%)",
                          fontSize: "0.55rem", fontWeight: 700, color: "#e6edf3",
                          fontFamily: "'JetBrains Mono', monospace",
                          textShadow: "0 1px 3px rgba(0,0,0,0.8)",
                        }}>
                          {curve.probPositive90d}%
                        </div>
                      </div>
                    </div>
                  </div>
                )}

                {/* Formula reference */}
                <div style={{
                  padding: "10px 14px", background: "#0d1117",
                  borderRadius: 6, border: "1px solid #21262d",
                }}>
                  <div style={{
                    fontFamily: "'JetBrains Mono', monospace", fontSize: "0.6rem", color: "#6e7681",
                  }}>
                    <div>term_spread = back_month_implied − front_month_implied</div>
                    <div style={{ marginTop: 2 }}>regime_signal = 7-day moving average of term_spread</div>
                    <div style={{ marginTop: 4 }}>
                      <span style={{ color: "#00ff88" }}>contango</span> (spread {">"} 0) → bullish BTC
                      {" · "}
                      <span style={{ color: "#ffd866" }}>flat</span> (≈ 0) → neutral
                      {" · "}
                      <span style={{ color: "#ff5544" }}>backwardation</span> ({"<"} 0) → bearish BTC
                    </div>
                    <div style={{ marginTop: 4, color: "#484f58" }}>
                      Methodology: Blockworks Research — 7dMA smoothed term spread · single maturity = 0 (no signal)
                    </div>
                    {spreadStats && (
                      <div style={{ marginTop: 4, color: "#484f58" }}>
                        Historical: mean={spreadStats.mean.toFixed(2)}% · σ={spreadStats.std.toFixed(2)}% · range=[{spreadStats.min.toFixed(1)}%, {spreadStats.max.toFixed(1)}%]
                      </div>
                    )}
                  </div>
                </div>
              </div>
            </div>

            {/* DefiLlama Historical APY */}
            <div style={{
              gridColumn: "1 / -1",
              background: "#161b22", border: "1px solid #21262d",
              borderRadius: 8, padding: 20,
            }}>
              <SectionHeader
                icon="📊"
                title="Historical sUSDe APY (DefiLlama)"
                subtitle="Daily sUSDe staking APY since inception"
              />
              {data?.defiLlama.length ? (
                <ResponsiveContainer width="100%" height={220}>
                  <AreaChart
                    data={data.defiLlama
                      .filter((_, i) => i % Math.max(1, Math.floor(data.defiLlama.length / 400)) === 0)
                      .map((e) => ({
                        date: e.date,
                        dateShort: `${e.date.slice(0, 7)}`,
                        apy: e.apy,
                        tvl: e.tvl_usd / 1e9,
                      }))}
                    margin={{ top: 10, right: 20, bottom: 10, left: 0 }}
                  >
                    <CartesianGrid strokeDasharray="3 3" stroke="#21262d" />
                    <XAxis
                      dataKey="dateShort"
                      tick={{ fill: "#6e7681", fontSize: 10, fontFamily: "'JetBrains Mono'" }}
                      axisLine={{ stroke: "#21262d" }}
                      interval={Math.max(1, Math.floor(data.defiLlama.length / 400 / 8))}
                    />
                    <YAxis
                      tick={{ fill: "#6e7681", fontSize: 10, fontFamily: "'JetBrains Mono'" }}
                      axisLine={{ stroke: "#21262d" }}
                      unit="%"
                    />
                    <Tooltip content={<CustomTooltip />} />
                    <Area
                      type="monotone" dataKey="apy" stroke="#388bfd"
                      fill="#388bfd15" strokeWidth={2} name="sUSDe APY" unit="%"
                    />
                  </AreaChart>
                </ResponsiveContainer>
              ) : (
                <LoadingSpinner />
              )}
            </div>
          </div>
        )}

        {/* ─── TAB: TERM STRUCTURE ─── */}
        {activeTab === "termstructure" && (
          <div style={{ display: "grid", gridTemplateColumns: "1fr", gap: 20 }}>
            {/* Multi-maturity curve */}
            <div style={{
              background: "#161b22", border: "1px solid #21262d",
              borderRadius: 8, padding: 20,
            }}>
              <SectionHeader
                icon="📐"
                title="Multi-Maturity Term Structure"
                subtitle="Implied yield at each sUSDe maturity on Pendle V2 · Upward slope = contango"
              />
              {data?.termStructure.maturities.length ? (
                <ResponsiveContainer width="100%" height={350}>
                  <ComposedChart
                    data={data.termStructure.maturities.map((m) => ({
                      label: `${m.expiry} (${m.days_to_expiry}d)`,
                      expiry: m.expiry,
                      implied: m.implied_apy * 100,
                      underlying: m.underlying_apy * 100,
                      premium: (m.implied_apy - m.underlying_apy) * 100,
                      tvl: m.tvl ? m.tvl / 1e6 : 0,
                    }))}
                    margin={{ top: 10, right: 60, bottom: 40, left: 0 }}
                  >
                    <CartesianGrid strokeDasharray="3 3" stroke="#21262d" />
                    <XAxis
                      dataKey="label"
                      tick={{ fill: "#6e7681", fontSize: 9, fontFamily: "'JetBrains Mono'" }}
                      axisLine={{ stroke: "#21262d" }}
                      angle={-25}
                      textAnchor="end"
                    />
                    <YAxis
                      yAxisId="apy"
                      tick={{ fill: "#6e7681", fontSize: 10, fontFamily: "'JetBrains Mono'" }}
                      axisLine={{ stroke: "#21262d" }}
                      unit="%"
                    />
                    <YAxis
                      yAxisId="tvl"
                      orientation="right"
                      tick={{ fill: "#6e7681", fontSize: 10, fontFamily: "'JetBrains Mono'" }}
                      axisLine={{ stroke: "#21262d" }}
                      tickFormatter={(v: number) => `$${v.toFixed(0)}M`}
                    />
                    <Tooltip content={<CustomTooltip />} />
                    <Area yAxisId="apy" type="monotone" dataKey="implied" fill="#388bfd10" stroke="none" />
                    <Line
                      yAxisId="apy" type="monotone" dataKey="implied" stroke="#388bfd"
                      strokeWidth={2.5} dot={{ r: 6, fill: "#388bfd", stroke: "#0d1117", strokeWidth: 2 }}
                      name="Implied APY" unit="%"
                    />
                    <Line
                      yAxisId="apy" type="monotone" dataKey="underlying" stroke="#ffd866"
                      strokeWidth={1.5} dot={{ r: 4, fill: "#ffd866" }}
                      name="Underlying APY" unit="%"
                      strokeDasharray="5 5"
                    />
                    <Bar yAxisId="tvl" dataKey="tvl" fill="#00ff8830" name="TVL" unit="M" radius={[4, 4, 0, 0]} />
                  </ComposedChart>
                </ResponsiveContainer>
              ) : (
                <div style={{ color: "#6e7681", fontSize: "0.7rem", textAlign: "center", padding: 60 }}>
                  Only 1 active maturity currently exists on Pendle.<br />
                  Historical multi-maturity data is available in the Term Spread tab.
                </div>
              )}

              {/* Maturity table */}
              {data?.termStructure.maturities.length ? (
                <div style={{ marginTop: 16, overflowX: "auto" }}>
                  <table style={{
                    width: "100%", borderCollapse: "collapse",
                    fontFamily: "'JetBrains Mono', monospace", fontSize: "0.6rem",
                  }}>
                    <thead>
                      <tr style={{ borderBottom: "1px solid #21262d" }}>
                        {["Expiry", "Days to Expiry", "Implied APY", "Underlying APY", "Premium", "TVL"].map(h => (
                          <th key={h} style={{ color: "#6e7681", padding: "8px 12px", textAlign: "right", fontWeight: 500 }}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {data.termStructure.maturities.map((m, i) => {
                        const prem = (m.implied_apy - m.underlying_apy) * 100;
                        return (
                          <tr key={i} style={{ borderBottom: "1px solid #161b22" }}>
                            <td style={{ color: "#e6edf3", padding: "6px 12px", textAlign: "right" }}>{m.expiry}</td>
                            <td style={{ color: "#8b949e", padding: "6px 12px", textAlign: "right" }}>{m.days_to_expiry}</td>
                            <td style={{ color: "#388bfd", padding: "6px 12px", textAlign: "right" }}>{(m.implied_apy * 100).toFixed(2)}%</td>
                            <td style={{ color: "#ffd866", padding: "6px 12px", textAlign: "right" }}>{(m.underlying_apy * 100).toFixed(2)}%</td>
                            <td style={{ color: prem > 0 ? "#00ff88" : prem < -0.5 ? "#ff5544" : "#ffd866", padding: "6px 12px", textAlign: "right" }}>
                              {prem > 0 ? "+" : ""}{prem.toFixed(2)}%
                            </td>
                            <td style={{ color: "#8b949e", padding: "6px 12px", textAlign: "right" }}>
                              {m.tvl ? `$${(m.tvl / 1e6).toFixed(1)}M` : "—"}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              ) : null}
            </div>

            {/* All Markets */}
            <div style={{
              background: "#161b22", border: "1px solid #21262d",
              borderRadius: 8, padding: 20,
            }}>
              <SectionHeader
                icon="🏪"
                title="All Known sUSDe Markets"
                subtitle="Active and expired Pendle markets tracked in the local database"
              />
              <div style={{ overflowX: "auto" }}>
                <table style={{
                  width: "100%", borderCollapse: "collapse",
                  fontFamily: "'JetBrains Mono', monospace", fontSize: "0.6rem",
                }}>
                  <thead>
                    <tr style={{ borderBottom: "1px solid #21262d" }}>
                      {["Address", "Expiry", "Status", "First Seen", "Last Updated"].map(h => (
                        <th key={h} style={{ color: "#6e7681", padding: "8px 12px", textAlign: "left", fontWeight: 500 }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {data?.markets.map((m, i) => (
                      <tr key={i} style={{ borderBottom: "1px solid #161b22" }}>
                        <td style={{ color: "#8b949e", padding: "6px 12px" }}>{m.address.slice(0, 10)}...{m.address.slice(-6)}</td>
                        <td style={{ color: "#e6edf3", padding: "6px 12px" }}>{m.expiry}</td>
                        <td style={{ padding: "6px 12px" }}>
                          <span style={{
                            color: m.is_active ? "#00ff88" : "#6e7681",
                            padding: "1px 6px", borderRadius: 3,
                            background: m.is_active ? "#00ff8815" : "#21262d",
                            border: `1px solid ${m.is_active ? "#00ff8830" : "#30363d"}`,
                          }}>
                            {m.is_active ? "ACTIVE" : "EXPIRED"}
                          </span>
                        </td>
                        <td style={{ color: "#6e7681", padding: "6px 12px" }}>{m.first_seen}</td>
                        <td style={{ color: "#6e7681", padding: "6px 12px" }}>{m.last_updated ?? "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        )}

        {/* ─── TAB: TERM SPREAD ─── */}
        {activeTab === "spread" && (
          <div style={{ display: "grid", gridTemplateColumns: "1fr", gap: 20 }}>
            {/* Historical Term Spread */}
            <div style={{
              background: "#161b22", border: "1px solid #21262d",
              borderRadius: 8, padding: 20,
            }}>
              <SectionHeader
                icon="📊"
                title="Historical Term Spread: Contango vs Backwardation"
                subtitle="Bars = daily raw spread · Orange line = 7-day MA (Blockworks methodology) · Above zero = contango · Below = backwardation"
              />
              {data?.termSpreadsWithBtc.length ? (
                <ResponsiveContainer width="100%" height={350}>
                  <ComposedChart
                    data={data.termSpreadsWithBtc.map((r) => ({
                      date: r.date,
                      dateShort: r.date.slice(5),
                      spread: r.term_spread * 100,
                      spread7dma: r.term_spread_7dma != null ? r.term_spread_7dma * 100 : null,
                      underlying: r.underlying_apy ? r.underlying_apy * 100 : null,
                    }))}
                    margin={{ top: 10, right: 20, bottom: 10, left: 0 }}
                  >
                    <CartesianGrid strokeDasharray="3 3" stroke="#21262d" />
                    <XAxis
                      dataKey="dateShort"
                      tick={{ fill: "#6e7681", fontSize: 10, fontFamily: "'JetBrains Mono'" }}
                      axisLine={{ stroke: "#21262d" }}
                      interval={Math.max(1, Math.floor(data.termSpreadsWithBtc.length / 12))}
                    />
                    <YAxis
                      tick={{ fill: "#6e7681", fontSize: 10, fontFamily: "'JetBrains Mono'" }}
                      axisLine={{ stroke: "#21262d" }}
                      unit="%"
                    />
                    <Tooltip content={<CustomTooltip />} />
                    <ReferenceLine y={0} stroke="#6e7681" strokeDasharray="5 5"
                      label={{ value: "Contango ↑ / Backwardation ↓", fill: "#6e7681", fontSize: 9, position: "insideTopRight" }}
                    />
                    <ReferenceLine y={HISTORICAL_MEAN_SPREAD} stroke="#a371f740" strokeDasharray="3 3"
                      label={{ value: `Mean: ${HISTORICAL_MEAN_SPREAD}%`, fill: "#a371f760", fontSize: 8, position: "insideBottomRight" }}
                    />
                    <Bar dataKey="spread" name="Term Spread (raw)" unit="%" radius={[2, 2, 0, 0]}>
                      {data.termSpreadsWithBtc.map((r, i) => {
                        const s = r.term_spread * 100;
                        return (
                          <Cell
                            key={i}
                            fill={s > 0.5 ? "#00ff88" : s > -0.5 ? "#ffd866" : s > -5 ? "#ff9944" : "#ff5544"}
                            fillOpacity={0.5}
                          />
                        );
                      })}
                    </Bar>
                    <Line
                      type="monotone" dataKey="spread7dma"
                      stroke="#ff9944" strokeWidth={2} dot={false}
                      name="7-day MA" unit="%"
                    />
                  </ComposedChart>
                </ResponsiveContainer>
              ) : (
                <LoadingSpinner />
              )}

              {/* Spread statistics */}
              {spreadStats && (
                <div style={{ display: "flex", gap: 12, marginTop: 12 }}>
                  {[
                    { label: "Contango (>+0.5%)", value: `${((spreadStats.contango / spreadStats.total) * 100).toFixed(0)}%`, desc: `${spreadStats.contango} of ${spreadStats.total} days`, color: "#00ff88" },
                    { label: "Flat (±0.5%)", value: `${((spreadStats.flat / spreadStats.total) * 100).toFixed(0)}%`, desc: `${spreadStats.flat} of ${spreadStats.total} days`, color: "#ffd866" },
                    { label: "Backwardation (<-0.5%)", value: `${((spreadStats.backwardation / spreadStats.total) * 100).toFixed(0)}%`, desc: `${spreadStats.backwardation} of ${spreadStats.total} days`, color: "#ff5544" },
                    { label: "Mean Spread", value: `${spreadStats.mean.toFixed(2)}%`, desc: `σ = ${spreadStats.std.toFixed(2)}%`, color: "#a371f7" },
                  ].map((item, i) => (
                    <div key={i} style={{
                      flex: 1, padding: "10px 14px", background: "#0d1117",
                      borderRadius: 6, border: "1px solid #21262d",
                    }}>
                      <div style={{
                        color: "#6e7681", fontSize: "0.55rem", textTransform: "uppercase",
                        letterSpacing: "0.05em", fontFamily: "'JetBrains Mono', monospace",
                      }}>{item.label}</div>
                      <div style={{ color: item.color, fontSize: "1rem", fontWeight: 700, marginTop: 2 }}>{item.value}</div>
                      <div style={{ color: "#484f58", fontSize: "0.55rem", fontFamily: "'JetBrains Mono', monospace" }}>{item.desc}</div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Term Spread + BTC Overlay */}
            <div style={{
              background: "#161b22", border: "1px solid #21262d",
              borderRadius: 8, padding: 20,
            }}>
              <SectionHeader
                icon="🔗"
                title="Term Spread (7dMA) vs BTC Price"
                subtitle="7-day moving average of term spread overlaid with BTC price · Tests the Blockworks thesis: contango → bullish BTC"
              />
              {data?.termSpreadsWithBtc.length ? (
                <ResponsiveContainer width="100%" height={350}>
                  <ComposedChart
                    data={data.termSpreadsWithBtc
                      .filter(r => r.btc_price != null)
                      .map((r) => ({
                        date: r.date,
                        dateShort: r.date.slice(5),
                        spread7dma: r.term_spread_7dma != null ? r.term_spread_7dma * 100 : r.term_spread * 100,
                        btc: r.btc_price! / 1000,
                      }))}
                    margin={{ top: 10, right: 60, bottom: 10, left: 0 }}
                  >
                    <CartesianGrid strokeDasharray="3 3" stroke="#21262d" />
                    <XAxis
                      dataKey="dateShort"
                      tick={{ fill: "#6e7681", fontSize: 10, fontFamily: "'JetBrains Mono'" }}
                      axisLine={{ stroke: "#21262d" }}
                      interval={Math.max(1, Math.floor(data.termSpreadsWithBtc.length / 12))}
                    />
                    <YAxis
                      yAxisId="spread"
                      tick={{ fill: "#6e7681", fontSize: 10, fontFamily: "'JetBrains Mono'" }}
                      axisLine={{ stroke: "#21262d" }}
                      unit="%"
                      label={{ value: "Spread 7dMA %", angle: -90, position: "insideLeft", fill: "#6e7681", fontSize: 10 }}
                    />
                    <YAxis
                      yAxisId="btc"
                      orientation="right"
                      tick={{ fill: "#6e7681", fontSize: 10, fontFamily: "'JetBrains Mono'" }}
                      axisLine={{ stroke: "#21262d" }}
                      tickFormatter={(v: number) => `$${v.toFixed(0)}k`}
                    />
                    <Tooltip content={<CustomTooltip />} />
                    <ReferenceLine yAxisId="spread" y={0} stroke="#6e768150" strokeDasharray="5 5" />
                    <Area
                      yAxisId="spread" type="monotone" dataKey="spread7dma"
                      fill="#388bfd10" stroke="#388bfd" strokeWidth={2}
                      name="Term Spread 7dMA" unit="%"
                    />
                    <Line
                      yAxisId="btc" type="monotone" dataKey="btc"
                      stroke="#ffd866" strokeWidth={1.5} dot={false}
                      name="BTC Price" unit="k"
                    />
                  </ComposedChart>
                </ResponsiveContainer>
              ) : (
                <LoadingSpinner />
              )}
            </div>

            {/* Spread Distribution */}
            <div style={{
              background: "#161b22", border: "1px solid #21262d",
              borderRadius: 8, padding: 20,
            }}>
              <SectionHeader
                icon="📋"
                title="Term Spread Distribution"
                subtitle="Histogram of daily term spread observations"
              />
              {data?.termSpreadsWithBtc.length ? (
                <ResponsiveContainer width="100%" height={250}>
                  <BarChart
                    data={(() => {
                      const spreads = data.termSpreadsWithBtc.map(r => r.term_spread * 100);
                      const buckets: { range: string; count: number; mid: number }[] = [];
                      const step = 2;
                      const minS = Math.floor(Math.min(...spreads) / step) * step;
                      const maxS = Math.ceil(Math.max(...spreads) / step) * step;
                      for (let low = minS; low < maxS; low += step) {
                        const count = spreads.filter(s => s >= low && s < low + step).length;
                        buckets.push({ range: `${low}% to ${low + step}%`, count, mid: low + step / 2 });
                      }
                      return buckets.filter(b => b.count > 0);
                    })()}
                    margin={{ top: 10, right: 20, bottom: 10, left: 0 }}
                  >
                    <CartesianGrid strokeDasharray="3 3" stroke="#21262d" />
                    <XAxis
                      dataKey="range"
                      tick={{ fill: "#6e7681", fontSize: 9, fontFamily: "'JetBrains Mono'" }}
                      axisLine={{ stroke: "#21262d" }}
                    />
                    <YAxis
                      tick={{ fill: "#6e7681", fontSize: 10, fontFamily: "'JetBrains Mono'" }}
                      axisLine={{ stroke: "#21262d" }}
                      label={{ value: "Days", angle: -90, position: "insideLeft", fill: "#6e7681", fontSize: 10 }}
                    />
                    <Tooltip content={<CustomTooltip />} />
                    <Bar dataKey="count" name="Observations" radius={[3, 3, 0, 0]}>
                      {(() => {
                        const spreads = data.termSpreadsWithBtc.map(r => r.term_spread * 100);
                        const step = 2;
                        const minS = Math.floor(Math.min(...spreads) / step) * step;
                        const maxS = Math.ceil(Math.max(...spreads) / step) * step;
                        const mids: number[] = [];
                        for (let low = minS; low < maxS; low += step) {
                          const count = spreads.filter(s => s >= low && s < low + step).length;
                          if (count > 0) mids.push(low + step / 2);
                        }
                        return mids.map((mid, i) => (
                          <Cell
                            key={i}
                            fill={mid > 0.5 ? "#00ff88" : mid > -0.5 ? "#ffd866" : mid > -5 ? "#ff9944" : "#ff5544"}
                            fillOpacity={0.7}
                          />
                        ));
                      })()}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              ) : (
                <LoadingSpinner />
              )}
            </div>
          </div>
        )}

        {/* ─── TAB: BTC CORRELATION ─── */}
        {activeTab === "btc" && (
          <div style={{ display: "grid", gridTemplateColumns: "1fr", gap: 20 }}>
            {/* BTC Price vs DefiLlama sUSDe APY */}
            <div style={{
              background: "#161b22", border: "1px solid #21262d",
              borderRadius: 8, padding: 20,
            }}>
              <SectionHeader
                icon="📈"
                title="BTC Price vs sUSDe APY"
                subtitle="BTC price overlaid with sUSDe yield · Basis trade profitability context"
              />
              {data?.defiLlama.length ? (
                <>
                  <ResponsiveContainer width="100%" height={350}>
                    <ComposedChart
                      data={(() => {
                        // Merge ALL BTC prices and DefiLlama APY by date
                        const merged = new Map<string, { btc?: number; apy?: number }>();
                        // 1. Full BTC price history (covers Apr 2024 → present)
                        for (const bp of data.btcPrices) {
                          const entry = merged.get(bp.date) ?? {};
                          entry.btc = bp.price;
                          merged.set(bp.date, entry);
                        }
                        // 2. Also pick up any BTC from term spread join
                        for (const r of data.termSpreadsWithBtc) {
                          if (r.btc_price != null) {
                            const entry = merged.get(r.date) ?? {};
                            if (!entry.btc) entry.btc = r.btc_price;
                            merged.set(r.date, entry);
                          }
                        }
                        // 3. DefiLlama APY history
                        for (const r of data.defiLlama) {
                          const entry = merged.get(r.date) ?? {};
                          entry.apy = r.apy;
                          merged.set(r.date, entry);
                        }
                        return Array.from(merged.entries())
                          .sort((a, b) => a[0].localeCompare(b[0]))
                          .filter(([, v]) => v.btc || v.apy)
                          .filter((_, i, arr) => i % Math.max(1, Math.floor(arr.length / 300)) === 0)
                          .map(([date, v]) => ({
                            date,
                            dateShort: date.slice(0, 7),
                            btc: v.btc ? v.btc / 1000 : null,
                            apy: v.apy ?? null,
                          }));
                      })()}
                      margin={{ top: 10, right: 60, bottom: 10, left: 0 }}
                    >
                      <CartesianGrid strokeDasharray="3 3" stroke="#21262d" />
                      <XAxis
                        dataKey="dateShort"
                        tick={{ fill: "#6e7681", fontSize: 10, fontFamily: "'JetBrains Mono'" }}
                        axisLine={{ stroke: "#21262d" }}
                        interval={15}
                      />
                      <YAxis
                        yAxisId="btc"
                        tick={{ fill: "#6e7681", fontSize: 10, fontFamily: "'JetBrains Mono'" }}
                        axisLine={{ stroke: "#21262d" }}
                        tickFormatter={(v: number) => `$${v.toFixed(0)}k`}
                      />
                      <YAxis
                        yAxisId="apy"
                        orientation="right"
                        tick={{ fill: "#6e7681", fontSize: 10, fontFamily: "'JetBrains Mono'" }}
                        axisLine={{ stroke: "#21262d" }}
                        unit="%"
                      />
                      <Tooltip content={<CustomTooltip />} />
                      <Line
                        yAxisId="btc" type="monotone" dataKey="btc"
                        stroke="#ffd866" strokeWidth={2} dot={false}
                        name="BTC Price" unit="k"
                      />
                      <Line
                        yAxisId="apy" type="monotone" dataKey="apy"
                        stroke="#388bfd" strokeWidth={1.5} dot={false}
                        name="sUSDe APY" unit="%"
                      />
                    </ComposedChart>
                  </ResponsiveContainer>

                  <div style={{
                    color: "#6e7681", fontSize: "0.6rem",
                    fontFamily: "'JetBrains Mono', monospace", marginTop: 8,
                  }}>
                    sUSDe yield is derived from the basis trade (long spot + short perps).
                    High BTC funding rates → high sUSDe yield.
                    Negative funding → yield compression.
                    The correlation between BTC price action and sUSDe APY reveals leverage cycles.
                  </div>
                </>
              ) : (
                <LoadingSpinner />
              )}
            </div>

            {/* Scatter: Term Spread vs forward BTC returns */}
            <div style={{
              background: "#161b22", border: "1px solid #21262d",
              borderRadius: 8, padding: 20,
            }}>
              <SectionHeader
                icon="🎯"
                title="Term Spread vs Forward BTC Return (90d)"
                subtitle="Each dot = one day · X = term spread, Y = subsequent 90-day BTC return"
              />
              {data?.termSpreadsWithBtc.length ? (
                <ResponsiveContainer width="100%" height={350}>
                  <ScatterChart margin={{ top: 10, right: 20, bottom: 20, left: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#21262d" />
                    <XAxis
                      type="number" dataKey="spread" name="Term Spread"
                      tick={{ fill: "#6e7681", fontSize: 10, fontFamily: "'JetBrains Mono'" }}
                      axisLine={{ stroke: "#21262d" }} unit="%"
                      label={{ value: "Term Spread (%)", position: "insideBottom", offset: -10, fill: "#6e7681", fontSize: 10 }}
                    />
                    <YAxis
                      type="number" dataKey="fwdReturn" name="90d BTC Return"
                      tick={{ fill: "#6e7681", fontSize: 10, fontFamily: "'JetBrains Mono'" }}
                      axisLine={{ stroke: "#21262d" }} unit="%"
                      label={{ value: "90d BTC Return (%)", angle: -90, position: "insideLeft", fill: "#6e7681", fontSize: 10 }}
                    />
                    <Tooltip content={<CustomTooltip />} />
                    <ReferenceLine x={0} stroke="#6e768130" strokeDasharray="3 3" />
                    <ReferenceLine y={0} stroke="#6e768130" strokeDasharray="3 3" />
                    <Scatter
                      data={(() => {
                        // Helper: find BTC price on or near a date (±3 days) from the full map
                        function findPrice(dateStr: string): number | null {
                          const exact = btcPriceMap.get(dateStr);
                          if (exact != null) return exact;
                          const d = new Date(dateStr);
                          for (let off = 1; off <= 3; off++) {
                            for (const dir of [1, -1]) {
                              const nd = new Date(d);
                              nd.setDate(nd.getDate() + off * dir);
                              const p = btcPriceMap.get(nd.toISOString().split("T")[0]);
                              if (p != null) return p;
                            }
                          }
                          return null;
                        }

                        const points: { spread: number; fwdReturn: number }[] = [];
                        const rows = data.termSpreadsWithBtc;
                        for (let i = 0; i < rows.length; i++) {
                          const currentPrice = rows[i].btc_price ?? findPrice(rows[i].date);
                          if (currentPrice == null || currentPrice <= 0) continue;
                          // Find BTC price ~90 days later from the full price map
                          const target = new Date(rows[i].date);
                          target.setDate(target.getDate() + 90);
                          const targetStr = target.toISOString().split("T")[0];
                          const futurePrice = findPrice(targetStr);
                          if (futurePrice != null) {
                            points.push({
                              spread: rows[i].term_spread * 100,
                              fwdReturn: ((futurePrice - currentPrice) / currentPrice) * 100,
                            });
                          }
                        }
                        return points;
                      })()}
                      fill="#388bfd" fillOpacity={0.5} r={4}
                    />
                  </ScatterChart>
                </ResponsiveContainer>
              ) : (
                <LoadingSpinner />
              )}

              <div style={{
                marginTop: 12, padding: "12px 16px", background: "#0d1117",
                borderRadius: 6, border: "1px solid #21262d",
              }}>
                <div style={{ color: "#e6edf3", fontSize: "0.65rem", fontWeight: 600, marginBottom: 6 }}>
                  Key Insight
                </div>
                <div style={{
                  color: "#8b949e", fontSize: "0.6rem", lineHeight: 1.7,
                  fontFamily: "'JetBrains Mono', monospace",
                }}>
                  The Blockworks report found that contango in the sUSDe term structure
                  (positive term spread) preceded positive 90-day BTC returns 80%+ of the time.
                  Steep backwardation (spread {"<"} -7.5%) preceded exclusively negative returns.
                  The scatter above tests this relationship with our local database.
                </div>
              </div>
            </div>
          </div>
        )}

        {/* ─── TAB: VOL PREDICTION ─── */}
        {activeTab === "prediction" && (
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 20 }}>
            {/* Spread vs Volatility */}
            <div style={{
              gridColumn: "1 / -1",
              background: "#161b22", border: "1px solid #21262d",
              borderRadius: 8, padding: 20,
            }}>
              <SectionHeader
                icon="🔮"
                title="Term Spread as Volatility Predictor"
                subtitle="Extreme spread values (contango or steep backwardation) predict heightened forward vol"
              />
              {data?.termSpreadsWithBtc.length ? (
                <ResponsiveContainer width="100%" height={350}>
                  <ComposedChart
                    data={(() => {
                      // Enrich term spread rows with BTC prices from the full map
                      const rows = data.termSpreadsWithBtc.map(r => ({
                        ...r,
                        btc: r.btc_price ?? btcPriceMap.get(r.date) ?? null,
                      })).filter(r => r.btc != null);
                      const result: { date: string; dateShort: string; spread7dma: number; vol30d: number | null }[] = [];
                      for (let i = 0; i < rows.length; i++) {
                        let vol: number | null = null;
                        if (i >= 30) {
                          const returns: number[] = [];
                          for (let j = i - 29; j <= i; j++) {
                            if (rows[j].btc && rows[j - 1]?.btc) {
                              returns.push(Math.log(rows[j].btc! / rows[j - 1].btc!));
                            }
                          }
                          if (returns.length > 5) {
                            const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
                            const variance = returns.reduce((a, b) => a + (b - mean) ** 2, 0) / returns.length;
                            vol = Math.sqrt(variance * 365) * 100; // annualized
                          }
                        }
                        const spread7dma = rows[i].term_spread_7dma != null
                          ? rows[i].term_spread_7dma! * 100
                          : rows[i].term_spread * 100;
                        result.push({
                          date: rows[i].date,
                          dateShort: rows[i].date.slice(5),
                          spread7dma,
                          vol30d: vol,
                        });
                      }
                      return result;
                    })()}
                    margin={{ top: 10, right: 60, bottom: 10, left: 0 }}
                  >
                    <CartesianGrid strokeDasharray="3 3" stroke="#21262d" />
                    <XAxis
                      dataKey="dateShort"
                      tick={{ fill: "#6e7681", fontSize: 10, fontFamily: "'JetBrains Mono'" }}
                      axisLine={{ stroke: "#21262d" }}
                      interval={Math.max(1, Math.floor(data.termSpreadsWithBtc.length / 12))}
                    />
                    <YAxis
                      yAxisId="spread"
                      tick={{ fill: "#6e7681", fontSize: 10, fontFamily: "'JetBrains Mono'" }}
                      axisLine={{ stroke: "#21262d" }}
                      unit="%"
                      label={{ value: "Spread 7dMA %", angle: -90, position: "insideLeft", fill: "#6e7681", fontSize: 10 }}
                    />
                    <YAxis
                      yAxisId="vol"
                      orientation="right"
                      tick={{ fill: "#6e7681", fontSize: 10, fontFamily: "'JetBrains Mono'" }}
                      axisLine={{ stroke: "#21262d" }}
                      unit="%"
                      label={{ value: "30d Vol %", angle: 90, position: "insideRight", fill: "#6e7681", fontSize: 10 }}
                    />
                    <Tooltip content={<CustomTooltip />} />
                    <ReferenceLine yAxisId="spread" y={0} stroke="#6e768130" strokeDasharray="3 3" />
                    <Area
                      yAxisId="spread" type="monotone" dataKey="spread7dma"
                      fill="#388bfd10" stroke="#388bfd" strokeWidth={1.5}
                      name="Term Spread 7dMA" unit="%"
                    />
                    <Line
                      yAxisId="vol" type="monotone" dataKey="vol30d"
                      stroke="#f778ba" strokeWidth={2} dot={false}
                      name="30d Realized Vol" unit="%"
                    />
                  </ComposedChart>
                </ResponsiveContainer>
              ) : (
                <LoadingSpinner />
              )}
            </div>

            {/* Regime Breakdown */}
            <div style={{
              background: "#161b22", border: "1px solid #21262d",
              borderRadius: 8, padding: 20,
            }}>
              <SectionHeader
                icon="🎰"
                title="Regime Statistics"
                subtitle="Distribution of term spread across market regimes"
              />
              {spreadStats ? (
                <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                  {[
                    { label: "Steep Contango (>+2%)", pct: data!.termSpreadsWithBtc.filter(r => r.term_spread * 100 > 2).length / spreadStats.total * 100, color: "#00ff88" },
                    { label: "Contango (+0.5% to +2%)", pct: data!.termSpreadsWithBtc.filter(r => r.term_spread * 100 > 0.5 && r.term_spread * 100 <= 2).length / spreadStats.total * 100, color: "#66ffaa" },
                    { label: "Flat (±0.5%)", pct: spreadStats.flat / spreadStats.total * 100, color: "#ffd866" },
                    { label: "Backwardation (-0.5% to -5%)", pct: data!.termSpreadsWithBtc.filter(r => r.term_spread * 100 >= -5 && r.term_spread * 100 < -0.5).length / spreadStats.total * 100, color: "#ff9944" },
                    { label: "Steep Backwardation (<-5%)", pct: data!.termSpreadsWithBtc.filter(r => r.term_spread * 100 < -5).length / spreadStats.total * 100, color: "#ff5544" },
                  ].map((item, i) => (
                    <div key={i}>
                      <div style={{
                        display: "flex", justifyContent: "space-between", marginBottom: 4,
                        fontFamily: "'JetBrains Mono', monospace", fontSize: "0.6rem",
                      }}>
                        <span style={{ color: item.color }}>{item.label}</span>
                        <span style={{ color: "#8b949e" }}>{item.pct.toFixed(1)}%</span>
                      </div>
                      <div style={{
                        height: 8, background: "#0d1117", borderRadius: 4,
                        overflow: "hidden", border: "1px solid #21262d",
                      }}>
                        <div style={{
                          height: "100%", width: `${Math.min(100, item.pct)}%`,
                          background: item.color, borderRadius: 4, opacity: 0.7,
                          transition: "width 0.5s ease",
                        }} />
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div style={{ color: "#6e7681", fontSize: "0.7rem", textAlign: "center", padding: 40 }}>
                  Insufficient data for regime analysis
                </div>
              )}
            </div>

            {/* Mechanics explanation */}
            <div style={{
              background: "#161b22", border: "1px solid #21262d",
              borderRadius: 8, padding: 20,
            }}>
              <SectionHeader
                icon="⚙️"
                title="Mechanics Chain"
                subtitle="How sUSDe yield translates to BTC regime signals"
              />
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {[
                  { step: "1", text: "Ethena runs delta-neutral basis (long spot BTC/ETH + short perps)", color: "#388bfd" },
                  { step: "2", text: "sUSDe captures yield from perpetual funding rates", color: "#a371f7" },
                  { step: "3", text: "Pendle splits sUSDe into PT (fixed) + YT (variable) at each maturity", color: "#f778ba" },
                  { step: "4", text: "Market-clearing implied yield at each maturity reveals forward expectations", color: "#ffd866" },
                  { step: "5", text: "Term spread (back−front) captures the slope of forward expectations", color: "#00ff88" },
                  { step: "6", text: "Contango → bullish BTC (persistent/rising funding) · Backwardation → bearish", color: "#ff9944" },
                ].map((item) => (
                  <div key={item.step} style={{ display: "flex", alignItems: "flex-start", gap: 8 }}>
                    <div style={{
                      width: 20, height: 20, borderRadius: "50%",
                      background: `${item.color}20`, border: `1px solid ${item.color}40`,
                      display: "flex", alignItems: "center", justifyContent: "center",
                      fontSize: "0.6rem", color: item.color, fontWeight: 600,
                      flexShrink: 0, marginTop: 1,
                    }}>
                      {item.step}
                    </div>
                    <span style={{ fontSize: "0.65rem", color: "#8b949e", lineHeight: 1.5 }}>{item.text}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* ─── TAB: DECILE ANALYSIS ─── */}
        {activeTab === "decile" && (
          <div style={{ display: "grid", gridTemplateColumns: "1fr", gap: 20 }}>
            {/* Decile chart */}
            <div style={{
              background: "#161b22", border: "1px solid #21262d",
              borderRadius: 8, padding: 20,
            }}>
              <SectionHeader
                icon="📊"
                title="Term Spread Decile Analysis"
                subtitle="Observations sorted into 10 bins by spread value · Shows avg 90d forward BTC return per decile"
              />
              {deciles.length ? (
                <>
                  <ResponsiveContainer width="100%" height={350}>
                    <BarChart
                      data={deciles.map(d => ({
                        decile: `D${d.decile}`,
                        avgSpread: d.avgSpread,
                        avgReturn: d.avgBtcReturn90d,
                        count: d.count,
                      }))}
                      margin={{ top: 10, right: 20, bottom: 10, left: 0 }}
                    >
                      <CartesianGrid strokeDasharray="3 3" stroke="#21262d" />
                      <XAxis
                        dataKey="decile"
                        tick={{ fill: "#6e7681", fontSize: 11, fontFamily: "'JetBrains Mono'" }}
                        axisLine={{ stroke: "#21262d" }}
                      />
                      <YAxis
                        tick={{ fill: "#6e7681", fontSize: 10, fontFamily: "'JetBrains Mono'" }}
                        axisLine={{ stroke: "#21262d" }}
                        unit="%"
                        label={{ value: "Avg 90d BTC Return %", angle: -90, position: "insideLeft", fill: "#6e7681", fontSize: 10 }}
                      />
                      <Tooltip content={<CustomTooltip />} />
                      <ReferenceLine y={0} stroke="#6e768150" strokeDasharray="5 5" />
                      <Bar dataKey="avgReturn" name="Avg 90d BTC Return" unit="%" radius={[4, 4, 0, 0]}>
                        {deciles.map((d, i) => (
                          <Cell
                            key={i}
                            fill={d.avgBtcReturn90d != null && d.avgBtcReturn90d > 0 ? "#00ff88" : "#ff5544"}
                            fillOpacity={0.7}
                          />
                        ))}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>

                  {/* Decile table */}
                  <div style={{ marginTop: 16, overflowX: "auto" }}>
                    <table style={{
                      width: "100%", borderCollapse: "collapse",
                      fontFamily: "'JetBrains Mono', monospace", fontSize: "0.6rem",
                    }}>
                      <thead>
                        <tr style={{ borderBottom: "1px solid #21262d" }}>
                          {["Decile", "Spread Range", "Count", "Avg Spread", "Avg 90d BTC Return"].map(h => (
                            <th key={h} style={{ color: "#6e7681", padding: "8px 12px", textAlign: "right", fontWeight: 500 }}>{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {deciles.map((d, i) => (
                          <tr key={i} style={{ borderBottom: "1px solid #161b22" }}>
                            <td style={{ color: "#e6edf3", padding: "6px 12px", textAlign: "right", fontWeight: 600 }}>D{d.decile}</td>
                            <td style={{ color: "#8b949e", padding: "6px 12px", textAlign: "right" }}>{d.range}</td>
                            <td style={{ color: "#8b949e", padding: "6px 12px", textAlign: "right" }}>{d.count}</td>
                            <td style={{
                              color: d.avgSpread > 0 ? "#00ff88" : d.avgSpread < -5 ? "#ff5544" : "#ffd866",
                              padding: "6px 12px", textAlign: "right"
                            }}>
                              {d.avgSpread > 0 ? "+" : ""}{d.avgSpread.toFixed(2)}%
                            </td>
                            <td style={{
                              color: d.avgBtcReturn90d != null
                                ? d.avgBtcReturn90d > 0 ? "#00ff88" : "#ff5544"
                                : "#6e7681",
                              padding: "6px 12px", textAlign: "right", fontWeight: 600,
                            }}>
                              {d.avgBtcReturn90d != null
                                ? `${d.avgBtcReturn90d > 0 ? "+" : ""}${d.avgBtcReturn90d.toFixed(1)}%`
                                : "—"}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </>
              ) : (
                <div style={{ color: "#6e7681", fontSize: "0.7rem", textAlign: "center", padding: 60 }}>
                  Insufficient data for decile analysis.
                  <br />Need at least 20 term spread observations with BTC price data.
                </div>
              )}
            </div>

            {/* Avg spread per decile chart */}
            <div style={{
              background: "#161b22", border: "1px solid #21262d",
              borderRadius: 8, padding: 20,
            }}>
              <SectionHeader
                icon="📐"
                title="Average Term Spread by Decile"
                subtitle="Shows the average term spread value in each decile bin"
              />
              {deciles.length ? (
                <ResponsiveContainer width="100%" height={250}>
                  <BarChart
                    data={deciles.map(d => ({
                      decile: `D${d.decile}`,
                      avgSpread: d.avgSpread,
                    }))}
                    margin={{ top: 10, right: 20, bottom: 10, left: 0 }}
                  >
                    <CartesianGrid strokeDasharray="3 3" stroke="#21262d" />
                    <XAxis
                      dataKey="decile"
                      tick={{ fill: "#6e7681", fontSize: 11, fontFamily: "'JetBrains Mono'" }}
                      axisLine={{ stroke: "#21262d" }}
                    />
                    <YAxis
                      tick={{ fill: "#6e7681", fontSize: 10, fontFamily: "'JetBrains Mono'" }}
                      axisLine={{ stroke: "#21262d" }}
                      unit="%"
                    />
                    <Tooltip content={<CustomTooltip />} />
                    <ReferenceLine y={0} stroke="#6e768130" strokeDasharray="3 3" />
                    <ReferenceLine y={HISTORICAL_MEAN_SPREAD} stroke="#a371f740" strokeDasharray="3 3"
                      label={{ value: `Report Mean`, fill: "#a371f760", fontSize: 8, position: "insideTopRight" }}
                    />
                    <Bar dataKey="avgSpread" name="Avg Spread" unit="%" radius={[4, 4, 0, 0]}>
                      {deciles.map((d, i) => (
                        <Cell
                          key={i}
                          fill={d.avgSpread > 0.5 ? "#00ff88" : d.avgSpread > -0.5 ? "#ffd866" : d.avgSpread > -5 ? "#ff9944" : "#ff5544"}
                          fillOpacity={0.7}
                        />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              ) : (
                <div style={{ color: "#6e7681", fontSize: "0.7rem", textAlign: "center", padding: 40 }}>
                  Insufficient data
                </div>
              )}
            </div>
          </div>
        )}

        {/* ─── FOOTER ─── */}
        <div style={{
          marginTop: 24, padding: "16px 0", borderTop: "1px solid #21262d",
          display: "flex", justifyContent: "space-between",
          alignItems: "center", flexWrap: "wrap", gap: 8,
        }}>
          <div style={{
            color: "#484f58", fontSize: "0.55rem",
            fontFamily: "'JetBrains Mono', monospace",
          }}>
            Data: Pendle V2 API · Ethena · DefiLlama · CoinGecko · Local SQLite ·
            Methodology: Blockworks Research "Forecasting Market Regimes with the sUSDe Term Structure"
          </div>
          <div style={{
            color: "#484f58", fontSize: "0.55rem",
            fontFamily: "'JetBrains Mono', monospace",
          }}>
            {data?.markets.length ?? 0} markets · {data?.stats?.snapshots ?? 0} snapshots ·
            {" "}{data?.stats?.termSpreads ?? 0} term spreads · Auto-refreshing daily · Not financial advice
          </div>
        </div>
      </div>
    </div>
  );
}
