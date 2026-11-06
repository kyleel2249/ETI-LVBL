import { createFileRoute, Link } from "@tanstack/react-router";
import { queryOptions, useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { Shell, Panel, Delta, StatusDot } from "@/components/eti/Shell";
import { getCryptoTickers, getEquitySnapshots } from "@/lib/eti/market.functions";
import { CRYPTO_WATCHLIST, EQUITY_WATCHLIST } from "@/lib/eti/types";
import { useBinanceLive, fmtPrice, fmtCompact } from "@/lib/eti/live";

const cryptoQ = queryOptions({ queryKey: ["tickers", "crypto"], queryFn: () => getCryptoTickers({ data: { symbols: CRYPTO_WATCHLIST } }), refetchInterval: 60_000 });
const equityQ = queryOptions({ queryKey: ["tickers", "equity"], queryFn: () => getEquitySnapshots({ data: { symbols: EQUITY_WATCHLIST } }), refetchInterval: 60_000 });

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "ETI — Market Monitor" },
      { name: "description", content: "Live multi-asset market monitor powered by Binance and Alpaca data, with breadth and volatility intelligence." },
      { property: "og:title", content: "ETI — Market Monitor" },
      { property: "og:description", content: "Live crypto and equity monitor with real-time streaming prices." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  loader: ({ context }) => context.queryClient.ensureQueryData(cryptoQ).catch(() => null),
  component: Markets,
});

function Markets() {
  const { data: crypto } = useSuspenseQuery(cryptoQ);
  const { data: equity } = useQuery(equityQ);
  const { ticks, status } = useBinanceLive(CRYPTO_WATCHLIST);
  const rows = (crypto ?? []).map((t) => { const k = ticks[t.symbol]; return k ? { ...t, last: k.price, changePct: k.changePct, ts: k.ts } : t; });
  const up = rows.filter((r) => r.changePct > 0).length;
  const avg = rows.reduce((a, r) => a + r.changePct, 0) / (rows.length || 1);
  const range = rows.reduce((a, r) => a + (r.high - r.low) / (r.low || 1), 0) / (rows.length || 1) * 100;
  const leader = [...rows].sort((a, b) => b.changePct - a.changePct)[0];

  return (
    <Shell>
      <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="label-caps mb-1">Multi-asset market monitor</p>
          <h1 className="text-3xl font-semibold tracking-tight">Markets</h1>
        </div>
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <StatusDot state={status === "live" ? "ok" : status === "offline" ? "down" : "warn"} />
          <span className="num">Binance stream: {status}</span>
        </div>
      </div>

      <div className="mb-6 grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Breadth (24h)" value={`${up}/${rows.length}`} sub="advancing" />
        <Stat label="Avg change" value={<Delta v={avg} />} sub="crypto basket" />
        <Stat label="Avg 24h range" value={<span className="num">{range.toFixed(2)}%</span>} sub="volatility proxy" />
        <Stat label="Leader" value={<span className="num">{leader?.symbol.replace("USDT", "") ?? "—"}</span>} sub={leader ? <Delta v={leader.changePct} /> : null} />
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        <Panel title="Crypto · Binance Spot" className="lg:col-span-2" right={<span className="label-caps">source: binance</span>}>
          {!crypto ? <p className="text-sm text-bear">Binance data unavailable right now.</p> : <TickerTable rows={rows} />}
        </Panel>
        <Panel title="Equities & ETFs · Alpaca" right={<span className="label-caps">feed: iex</span>}>
          {!equity ? <p className="text-sm text-muted-foreground">Loading…</p>
            : !equity.configured ? (
              <div className="space-y-2 text-sm">
                <p className="text-muted-foreground">Alpaca is not connected. Equity prices stay empty rather than showing made-up numbers.</p>
                <Link to="/providers" className="text-primary underline-offset-4 hover:underline">Connect Alpaca paper account →</Link>
              </div>
            ) : equity.error ? <p className="text-sm text-bear">{equity.error}</p>
            : <TickerTable rows={equity.tickers} compact />}
        </Panel>
      </div>
    </Shell>
  );
}

function Stat({ label, value, sub }: { label: string; value: React.ReactNode; sub?: React.ReactNode }) {
  return (
    <div className="panel px-4 py-3">
      <p className="label-caps">{label}</p>
      <p className="mt-1 text-2xl font-semibold">{value}</p>
      <p className="text-xs text-muted-foreground">{sub}</p>
    </div>
  );
}

function TickerTable({ rows, compact }: { rows: { symbol: string; last: number; changePct: number; high: number; low: number; quoteVolume: number }[]; compact?: boolean }) {
  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="label-caps text-left">
          <th className="pb-2 font-normal">Symbol</th>
          <th className="pb-2 text-right font-normal">Last</th>
          <th className="pb-2 text-right font-normal">24h</th>
          {!compact && <th className="hidden pb-2 text-right font-normal md:table-cell">Range</th>}
          {!compact && <th className="hidden pb-2 text-right font-normal md:table-cell">Vol (quote)</th>}
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.symbol} className="border-t border-border/60 transition-colors hover:bg-accent/50">
            <td className="py-2">
              <Link to="/asset/$symbol" params={{ symbol: r.symbol }} className="num font-semibold hover:text-primary">{r.symbol}</Link>
            </td>
            <td className="num py-2 text-right">{fmtPrice(r.last)}</td>
            <td className="py-2 text-right"><Delta v={r.changePct} /></td>
            {!compact && <td className="num hidden py-2 text-right text-muted-foreground md:table-cell">{fmtPrice(r.low)} – {fmtPrice(r.high)}</td>}
            {!compact && <td className="num hidden py-2 text-right text-muted-foreground md:table-cell">{fmtCompact(r.quoteVolume)}</td>}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
