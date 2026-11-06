import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { Shell, Panel, StatusDot } from "@/components/eti/Shell";
import { Button } from "@/components/ui/button";
import { getProviderStatus } from "@/lib/eti/market.functions";

export const Route = createFileRoute("/providers")({
  head: () => ({
    meta: [
      { title: "Provider Diagnostics — ETI" },
      { name: "description", content: "Connection health, latency and entitlement status for Binance and Alpaca." },
      { property: "og:title", content: "Provider Diagnostics — ETI" },
      { property: "og:description", content: "Binance and Alpaca connection centre." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: Providers,
});

function Providers() {
  const q = useQuery({ queryKey: ["providers"], queryFn: () => getProviderStatus(), refetchInterval: 30_000 });
  return (
    <Shell>
      <div className="mb-6 flex items-end justify-between">
        <div>
          <p className="label-caps mb-1">Connection centre</p>
          <h1 className="text-3xl font-semibold tracking-tight">Providers</h1>
        </div>
        <Button variant="outline" size="sm" onClick={() => q.refetch()} disabled={q.isFetching}>{q.isFetching ? "Checking…" : "Re-check"}</Button>
      </div>
      <div className="grid gap-6 md:grid-cols-2">
        {(q.data ?? []).map((p) => (
          <Panel key={p.provider} title={p.provider === "binance" ? "Binance Spot" : "Alpaca"} right={
            <span className="flex items-center gap-2 text-xs"><StatusDot state={!p.configured ? "off" : p.reachable ? "ok" : "down"} /><span className="num">{!p.configured ? "not configured" : p.reachable ? "healthy" : "error"}</span></span>
          }>
            <dl className="space-y-2 text-sm">
              <div className="flex justify-between"><dt className="text-muted-foreground">Mode</dt><dd className="num">{p.mode}</dd></div>
              <div className="flex justify-between"><dt className="text-muted-foreground">Latency</dt><dd className="num">{p.latencyMs != null ? `${p.latencyMs} ms` : "—"}</dd></div>
              <div className="flex justify-between"><dt className="text-muted-foreground">Checked</dt><dd className="num">{new Date(p.checkedAt).toLocaleTimeString()}</dd></div>
              <p className="pt-2 text-xs text-muted-foreground">{p.detail}</p>
            </dl>
          </Panel>
        ))}
        {q.isLoading && <p className="text-sm text-muted-foreground">Checking providers…</p>}
      </div>
      <Panel title="What each provider powers" className="mt-6">
        <ul className="space-y-1 text-sm text-muted-foreground">
          <li><span className="text-foreground">Binance</span> — crypto prices, candles, order book and live streaming. No keys needed for market data.</li>
          <li><span className="text-foreground">Alpaca</span> — US stocks/ETFs and paper account status. Requires paper API keys (separate from live keys).</li>
        </ul>
      </Panel>
    </Shell>
  );
}
