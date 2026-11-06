// Checks a running ETI instance. Usage: npm run health [-- http://localhost:4173]
const base = process.argv[2] ?? process.env.ETI_URL ?? "http://localhost:4173";
const paths = ["/", "/providers", "/paper", "/trading", "/macro", "/asset/BTCUSDT"];
let bad = 0;
for (const p of paths) {
  try {
    const r = await fetch(base + p, { signal: AbortSignal.timeout(8000) });
    console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.status}  ${p}`);
    if (!r.ok) bad++;
  } catch (e) {
    console.log(`FAIL  ${p} — ${e.cause?.code ?? e.message}. Is ETI running? (npm start)`);
    bad++;
  }
}
process.exit(bad ? 1 : 0);
