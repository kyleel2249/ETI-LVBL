export type Stance = "bullish" | "bearish" | "neutral";
export type Member = { role: string; stance: Stance; confidence: number; reasoning: string };
export type DataStatus = "fresh" | "delayed" | "stale" | "incomplete" | "unavailable" | "invalid";
export type Decision =
  "STRONG BUY" | "BUY" | "STRONG SELL" | "SELL" | "WAIT" | "NO-TRADE" | "INSUFFICIENT DATA";

export type DecisionInput = {
  members: Member[];
  dataStatus: DataStatus;
  qualityScore: number;
  /** Result of the risk engine for a concrete proposed trade; null = not evaluated yet. */
  risk: { approved: boolean; reasons: string[] } | null;
};

export type DecisionResult = {
  decision: Decision;
  score: number; // -1..1 weighted evidence balance
  dissent: number; // 0..1 weighted share opposing the majority direction
  avgConfidence: number;
  rationale: string[];
  dissenters: string[];
  vetoed: boolean;
};

/** Relevance weights. Roles that routinely lack data (news, fundamentals for crypto) self-report neutral/low confidence. */
const WEIGHTS: Record<string, number> = {
  "Chief Investment Strategist": 1,
  "Technical Analysis Specialist": 1,
  "Market Structure Analyst": 1,
  "Quantitative Researcher": 1,
  "Liquidity Analyst": 0.8,
  "Predictive Intelligence Analyst": 0.8,
  "Macroeconomic Analyst": 0.6,
  "Fundamental Analysis Specialist": 0.5,
  "Execution Analyst": 0.5,
  "Portfolio Auditor": 0.5,
  "News and Sentiment Analyst": 0.3,
};
const RISK_OFFICER = "Risk Management Officer";
const sign = (s: Stance) => (s === "bullish" ? 1 : s === "bearish" ? -1 : 0);

export function decide(i: DecisionInput): DecisionResult {
  const base = {
    score: 0,
    dissent: 0,
    avgConfidence: 0,
    dissenters: [] as string[],
    vetoed: false,
  };
  const insufficient = (why: string): DecisionResult => ({
    ...base,
    decision: "INSUFFICIENT DATA",
    rationale: [why],
  });

  if (
    i.dataStatus === "stale" ||
    i.dataStatus === "incomplete" ||
    i.dataStatus === "unavailable" ||
    i.dataStatus === "invalid"
  )
    return insufficient(`Underlying data is ${i.dataStatus}; ETI abstains.`);
  if (i.qualityScore < 60)
    return insufficient(`Data quality score ${i.qualityScore} is below 60; ETI abstains.`);

  const voters = i.members.filter((m) => m.role !== RISK_OFFICER);
  if (voters.length < 8)
    return insufficient(`Only ${voters.length} analyst opinions available (need 8+).`);

  let num = 0,
    den = 0,
    up = 0,
    down = 0,
    confSum = 0;
  for (const m of voters) {
    const w = ((WEIGHTS[m.role] ?? 0.5) * Math.max(0, Math.min(100, m.confidence))) / 100;
    den += w;
    num += w * sign(m.stance);
    if (m.stance === "bullish") up += w;
    else if (m.stance === "bearish") down += w;
    confSum += m.confidence;
  }
  const score = den > 0 ? num / den : 0;
  const majority: Stance = score > 0 ? "bullish" : score < 0 ? "bearish" : "neutral";
  const opposed = majority === "bullish" ? down : majority === "bearish" ? up : 0;
  const dissent = den > 0 ? opposed / den : 0;
  const avgConfidence = confSum / voters.length;
  const dissenters = voters
    .filter((m) => majority !== "neutral" && m.stance !== "neutral" && m.stance !== majority)
    .map((m) => m.role);
  const rationale = [
    `Evidence-weighted balance ${score.toFixed(2)} (−1 bearish … +1 bullish)`,
    `Weighted dissent ${(dissent * 100).toFixed(0)}%`,
    `Average analyst confidence ${avgConfidence.toFixed(0)}`,
  ];

  const veto = i.risk !== null && !i.risk.approved;
  if (veto)
    return {
      decision: "NO-TRADE",
      score,
      dissent,
      avgConfidence,
      dissenters,
      vetoed: true,
      rationale: [
        "Risk Management Officer veto: " + (i.risk!.reasons[0] ?? "risk checks failed"),
        ...rationale,
      ],
    };

  const abs = Math.abs(score);
  const canBeStrong =
    i.risk?.approved === true &&
    i.dataStatus === "fresh" &&
    abs >= 0.6 &&
    dissent <= 0.15 &&
    avgConfidence >= 65;
  if (i.risk === null)
    rationale.push(
      "No concrete trade evaluated by the risk engine; strong signals are not issued.",
    );
  if (i.dataStatus === "delayed") rationale.push("Data is delayed; strong signals are not issued.");

  let decision: Decision;
  if (abs >= 0.3 && dissent <= 0.4 && avgConfidence >= 40)
    decision =
      score > 0 ? (canBeStrong ? "STRONG BUY" : "BUY") : canBeStrong ? "STRONG SELL" : "SELL";
  else {
    decision = "WAIT";
    rationale.push("Evidence is mixed or weak; waiting for clearer conditions.");
  }
  return { decision, score, dissent, avgConfidence, dissenters, vetoed: false, rationale };
}
