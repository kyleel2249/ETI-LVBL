export type Obs = { date: string; value: number };

export const MACRO_SERIES = {
  FEDFUNDS: { label: "Fed funds rate", unit: "%", kind: "rate", maxAgeDays: 75 },
  DGS10: { label: "10Y Treasury yield", unit: "%", kind: "rate", maxAgeDays: 10 },
  T10Y2Y: { label: "10Y–2Y yield spread", unit: "pp", kind: "rate", maxAgeDays: 10 },
  CPIAUCSL: { label: "CPI (all urban, SA)", unit: "index", kind: "level", maxAgeDays: 75 },
  UNRATE: { label: "Unemployment rate", unit: "%", kind: "rate", maxAgeDays: 75 },
  PAYEMS: { label: "Nonfarm payrolls", unit: "k jobs", kind: "level", maxAgeDays: 75 },
} as const;
export type MacroId = keyof typeof MACRO_SERIES;

export type MacroSignal = {
  id: string;
  label: string;
  stance: "risk-on" | "risk-off" | "neutral";
  evidence: string;
};
export type MacroSnapshot = {
  asOf: number;
  series: {
    id: MacroId;
    label: string;
    unit: string;
    latest: number;
    date: string;
    prev: number | null;
    change: number | null;
    yoyPct: number | null;
    stale: boolean;
  }[];
  signals: MacroSignal[];
  missing: MacroId[];
  /** Overall read of the macro backdrop; "neutral" when evidence is thin or mixed. */
  backdrop: "risk-on" | "risk-off" | "neutral";
  limitations: string[];
};

/** Parse FRED observations (newest first or oldest first); "." marks missing values. */
export function parseObservations(raw: { date: string; value: string }[]): Obs[] {
  return raw
    .map((o) => ({ date: o.date, value: Number(o.value) }))
    .filter((o) => o.value === o.value && o.date && o.value !== null && Number.isFinite(o.value))
    .sort((a, b) => a.date.localeCompare(b.date));
}

const daysBetween = (a: string, b: number) => (b - Date.parse(a)) / 864e5;

export function analyzeMacro(
  data: Partial<Record<MacroId, Obs[]>>,
  now = Date.now(),
): MacroSnapshot {
  const series: MacroSnapshot["series"] = [];
  const missing: MacroId[] = [];
  for (const id of Object.keys(MACRO_SERIES) as MacroId[]) {
    const o = data[id];
    const last = o?.at(-1);
    if (!o || !last) {
      missing.push(id);
      continue;
    }
    const m = MACRO_SERIES[id];
    const prev = o.at(-2)?.value ?? null;
    // YoY only for level series with monthly spacing: compare with the observation ~12 months earlier.
    let yoy: number | null = null;
    if (m.kind === "level") {
      const target = Date.parse(last.date) - 365 * 864e5;
      const base = [...o].reverse().find((x) => Date.parse(x.date) <= target + 20 * 864e5);
      if (base && base.value > 0) yoy = (last.value / base.value - 1) * 100;
    }
    series.push({
      id,
      label: m.label,
      unit: m.unit,
      latest: last.value,
      date: last.date,
      prev,
      change: prev === null ? null : last.value - prev,
      yoyPct: yoy,
      stale: daysBetween(last.date, now) > m.maxAgeDays,
    });
  }
  const get = (id: MacroId) => series.find((s) => s.id === id);
  const signals: MacroSignal[] = [];
  const spread = get("T10Y2Y");
  if (spread)
    signals.push({
      id: "curve",
      label: "Yield curve",
      stance: spread.latest < 0 ? "risk-off" : spread.latest > 0.5 ? "risk-on" : "neutral",
      evidence: `10Y–2Y spread ${spread.latest.toFixed(2)}pp (${spread.date})`,
    });
  const cpi = get("CPIAUCSL");
  if (cpi?.yoyPct != null)
    signals.push({
      id: "inflation",
      label: "Inflation",
      stance: cpi.yoyPct > 4 ? "risk-off" : cpi.yoyPct < 3 ? "risk-on" : "neutral",
      evidence: `CPI ${cpi.yoyPct.toFixed(1)}% YoY (${cpi.date})`,
    });
  const ur = data["UNRATE"];
  if (ur && ur.length >= 7) {
    const d = ur.at(-1)!.value - ur.at(-7)!.value;
    signals.push({
      id: "labour",
      label: "Labour market",
      stance: d >= 0.5 ? "risk-off" : d <= -0.2 ? "risk-on" : "neutral",
      evidence: `Unemployment ${ur.at(-1)!.value.toFixed(1)}%, ${d >= 0 ? "+" : ""}${d.toFixed(1)}pp over 6 months`,
    });
  }
  const ff = data["FEDFUNDS"];
  if (ff && ff.length >= 4) {
    const d = ff.at(-1)!.value - ff.at(-4)!.value;
    signals.push({
      id: "policy",
      label: "Policy rate",
      stance: d >= 0.25 ? "risk-off" : d <= -0.25 ? "risk-on" : "neutral",
      evidence: `Fed funds ${ff.at(-1)!.value.toFixed(2)}%, ${d >= 0 ? "+" : ""}${d.toFixed(2)}pp over 3 months`,
    });
  }
  const on = signals.filter((s) => s.stance === "risk-on").length;
  const off = signals.filter((s) => s.stance === "risk-off").length;
  const backdrop =
    signals.length < 3
      ? "neutral"
      : on - off >= 2
        ? "risk-on"
        : off - on >= 2
          ? "risk-off"
          : "neutral";
  const limitations = [
    "Macro series are slow-moving and lagged; they describe the backdrop, not short-term price direction.",
  ];
  if (missing.length) limitations.push(`Missing series: ${missing.join(", ")}`);
  if (series.some((s) => s.stale))
    limitations.push(
      `Stale series: ${series
        .filter((s) => s.stale)
        .map((s) => s.id)
        .join(", ")}`,
    );
  if (signals.length < 3)
    limitations.push("Fewer than 3 signals available — backdrop forced to neutral.");
  return { asOf: now, series, signals, missing, backdrop, limitations };
}
