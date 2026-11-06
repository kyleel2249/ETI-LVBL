import { describe, expect, it } from "vitest";
import { decide, type Member } from "./decision";
import { analyzeMacro, parseObservations, type Obs } from "./macro";

const mk = (stance: Member["stance"], confidence = 70): Omit<Member, "role" | "reasoning"> => ({
  stance,
  confidence,
});
const ROLES = [
  "Chief Investment Strategist",
  "Technical Analysis Specialist",
  "Fundamental Analysis Specialist",
  "Macroeconomic Analyst",
  "Quantitative Researcher",
  "Market Structure Analyst",
  "Liquidity Analyst",
  "News and Sentiment Analyst",
  "Predictive Intelligence Analyst",
  "Risk Management Officer",
  "Execution Analyst",
  "Portfolio Auditor",
];
const council = (f: (r: string) => Omit<Member, "role" | "reasoning">): Member[] =>
  ROLES.map((role) => ({ role, reasoning: "x", ...f(role) }));
const ok = {
  dataStatus: "fresh" as const,
  qualityScore: 95,
  risk: { approved: true, reasons: [] },
};

describe("council decision aggregation", () => {
  it("abstains on stale/invalid/incomplete data and low quality", () => {
    for (const s of ["stale", "incomplete", "unavailable", "invalid"] as const)
      expect(decide({ ...ok, members: council(() => mk("bullish")), dataStatus: s }).decision).toBe(
        "INSUFFICIENT DATA",
      );
    expect(
      decide({ ...ok, members: council(() => mk("bullish")), qualityScore: 40 }).decision,
    ).toBe("INSUFFICIENT DATA");
  });
  it("abstains with too few opinions", () => {
    expect(decide({ ...ok, members: council(() => mk("bullish")).slice(0, 5) }).decision).toBe(
      "INSUFFICIENT DATA",
    );
  });
  it("unanimous high-confidence + risk approved + fresh = STRONG BUY / STRONG SELL", () => {
    expect(decide({ ...ok, members: council(() => mk("bullish", 80)) }).decision).toBe(
      "STRONG BUY",
    );
    expect(decide({ ...ok, members: council(() => mk("bearish", 80)) }).decision).toBe(
      "STRONG SELL",
    );
  });
  it("risk officer veto beats a unanimous bullish council", () => {
    const r = decide({
      ...ok,
      members: council(() => mk("bullish", 90)),
      risk: { approved: false, reasons: ["Risk ≤ 1%: 2.5% at stop"] },
    });
    expect(r.decision).toBe("NO-TRADE");
    expect(r.vetoed).toBe(true);
  });
  it("never issues a strong call without a risk evaluation, or on delayed data", () => {
    expect(decide({ ...ok, members: council(() => mk("bullish", 90)), risk: null }).decision).toBe(
      "BUY",
    );
    expect(
      decide({ ...ok, members: council(() => mk("bullish", 90)), dataStatus: "delayed" }).decision,
    ).toBe("BUY");
  });
  it("a lone confident analyst among low-confidence neutrals is not enough evidence", () => {
    const m = council((r) =>
      r === "Technical Analysis Specialist" ? mk("bullish", 90) : mk("neutral", 20),
    );
    const r = decide({ ...ok, members: m });
    expect(r.decision).toBe("WAIT");
    expect(r.dissent).toBe(0);
  });
  it("weights by role relevance: core analysts outweigh sentiment/auditor opinions", () => {
    const core = [
      "Chief Investment Strategist",
      "Technical Analysis Specialist",
      "Market Structure Analyst",
      "Quantitative Researcher",
    ];
    const m = council((r) =>
      core.includes(r)
        ? mk("bullish", 80)
        : r === "News and Sentiment Analyst" || r === "Portfolio Auditor"
          ? mk("bearish", 80)
          : mk("neutral", 60),
    );
    const r = decide({ ...ok, members: m });
    expect(r.score).toBeGreaterThan(0.3);
    expect(["BUY", "STRONG BUY"]).toContain(r.decision);
  });
  it("mixed evidence waits", () => {
    const m = council((r, i = ROLES.indexOf(r)) => mk(i % 2 ? "bullish" : "bearish", 70));
    expect(decide({ ...ok, members: m }).decision).toBe("WAIT");
  });
  it("heavy dissent prevents a directional call", () => {
    const m = council((r) =>
      [
        "Technical Analysis Specialist",
        "Chief Investment Strategist",
        "Quantitative Researcher",
      ].includes(r)
        ? mk("bullish", 80)
        : [
              "Market Structure Analyst",
              "Liquidity Analyst",
              "Predictive Intelligence Analyst",
            ].includes(r)
          ? mk("bearish", 80)
          : mk("neutral", 50),
    );
    expect(["WAIT"]).toContain(decide({ ...ok, members: m }).decision);
  });
  it("risk officer's own stance does not count as evidence", () => {
    const m = council((r) =>
      r === "Risk Management Officer" ? mk("bearish", 100) : mk("bullish", 80),
    );
    expect(decide({ ...ok, members: m }).decision).toBe("STRONG BUY");
  });
});

const monthly = (start: string, vals: number[]): Obs[] =>
  vals.map((value, i) => {
    const d = new Date(Date.parse(start));
    d.setUTCMonth(d.getUTCMonth() + i);
    return { date: d.toISOString().slice(0, 10), value };
  });
const NOW = Date.parse("2026-11-06");

describe("macro analysis", () => {
  it("parses FRED observations, dropping '.' placeholders and sorting ascending", () => {
    const o = parseObservations([
      { date: "2026-02-01", value: "2.0" },
      { date: "2026-01-01", value: "1.0" },
      { date: "2026-03-01", value: "." },
    ]);
    expect(o.map((x) => x.value)).toEqual([1, 2]);
  });
  it("computes CPI YoY and flags signals with evidence", () => {
    const cpi = monthly(
      "2025-09-01",
      [300, 301, 302, 303, 304, 305, 306, 307, 308, 309, 310, 311, 312.0],
    ); // 13 pts → ~4% yoy
    const s = analyzeMacro(
      {
        CPIAUCSL: cpi,
        T10Y2Y: [{ date: "2026-11-04", value: -0.4 }],
        UNRATE: monthly("2026-03-01", [4.0, 4.1, 4.3, 4.5, 4.6, 4.7, 4.8, 4.9]),
        FEDFUNDS: monthly("2026-05-01", [4.0, 4.0, 4.0, 4.0, 4.0, 4.0]),
      },
      NOW,
    );
    const cp = s.series.find((x) => x.id === "CPIAUCSL")!;
    expect(cp.yoyPct).toBeCloseTo(4.0, 0);
    expect(s.signals.find((x) => x.id === "curve")!.stance).toBe("risk-off");
    expect(s.signals.find((x) => x.id === "labour")!.stance).toBe("risk-off");
    expect(s.missing).toContain("DGS10");
  });
  it("is neutral with thin evidence and reports limitations", () => {
    const s = analyzeMacro({ T10Y2Y: [{ date: "2026-11-04", value: 1 }] }, NOW);
    expect(s.backdrop).toBe("neutral");
    expect(s.limitations.join()).toMatch(/Fewer than 3/);
  });
  it("flags stale series", () => {
    const s = analyzeMacro({ DGS10: [{ date: "2026-08-01", value: 4 }] }, NOW);
    expect(s.series[0]!.stale).toBe(true);
  });
});
