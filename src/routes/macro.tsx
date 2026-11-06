import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { Shell, Panel, StatusDot } from "@/components/eti/Shell";
import { Button } from "@/components/ui/button";
import { getMacro } from "@/lib/eti/trading.functions";

export const Route = createFileRoute("/macro")({
  head: () => ({
    meta: [
      { title: "Macro Backdrop — ETI" },
      {
        name: "description",
        content: "FRED economic indicators: rates, inflation, labour and the yield curve.",
      },
      { property: "og:title", content: "Macro Backdrop — ETI" },
      { property: "og:description", content: "Economic indicators from FRED." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  ssr: false,
  component: Macro,
});

function Macro() {
  const q = useQuery({
    queryKey: ["macro"],
    queryFn: () => getMacro(),
    staleTime: 3_600_000,
    retry: 0,
  });
  const d = q.data;
  const tone = (s: string) =>
    s === "risk-on" ? "text-bull" : s === "risk-off" ? "text-bear" : "text-muted-foreground";
  return (
    <Shell>
      <div className="mb-6 flex items-end justify-between">
        <div>
          <p className="label-caps mb-1">Economic data · FRED</p>
          <h1 className="text-3xl font-semibold tracking-tight">Macro backdrop</h1>
        </div>
        <Button variant="outline" size="sm" onClick={() => q.refetch()} disabled={q.isFetching}>
          {q.isFetching ? "Loading…" : "Refresh"}
        </Button>
      </div>
      {q.isLoading && <p className="text-sm text-muted-foreground">Loading indicators…</p>}
      {q.error && <p className="text-sm text-bear">{(q.error as Error).message}</p>}
      {d && !d.configured && (
        <Panel title="FRED not configured">
          <p className="text-sm text-muted-foreground">
            Add a free <span className="num">FRED_API_KEY</span> (fred.stlouisfed.org → My Account →
            API Keys) to your <span className="num">.env</span> and restart. ETI shows no macro
            figures until then — nothing is simulated.
          </p>
        </Panel>
      )}
      {d?.configured && !d.snapshot && (
        <Panel title="No data">
          <p className="text-sm text-bear">FRED returned no usable series.</p>
          <ul className="mt-2 text-xs text-muted-foreground">
            {Object.entries(d.errors).map(([k, v]) => (
              <li key={k}>
                {k}: {v}
              </li>
            ))}
          </ul>
        </Panel>
      )}
      {d?.snapshot && (
        <div className="grid gap-6 lg:grid-cols-3">
          <Panel
            title="Backdrop"
            right={
              <span className={`num text-sm font-semibold ${tone(d.snapshot.backdrop)}`}>
                {d.snapshot.backdrop}
              </span>
            }
            className="lg:col-span-1"
          >
            <ul className="space-y-3 text-sm">
              {d.snapshot.signals.map((s) => (
                <li key={s.id}>
                  <div className="flex justify-between">
                    <span>{s.label}</span>
                    <span className={`num ${tone(s.stance)}`}>{s.stance}</span>
                  </div>
                  <p className="text-xs text-muted-foreground">{s.evidence}</p>
                </li>
              ))}
            </ul>
            <ul className="mt-4 list-disc space-y-1 pl-5 text-xs text-muted-foreground">
              {d.snapshot.limitations.map((l, i) => (
                <li key={i}>{l}</li>
              ))}
            </ul>
          </Panel>
          <Panel title="Indicators" className="lg:col-span-2">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="label-caps text-left">
                    <th className="py-1">Series</th>
                    <th className="text-right">Latest</th>
                    <th className="text-right">Change</th>
                    <th className="text-right">YoY</th>
                    <th className="text-right">As of</th>
                  </tr>
                </thead>
                <tbody>
                  {d.snapshot.series.map((s) => (
                    <tr key={s.id} className="border-t border-border">
                      <td className="py-2">
                        {s.label}
                        <span className="num ml-2 text-xs text-muted-foreground">{s.id}</span>
                      </td>
                      <td className="num text-right">
                        {s.latest.toLocaleString(undefined, { maximumFractionDigits: 2 })}{" "}
                        <span className="text-xs text-muted-foreground">{s.unit}</span>
                      </td>
                      <td className="num text-right">
                        {s.change == null ? "—" : (s.change >= 0 ? "+" : "") + s.change.toFixed(2)}
                      </td>
                      <td className="num text-right">
                        {s.yoyPct == null ? "—" : s.yoyPct.toFixed(1) + "%"}
                      </td>
                      <td className="num text-right text-muted-foreground">
                        <span className="inline-flex items-center gap-1.5">
                          <StatusDot state={s.stale ? "warn" : "ok"} />
                          {s.date}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Panel>
        </div>
      )}
    </Shell>
  );
}
