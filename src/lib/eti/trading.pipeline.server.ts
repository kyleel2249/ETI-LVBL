import { readTradingConfig, type TradingConfig } from "./config";
import {
  gateOrder,
  prepareAlpacaOrder,
  prepareBinanceOrder,
  type GateResult,
  type OrderRequest,
} from "./orders";
import * as alpaca from "./providers/alpaca.server";
import * as binance from "./providers/binance.server";
import { reconcileOrders, type NormalizedOrder, type Reconciliation } from "./providers/normalize";
import { ProviderError, realDeps, type Deps } from "./providers/resilience";
import type { Store } from "./storage/types";

type Env = Record<string, string | undefined>;
export type Ctx = { env: Env; store: Store; deps?: Deps };

export type OrderOutcome = {
  status: "preview_ok" | "submitted" | "rejected" | "duplicate" | "failed";
  gate: GateResult | null;
  reasons: string[];
  prepared?:
    { qty: string; price?: string; notional?: number; exchangeValidated: boolean } | undefined;
  refPrice?: number | undefined;
  order?: NormalizedOrder | undefined;
  assumptions: string[];
};

export type OrderRecord = {
  status: "submitting" | "submitted" | "failed";
  req: OrderRequest;
  gate: GateResult | null;
  order: NormalizedOrder | null;
  error: string | null;
  at: number;
};

export const orderKey = (r: Pick<OrderRequest, "provider" | "venue" | "clientOrderId">) =>
  `${r.provider}:${r.venue}:${r.clientOrderId}`;

export async function effectiveConfig(c: Ctx): Promise<TradingConfig> {
  const cfg = readTradingConfig(c.env);
  const stored = await c.store.get<{ enabled: boolean }>("settings", "kill_switch");
  return { ...cfg, killSwitch: cfg.killSwitch || stored?.data.enabled === true };
}
export async function setKillSwitch(c: Ctx, enabled: boolean) {
  await c.store.put("settings", "kill_switch", { enabled }, { overwrite: true });
  await c.store.put(
    "audit",
    `${Date.now()}-kill`,
    { event: "kill_switch", enabled },
    { overwrite: true },
  );
}

const reject = (
  reasons: string[],
  gate: GateResult | null = null,
  assumptions: string[] = [],
): OrderOutcome => ({ status: "rejected", gate, reasons, assumptions });

export async function runOrder(
  c: Ctx,
  req: OrderRequest,
  mode: "preview" | "submit",
): Promise<OrderOutcome> {
  const d = c.deps ?? realDeps;
  const cfg = await effectiveConfig(c);
  try {
    const out =
      req.provider === "binance"
        ? await binanceFlow(c, d, cfg, req, mode)
        : await alpacaFlow(c, d, cfg, req, mode);
    await c.store.put(
      "audit",
      `${Date.now()}-${req.clientOrderId}-${mode}`,
      { event: `order_${mode}`, key: orderKey(req), status: out.status, reasons: out.reasons },
      { overwrite: true },
    );
    return out;
  } catch (e) {
    const msg =
      e instanceof ProviderError ? e.message : `Unexpected error: ${(e as Error).message}`;
    await c.store.put(
      "audit",
      `${Date.now()}-${req.clientOrderId}-err`,
      { event: "order_error", key: orderKey(req), error: msg },
      { overwrite: true },
    );
    return { status: "failed", gate: null, reasons: [msg], assumptions: [] };
  }
}

async function binanceFlow(
  c: Ctx,
  d: Deps,
  cfg: TradingConfig,
  req: OrderRequest,
  mode: "preview" | "submit",
): Promise<OrderOutcome> {
  if (req.venue === "paper") return reject(["Binance has no paper venue; use testnet"]);
  const v = req.venue;
  const creds = binance.binanceCreds(v, c.env);
  if (!creds) return reject([`Binance ${v} credentials are not configured`]);

  const symbol = req.symbol.toUpperCase();
  const info = await binance.getSymbolInfo(v, symbol, d);
  if (!info) return reject([`${symbol} is not listed on Binance ${v}`]);
  if (info.quoteAsset !== "USDT")
    return reject([
      `Only USDT-quoted pairs are supported (${symbol} quotes ${info.quoteAsset}); no implicit currency conversion is performed`,
    ]);

  const [ref, acct, open] = await Promise.all([
    binance.getRefPrice(v, symbol, d),
    binance.getAccount(v, creds, d),
    binance.openOrders(v, creds, undefined, d),
  ]);
  if (!acct.canTrade) return reject(["Binance account cannot trade"]);
  const equity = acct.balances
    .filter((b) => b.asset === "USDT")
    .reduce((a, b) => a + b.free + b.locked, 0);
  const assumptions = [
    "Equity = USDT balance only (other assets are not converted)",
    "Open positions approximated by open orders (spot has no positions)",
    "Realized P&L today not tracked for Binance; daily-loss rule sees 0",
  ];

  const prep = prepareBinanceOrder(info, req.side, req.type, req.qty, req.limitPrice, ref.price);
  const gate = gateOrder({
    req: { ...req, symbol, qty: Number(prep.qty) || req.qty },
    cfg,
    refPrice: ref.price,
    dataTs: ref.ts,
    risk: { equity, openPositions: open.length, realizedTodayPnl: 0 },
  });
  const reasons = [...prep.errors, ...gate.blocked];
  if (reasons.length) return reject(reasons, gate, assumptions);

  const params = {
    symbol,
    side: req.side,
    type: req.type,
    qty: prep.qty,
    ...(prep.price ? { price: prep.price } : {}),
    clientOrderId: req.clientOrderId,
  };
  await binance.testOrder(v, creds, params, d); // exchange-side validation, no execution
  const prepared = {
    qty: prep.qty,
    ...(prep.price ? { price: prep.price } : {}),
    notional: prep.notional,
    exchangeValidated: true,
  };
  if (mode === "preview")
    return { status: "preview_ok", gate, reasons: [], prepared, refPrice: ref.price, assumptions };

  return submitOnce(c, req, gate, prepared, ref.price, assumptions, () =>
    binance.placeOrder(v, creds, params, d),
  );
}

async function alpacaFlow(
  c: Ctx,
  d: Deps,
  cfg: TradingConfig,
  req: OrderRequest,
  mode: "preview" | "submit",
): Promise<OrderOutcome> {
  if (req.venue === "testnet") return reject(["Alpaca has no testnet; use paper"]);
  const v = req.venue;
  const creds = alpaca.alpacaCreds(v, c.env);
  if (!creds)
    return reject([
      `Alpaca ${v} credentials are not configured${v === "live" ? " (ALPACA_LIVE_API_KEY / ALPACA_LIVE_API_SECRET)" : ""}`,
    ]);
  const symbol = req.symbol.toUpperCase();

  const asset = await alpaca.getAsset(v, creds, symbol, d);
  if (asset && asset.class && asset.class !== "us_equity")
    return reject([
      `${symbol} is a ${asset.class} asset; only US equities/ETFs are supported through Alpaca here`,
    ]);
  const prep = prepareAlpacaOrder(asset, req.qty);
  const [acct, positions, last] = await Promise.all([
    alpaca.getAccount(v, creds, d),
    alpaca.getPositions(v, creds, d),
    alpaca.getLatestTrade(v, creds, symbol, d).catch((e) => e as Error),
  ]);
  if (last instanceof Error) return reject([last.message]);
  if (acct.tradingBlocked || acct.accountBlocked)
    return reject(["Alpaca account is blocked from trading"]);
  const assumptions = [
    "Daily P&L = equity − last equity (includes unrealized)",
    "Latest trade is from the IEX feed; may differ from consolidated prices",
  ];

  const gate = gateOrder({
    req: { ...req, symbol, qty: Number(prep.qty) || req.qty },
    cfg,
    refPrice: last.price,
    dataTs: last.ts,
    risk: {
      equity: acct.equity,
      openPositions: positions.length,
      realizedTodayPnl: acct.equity - acct.lastEquity,
    },
  });
  const reasons = [...prep.errors, ...gate.blocked];
  if (!Number.isInteger(Number(prep.qty)))
    reasons.push("Fractional quantities cannot carry bracket exits; use whole shares");
  if (reasons.length) return reject(reasons, gate, assumptions);

  const prepared = {
    qty: prep.qty,
    notional: Number(prep.qty) * gate.entry,
    exchangeValidated: false,
  };
  if (mode === "preview")
    return {
      status: "preview_ok",
      gate,
      reasons: [],
      prepared,
      refPrice: last.price,
      assumptions: [
        ...assumptions,
        "Alpaca has no dry-run endpoint; the order is validated by the risk gate only",
      ],
    };

  return submitOnce(c, req, gate, prepared, last.price, assumptions, () =>
    alpaca.submitOrder(
      v,
      creds,
      {
        symbol,
        side: req.side,
        type: req.type,
        qty: prep.qty,
        ...(req.limitPrice !== undefined ? { limitPrice: req.limitPrice } : {}),
        stop: req.stop,
        target: req.target,
        clientOrderId: req.clientOrderId,
        bracket: true,
      },
      d,
    ),
  );
}

/** Idempotent submission: the order record is claimed (insert-if-absent) before anything is sent. */
async function submitOnce(
  c: Ctx,
  req: OrderRequest,
  gate: GateResult,
  prepared: NonNullable<OrderOutcome["prepared"]>,
  refPrice: number,
  assumptions: string[],
  send: () => Promise<NormalizedOrder>,
): Promise<OrderOutcome> {
  const key = orderKey(req);
  const { confirmLive: _confirm, ...safeReq } = req; // never persist the confirmation phrase
  const rec: OrderRecord = {
    status: "submitting",
    req: safeReq,
    gate,
    order: null,
    error: null,
    at: Date.now(),
  };
  const claimed = await c.store.put("orders", key, rec);
  if (!claimed) {
    const prev = await c.store.get<OrderRecord>("orders", key);
    return {
      status: "duplicate",
      gate,
      reasons: ["Duplicate clientOrderId — order was already submitted; nothing was sent"],
      order: prev?.data.order ?? undefined,
      prepared,
      refPrice,
      assumptions,
    };
  }
  try {
    const order = await send();
    await c.store.put("orders", key, { ...rec, status: "submitted", order }, { overwrite: true });
    return { status: "submitted", gate, reasons: [], order, prepared, refPrice, assumptions };
  } catch (e) {
    const msg = e instanceof ProviderError ? e.message : (e as Error).message;
    await c.store.put("orders", key, { ...rec, status: "failed", error: msg }, { overwrite: true });
    return { status: "failed", gate, reasons: [msg], prepared, refPrice, assumptions };
  }
}

/* ---------- monitoring, cancellation, reconciliation ---------- */

const TERMINAL = new Set(["filled", "canceled", "rejected", "expired"]);

async function localOrders(
  c: Ctx,
  provider: OrderRequest["provider"],
  venue: OrderRequest["venue"],
) {
  const all = await c.store.list<OrderRecord>("orders", { limit: 200 });
  return all.filter((r) => r.data.req.provider === provider && r.data.req.venue === venue);
}

async function fetchRemote(c: Ctx, d: Deps, rec: OrderRecord): Promise<NormalizedOrder> {
  const { provider, venue, symbol, clientOrderId } = rec.req;
  if (provider === "binance") {
    const creds = binance.binanceCreds(venue as "testnet" | "live", c.env);
    if (!creds) throw new ProviderError("Binance credentials are not configured", "binance", null);
    return binance.getOrderByClientId(
      venue as "testnet" | "live",
      creds,
      symbol.toUpperCase(),
      clientOrderId,
      d,
    );
  }
  const creds = alpaca.alpacaCreds(venue as "paper" | "live", c.env);
  if (!creds) throw new ProviderError("Alpaca credentials are not configured", "alpaca", null);
  return alpaca.getOrderByClientId(venue as "paper" | "live", creds, clientOrderId, d);
}

export type SyncResult = {
  checked: number;
  updated: number;
  errors: string[];
  reconciliation: Reconciliation;
};

/** Re-reads recent orders from the provider, stores any status change, and reports drift. */
export async function syncOrders(
  c: Ctx,
  provider: OrderRequest["provider"],
  venue: OrderRequest["venue"],
): Promise<SyncResult> {
  const d = c.deps ?? realDeps;
  const recs = (await localOrders(c, provider, venue))
    .filter((r) => r.data.status === "submitted" && r.data.order)
    .slice(0, 20);
  const local: NormalizedOrder[] = [];
  const remote: NormalizedOrder[] = [];
  const errors: string[] = [];
  let updated = 0;
  for (const r of recs) {
    try {
      const fresh = await fetchRemote(c, d, r.data);
      local.push(r.data.order!);
      remote.push(fresh);
      if (fresh.status !== r.data.order!.status || fresh.filledQty !== r.data.order!.filledQty) {
        await c.store.put(
          "orders",
          orderKey(r.data.req),
          { ...r.data, order: fresh },
          { overwrite: true },
        );
        updated++;
      }
    } catch (e) {
      errors.push(`${r.data.req.clientOrderId}: ${(e as Error).message}`);
    }
  }
  const reconciliation = reconcileOrders(local, remote);
  await c.store.put("sync_events", `${Date.now()}-${provider}-${venue}`, {
    provider,
    venue,
    checked: recs.length,
    updated,
    errors,
    reconciliation,
  });
  return { checked: recs.length, updated, errors, reconciliation };
}

export async function cancelStored(
  c: Ctx,
  provider: OrderRequest["provider"],
  venue: OrderRequest["venue"],
  clientOrderId: string,
): Promise<{ ok: boolean; message: string }> {
  const d = c.deps ?? realDeps;
  const key = `${provider}:${venue}:${clientOrderId}`;
  const rec = await c.store.get<OrderRecord>("orders", key);
  if (!rec || !rec.data.order) return { ok: false, message: "No such submitted order" };
  if (TERMINAL.has(rec.data.order.status))
    return { ok: false, message: `Order already ${rec.data.order.status}` };
  try {
    if (provider === "binance") {
      const creds = binance.binanceCreds(venue as "testnet" | "live", c.env);
      if (!creds) return { ok: false, message: "Binance credentials are not configured" };
      await binance.cancelOrder(
        venue as "testnet" | "live",
        creds,
        rec.data.req.symbol.toUpperCase(),
        clientOrderId,
        d,
      );
    } else {
      const creds = alpaca.alpacaCreds(venue as "paper" | "live", c.env);
      if (!creds) return { ok: false, message: "Alpaca credentials are not configured" };
      await alpaca.cancelOrder(venue as "paper" | "live", creds, rec.data.order.id, d);
    }
    await c.store.put(
      "orders",
      key,
      {
        ...rec.data,
        order: { ...rec.data.order, status: "canceled", providerStatus: "CANCEL_REQUESTED" },
      },
      { overwrite: true },
    );
    await c.store.put("audit", `${Date.now()}-${clientOrderId}-cancel`, {
      event: "order_cancel",
      key,
    });
    return {
      ok: true,
      message: "Cancel requested; run sync to confirm the provider's final status",
    };
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }
}

export async function listLocalOrders(
  c: Ctx,
  provider: OrderRequest["provider"],
  venue: OrderRequest["venue"],
) {
  return (await localOrders(c, provider, venue)).map((r) => ({
    key: r.id,
    at: r.data.at,
    status: r.data.status,
    error: r.data.error,
    req: r.data.req,
    order: r.data.order,
  }));
}
