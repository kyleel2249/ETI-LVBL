import type { AlpacaAsset } from "../orders";
import { normalizeAlpacaOrder, type NormalizedOrder } from "./normalize";
import { ProviderError, realDeps, resilientFetch, type Deps } from "./resilience";

type Env = Record<string, string | undefined>;
export type AlpacaVenue = "paper" | "live";
export type AlpacaCreds = { key: string; secret: string };

export const alpacaBase = (v: AlpacaVenue) =>
  v === "paper" ? "https://paper-api.alpaca.markets" : "https://api.alpaca.markets";
const DATA = "https://data.alpaca.markets";

/** Paper and live credentials are different variables. Paper keys are never used for live, or vice versa. */
export function alpacaCreds(v: AlpacaVenue, env: Env): AlpacaCreds | null {
  const key =
    v === "paper"
      ? (env["ALPACA_PAPER_API_KEY"] ?? env["ALPACA_API_KEY"])
      : env["ALPACA_LIVE_API_KEY"];
  const secret =
    v === "paper"
      ? (env["ALPACA_PAPER_API_SECRET"] ?? env["ALPACA_SECRET_KEY"])
      : env["ALPACA_LIVE_API_SECRET"];
  return key && secret ? { key, secret } : null;
}

async function call<T>(
  v: AlpacaVenue,
  method: "GET" | "POST" | "DELETE",
  url: string,
  c: AlpacaCreds,
  body: unknown,
  d: Deps,
): Promise<T> {
  const res = await resilientFetch(
    url,
    {
      method,
      headers: {
        "APCA-API-KEY-ID": c.key,
        "APCA-API-SECRET-KEY": c.secret,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    },
    { key: `alpaca:${v}`, provider: "alpaca", retries: method === "GET" ? 2 : 0 },
    d,
  );
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* ignore */
  }
  if (!res.ok) {
    const j = (json ?? {}) as { message?: string; code?: number };
    const auth = res.status === 401 || res.status === 403;
    throw new ProviderError(
      `Alpaca ${v}: ${auth ? "authentication failed — check keys are for this environment" : (j.message ?? `HTTP ${res.status}`)}`,
      "alpaca",
      res.status,
      j.code ?? null,
    );
  }
  return json as T;
}

export async function getAccount(v: AlpacaVenue, c: AlpacaCreds, d: Deps = realDeps) {
  const a = await call<Record<string, string | boolean>>(
    v,
    "GET",
    `${alpacaBase(v)}/v2/account`,
    c,
    null,
    d,
  );
  return {
    status: String(a["status"]),
    currency: String(a["currency"]),
    equity: Number(a["equity"]),
    lastEquity: Number(a["last_equity"]),
    buyingPower: Number(a["buying_power"]),
    cash: Number(a["cash"]),
    tradingBlocked: Boolean(a["trading_blocked"]),
    accountBlocked: Boolean(a["account_blocked"]),
    patternDayTrader: Boolean(a["pattern_day_trader"]),
  };
}
export async function getPositions(v: AlpacaVenue, c: AlpacaCreds, d: Deps = realDeps) {
  const p = await call<Record<string, string>[]>(
    v,
    "GET",
    `${alpacaBase(v)}/v2/positions`,
    c,
    null,
    d,
  );
  return p.map((x) => ({
    symbol: x["symbol"]!,
    side: x["side"]!,
    qty: Number(x["qty"]),
    avgEntry: Number(x["avg_entry_price"]),
    marketValue: Number(x["market_value"]),
    unrealizedPl: Number(x["unrealized_pl"]),
  }));
}
export async function getAsset(
  v: AlpacaVenue,
  c: AlpacaCreds,
  symbol: string,
  d: Deps = realDeps,
): Promise<AlpacaAsset | null> {
  try {
    const a = await call<Record<string, unknown>>(
      v,
      "GET",
      `${alpacaBase(v)}/v2/assets/${encodeURIComponent(symbol)}`,
      c,
      null,
      d,
    );
    return {
      symbol: String(a["symbol"]),
      status: String(a["status"]),
      tradable: Boolean(a["tradable"]),
      fractionable: Boolean(a["fractionable"]),
      class: String(a["class"]),
    };
  } catch (e) {
    if (e instanceof ProviderError && e.status === 404) return null;
    throw e;
  }
}
/** Latest trade; entitlement problems surface as errors, never as substituted data. */
export async function getLatestTrade(
  v: AlpacaVenue,
  c: AlpacaCreds,
  symbol: string,
  d: Deps = realDeps,
): Promise<{ price: number; ts: number }> {
  const r = await call<{ trade?: { p?: number; t?: string } }>(
    v,
    "GET",
    `${DATA}/v2/stocks/${encodeURIComponent(symbol)}/trades/latest?feed=iex`,
    c,
    null,
    d,
  );
  const price = r.trade?.p;
  const ts = r.trade?.t ? Date.parse(r.trade.t) : NaN;
  if (!price || !Number.isFinite(ts))
    throw new ProviderError(
      `No latest trade available for ${symbol} (not entitled or unsupported)`,
      "alpaca",
      null,
    );
  return { price, ts };
}

export type AlpacaOrderParams = {
  symbol: string;
  side: "buy" | "sell";
  type: "market" | "limit";
  qty: string;
  limitPrice?: number;
  stop: number;
  target: number;
  clientOrderId: string;
  bracket: boolean;
};
export async function submitOrder(
  v: AlpacaVenue,
  c: AlpacaCreds,
  o: AlpacaOrderParams,
  d: Deps = realDeps,
): Promise<NormalizedOrder> {
  const body: Record<string, unknown> = {
    symbol: o.symbol,
    qty: o.qty,
    side: o.side,
    type: o.type,
    time_in_force: "day",
    client_order_id: o.clientOrderId,
    ...(o.type === "limit" ? { limit_price: String(o.limitPrice) } : {}),
    // Native bracket (protective stop + target) so the risk-approved exits actually exist at the broker.
    ...(o.bracket
      ? {
          order_class: "bracket",
          take_profit: { limit_price: String(o.target) },
          stop_loss: { stop_price: String(o.stop) },
        }
      : {}),
  };
  return normalizeAlpacaOrder(
    await call<Record<string, unknown>>(v, "POST", `${alpacaBase(v)}/v2/orders`, c, body, d),
    v,
  );
}
export async function getOrderByClientId(
  v: AlpacaVenue,
  c: AlpacaCreds,
  clientOrderId: string,
  d: Deps = realDeps,
) {
  return normalizeAlpacaOrder(
    await call<Record<string, unknown>>(
      v,
      "GET",
      `${alpacaBase(v)}/v2/orders:by_client_order_id?client_order_id=${encodeURIComponent(clientOrderId)}`,
      c,
      null,
      d,
    ),
    v,
  );
}
export async function listOrders(
  v: AlpacaVenue,
  c: AlpacaCreds,
  status: "open" | "closed" | "all",
  d: Deps = realDeps,
) {
  const r = await call<Record<string, unknown>[]>(
    v,
    "GET",
    `${alpacaBase(v)}/v2/orders?status=${status}&limit=100&direction=desc`,
    c,
    null,
    d,
  );
  return r.map((o) => normalizeAlpacaOrder(o, v));
}
export async function cancelOrder(
  v: AlpacaVenue,
  c: AlpacaCreds,
  orderId: string,
  d: Deps = realDeps,
) {
  await call<void>(
    v,
    "DELETE",
    `${alpacaBase(v)}/v2/orders/${encodeURIComponent(orderId)}`,
    c,
    null,
    d,
  );
  return { canceled: true as const };
}
