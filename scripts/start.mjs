// Cross-platform local launcher (Windows/macOS/Linux).
// Builds the Node-server target if needed, then runs it. The Cloudflare target is
// built separately by `npm run deploy:cloudflare` (same source, different Nitro preset).
import { existsSync, readFileSync } from "node:fs";
import { spawnSync, spawn } from "node:child_process";

const PORT = process.env.PORT ?? "4173";
const HOST = process.env.HOST ?? "127.0.0.1";
const forceBuild = process.argv.includes("--production");

function builtPreset() {
  try {
    return JSON.parse(readFileSync(".output/nitro.json", "utf8")).preset;
  } catch {
    return null;
  }
}

if (forceBuild || builtPreset() !== "node-server") {
  console.log("Building ETI (node-server target)...");
  const b = spawnSync(process.platform === "win32" ? "npm.cmd" : "npm", ["run", "build"], {
    stdio: "inherit",
    shell: process.platform === "win32",
    env: { ...process.env, NITRO_PRESET: "node-server" },
  });
  if (b.status !== 0) {
    console.error("Build failed — see errors above.");
    process.exit(b.status ?? 1);
  }
}
if (!existsSync(".output/server/index.mjs")) {
  console.error("Build output missing: .output/server/index.mjs");
  process.exit(1);
}
console.log(`\nETI is starting at http://localhost:${PORT}\n`);
const child = spawn(process.execPath, [".output/server/index.mjs"], {
  stdio: "inherit",
  env: { ...process.env, PORT, HOST },
});
child.on("exit", (code) => process.exit(code ?? 0));
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => child.kill(sig));
