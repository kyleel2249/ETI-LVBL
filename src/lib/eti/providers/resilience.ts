/** Retry with exponential backoff + jitter, request timeouts, and a per-key circuit breaker. */

export class ProviderError extends Error {
  constructor(
    message: string,
    readonly provider: string,
    readonly status: number | null,
    readonly code: string | number | null = null,
    readonly retryable = false,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

type Breaker = { failures: number; openUntil: number };
const breakers = new Map<string, Breaker>();
export const BREAKER_THRESHOLD = 5;
export const BREAKER_COOLDOWN_MS = 30_000;

export function breakerState(key: string, now = Date.now()) {
  const b = breakers.get(key);
  return { failures: b?.failures ?? 0, open: !!b && b.openUntil > now };
}
export function resetBreakers() {
  breakers.clear();
}

export type Deps = {
  fetch: typeof fetch;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  random: () => number;
};
export const realDeps: Deps = {
  fetch: (...a) => fetch(...a),
  now: () => Date.now(),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  random: Math.random,
};

export type CallOptions = {
  key: string; // breaker key, e.g. "binance:testnet"
  provider: string;
  /** Only idempotent calls (GET, or requests with a client order id) may be retried. */
  retries?: number;
  timeoutMs?: number;
};

export async function resilientFetch(
  url: string,
  init: RequestInit,
  o: CallOptions,
  d: Deps = realDeps,
): Promise<Response> {
  const br = breakers.get(o.key) ?? { failures: 0, openUntil: 0 };
  breakers.set(o.key, br);
  if (br.openUntil > d.now())
    throw new ProviderError(
      `${o.provider}: circuit open, retry shortly`,
      o.provider,
      null,
      "CIRCUIT_OPEN",
      true,
    );

  const max = o.retries ?? 0;
  let last: ProviderError | null = null;
  for (let attempt = 0; attempt <= max; attempt++) {
    try {
      const res = await d.fetch(url, { ...init, signal: AbortSignal.timeout(o.timeoutMs ?? 8000) });
      if (res.status === 429 || res.status >= 500) {
        last = new ProviderError(
          `${o.provider}: HTTP ${res.status}`,
          o.provider,
          res.status,
          res.status === 429 ? "RATE_LIMIT" : "SERVER",
          true,
        );
        const ra = Number(res.headers.get("retry-after"));
        if (attempt < max)
          await d.sleep(
            Number.isFinite(ra) && ra > 0 ? Math.min(ra * 1000, 10_000) : backoff(attempt, d),
          );
        continue;
      }
      br.failures = 0; // 4xx are caller errors, not provider outages
      return res;
    } catch (e) {
      last = new ProviderError(
        `${o.provider}: network error (${(e as { cause?: { code?: string } }).cause?.code ?? (e as Error).name})`,
        o.provider,
        null,
        "NETWORK",
        true,
      );
      if (attempt < max) await d.sleep(backoff(attempt, d));
    }
  }
  br.failures++;
  if (br.failures >= BREAKER_THRESHOLD) br.openUntil = d.now() + BREAKER_COOLDOWN_MS;
  throw last ?? new ProviderError(`${o.provider}: request failed`, o.provider, null);
}

export function backoff(attempt: number, d: Pick<Deps, "random">) {
  const base = Math.min(8000, 250 * 2 ** attempt);
  return Math.round(base / 2 + d.random() * (base / 2)); // "equal jitter"
}
