import { useEffect, useRef, useState } from "react";

export type LiveTick = { price: number; changePct: number; ts: number };

/**
 * Binance public mini-ticker WebSocket with heartbeat, reconnect with backoff,
 * and stale-message protection. Status reflects the real socket state.
 */
export function useBinanceLive(symbols: string[]) {
  const [ticks, setTicks] = useState<Record<string, LiveTick>>({});
  const [status, setStatus] = useState<"connecting" | "live" | "reconnecting" | "offline">("connecting");
  const key = symbols.join(",");
  const lastTs = useRef<Record<string, number>>({});

  useEffect(() => {
    if (!symbols.length) return;
    let ws: WebSocket | null = null;
    let attempt = 0;
    let stopped = false;
    let watchdog: ReturnType<typeof setInterval> | undefined;
    let lastMsg = Date.now();
    const hosts = ["wss://data-stream.binance.vision", "wss://stream.binance.com:9443"];

    const connect = () => {
      const streams = symbols.map((s) => `${s.toLowerCase()}@miniTicker`).join("/");
      ws = new WebSocket(`${hosts[attempt % hosts.length]}/stream?streams=${streams}`);
      ws.onopen = () => { attempt = 0; setStatus("live"); lastMsg = Date.now(); };
      ws.onmessage = (e) => {
        lastMsg = Date.now();
        try {
          const d = JSON.parse(e.data).data;
          if (!d?.s || (lastTs.current[d.s] ?? 0) >= d.E) return; // dedupe / out-of-order
          lastTs.current[d.s] = d.E;
          const c = +d.c, o = +d.o;
          setTicks((t) => ({ ...t, [d.s]: { price: c, changePct: o ? ((c - o) / o) * 100 : 0, ts: d.E } }));
        } catch { /* ignore malformed */ }
      };
      ws.onclose = () => {
        if (stopped) return;
        setStatus(attempt > 5 ? "offline" : "reconnecting");
        attempt++;
        setTimeout(connect, Math.min(30_000, 1000 * 2 ** attempt));
      };
      ws.onerror = () => ws?.close();
    };
    connect();
    watchdog = setInterval(() => { if (Date.now() - lastMsg > 20_000) ws?.close(); }, 5000);
    return () => { stopped = true; clearInterval(watchdog); ws?.close(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return { ticks, status };
}

export function fmtPrice(n: number) {
  if (!Number.isFinite(n)) return "—";
  const d = n >= 1000 ? 2 : n >= 1 ? 3 : 6;
  return n.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
}
export function fmtCompact(n: number) {
  return Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 2 }).format(n);
}
