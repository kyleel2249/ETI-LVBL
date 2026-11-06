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
    const key = process.env.LOVABLE_API_KEY;
    if (!key) throw new Error("AI is not configured");
    const system = `You are ETI's AI Trading Council: ${COUNCIL.join(", ")}. Each member independently analyses ONLY the supplied measured data. Never invent prices, news, fundamentals, or events not in the data — if a member lacks data (e.g. fundamentals or news for crypto), they must say so and stay neutral with low confidence. Probabilities are estimates, not guarantees. Members must disagree when evidence is mixed. This is research for paper trading only.`;
    const res = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "google/gemini-3-flash-preview",
        messages: [{ role: "system", content: system }, { role: "user", content: JSON.stringify(data) }],
        tools: [{
          type: "function",
          function: {
            name: "verdict", description: "Return the council verdict",
            parameters: {
              type: "object", required: ["members", "consensus", "confidence", "scenarios", "plan", "dissent", "disclaimer"],
              properties: {
                members: { type: "array", items: { type: "object", required: ["role", "stance", "confidence", "reasoning"], properties: {
                  role: { type: "string" }, stance: { type: "string", enum: ["bullish", "bearish", "neutral"] }, confidence: { type: "number", description: "0-100" }, reasoning: { type: "string", description: "1-2 sentences citing specific numbers" } } } },
                consensus: { type: "string", enum: ["bullish", "bearish", "neutral"] },
                confidence: { type: "number" },
                scenarios: { type: "array", items: { type: "object", required: ["name", "probability", "description"], properties: { name: { type: "string" }, probability: { type: "number" }, description: { type: "string" } } } },
                plan: { type: "object", required: ["bias", "entryZone", "invalidation", "targets"], properties: { bias: { type: "string" }, entryZone: { type: "string" }, invalidation: { type: "string" }, targets: { type: "string" } } },
                dissent: { type: "string" }, disclaimer: { type: "string" },
              },
            },
          },
        }],
        tool_choice: { type: "function", function: { name: "verdict" } },
      }),
    });
    if (res.status === 429) throw new Error("AI rate limit reached — try again in a minute.");
    if (res.status === 402) throw new Error("AI credits exhausted — add credits in workspace settings.");
    if (!res.ok) throw new Error(`AI request failed [${res.status}]: ${await res.text()}`);
    const j = await res.json();
    const args = j.choices?.[0]?.message?.tool_calls?.[0]?.function?.arguments;
    if (!args) throw new Error("Council returned no verdict");
    return JSON.parse(args) as CouncilVerdict;
  });
