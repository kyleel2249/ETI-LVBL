import {
  LIVE_CONFIRM_PHRASE,
  liveAllowed,
  type Provider,
  type TradingConfig,
  type Venue,
} from "./config";
import {
  DEFAULT_LIMITS,
  evaluateTrade,
  type RiskCheck,
  type RiskContext,
  type RiskLimits,
} from "./risk";

export type OrderRequest = {
  provider: Provider;
  venue: Venue;
  symbol: string;
  side: "buy" | "sell";
  type: "market" | "limit";
  qty: number;
  limitPrice?: number;
  stop: number;
  target: number;
  /** Idempotency key supplied by the caller (one per ticket). */
  clientOrderId: string;
  confirmLive?: string;
};

export type GateInput = {
  req: OrderRequest;
  cfg: TradingConfig;
  /** Server-observed reference price and its timestamp — never client-supplied. */
  refPrice: number;
  dataTs: number;
  risk: Omit<RiskContext, "killSwitch">;
  limits?: RiskLimits;
  now?: number;
};

export type GateResult = {
  ok: boolean;
  blocked: string[];
  checks: RiskCheck[];
  entry: number;
  rr: number;
  riskPct: number;
};

/** Pure pre-trade gate. Every order, on every venue, must pass this before submission. */
export function gateOrder(i: GateInput): GateResult {
  const { req, cfg } = i;
  const blocked: string[] = [];

  if (cfg.killSwitch) blocked.push("Kill switch is on");

  if (req.venue === "live") {
    const l = liveAllowed(cfg, req.provider);
    if (!l.allowed) blocked.push(`Live trading blocked: ${l.reason}`);
    if (req.confirmLive !== LIVE_CONFIRM_PHRASE)
      blocked.push(`Live order needs confirmation phrase "${LIVE_CONFIRM_PHRASE}"`);
  } else if (req.venue === "testnet") {
    if (req.provider !== "binance") blocked.push("Testnet exists only for Binance");
    if (!cfg.binanceTestnetEnabled) blocked.push("BINANCE_TESTNET_ENABLED is not true");
  } else if (req.venue === "paper") {
    if (req.provider !== "alpaca") blocked.push("Paper venue is Alpaca only");
    if (!cfg.alpacaPaper) blocked.push("ALPACA_PAPER=false — paper venue is unavailable");
  }

  if (!/^[A-Za-z0-9_-]{8,64}$/.test(req.clientOrderId))
    blocked.push("clientOrderId must be 8-64 chars [A-Za-z0-9_-]");
  if (req.type === "limit" && !(req.limitPrice && req.limitPrice > 0))
    blocked.push("Limit order needs a positive limitPrice");

  const entry = req.type === "limit" && req.limitPrice ? req.limitPrice : i.refPrice;
  const r = evaluateTrade(
    { side: req.side, qty: req.qty, entry, stop: req.stop, target: req.target, dataTs: i.dataTs },
    { ...i.risk, killSwitch: cfg.killSwitch, ...(i.now !== undefined ? { now: i.now } : {}) },
    i.limits ?? { ...DEFAULT_LIMITS, maxDataAgeMs: cfg.maxDataAgeMs },
  );
  for (const c of r.checks)
    if (!c.pass && c.rule !== "Kill switch off") blocked.push(`${c.rule}: ${c.detail}`);

  return {
    ok: blocked.length === 0,
    blocked,
    checks: r.checks,
    entry,
    rr: r.rr,
    riskPct: r.riskPct,
  };
}

/* ---------- exchange precision helpers (never assume one lot/tick size fits all) ---------- */

export type BinanceSymbolInfo = {
  symbol: string;
  status: string;
  baseAsset: string;
  quoteAsset: string;
  isSpotTradingAllowed?: boolean;
  filters: { filterType: string; [k: string]: string | number | boolean | undefined }[];
};

const decimals = (step: string) => {
  const s = step.includes("e") ? Number(step).toFixed(12) : step;
  const i = s.indexOf(".");
  if (i < 0) return 0;
  const frac = s.slice(i + 1).replace(/0+$/, "");
  return frac.length;
};

/** Floor `v` to a multiple of `step` and format with the step's decimals (avoids float noise). */
export function floorToStep(v: number, step: string): string {
  const st = Number(step);
  if (!(st > 0)) return String(v);
  const d = decimals(step);
  const units = Math.floor(v / st + 1e-9);
  return (units * st).toFixed(d);
}

export type PreparedBinanceOrder = {
  ok: boolean;
  errors: string[];
  qty: string;
  price?: string;
  notional: number;
};

export function prepareBinanceOrder(
  info: BinanceSymbolInfo,
  side: "buy" | "sell",
  type: "market" | "limit",
  qty: number,
  price: number | undefined,
  refPrice: number,
): PreparedBinanceOrder {
  const errors: string[] = [];
  if (info.status !== "TRADING")
    errors.push(`${info.symbol} is not tradable (status ${info.status})`);
  if (info.isSpotTradingAllowed === false)
    errors.push(`${info.symbol} does not allow spot trading`);
  const f = (t: string) => info.filters.find((x) => x.filterType === t);
  const lot = f(type === "market" ? "MARKET_LOT_SIZE" : "LOT_SIZE") ?? f("LOT_SIZE");
  const pf = f("PRICE_FILTER");
  const notionalF = f("NOTIONAL") ?? f("MIN_NOTIONAL");

  const step = lot ? String(lot["stepSize"]) : "0.00000001";
  const q = floorToStep(qty, Number(step) > 0 ? step : "0.00000001");
  if (lot && Number(q) < Number(lot["minQty"]))
    errors.push(`Quantity ${q} below minQty ${lot["minQty"]}`);
  if (lot && Number(lot["maxQty"]) > 0 && Number(q) > Number(lot["maxQty"]))
    errors.push(`Quantity ${q} above maxQty ${lot["maxQty"]}`);
  if (!(Number(q) > 0)) errors.push("Quantity rounds to zero for this symbol's step size");

  let p: string | undefined;
  if (type === "limit") {
    const tick = pf ? String(pf["tickSize"]) : "0.00000001";
    p = floorToStep(price ?? 0, Number(tick) > 0 ? tick : "0.00000001");
    if (pf && Number(pf["minPrice"]) > 0 && Number(p) < Number(pf["minPrice"]))
      errors.push(`Price ${p} below minPrice`);
  }
  const px = p !== undefined ? Number(p) : refPrice;
  const notional = Number(q) * px;
  const minN = notionalF ? Number(notionalF["minNotional"]) : 0;
  if (minN > 0 && notional < minN)
    errors.push(`Notional ${notional.toFixed(4)} below minNotional ${minN}`);
  void side;
  return {
    ok: errors.length === 0,
    errors,
    qty: q,
    ...(p !== undefined ? { price: p } : {}),
    notional,
  };
}

export type AlpacaAsset = {
  symbol: string;
  status: string;
  tradable: boolean;
  fractionable?: boolean;
  class?: string;
};

export function prepareAlpacaOrder(
  asset: AlpacaAsset | null,
  qty: number,
): { ok: boolean; errors: string[]; qty: string } {
  const errors: string[] = [];
  if (!asset)
    errors.push("Symbol not found at Alpaca (unsupported or unavailable to this account)");
  else {
    if (asset.status !== "active")
      errors.push(`${asset.symbol} is not active (status ${asset.status})`);
    if (!asset.tradable) errors.push(`${asset.symbol} is not tradable on this account`);
  }
  let q = qty;
  if (asset && !asset.fractionable) {
    q = Math.floor(qty);
    if (q < 1)
      errors.push(`${asset.symbol} is not fractionable — quantity must be at least 1 whole share`);
  } else q = Math.floor(qty * 1e9) / 1e9;
  return { ok: errors.length === 0, errors, qty: String(q) };
}
