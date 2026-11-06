import { signBinanceQuery } from "../sign";
import type { Venue } from "../config";
import type { BinanceSymbolInfo } from "../orders";
import { normalizeBinanceOrder, type NormalizedOrder } from "./normalize";
import { ProviderError, realDeps, resilientFetch, type Deps } from "./resilience";

type Env = Record<string, string | undefined>;
export type BinanceVenue = Exclude<Venue, "paper">;
export type BinanceCreds = { key: string; secret: string };

export const binanceBase = (v: BinanceVenue) =>
  v === "testnet" ? "https://testnet.binance.vision" : "https://api.binance.com";

/** Testnet and production keys are separate variables, so testnet can never pick up production keys. */
export function binanceCreds(v: BinanceVenue, env: Env): BinanceCreds | null {
  const key = v === "testnet" ? env["BINANCE_TESTNET_API_KEY"] : env["BINANCE_API_KEY"];
  const secret = v === "testnet" ? env["BINANCE_TESTNET_SECRET_KEY"] : env["BINANCE_SECRET_KEY"];
  return key && secret ? { key, secret } : null;
}

type Params = Record<string, string | number | boolean | undefined>;

async function call<T>(
  v: BinanceVenue,
  method: "GET" | "POST" | "DELETE",
  path: string,
  params: Params,
  creds: BinanceCreds | null,
  d: Deps,
): Promise<T> {
  const signed = creds !== null;
  const qs = signed
    ? await signBinanceQuery(params, creds.secret, d.now())
    : new URLSearchParams(
        Object.entries(params)
          .filter(([, x]) => x !== undefined)
          .map(([k, x]) => [k, String(x)]),
      ).toString();
  const url = `${binanceBase(v)}${path}${qs ? `?${qs}` : ""}`;
  const headers: Record<string, string> = signed ? { "X-MBX-APIKEY": creds.key } : {};
  // Only GETs are retried automatically; order POSTs rely on newClientOrderId for idempotency instead.
  const res = await resilientFetch(
    url,
    { method, headers },
    { key: `binance:${v}`, provider: "binance", retries: method === "GET" ? 2 : 0 },
    d,
  );
  const text = await res.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* non-JSON error body */
  }
  if (!res.ok) {
    const j = (json ?? {}) as { code?: number; msg?: string };
    throw new ProviderError(
      `Binance ${v} ${path}: ${j.msg ?? `HTTP ${res.status}`}`,
      "binance",
      res.status,
      j.code ?? null,
    );
  }
  return json as T;
}

export async function getSymbolInfo(
  v: BinanceVenue,
  symbol: string,
  d: Deps = realDeps,
): Promise<BinanceSymbolInfo | null> {
  try {
    const r = await call<{ symbols: BinanceSymbolInfo[] }>(
      v,
      "GET",
      "/api/v3/exchangeInfo",
      { symbol },
      null,
      d,
    );
    return r.symbols?.[0] ?? null;
  } catch (e) {
    if (e instanceof ProviderError && e.code === -1121) return null; // invalid symbol
    throw e;
  }
}

/** Server-observed reference price; `ts` is the retrieval time of an exchange response. */
export async function getRefPrice(
  v: BinanceVenue,
  symbol: string,
  d: Deps = realDeps,
): Promise<{ price: number; ts: number }> {
  const r = await call<{ price: string }>(v, "GET", "/api/v3/ticker/price", { symbol }, null, d);
  const price = Number(r.price);
  if (!(price > 0)) throw new ProviderError("Binance returned an invalid price", "binance", null);
  return { price, ts: d.now() };
}

export async function getAccount(v: BinanceVenue, creds: BinanceCreds, d: Deps = realDeps) {
  const a = await call<{
    canTrade: boolean;
    accountType: string;
    permissions: string[];
    balances: { asset: string; free: string; locked: string }[];
  }>(v, "GET", "/api/v3/account", { omitZeroBalances: true }, creds, d);
  return {
    canTrade: a.canTrade,
    accountType: a.accountType,
    permissions: a.permissions,
    balances: a.balances
      .map((b) => ({ asset: b.asset, free: Number(b.free), locked: Number(b.locked) }))
      .filter((b) => b.free + b.locked > 0),
  };
}

export type BinanceOrderParams = {
  symbol: string;
  side: "buy" | "sell";
  type: "market" | "limit";
  qty: string;
  price?: string;
  clientOrderId: string;
};
const orderBody = (o: BinanceOrderParams): Params => ({
  symbol: o.symbol,
  side: o.side.toUpperCase(),
  type: o.type.toUpperCase(),
  quantity: o.qty,
  ...(o.type === "limit" ? { price: o.price, timeInForce: "GTC" } : {}),
  newClientOrderId: o.clientOrderId,
  newOrderRespType: "FULL",
});

/** Exchange-side validation without placing an order (POST /api/v3/order/test). */
export async function testOrder(
  v: BinanceVenue,
  creds: BinanceCreds,
  o: BinanceOrderParams,
  d: Deps = realDeps,
) {
  await call(v, "POST", "/api/v3/order/test", orderBody(o), creds, d);
  return { valid: true as const };
}
export async function placeOrder(
  v: BinanceVenue,
  creds: BinanceCreds,
  o: BinanceOrderParams,
  d: Deps = realDeps,
): Promise<NormalizedOrder> {
  return normalizeBinanceOrder(
    await call<Record<string, unknown>>(v, "POST", "/api/v3/order", orderBody(o), creds, d),
    v === "testnet" ? "testnet" : "live",
  );
}
export async function getOrderByClientId(
  v: BinanceVenue,
  creds: BinanceCreds,
  symbol: string,
  clientOrderId: string,
  d: Deps = realDeps,
) {
  return normalizeBinanceOrder(
    await call<Record<string, unknown>>(
      v,
      "GET",
      "/api/v3/order",
      { symbol, origClientOrderId: clientOrderId },
      creds,
      d,
    ),
    v === "testnet" ? "testnet" : "live",
  );
}
export async function cancelOrder(
  v: BinanceVenue,
  creds: BinanceCreds,
  symbol: string,
  clientOrderId: string,
  d: Deps = realDeps,
) {
  return normalizeBinanceOrder(
    await call<Record<string, unknown>>(
      v,
      "DELETE",
      "/api/v3/order",
      { symbol, origClientOrderId: clientOrderId },
      creds,
      d,
    ),
    v === "testnet" ? "testnet" : "live",
  );
}
export async function openOrders(
  v: BinanceVenue,
  creds: BinanceCreds,
  symbol?: string,
  d: Deps = realDeps,
) {
  const r = await call<Record<string, unknown>[]>(
    v,
    "GET",
    "/api/v3/openOrders",
    { symbol },
    creds,
    d,
  );
  return r.map((o) => normalizeBinanceOrder(o, v === "testnet" ? "testnet" : "live"));
}
