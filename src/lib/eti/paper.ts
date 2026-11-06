import { useCallback, useEffect, useState } from "react";

export type PaperPosition = { id: string; symbol: string; side: "buy" | "sell"; qty: number; entry: number; stop: number; target: number; openedAt: number; thesis: string };
export type PaperTrade = PaperPosition & { exit: number; closedAt: number; pnl: number; reason: string };
export type PaperState = { startingEquity: number; cash: number; positions: PaperPosition[]; history: PaperTrade[]; killSwitch: boolean };

const KEY = "eti.paper.v1";
const initial: PaperState = { startingEquity: 100_000, cash: 100_000, positions: [], history: [], killSwitch: false };

export function pnlOf(p: { side: "buy" | "sell"; qty: number; entry: number }, price: number) {
  return (p.side === "buy" ? price - p.entry : p.entry - price) * p.qty;
}

/** ETI internal paper simulator (browser-local). Real-provider paper orders come with Alpaca keys. */
export function usePaper() {
  const [state, setState] = useState<PaperState>(initial);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    try { const raw = localStorage.getItem(KEY); if (raw) setState(JSON.parse(raw)); } catch { /* ignore */ }
    setReady(true);
  }, []);
  useEffect(() => { if (ready) localStorage.setItem(KEY, JSON.stringify(state)); }, [state, ready]);

  const open = useCallback((p: Omit<PaperPosition, "id" | "openedAt">) =>
    setState((s) => ({ ...s, positions: [...s.positions, { ...p, id: crypto.randomUUID(), openedAt: Date.now() }] })), []);
  const close = useCallback((id: string, exit: number, reason: string) =>
    setState((s) => {
      const p = s.positions.find((x) => x.id === id);
      if (!p) return s;
      const pnl = pnlOf(p, exit);
      return { ...s, cash: s.cash + pnl, positions: s.positions.filter((x) => x.id !== id), history: [{ ...p, exit, closedAt: Date.now(), pnl, reason }, ...s.history] };
    }), []);
  const setKill = useCallback((v: boolean) => setState((s) => ({ ...s, killSwitch: v })), []);
  const reset = useCallback(() => setState(initial), []);
  const realizedToday = state.history.filter((t) => new Date(t.closedAt).toDateString() === new Date().toDateString()).reduce((a, t) => a + t.pnl, 0);
  return { state, ready, open, close, setKill, reset, realizedToday };
}
