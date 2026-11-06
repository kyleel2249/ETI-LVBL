export type RiskLimits = {
  maxRiskPerTradePct: number; // of equity at stop
  maxPositionPct: number; // notional as % of equity
  maxOpenPositions: number;
  maxDailyLossPct: number;
  minRewardRisk: number;
  maxDataAgeMs: number;
};

export const DEFAULT_LIMITS: RiskLimits = {
  maxRiskPerTradePct: 1,
  maxPositionPct: 20,
  maxOpenPositions: 5,
  maxDailyLossPct: 3,
  minRewardRisk: 1.5,
  maxDataAgeMs: 60_000,
};

export type ProposedTrade = {
  side: "buy" | "sell";
  qty: number;
  entry: number;
  stop: number;
  target: number;
  dataTs: number;
};

export type RiskContext = { equity: number; openPositions: number; realizedTodayPnl: number; killSwitch: boolean; now?: number };

export type RiskCheck = { rule: string; pass: boolean; detail: string };

export function evaluateTrade(t: ProposedTrade, ctx: RiskContext, l: RiskLimits = DEFAULT_LIMITS) {
  const now = ctx.now ?? Date.now();
  const checks: RiskCheck[] = [];
  const add = (rule: string, pass: boolean, detail: string) => checks.push({ rule, pass, detail });

  add("Kill switch off", !ctx.killSwitch, ctx.killSwitch ? "Trading halted by kill switch" : "Active");
  add("Valid quantity", t.qty > 0 && Number.isFinite(t.qty), `qty ${t.qty}`);
  const stopOk = t.side === "buy" ? t.stop < t.entry && t.target > t.entry : t.stop > t.entry && t.target < t.entry;
  add("Stop/target on correct side", stopOk, `entry ${t.entry} · stop ${t.stop} · target ${t.target}`);

  const riskPerUnit = Math.abs(t.entry - t.stop);
  const reward = Math.abs(t.target - t.entry);
  const rr = riskPerUnit > 0 ? reward / riskPerUnit : 0;
  add(`Reward:risk ≥ ${l.minRewardRisk}`, rr >= l.minRewardRisk, `R:R ${rr.toFixed(2)}`);

  const riskPct = ctx.equity > 0 ? ((riskPerUnit * t.qty) / ctx.equity) * 100 : Infinity;
  add(`Risk ≤ ${l.maxRiskPerTradePct}% equity`, riskPct <= l.maxRiskPerTradePct, `${riskPct.toFixed(2)}% at stop`);

  const posPct = ctx.equity > 0 ? ((t.entry * t.qty) / ctx.equity) * 100 : Infinity;
  add(`Position ≤ ${l.maxPositionPct}% equity`, posPct <= l.maxPositionPct, `${posPct.toFixed(2)}% notional`);

  add(`Open positions < ${l.maxOpenPositions}`, ctx.openPositions < l.maxOpenPositions, `${ctx.openPositions} open`);

  const dayLossPct = ctx.equity > 0 ? (-Math.min(0, ctx.realizedTodayPnl) / ctx.equity) * 100 : 0;
  add(`Daily loss < ${l.maxDailyLossPct}%`, dayLossPct < l.maxDailyLossPct, `${dayLossPct.toFixed(2)}% lost today`);

  const age = now - t.dataTs;
  add("Price data fresh", age <= l.maxDataAgeMs, `${Math.round(age / 1000)}s old`);

  return { approved: checks.every((c) => c.pass), checks, rr, riskPct, posPct };
}

/** Quantity that risks exactly maxRiskPerTradePct, capped by max position size. */
export function suggestQty(equity: number, entry: number, stop: number, l: RiskLimits = DEFAULT_LIMITS) {
  const perUnit = Math.abs(entry - stop);
  if (perUnit <= 0 || entry <= 0) return 0;
  const byRisk = (equity * l.maxRiskPerTradePct) / 100 / perUnit;
  const byPos = (equity * l.maxPositionPct) / 100 / entry;
  return Math.floor(Math.min(byRisk, byPos) * 1e6) / 1e6;
}
