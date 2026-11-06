// Builds the Cloudflare target and deploys it with Wrangler.
//   npm run deploy:cloudflare            build + deploy (needs `npx wrangler login` or CLOUDFLARE_API_TOKEN)
//   npm run deploy:cloudflare -- --dry-run   build + show the generated Wrangler config, deploy nothing
// Set ETI_D1_DATABASE_ID to bind a D1 database named `eti` (create it with: npx wrangler d1 create eti).
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const dry = process.argv.includes("--dry-run");
const d1 = process.env.ETI_D1_DATABASE_ID;
const win = process.platform === "win32";
const run = (cmd, args, env = {}) => spawnSync(win ? `${cmd}.cmd` : cmd, args, { stdio: "inherit", shell: win, env: { ...process.env, ...env } });

if (existsSync("wrangler.jsonc") || existsSync("wrangler.json") || existsSync("wrangler.toml")) {
  console.error("A Wrangler config already exists in the project root; refusing to overwrite it. Add the D1 binding there instead (see docs/CLOUDFLARE_DEPLOYMENT.md).");
  process.exit(1);
}
const cfg = {
  name: process.env.ETI_WORKER_NAME ?? "eti",
  compatibility_date: "2025-09-01",
  compatibility_flags: ["nodejs_compat"],
  ...(d1 ? { d1_databases: [{ binding: "DB", database_name: "eti", database_id: d1, migrations_dir: "cloudflare/migrations" }] } : {}),
};
let code = 0;
try {
  writeFileSync("wrangler.jsonc", JSON.stringify(cfg, null, 2));
  if (!d1) console.warn("\nWARNING: ETI_D1_DATABASE_ID not set — deploying WITHOUT durable storage (orders/audit/forecasts would not persist).\n");
  let r = run("npm", ["run", "build"], { NITRO_PRESET: "cloudflare-module" });
  if (r.status !== 0) throw new Error("build failed");
  if (!existsSync(".output/server/wrangler.json")) throw new Error("expected .output/server/wrangler.json was not generated");
  const out = JSON.parse(readFileSync(".output/server/wrangler.json", "utf8"));
  console.log(`\nGenerated Wrangler config: name=${out.name}, D1 bindings=${(out.d1_databases ?? []).map((b) => b.binding).join(",") || "none"}, flags=${(out.compatibility_flags ?? []).join(",")}`);
  if (dry) console.log("Dry run: nothing deployed.");
  else {
    if (d1) {
      // migrations_dir resolves relative to the config file, so use the root config for this step
      r = run("npx", ["wrangler", "d1", "migrations", "apply", "eti", "--remote", "--config", "wrangler.jsonc"]);
      if (r.status !== 0) throw new Error("D1 migrations failed");
    }
    r = run("npx", ["wrangler", "deploy", "--config", ".output/server/wrangler.json"]);
    if (r.status !== 0) throw new Error("wrangler deploy failed");
  }
} catch (e) {
  console.error(String(e.message ?? e));
  code = 1;
} finally {
  rmSync("wrangler.jsonc", { force: true });
}
process.exit(code);
