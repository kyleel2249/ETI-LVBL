/** HMAC-SHA256 hex signature (Web Crypto: works in Node 20+ and Cloudflare Workers). */
export async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(message));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function sha256Hex(message: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(message));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Build a Binance signed query string (params + timestamp + recvWindow + signature). */
export async function signBinanceQuery(
  params: Record<string, string | number | boolean | undefined>,
  secret: string,
  now = Date.now(),
  recvWindow = 5000,
): Promise<string> {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined) qs.set(k, String(v));
  qs.set("recvWindow", String(recvWindow));
  qs.set("timestamp", String(now));
  const base = qs.toString();
  return `${base}&signature=${await hmacSha256Hex(secret, base)}`;
}
