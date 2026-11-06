import { createFileRoute, Link } from "@tanstack/react-router";
import { Shell, Panel, Delta } from "@/components/eti/Shell";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { usePaper, pnlOf } from "@/lib/eti/paper";
import { useBinanceLive, fmtPrice } from "@/lib/eti/live";
import { DEFAULT_LIMITS } from "@/lib/eti/risk";

export const Route = createFileRoute("/paper")({
  head: () => ({
    meta: [
      { title: "Paper Trading & Risk — ETI" },
      { name: "description", content: "Paper positions, live P&L, risk limits, kill switch and trading journal." },
      { property: "og:title", content: "Paper Trading & Risk — ETI" },
      { property: "og:description", content: "Risk-gated paper trading desk with journal." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  ssr: false,
  component: PaperDesk,
});

function PaperDesk() {
  const p = usePaper();
  const syms = [...new Set(p.state.positions.map((x) => x.symbol).filter((s) => s.endsWith("USDT")))];
  const { ticks } = useBinanceLive(syms);
  const unreal = p.state.positions.reduce((a, x) => a + (ticks[x.symbol] ? pnlOf(x, ticks[x.symbol]!.price) : 0), 0);
  const equity = p.state.cash + unreal;
  const wins = p.state.history.filter((t) => t.pnl > 0).length;

  return (
    <Shell>
      <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="label-caps mb-1">ETI simulator · stored in this browser</p>
          <h1 className="text-3xl font-semibold tracking-tight">Paper & Risk</h1>
        </div>
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-2 text-sm">
            <Switch checked={p.state.killSwitch} onCheckedChange={p.setKill} />
            <span className={p.state.killSwitch ? "text-bear" : "text-muted-foreground"}>Kill switch</span>
          </label>
          <Button variant="outline" size="sm" onClick={() => confirm("Reset paper account to $100,000?") && p.reset()}>Reset</Button>
        </div>
      </div>

      <div className="mb-6 grid grid-cols-2 gap-3 md:grid-cols-5">
        <Stat k="Equity" v={`$${equity.toLocaleString(undefined, { maximumFractionDigits: 2 })}`} />
        <Stat k="Unrealised" v={<Delta v={unreal} suffix="" />} />
        <Stat k="Realised today" v={<Delta v={p.realizedToday} suffix="" />} />
        <Stat k="Total return" v={<Delta v={((equity - p.state.startingEquity) / p.state.startingEquity) * 100} />} />
        <Stat k="Win rate" v={p.state.history.length ? `${Math.round((wins / p.state.history.length) * 100)}%` : "—"} />
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        <Panel title="Open positions" className="lg:col-span-2">
          {!p.state.positions.length ? (
            <p className="text-sm text-muted-foreground">No open positions. Open a symbol from <Link to="/" className="text-primary">Markets</Link> to place a risk-checked paper order.</p>
          ) : (
            <table className="w-full text-sm">
              <thead><tr className="label-caps text-left"><th className="pb-2 font-normal">Symbol</th><th className="font-normal">Side</th><th className="text-right font-normal">Qty</th><th className="text-right font-normal">Entry</th><th className="text-right font-normal">Mark</th><th className="text-right font-normal">P&L</th><th /></tr></thead>
              <tbody>
                {p.state.positions.map((x) => {
                  const mark = ticks[x.symbol]?.price;
                  return (
                    <tr key={x.id} className="border-t border-border/60">
                      <td className="num py-2">{x.symbol}</td>
                      <td className={x.side === "buy" ? "text-bull" : "text-bear"}>{x.side === "buy" ? "long" : "short"}</td>
                      <td className="num text-right">{x.qty}</td>
                      <td className="num text-right">{fmtPrice(x.entry)}</td>
                      <td className="num text-right">{mark ? fmtPrice(mark) : "—"}</td>
                      <td className="text-right">{mark ? <Delta v={pnlOf(x, mark)} suffix="" /> : "—"}</td>
                      <td className="text-right"><Button size="sm" variant="outline" disabled={!mark} onClick={() => mark && p.close(x.id, mark, "manual")}>Close</Button></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </Panel>
        <Panel title="Risk limits">
          <dl className="space-y-2 text-sm">
            {[
              ["Max risk per trade", `${DEFAULT_LIMITS.maxRiskPerTradePct}% of equity`],
              ["Max position size", `${DEFAULT_LIMITS.maxPositionPct}% of equity`],
              ["Max open positions", DEFAULT_LIMITS.maxOpenPositions],
              ["Daily loss halt", `${DEFAULT_LIMITS.maxDailyLossPct}%`],
              ["Min reward:risk", DEFAULT_LIMITS.minRewardRisk],
              ["Max price age", `${DEFAULT_LIMITS.maxDataAgeMs / 1000}s`],
            ].map(([k, v]) => <div key={k as string} className="flex justify-between"><dt className="text-muted-foreground">{k}</dt><dd className="num">{v}</dd></div>)}
          </dl>
        </Panel>
        <Panel title="Trading journal" className="lg:col-span-3">
          {!p.state.history.length ? <p className="text-sm text-muted-foreground">Closed trades appear here.</p> : (
            <table className="w-full text-sm">
              <thead><tr className="label-caps text-left"><th className="pb-2 font-normal">Closed</th><th className="font-normal">Symbol</th><th className="font-normal">Side</th><th className="text-right font-normal">Entry → Exit</th><th className="text-right font-normal">P&L</th><th className="font-normal pl-4">Thesis</th></tr></thead>
              <tbody>
                {p.state.history.map((t) => (
                  <tr key={t.id} className="border-t border-border/60">
                    <td className="num py-2 text-muted-foreground">{new Date(t.closedAt).toLocaleString()}</td>
                    <td className="num">{t.symbol}</td><td>{t.side === "buy" ? "long" : "short"}</td>
                    <td className="num text-right">{fmtPrice(t.entry)} → {fmtPrice(t.exit)}</td>
                    <td className="text-right"><Delta v={t.pnl} suffix="" /></td>
                    <td className="pl-4 text-xs text-muted-foreground">{t.thesis}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Panel>
      </div>
    </Shell>
  );
}

function Stat({ k, v }: { k: string; v: React.ReactNode }) {
  return <div className="panel px-4 py-3"><p className="label-caps">{k}</p><p className="num mt-1 text-xl font-semibold">{v}</p></div>;
}
