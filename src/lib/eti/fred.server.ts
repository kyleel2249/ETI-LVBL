import { MACRO_SERIES, parseObservations, type MacroId, type Obs } from "./macro";
import { ProviderError, realDeps, resilientFetch, type Deps } from "./providers/resilience";

const BASE = "https://api.stlouisfed.org/fred/series/observations";

export async function fetchSeries(
  id: MacroId,
  apiKey: string,
  limit = 60,
  d: Deps = realDeps,
): Promise<Obs[]> {
  const url = `${BASE}?series_id=${encodeURIComponent(id)}&api_key=${encodeURIComponent(apiKey)}&file_type=json&sort_order=desc&limit=${limit}`;
  const res = await resilientFetch(
    url,
    { method: "GET" },
    { key: "fred", provider: "fred", retries: 2 },
    d,
  );
  if (!res.ok) {
    const bad = res.status === 400 || res.status === 403;
    throw new ProviderError(
      bad ? "FRED rejected the request — check FRED_API_KEY" : `FRED: HTTP ${res.status}`,
      "fred",
      res.status,
    );
  }
  const j = (await res.json()) as { observations?: { date: string; value: string }[] };
  return parseObservations(j.observations ?? []);
}

export async function fetchAllMacro(apiKey: string, d: Deps = realDeps) {
  const ids = Object.keys(MACRO_SERIES) as MacroId[];
  const out: Partial<Record<MacroId, Obs[]>> = {};
  const errors: Record<string, string> = {};
  await Promise.all(
    ids.map(async (id) => {
      try {
        out[id] = await fetchSeries(id, apiKey, 60, d);
      } catch (e) {
        errors[id] = (e as Error).message;
      }
    }),
  );
  return { data: out, errors };
}
