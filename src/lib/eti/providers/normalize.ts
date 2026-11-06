export type OrderStatus =
  "new" | "partially_filled" | "filled" | "canceled" | "rejected" | "expired" | "unknown";

export type NormalizedOrder = {
  provider: "alpaca" | "binance";
  venue: "paper" | "testnet" | "live";
  id: string;
  clientOrderId: string;
  symbol: string;
  side: "buy" | "sell";
  type: string;
  qty: number;
  filledQty: number;
  avgFillPrice: number | null;
  status: OrderStatus;
  providerStatus: string;
  submittedAt: number | null;
  updatedAt: number | null;
};

const num = (v: unknown) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

const BINANCE: Record<string, OrderStatus> = {
  NEW: "new",
  PENDING_NEW: "new",
  PARTIALLY_FILLED: "partially_filled",
  FILLED: "filled",
  CANCELED: "canceled",
  PENDING_CANCEL: "canceled",
  REJECTED: "rejected",
  EXPIRED: "expired",
  EXPIRED_IN_MATCH: "expired",
};
export function normalizeBinanceOrder(
  o: Record<string, unknown>,
  venue: "testnet" | "live",
): NormalizedOrder {
  const exec = num(o["executedQty"]);
  const quote = num(o["cummulativeQuoteQty"]);
  const st = String(o["status"] ?? "");
  return {
    provider: "binance",
    venue,
    id: String(o["orderId"] ?? ""),
    clientOrderId: String(o["clientOrderId"] ?? o["origClientOrderId"] ?? ""),
    symbol: String(o["symbol"] ?? ""),
    side: String(o["side"]).toLowerCase() === "sell" ? "sell" : "buy",
    type: String(o["type"] ?? "").toLowerCase(),
    qty: num(o["origQty"]),
    filledQty: exec,
    avgFillPrice: exec > 0 ? quote / exec : null,
    status: BINANCE[st] ?? "unknown",
    providerStatus: st,
    submittedAt: o["transactTime"] ? num(o["transactTime"]) : o["time"] ? num(o["time"]) : null,
    updatedAt: o["updateTime"] ? num(o["updateTime"]) : null,
  };
}

const ALPACA: Record<string, OrderStatus> = {
  new: "new",
  accepted: "new",
  pending_new: "new",
  accepted_for_bidding: "new",
  held: "new",
  pending_replace: "new",
  replaced: "new",
  partially_filled: "partially_filled",
  filled: "filled",
  done_for_day: "expired",
  canceled: "canceled",
  pending_cancel: "canceled",
  stopped: "canceled",
  rejected: "rejected",
  suspended: "rejected",
  expired: "expired",
};
export function normalizeAlpacaOrder(
  o: Record<string, unknown>,
  venue: "paper" | "live",
): NormalizedOrder {
  const st = String(o["status"] ?? "");
  const t = (v: unknown) => (typeof v === "string" ? Date.parse(v) || null : null);
  return {
    provider: "alpaca",
    venue,
    id: String(o["id"] ?? ""),
    clientOrderId: String(o["client_order_id"] ?? ""),
    symbol: String(o["symbol"] ?? ""),
    side: String(o["side"]) === "sell" ? "sell" : "buy",
    type: String(o["type"] ?? o["order_type"] ?? ""),
    qty: num(o["qty"]),
    filledQty: num(o["filled_qty"]),
    avgFillPrice: o["filled_avg_price"] ? num(o["filled_avg_price"]) : null,
    status: ALPACA[st] ?? "unknown",
    providerStatus: st,
    submittedAt: t(o["submitted_at"]) ?? t(o["created_at"]),
    updatedAt: t(o["updated_at"]),
  };
}

export type Reconciliation = {
  matched: number;
  /** Local record says submitted, provider has no such order. */
  missingAtProvider: string[];
  /** Provider has an order we have no local record of. */
  missingLocally: string[];
  mismatched: {
    clientOrderId: string;
    field: string;
    local: string | number | null;
    remote: string | number | null;
  }[];
};

export function reconcileOrders(
  local: NormalizedOrder[],
  remote: NormalizedOrder[],
): Reconciliation {
  const r = new Map(remote.map((o) => [o.clientOrderId, o]));
  const l = new Map(local.map((o) => [o.clientOrderId, o]));
  const out: Reconciliation = {
    matched: 0,
    missingAtProvider: [],
    missingLocally: [],
    mismatched: [],
  };
  for (const [cid, lo] of l) {
    const ro = r.get(cid);
    if (!ro) {
      out.missingAtProvider.push(cid);
      continue;
    }
    let bad = false;
    for (const f of ["status", "filledQty", "qty", "symbol", "side"] as const) {
      if (lo[f] !== ro[f]) {
        out.mismatched.push({ clientOrderId: cid, field: f, local: lo[f], remote: ro[f] });
        bad = true;
      }
    }
    if (!bad) out.matched++;
  }
  for (const cid of r.keys()) if (!l.has(cid)) out.missingLocally.push(cid);
  return out;
}
