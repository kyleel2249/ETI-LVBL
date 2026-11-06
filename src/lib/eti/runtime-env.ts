type Env = Record<string, string | undefined>;

/**
 * Environment for server code on both runtimes.
 * Node: process.env. Cloudflare Workers: bindings/secrets live on the Nitro-provided `__env__`
 * (and are only copied into process.env under some compatibility flags), so merge both.
 * Only string values are taken, so bindings such as D1 never leak into the config.
 */
export function mergeEnv(procEnv: Env | undefined, workerEnv: Record<string, unknown> | undefined): Env {
  const out: Env = { ...(procEnv ?? {}) };
  for (const [k, v] of Object.entries(workerEnv ?? {})) if (typeof v === "string") out[k] = v;
  return out;
}

export function runtimeEnv(): Env {
  const g = globalThis as unknown as { __env__?: Record<string, unknown>; process?: { env?: Env } };
  return mergeEnv(g.process?.env, g.__env__);
}
