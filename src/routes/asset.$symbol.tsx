import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { ComposedChart, Area, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, Bar } from "recharts";
import { toast } from "sonner";
import { Shell, Panel, Delta } from "@/components/eti/Shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { getCandles, getOrderBook } from "@/lib/eti/market.functions";
import { runCouncil, type CouncilVerdict } from "@/lib/eti/council.functions";
import { snapshot, sma } from "@/lib/eti/indicators";
import { assessCandles, dataStatusOf } from "@/lib/eti/quality";
import { decide, type DataStatus } from "@/lib/eti/decision";
import { ForecastPanel } from "@/components/eti/ForecastPanel";
import { getMacro } from "@/lib/eti/trading.functions";
import { evaluateTrade, suggestQty } from "@/lib/eti/risk";
import { usePaper } from "@/lib/eti/paper";
import { useBinanceLive, useBinanceMarketStream, fmtPrice } from "@/lib/eti/live";
import { mergeKline } from "@/lib/eti/stream";
import { analyzeBook } from "@/lib/eti/orderbook";
import { INTERVALS, type Interval } from "@/lib/eti/types";

export const Route = createFileRoute("/asset/$symbol")({
  head: ({ params }) => ({
    meta: [
      { title: `${params.symbol} intelligence — ETI` },
      { name: "description", content: `Technical snapshot, order-book liquidity, AI council verdict and paper trading for ${params.symbol}.` },
      { property: "og:title", content: `${params.symbol} intelligence — ETI` },
      { property: "og:description", content: `Measured indicators and AI council analysis for ${params.symbol}.` },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  ssr: false,
  component: Asset,
});

function Asset() {
  const { symbol } = Route.useParams();
  const isCrypto = symbol.endsWith("USDT");
  const [interval, setInterval] = useState<Interval>("1h");
  const candlesQ = useQuery({ queryKey: ["candles", symbol, interval], queryFn: () => getCandles({ data: { symbol, interval } }), refetchInterval: 60_000, retry: 1 });
  const bookQ = useQuery({ queryKey: ["book", symbol], queryFn: () => getOrderBook({ data: { symbol } }), refetchInterval: 5_000, enabled: isCrypto });
  const { ticks, status } = useBinanceLive(isCrypto ? [symbol] : []);

  const stream = useBinanceMarketStream(isCrypto ? symbol : null, interval);
  const candles = useMemo(() => mergeKline(candlesQ.data?.candles ?? [], isCrypto ? stream.state.kline : null), [candlesQ.data, stream.state.kline, isCrypto]);
  const snap = useMemo(() => (candles.length > 30 ? snapshot(candles) : null), [candles]);
  const quality = useMemo(() => assessCandles(candles, interval), [candles, interval]);
  const dataStatus = useMemo(() => dataStatusOf(quality), [quality]);
  const macroQ = useQuery({ queryKey: ["macro"], queryFn: () => getMacro(), staleTime: 3_600_000, retry: 0 });
  const macro = useMemo(() => (macroQ.data?.snapshot ? { backdrop: macroQ.data.snapshot.backdrop, signals: macroQ.data.snapshot.signals.map((x) => `${x.label}: ${x.stance} — ${x.evidence}`), limitations: macroQ.data.snapshot.limitations } : null), [macroQ.data]);
  const live = ticks[symbol]?.price ?? snap?.last ?? 0;
  const liveTs = ticks[symbol]?.ts ?? candles.at(-1)?.t ?? 0;

  const liveDepth = stream.status === "live" ? stream.state.depth : null;
  const bookSrc = liveDepth ?? bookQ.data;
  const book = useMemo(() => {
    const b = bookSrc;
    if (!b || !b.bids.length || !b.asks.length) return null;
    const bidV = b.bids.reduce((a, [p, q]) => a + p * q, 0), askV = b.asks.reduce((a, [p, q]) => a + p * q, 0);
    const mid = (b.bids[0]![0] + b.asks[0]![0]) / 2;
    return { bidV, askV, imbalance: (bidV - askV) / (bidV + askV), spreadBps: ((b.asks[0]![0] - b.bids[0]![0]) / mid) * 1e4, top: b, analytics: analyzeBook(b), source: liveDepth ? "live stream" : "REST snapshot" };
  }, [bookSrc, liveDepth]);

  const chart = useMemo(() => {
    const closes = candles.map((c) => c.c);
    const s20 = sma(closes, 20), s50 = sma(closes, 50);
    return candles.slice(-150).map((c, i, arr) => {
      const idx = candles.length - arr.length + i;
      return { t: c.t, c: c.c, v: c.v, s20: s20[idx], s50: s50[idx] };
    });
  }, [candles]);

  return (
    <Shell>
      <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <Link to="/" className="label-caps hover:text-foreground">← Markets</Link>
          <h1 className="num mt-1 text-3xl font-bold">{symbol}</h1>
          <div className="mt-1 flex items-baseline gap-3">
            <span className="num text-2xl">{fmtPrice(live)}</span>
            {ticks[symbol] && <Delta v={ticks[symbol].changePct} />}
            <span className="label-caps">{isCrypto ? `stream ${status}` : "polling"} · {candlesQ.data?.source ?? "—"}</span>
          </div>
        </div>
        <div className="flex gap-1">
          {INTERVALS.map((i) => (
            <Button key={i} size="sm" variant={i === interval ? "default" : "outline"} onClick={() => setInterval(i)} className="num">{i}</Button>
          ))}
        </div>
      </div>

      {candlesQ.error && <Panel className="mb-6"><p className="text-sm text-bear">{(candlesQ.error as Error).message}</p></Panel>}

      <div className="grid gap-6 lg:grid-cols-3">
        <Panel title="Price · SMA20 · SMA50" className="lg:col-span-2" right={<span className="label-caps">data quality {quality.score}/100</span>}>
          <div className="h-80">
            <ResponsiveContainer>
              <ComposedChart data={chart}>
                <defs>
                  <linearGradient id="px" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="var(--chart-1)" stopOpacity={0.35} />
                    <stop offset="100%" stopColor="var(--chart-1)" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <XAxis dataKey="t" tickFormatter={(t) => new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric" })} stroke="var(--muted-foreground)" fontSize={11} minTickGap={40} />
                <YAxis yAxisId="p" domain={["auto", "auto"]} orientation="right" stroke="var(--muted-foreground)" fontSize={11} tickFormatter={(v) => fmtPrice(v)} width={80} />
                <YAxis yAxisId="v" hide domain={[0, (m: number) => m * 4]} />
                <Tooltip contentStyle={{ background: "var(--popover)", border: "1px solid var(--border)", fontSize: 12 }} labelFormatter={(t) => new Date(t).toUTCString()} formatter={(v: number) => fmtPrice(v)} />
                <Bar yAxisId="v" dataKey="v" fill="var(--chart-5)" opacity={0.35} />
                <Area yAxisId="p" dataKey="c" stroke="var(--chart-1)" fill="url(#px)" strokeWidth={1.5} dot={false} isAnimationActive={false} />
                <Line yAxisId="p" dataKey="s20" stroke="var(--chart-2)" dot={false} strokeWidth={1} isAnimationActive={false} />
                <Line yAxisId="p" dataKey="s50" stroke="var(--chart-3)" dot={false} strokeWidth={1} isAnimationActive={false} />
              </ComposedChart>
            </ResponsiveContainer>
          </div>
          {quality.issues.length > 0 && <p className="mt-2 text-xs text-warn">Data notes: {quality.issues.join(" · ")}</p>}
        </Panel>

        <Panel title="Technical snapshot">
          {!snap ? <p className="text-sm text-muted-foreground">Loading measured indicators…</p> : (
            <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
              <Kv k="Trend" v={<span className={snap.trend === "up" ? "text-bull" : snap.trend === "down" ? "text-bear" : ""}>{snap.trend}</span>} />
              <Kv k="Regime" v={snap.regime} />
              <Kv k="RSI 14" v={snap.rsi?.toFixed(1) ?? "—"} />
              <Kv k="MACD hist" v={snap.macd.hist?.toFixed(4) ?? "—"} />
              <Kv k="ATR %" v={snap.atrPct ? `${snap.atrPct.toFixed(2)}%` : "—"} />
              <Kv k="Volatility" v={snap.volPct ? `${snap.volPct.toFixed(2)}%` : "—"} />
              <Kv k="Support" v={fmtPrice(snap.support)} />
              <Kv k="Resistance" v={fmtPrice(snap.resistance)} />
              <Kv k="EMA 200" v={snap.ema200 ? fmtPrice(snap.ema200) : "—"} />
              <Kv k="Volume z" v={snap.volumeZ?.toFixed(2) ?? "—"} />
              <Kv k="Max drawdown" v={`${snap.maxDrawdownPct.toFixed(1)}%`} />
              <Kv k="Candles" v={quality.count} />
            </dl>
          )}
        </Panel>

        {isCrypto && (
          <Panel title="Order book liquidity" right={<span className="label-caps">{book ? `${book.top.bids.length} levels · ${book.source}` : "connecting"}</span>}>
            {!book ? <p className="text-sm text-muted-foreground">Loading depth…</p> : (
              <div className="space-y-3 text-sm">
                <div className="flex h-2 overflow-hidden rounded-sm">
                  <div className="bg-bull" style={{ width: `${(book.bidV / (book.bidV + book.askV)) * 100}%` }} />
                  <div className="flex-1 bg-bear" />
                </div>
                <dl className="grid grid-cols-2 gap-3">
                  <Kv k="Imbalance" v={<Delta v={book.imbalance * 100} />} />
                  <Kv k="Spread" v={`${book.spreadBps.toFixed(2)} bps`} />
                  <Kv k="Bid depth" v={`$${Math.round(book.bidV).toLocaleString()}`} />
                  <Kv k="Ask depth" v={`$${Math.round(book.askV).toLocaleString()}`} />
                  {book.analytics && <Kv k="Large orders (≥5× median)" v={book.analytics.largeOrders.length ? `${book.analytics.largeOrders.length} · biggest ${book.analytics.largeOrders[0]!.side} @ ${fmtPrice(book.analytics.largeOrders[0]!.price)}` : "none observed"} />}
                  {book.analytics && <Kv k="Top-3 concentration" v={`bid ${(book.analytics.concentration.bid * 100).toFixed(0)}% · ask ${(book.analytics.concentration.ask * 100).toFixed(0)}%`} />}
                </dl>
                <div className="num grid grid-cols-2 gap-2 text-xs">
                  <div>{book.top.bids.slice(0, 6).map(([p, q]) => <div key={p} className="flex justify-between text-bull"><span>{fmtPrice(p)}</span><span className="text-muted-foreground">{q.toFixed(4)}</span></div>)}</div>
                  <div>{book.top.asks.slice(0, 6).map(([p, q]) => <div key={p} className="flex justify-between text-bear"><span>{fmtPrice(p)}</span><span className="text-muted-foreground">{q.toFixed(4)}</span></div>)}</div>
                </div>
              </div>
            )}
          </Panel>
        )}

        <CouncilPanel symbol={symbol} interval={interval} source={candlesQ.data?.source ?? ""} snap={snap} quality={quality} dataStatus={dataStatus} macro={macro} book={book ? { imbalance: book.imbalance, spreadBps: book.spreadBps } : null} className={isCrypto ? "lg:col-span-2" : "lg:col-span-3"} />
        <ForecastPanel symbol={symbol} interval={interval} candles={candles} dataOk={dataStatus === "fresh" || dataStatus === "incomplete"} className="lg:col-span-3" />

        <TicketPanel symbol={symbol} price={live} priceTs={liveTs} atr={snap?.atr ?? null} />
      </div>
    </Shell>
  );
}

function Kv({ k, v }: { k: string; v: React.ReactNode }) {
  return <div><dt className="label-caps">{k}</dt><dd className="num mt-0.5">{v}</dd></div>;
}

function CouncilPanel({ symbol, interval, source, snap, quality, dataStatus, macro, book, className }: { dataStatus: DataStatus; macro: { backdrop: string; signals: string[]; limitations: string[] } | null; symbol: string; interval: string; source: string; snap: ReturnType<typeof snapshot> | null; quality: { score: number; issues: string[] }; book: { imbalance: number; spreadBps: number } | null; className?: string }) {
  const [verdict, setVerdict] = useState<CouncilVerdict | null>(null);
  const [busy, setBusy] = useState(false);
  const convene = async () => {
    if (!snap) return;
    setBusy(true);
    try {
      setVerdict(await runCouncil({ data: { symbol, interval, source, snapshot: { ...(snap as unknown as Record<string, unknown>), ...(macro ? { macro } : {}) }, quality, book } }));
    } catch (e) { toast.error((e as Error).message); }
    finally { setBusy(false); }
  };
  const decision = verdict ? decide({ members: verdict.members, dataStatus, qualityScore: quality.score, risk: null }) : null;
  const dTone = decision ? (/BUY/.test(decision.decision) ? "text-bull" : /SELL/.test(decision.decision) ? "text-bear" : "text-warn") : "";
  const tone = (s: string) => (s === "bullish" ? "text-bull" : s === "bearish" ? "text-bear" : "text-muted-foreground");
  return (
    <Panel title="AI Trading Council · 12 analysts" className={className ?? ""}
      right={<Button size="sm" onClick={convene} disabled={!snap || busy} className="glow">{busy ? "Deliberating…" : verdict ? "Reconvene" : "Convene council"}</Button>}>
      {!verdict ? (
        <p className="text-sm text-muted-foreground">The council reviews only the measured indicators, data quality and liquidity on this page — no invented news or prices.</p>
      ) : (
        <div className="space-y-5">
          <div className="flex flex-wrap items-baseline gap-4">
            <span className={`text-2xl font-semibold capitalize ${tone(verdict.consensus)}`}>{verdict.consensus}</span>
            <span className="num text-sm text-muted-foreground">{Math.round(verdict.confidence)}% confidence</span>
          </div>
          {decision && (
            <div className="rounded-sm border border-border p-3" role="status">
              <div className="flex items-baseline justify-between"><span className="label-caps">ETI decision (evidence-weighted, risk-gated)</span><span className={`num text-lg font-semibold ${dTone}`}>{decision.decision}</span></div>
              <ul className="mt-1 list-disc pl-5 text-xs text-muted-foreground">{decision.rationale.map((r, i) => <li key={i}>{r}</li>)}</ul>
              {decision.dissenters.length > 0 && <p className="mt-1 text-xs text-muted-foreground">Dissent: {decision.dissenters.join(", ")}</p>}
            </div>
          )}
          <div className="grid gap-3 md:grid-cols-3">
            {verdict.scenarios.map((s) => (
              <div key={s.name} className="rounded-sm border border-border p-3">
                <div className="flex justify-between"><span className="text-sm font-medium">{s.name}</span><span className="num text-sm text-primary">{Math.round(s.probability)}%</span></div>
                <p className="mt-1 text-xs text-muted-foreground">{s.description}</p>
              </div>
            ))}
          </div>
          <dl className="grid gap-3 text-sm md:grid-cols-4">
            <Kv k="Bias" v={verdict.plan.bias} /><Kv k="Entry zone" v={verdict.plan.entryZone} />
            <Kv k="Invalidation" v={verdict.plan.invalidation} /><Kv k="Targets" v={verdict.plan.targets} />
          </dl>
          <div className="grid gap-2 md:grid-cols-2">
            {verdict.members.map((m) => (
              <div key={m.role} className="border-l-2 border-border pl-3">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="text-sm font-medium">{m.role}</span>
                  <span className={`num text-xs capitalize ${tone(m.stance)}`}>{m.stance} · {Math.round(m.confidence)}%</span>
                </div>
                <p className="text-xs text-muted-foreground">{m.reasoning}</p>
              </div>
            ))}
          </div>
          <p className="text-xs text-warn">Dissent: {verdict.dissent}</p>
          <p className="text-xs text-muted-foreground">{verdict.disclaimer}</p>
        </div>
      )}
    </Panel>
  );
}

function TicketPanel({ symbol, price, priceTs, atr }: { symbol: string; price: number; priceTs: number; atr: number | null }) {
  const paper = usePaper();
  const [side, setSide] = useState<"buy" | "sell">("buy");
  const dist = atr ? atr * 1.5 : price * 0.02;
  const [stopIn, setStop] = useState("");
  const [targetIn, setTarget] = useState("");
  const [qtyIn, setQty] = useState("");
  const stop = stopIn ? +stopIn : side === "buy" ? price - dist : price + dist;
  const target = targetIn ? +targetIn : side === "buy" ? price + dist * 2 : price - dist * 2;
  const equity = paper.state.cash;
  const qty = qtyIn ? +qtyIn : suggestQty(equity, price, stop);
  const evalr = evaluateTrade({ side, qty, entry: price, stop, target, dataTs: priceTs }, { equity, openPositions: paper.state.positions.length, realizedTodayPnl: paper.realizedToday, killSwitch: paper.state.killSwitch });

  const submit = () => {
    if (!evalr.approved) return;
    paper.open({ symbol, side, qty, entry: price, stop, target, thesis: `R:R ${evalr.rr.toFixed(2)} · risk ${evalr.riskPct.toFixed(2)}%` });
    toast.success(`Paper ${side} ${qty} ${symbol} @ ${fmtPrice(price)}`);
  };

  return (
    <Panel title="Paper ticket · ETI simulator">
      <div className="space-y-3 text-sm">
        <div className="grid grid-cols-2 gap-1">
          <Button size="sm" variant={side === "buy" ? "default" : "outline"} onClick={() => setSide("buy")}>Long</Button>
          <Button size="sm" variant={side === "sell" ? "default" : "outline"} onClick={() => setSide("sell")}>Short</Button>
        </div>
        <Field label="Quantity (auto = 1% risk)" value={qtyIn} placeholder={String(qty)} onChange={setQty} />
        <Field label="Stop" value={stopIn} placeholder={fmtPrice(stop)} onChange={setStop} />
        <Field label="Target" value={targetIn} placeholder={fmtPrice(target)} onChange={setTarget} />
        <ul className="space-y-1 text-xs">
          {evalr.checks.map((c) => (
            <li key={c.rule} className="flex justify-between gap-2">
              <span className={c.pass ? "text-bull" : "text-bear"}>{c.pass ? "✓" : "✗"} {c.rule}</span>
              <span className="num text-muted-foreground">{c.detail}</span>
            </li>
          ))}
        </ul>
        <Button className="w-full" disabled={!evalr.approved || !price} onClick={submit}>{evalr.approved ? "Submit paper order" : "Blocked by risk engine"}</Button>
      </div>
    </Panel>
  );
}

function Field({ label, value, placeholder, onChange }: { label: string; value: string; placeholder: string; onChange: (v: string) => void }) {
  return (
    <label className="block">
      <span className="label-caps">{label}</span>
      <Input className="num mt-1 h-8" inputMode="decimal" value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} />
    </label>
  );
}
