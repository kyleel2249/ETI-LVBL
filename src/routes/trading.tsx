import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { Shell, Panel, StatusDot } from "@/components/eti/Shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { LIVE_CONFIRM_PHRASE } from "@/lib/eti/config";
import {
  cancelOrderFn,
  getTradingStatus,
  getVenueState,
  previewOrder,
  setKill,
  submitOrder,
  syncVenue,
} from "@/lib/eti/trading.functions";
import type { OrderOutcome } from "@/lib/eti/trading.pipeline.server";

export const Route = createFileRoute("/trading")({
  head: () => ({
    meta: [
      { title: "Order Desk — ETI" },
      {
        name: "description",
        content:
          "Risk-gated order tickets for Alpaca paper and Binance testnet, with reconciliation and kill switch.",
      },
      { property: "og:title", content: "Order Desk — ETI" },
      { property: "og:description", content: "Risk-gated provider order desk." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  ssr: false,
  component: Trading,
});

type Provider = "alpaca" | "binance";
type Venue = "paper" | "testnet" | "live";
const newId = () => `eti-${crypto.randomUUID()}`;
const fmt = (n: number | null | undefined, d = 2) =>
  n == null || !Number.isFinite(n)
    ? "—"
    : n.toLocaleString(undefined, { maximumFractionDigits: d });

function Trading() {
  const qc = useQueryClient();
  const status = useQuery({
    queryKey: ["trading-status"],
    queryFn: () => getTradingStatus(),
    refetchInterval: 15_000,
  });
  const [provider, setProvider] = useState<Provider>("binance");
  const [venue, setVenue] = useState<Venue>("testnet");
  const [f, setF] = useState({
    symbol: "BTCUSDT",
    side: "buy" as "buy" | "sell",
    type: "market" as "market" | "limit",
    qty: "",
    limitPrice: "",
    stop: "",
    target: "",
  });
  const [cid, setCid] = useState(newId);
  const [confirm, setConfirm] = useState("");
  const [outcome, setOutcome] = useState<OrderOutcome | null>(null);
  const [previewedSig, setPreviewedSig] = useState<string | null>(null);

  const s = status.data;
  const liveInfo = s ? (provider === "alpaca" ? s.alpaca.live : s.binance.live) : null;
  const venues: Venue[] = provider === "alpaca" ? ["paper", "live"] : ["testnet", "live"];
  const pick = (p: Provider) => {
    setProvider(p);
    setVenue(p === "alpaca" ? "paper" : "testnet");
    setOutcome(null);
    setPreviewedSig(null);
    if (p === "alpaca" && f.symbol.endsWith("USDT")) setF((x) => ({ ...x, symbol: "SPY" }));
    if (p === "binance" && !f.symbol.endsWith("USDT")) setF((x) => ({ ...x, symbol: "BTCUSDT" }));
  };

  const venueQ = useQuery({
    queryKey: ["venue", provider, venue],
    queryFn: () => getVenueState({ data: { provider, venue } }),
    refetchInterval: 20_000,
    retry: 0,
  });
  const payload = useMemo(
    () => ({
      provider,
      venue,
      symbol: f.symbol.trim().toUpperCase(),
      side: f.side,
      type: f.type,
      qty: Number(f.qty),
      stop: Number(f.stop),
      target: Number(f.target),
      clientOrderId: cid,
      ...(f.type === "limit" && f.limitPrice ? { limitPrice: Number(f.limitPrice) } : {}),
      ...(venue === "live" ? { confirmLive: confirm } : {}),
    }),
    [provider, venue, f, cid, confirm],
  );
  const sig = JSON.stringify({ ...payload, confirmLive: undefined });
  const valid =
    [payload.qty, payload.stop, payload.target].every((n) => Number.isFinite(n) && n > 0) &&
    payload.symbol.length > 0;

  const check = useMutation({
    mutationFn: () => previewOrder({ data: payload }),
    onSuccess: (o) => {
      setOutcome(o);
      setPreviewedSig(o.status === "preview_ok" ? sig : null);
    },
    onError: (e) => toast.error((e as Error).message),
  });
  const submit = useMutation({
    mutationFn: () => submitOrder({ data: payload }),
    onSuccess: (o) => {
      setOutcome(o);
      setPreviewedSig(null);
      qc.invalidateQueries({ queryKey: ["venue"] });
      if (o.status === "submitted")
        toast.success(`Order ${o.order?.providerStatus ?? "submitted"} on ${venue}`);
      else if (o.status === "duplicate") toast.message("Already submitted — nothing sent again");
      else toast.error(o.reasons[0] ?? "Order not placed");
    },
    onError: (e) => toast.error((e as Error).message),
  });
  const kill = useMutation({
    mutationFn: (enabled: boolean) => setKill({ data: { enabled } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["trading-status"] }),
  });
  const sync = useMutation({
    mutationFn: () => syncVenue({ data: { provider, venue } }),
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ["venue"] });
      toast.message(
        `Checked ${r.checked}, updated ${r.updated}${r.errors.length ? `, ${r.errors.length} error(s)` : ""}`,
      );
    },
    onError: (e) => toast.error((e as Error).message),
  });
  const cancel = useMutation({
    mutationFn: (clientOrderId: string) =>
      cancelOrderFn({ data: { provider, venue, clientOrderId } }),
    onSuccess: (r) => {
      if (r.ok) toast.success(r.message);
      else toast.error(r.message);
      qc.invalidateQueries({ queryKey: ["venue"] });
    },
  });

  const canSubmit =
    valid &&
    previewedSig === sig &&
    !submit.isPending &&
    (venue !== "live" || confirm === LIVE_CONFIRM_PHRASE);
  const keys = s
    ? provider === "alpaca"
      ? venue === "paper"
        ? s.alpaca.paperKeys
        : s.alpaca.liveKeys
      : venue === "testnet"
        ? s.binance.testnetKeys
        : s.binance.liveKeys
    : false;
  const set =
    (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
      setF((x) => ({ ...x, [k]: e.target.value }));
      setPreviewedSig(null);
    };
  const sel = "h-9 w-full rounded-sm border border-border bg-background px-2 text-sm";

  return (
    <Shell>
      <div className="mb-6">
        <p className="label-caps mb-1">Risk-gated execution</p>
        <h1 className="text-3xl font-semibold tracking-tight">Order desk</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Every order passes instrument checks, fresh server-side pricing, the risk engine and
          (where available) exchange validation before it is sent.
        </p>
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        <Panel
          title="Safety"
          className="lg:col-span-1"
          right={
            <span className="flex items-center gap-2 text-xs">
              <StatusDot state={s?.killSwitch ? "down" : "ok"} />
              <span className="num">{s?.killSwitch ? "halted" : "armed"}</span>
            </span>
          }
        >
          <dl className="space-y-3 text-sm">
            <div className="flex items-center justify-between">
              <dt>Kill switch (blocks all orders)</dt>
              <dd>
                <Switch
                  checked={!!s?.killSwitch}
                  onCheckedChange={(v) => kill.mutate(v)}
                  disabled={!s || kill.isPending}
                  aria-label="Kill switch"
                />
              </dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-muted-foreground">Live trading</dt>
              <dd className="num">
                {s?.liveTradingEnabled ? "enabled by config" : "off (default)"}
              </dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-muted-foreground">Max risk / trade</dt>
              <dd className="num">{s?.limits.maxRiskPerTradePct ?? 1}% equity</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-muted-foreground">Storage</dt>
              <dd className="num">
                {s ? `${s.storage.kind}${s.storage.durable ? "" : " (not durable)"}` : "—"}
              </dd>
            </div>
            {liveInfo && (
              <p className="text-xs text-muted-foreground">
                Live on {provider}:{" "}
                {liveInfo.allowed
                  ? "permitted by configuration — each live order still needs the confirmation phrase and risk approval."
                  : liveInfo.reason}
              </p>
            )}
          </dl>
        </Panel>

        <Panel title="Order ticket" className="lg:col-span-2">
          <div className="mb-4 flex flex-wrap gap-2">
            {(["binance", "alpaca"] as Provider[]).map((p) => (
              <Button
                key={p}
                size="sm"
                variant={provider === p ? "default" : "outline"}
                onClick={() => pick(p)}
              >
                {p === "binance" ? "Binance Spot" : "Alpaca"}
              </Button>
            ))}
            <span className="mx-1 w-px bg-border" />
            {venues.map((v) => (
              <Button
                key={v}
                size="sm"
                variant={venue === v ? "default" : "outline"}
                onClick={() => {
                  setVenue(v);
                  setOutcome(null);
                  setPreviewedSig(null);
                }}
              >
                {v}
              </Button>
            ))}
          </div>
          {!keys && s && (
            <p className="mb-3 rounded-sm border border-border p-2 text-xs text-muted-foreground">
              {provider} {venue} credentials are not configured on the server — see
              docs/API_SETUP.md. You can still build a ticket, but checks will report this.
            </p>
          )}
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <label className="text-xs">
              Symbol
              <Input value={f.symbol} onChange={set("symbol")} className="num mt-1" />
            </label>
            <label className="text-xs">
              Side
              <select value={f.side} onChange={set("side")} className={`${sel} mt-1`}>
                <option value="buy">buy</option>
                <option value="sell">sell</option>
              </select>
            </label>
            <label className="text-xs">
              Type
              <select value={f.type} onChange={set("type")} className={`${sel} mt-1`}>
                <option value="market">market</option>
                <option value="limit">limit</option>
              </select>
            </label>
            <label className="text-xs">
              Quantity
              <Input inputMode="decimal" value={f.qty} onChange={set("qty")} className="num mt-1" />
            </label>
            {f.type === "limit" && (
              <label className="text-xs">
                Limit price
                <Input
                  inputMode="decimal"
                  value={f.limitPrice}
                  onChange={set("limitPrice")}
                  className="num mt-1"
                />
              </label>
            )}
            <label className="text-xs">
              Stop-loss
              <Input
                inputMode="decimal"
                value={f.stop}
                onChange={set("stop")}
                className="num mt-1"
              />
            </label>
            <label className="text-xs">
              Take-profit
              <Input
                inputMode="decimal"
                value={f.target}
                onChange={set("target")}
                className="num mt-1"
              />
            </label>
          </div>
          {venue === "live" && (
            <label className="mt-3 block text-xs">
              Type <span className="num text-primary">{LIVE_CONFIRM_PHRASE}</span> to confirm a
              real-money order
              <Input
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                className="num mt-1"
              />
            </label>
          )}
          <div className="mt-4 flex flex-wrap items-center gap-2">
            <Button
              variant="outline"
              onClick={() => check.mutate()}
              disabled={!valid || check.isPending}
            >
              {check.isPending ? "Checking…" : "1 · Check order"}
            </Button>
            <Button onClick={() => submit.mutate()} disabled={!canSubmit} className="glow">
              {submit.isPending ? "Sending…" : `2 · Submit to ${venue}`}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setCid(newId());
                setOutcome(null);
                setPreviewedSig(null);
              }}
            >
              New ticket
            </Button>
            <span
              className="num ml-auto truncate text-[10px] text-muted-foreground"
              title="Idempotency key"
            >
              {cid}
            </span>
          </div>

          {outcome && (
            <div className="mt-4 space-y-3 border-t border-border pt-4 text-sm" role="status">
              <p className="flex items-center gap-2 font-medium">
                <StatusDot
                  state={
                    outcome.status === "preview_ok" || outcome.status === "submitted"
                      ? "ok"
                      : outcome.status === "duplicate"
                        ? "warn"
                        : "down"
                  }
                />
                {
                  {
                    preview_ok: "Checks passed — ready to submit",
                    submitted: "Submitted",
                    rejected: "Rejected — nothing was sent",
                    duplicate: "Duplicate — nothing was sent",
                    failed: "Provider error",
                  }[outcome.status]
                }
              </p>
              {outcome.reasons.length > 0 && (
                <ul className="list-disc space-y-0.5 pl-5 text-xs text-bear">
                  {outcome.reasons.map((r, i) => (
                    <li key={i}>{r}</li>
                  ))}
                </ul>
              )}
              {outcome.gate && (
                <ul className="grid gap-x-6 gap-y-1 text-xs md:grid-cols-2">
                  {outcome.gate.checks.map((c) => (
                    <li key={c.rule} className="flex justify-between gap-3">
                      <span className={c.pass ? "text-bull" : "text-bear"}>
                        {c.pass ? "✓" : "✗"} {c.rule}
                      </span>
                      <span className="num text-muted-foreground">{c.detail}</span>
                    </li>
                  ))}
                </ul>
              )}
              {outcome.prepared && (
                <p className="num text-xs text-muted-foreground">
                  Prepared qty {outcome.prepared.qty}
                  {outcome.prepared.price ? ` @ ${outcome.prepared.price}` : ""} · reference{" "}
                  {fmt(outcome.refPrice, 4)} ·{" "}
                  {outcome.prepared.exchangeValidated
                    ? "exchange-validated"
                    : "risk-gate validated"}
                </p>
              )}
              {outcome.order && (
                <p className="num text-xs">
                  Order {outcome.order.id}: {outcome.order.status} · filled{" "}
                  {outcome.order.filledQty}/{outcome.order.qty}
                  {outcome.order.avgFillPrice ? ` @ ${fmt(outcome.order.avgFillPrice, 4)}` : ""}
                </p>
              )}
              {outcome.assumptions.length > 0 && (
                <details className="text-xs text-muted-foreground">
                  <summary className="cursor-pointer">Assumptions</summary>
                  <ul className="list-disc pl-5">
                    {outcome.assumptions.map((a, i) => (
                      <li key={i}>{a}</li>
                    ))}
                  </ul>
                </details>
              )}
            </div>
          )}
        </Panel>

        <Panel title={`${provider} ${venue} account`} className="lg:col-span-1">
          {venueQ.isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
          {venueQ.data && !venueQ.data.ok && (
            <p className="text-sm text-muted-foreground">{venueQ.data.error}</p>
          )}
          {venueQ.data?.ok && (
            <dl className="space-y-2 text-sm">
              <div className="flex justify-between">
                <dt className="text-muted-foreground">{venueQ.data.equityLabel}</dt>
                <dd className="num">{fmt(venueQ.data.equity)}</dd>
              </div>
              {"buyingPower" in venueQ.data.account && (
                <div className="flex justify-between">
                  <dt className="text-muted-foreground">Buying power</dt>
                  <dd className="num">{fmt(venueQ.data.account.buyingPower)}</dd>
                </div>
              )}
              {"dayPnl" in venueQ.data.account && (
                <div className="flex justify-between">
                  <dt className="text-muted-foreground">Day P&L</dt>
                  <dd className="num">{fmt(venueQ.data.account.dayPnl)}</dd>
                </div>
              )}
              {venueQ.data.balances.map((b) => (
                <div key={b.asset} className="flex justify-between">
                  <dt className="text-muted-foreground">{b.asset}</dt>
                  <dd className="num">
                    {fmt(b.free, 8)}
                    {b.locked ? ` (+${fmt(b.locked, 8)} locked)` : ""}
                  </dd>
                </div>
              ))}
              {venueQ.data.positions.map((p) => (
                <div key={p.symbol} className="flex justify-between">
                  <dt>
                    {p.symbol} {p.side}
                  </dt>
                  <dd className="num">
                    {p.qty} · P&L {fmt(p.unrealizedPl)}
                  </dd>
                </div>
              ))}
              {venueQ.data.positions.length === 0 && provider === "alpaca" && (
                <p className="text-xs text-muted-foreground">No open positions.</p>
              )}
            </dl>
          )}
        </Panel>

        <Panel
          title="Orders (tracked by ETI)"
          className="lg:col-span-2"
          right={
            <Button
              size="sm"
              variant="outline"
              onClick={() => sync.mutate()}
              disabled={sync.isPending}
            >
              {sync.isPending ? "Syncing…" : "Sync with provider"}
            </Button>
          }
        >
          {(venueQ.data?.orders.length ?? 0) === 0 ? (
            <p className="text-sm text-muted-foreground">
              No orders submitted from ETI on this venue yet.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="label-caps text-left">
                    <th className="py-1">Time</th>
                    <th>Symbol</th>
                    <th>Side</th>
                    <th className="text-right">Qty</th>
                    <th>Status</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {venueQ.data!.orders.map((o) => (
                    <tr key={o.key} className="border-t border-border">
                      <td className="num py-2 text-muted-foreground">
                        {new Date(o.at).toLocaleString()}
                      </td>
                      <td className="num">{o.req.symbol}</td>
                      <td>{o.req.side}</td>
                      <td className="num text-right">
                        {o.order?.filledQty ?? 0}/{o.order?.qty ?? o.req.qty}
                      </td>
                      <td className="num">
                        {o.status === "failed" ? (
                          <span className="text-bear" title={o.error ?? ""}>
                            failed
                          </span>
                        ) : (
                          (o.order?.status ?? o.status)
                        )}
                      </td>
                      <td className="text-right">
                        {o.order &&
                          !["filled", "canceled", "rejected", "expired"].includes(
                            o.order.status,
                          ) && (
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() => cancel.mutate(o.req.clientOrderId)}
                            >
                              Cancel
                            </Button>
                          )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {sync.data &&
            (sync.data.reconciliation.missingAtProvider.length > 0 ||
              sync.data.reconciliation.mismatched.length > 0 ||
              sync.data.errors.length > 0) && (
              <div className="mt-3 rounded-sm border border-border p-2 text-xs">
                <p className="font-medium">Reconciliation differences</p>
                <ul className="list-disc pl-5 text-muted-foreground">
                  {sync.data.errors.map((e, i) => (
                    <li key={i}>{e}</li>
                  ))}
                  {sync.data.reconciliation.mismatched.map((m, i) => (
                    <li key={`m${i}`}>
                      {m.clientOrderId}: {m.field} local {String(m.local)} vs provider{" "}
                      {String(m.remote)}
                    </li>
                  ))}
                </ul>
              </div>
            )}
        </Panel>
      </div>
    </Shell>
  );
}
