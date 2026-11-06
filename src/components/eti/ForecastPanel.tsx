import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Panel } from "@/components/eti/Shell";
import { Button } from "@/components/ui/button";
import { walkForward, type WalkForward } from "@/lib/eti/backtest";
import { forecast, scoreForecast } from "@/lib/eti/forecast";
import { INTERVAL_MS } from "@/lib/eti/quality";
import { listForecasts, saveForecast } from "@/lib/eti/trading.functions";
import type { Candle, Interval } from "@/lib/eti/types";

const HORIZONS = [6, 12, 24, 48];
const px = (n: number) => n.toLocaleString(undefined, { maximumFractionDigits: n < 10 ? 4 : 2 });
const pct = (n: number) => `${(n * 100).toFixed(0)}%`;

export function ForecastPanel({
  symbol,
  interval,
  candles,
  dataOk,
  className,
}: {
  symbol: string;
  interval: Interval;
  candles: Candle[];
  dataOk: boolean;
  className?: string;
}) {
  const qc = useQueryClient();
  const [h, setH] = useState(12);
  const [wf, setWf] = useState<WalkForward | null>(null);
  const [busy, setBusy] = useState(false);
  const res = useMemo(
    () => (dataOk && candles.length >= 60 ? forecast(candles, { horizonBars: h, interval }) : null),
    [candles, h, interval, dataOk],
  );
  const f = res?.ok ? res.forecast : null;
  const saved = useQuery({
    queryKey: ["forecasts", symbol, interval],
    queryFn: () => listForecasts({ data: { symbol, interval } }),
    retry: 0,
  });

  const validate = () => {
    setBusy(true);
    // yield to the UI before the CPU-heavy rolling evaluation
    setTimeout(() => {
      try {
        setWf(
          walkForward(candles, {
            horizonBars: h,
            interval,
            step: Math.max(1, Math.floor(h / 2)),
            sims: 250,
          }),
        );
      } finally {
        setBusy(false);
      }
    }, 30);
  };
  const record = async () => {
    if (!f) return;
    try {
      const r = await saveForecast({ data: { symbol, interval, forecast: f } });
      toast[r.created ? "success" : "message"](
        r.created ? "Forecast recorded (immutable)" : "This exact forecast was already recorded",
      );
      qc.invalidateQueries({ queryKey: ["forecasts", symbol, interval] });
    } catch (e) {
      toast.error((e as Error).message);
    }
  };
  const tracked = useMemo(() => {
    const rows = (saved.data ?? []).map((r) => ({
      ...r,
      score: scoreForecast(r.forecast, candles, INTERVAL_MS[interval] ?? 3.6e6),
    }));
    const done = rows.filter((r) => r.score.realized !== null);
    return {
      rows,
      done,
      cov90: done.length ? done.filter((r) => r.score.inside90).length / done.length : null,
    };
  }, [saved.data, candles, interval]);

  const badge = wf
    ? { validated: "text-bull", miscalibrated: "text-bear", unvalidated: "text-warn" }[wf.status]
    : "text-muted-foreground";
  return (
    <Panel
      title="Probabilistic forecast"
      className={className ?? ""}
      right={
        <div className="flex items-center gap-1" role="group" aria-label="Forecast horizon (bars)">
          {HORIZONS.map((x) => (
            <Button
              key={x}
              size="sm"
              variant={h === x ? "default" : "outline"}
              onClick={() => {
                setH(x);
                setWf(null);
              }}
            >
              {x}
            </Button>
          ))}
        </div>
      }
    >
      {!dataOk && (
        <p className="text-sm text-muted-foreground">
          Forecasts are withheld while the underlying data is stale, incomplete or invalid.
        </p>
      )}
      {dataOk && res && !res.ok && <p className="text-sm text-muted-foreground">{res.reason}</p>}
      {f && (
        <div className="space-y-5">
          <p className="text-xs text-muted-foreground">
            Distribution of price {h} bars ahead ({f.sims} seeded simulations, model{" "}
            <span className="num">{f.model}</span>). These are probabilities, not predictions.
          </p>
          <dl className="grid grid-cols-2 gap-3 text-sm md:grid-cols-5">
            {(
              [
                ["5%", f.final.p5],
                ["25%", f.final.p25],
                ["Median", f.final.p50],
                ["75%", f.final.p75],
                ["95%", f.final.p95],
              ] as const
            ).map(([k, v]) => (
              <div key={k}>
                <dt className="label-caps">{k}</dt>
                <dd className="num mt-0.5">{px(v)}</dd>
              </div>
            ))}
          </dl>
          <dl className="grid grid-cols-2 gap-3 text-sm md:grid-cols-4">
            <div>
              <dt className="label-caps">P(higher)</dt>
              <dd className="num mt-0.5">{pct(f.probUp)}</dd>
            </div>
            <div>
              <dt className="label-caps">Expected σ ({h} bars)</dt>
              <dd className="num mt-0.5">{f.expectedVolPct.toFixed(2)}%</dd>
            </div>
            {f.scenarios.map((s) => (
              <div key={s.name} className="md:col-span-1">
                <dt className="label-caps">
                  {s.name} · {pct(s.probability)}
                </dt>
                <dd className="num mt-0.5">{px(s.price)}</dd>
              </div>
            ))}
          </dl>
          <div className="rounded-sm border border-border p-3 text-sm">
            <p className="label-caps mb-2">Long plan (ATR-based, R:R {f.plan.rewardRisk})</p>
            <dl className="grid grid-cols-2 gap-3 md:grid-cols-5">
              <div>
                <dt className="text-xs text-muted-foreground">Entry</dt>
                <dd className="num">{px(f.plan.entry)}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">Stop</dt>
                <dd className="num text-bear">{px(f.plan.stop)}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">Target</dt>
                <dd className="num text-bull">{px(f.plan.target)}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">P(target first)</dt>
                <dd className="num">{pct(f.plan.probTargetBeforeStop)}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">P(stop first)</dt>
                <dd className="num">{pct(f.plan.probStopBeforeTarget)}</dd>
              </div>
            </dl>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" variant="outline" onClick={validate} disabled={busy}>
              {busy ? "Validating…" : "Validate (walk-forward)"}
            </Button>
            <Button size="sm" variant="outline" onClick={record}>
              Record forecast
            </Button>
            {wf && <span className={`num text-sm font-medium ${badge}`}>{wf.status}</span>}
          </div>
          {wf && (
            <div className="space-y-1 text-xs text-muted-foreground">
              <p className="num">
                {wf.origins} out-of-sample forecasts · 90% band coverage {pct(wf.coverage90)}{" "}
                (nominal 90%) · 50% band {pct(wf.coverage50)} (nominal 50%) · direction hit-rate{" "}
                {pct(wf.directionalHitRate)}
              </p>
              {wf.notes.map((n, i) => (
                <p key={i}>{n}</p>
              ))}
            </div>
          )}
          {tracked.rows.length > 0 && (
            <p className="text-xs text-muted-foreground">
              Recorded forecasts: {tracked.rows.length}. Resolved: {tracked.done.length}
              {tracked.cov90 !== null ? ` · realized 90% coverage ${pct(tracked.cov90)}` : ""}.
              Records are never edited.
            </p>
          )}
          <details className="text-xs text-muted-foreground">
            <summary className="cursor-pointer">Assumptions and limitations</summary>
            <ul className="list-disc pl-5">
              {[...f.assumptions, ...f.limitations].map((a, i) => (
                <li key={i}>{a}</li>
              ))}
            </ul>
          </details>
        </div>
      )}
    </Panel>
  );
}
