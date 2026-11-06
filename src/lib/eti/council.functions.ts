import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

export const COUNCIL = [
  "Chief Investment Strategist", "Technical Analysis Specialist", "Fundamental Analysis Specialist", "Macroeconomic Analyst",
  "Quantitative Researcher", "Market Structure Analyst", "Liquidity Analyst", "News and Sentiment Analyst",
  "Predictive Intelligence Analyst", "Risk Management Officer", "Execution Analyst", "Portfolio Auditor",
] as const;

export type CouncilMember = { role: string; stance: "bullish" | "bearish" | "neutral"; confidence: number; reasoning: string };
export type CouncilVerdict = {
  members: CouncilMember[];
  consensus: "bullish" | "bearish" | "neutral";
  confidence: number;
  scenarios: { name: string; probability: number; description: string }[];
  plan: { bias: string; entryZone: string; invalidation: string; targets: string };
  dissent: string;
  disclaimer: string;
};

const input = z.object({
  symbol: z.string().max(20),
  interval: z.string().max(5),
  source: z.string().max(60),
  snapshot: z.record(z.any()),
  quality: z.object({ score: z.number(), issues: z.array(z.string()) }),
  book: z.object({ imbalance: z.number(), spreadBps: z.number() }).nullable(),
});

export const runCouncil = createServerFn({ method: "POST" })
  .inputValidator((d: z.infer<typeof input>) => input.parse(d))
  .handler(async ({ data }): Promise<CouncilVerdict> => {
    const key = process.env['LOVABLE_API_KEY'];
    if (!key) throw new Error("AI is not configured");
    const system = `You are ETI's AI Trading Council: ${COUNCIL.join(", ")}. Each member independently analyses ONLY the supplied measured data. Never invent prices, news, fundamentals, or events not in the data — if a member lacks data (e.g. fundamentals or news for crypto), they must say so and stay neutral with low confidence. Probabilities are estimates, not guarantees. Members must disagree when evidence is mixed. This is research for paper trading only.`;
    const str = { type: "string" };
    const num = { type: "number" };
    const obj = (props: Record<string, unknown>) => ({ type: "object", additionalProperties: false, required: Object.keys(props), properties: props });
    const schema = obj({
      members: { type: "array", items: obj({ role: str, stance: { type: "string", enum: ["bullish", "bearish", "neutral"] }, confidence: num, reasoning: str }) },
      consensus: { type: "string", enum: ["bullish", "bearish", "neutral"] },
      confidence: num,
      scenarios: { type: "array", items: obj({ name: str, probability: num, description: str }) },
      plan: obj({ bias: str, entryZone: str, invalidation: str, targets: str }),
      dissent: str, disclaimer: str,
    });
    const res = await fetch("https://ai.gateway.lovable.dev/v1/responses", {
      method: "POST",
      headers: { "Lovable-API-Key": key, Authorization: `Bearer ${key}`, "Content-Type": "application/json", "X-Lovable-AIG-SDK": "fetch" },
      body: JSON.stringify({
        model: "openai/gpt-6-astra",
        stream: true,
        store: false,
        reasoning: { effort: "low" },
        instructions: system + " Confidence values are 0-100; scenario probabilities sum to ~100. Each member's reasoning is 1-2 sentences citing specific numbers.",
        input: [{ role: "user", content: JSON.stringify(data) }],
        text: { format: { type: "json_schema", name: "verdict", strict: true, schema } },
      }),
    });
    if (res.status === 429) throw new Error("AI rate limit reached — try again in a minute.");
    if (res.status === 402) throw new Error("AI credits exhausted — add credits in workspace settings.");
    if (!res.ok || !res.body) throw new Error(`AI request failed [${res.status}]: ${await res.text()}`);
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "", args = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === "[DONE]") continue;
        try {
          const ev = JSON.parse(payload);
          if (ev.type === "response.output_text.delta") args += ev.delta;
          if (ev.type === "response.failed" || ev.type === "error") throw new Error(JSON.stringify(ev.response?.error ?? ev.error ?? ev));
        } catch (e) { if (e instanceof Error && !(e instanceof SyntaxError)) throw e; }
      }
    }
    if (!args) throw new Error("Council returned no verdict");
    return JSON.parse(args) as CouncilVerdict;
  });
