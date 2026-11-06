// Local environment diagnostics. Exits non-zero if something blocks running ETI.
import { existsSync, readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { platform } from "node:os";

const out = [];
let failed = false;
const row = (ok, name, detail) => {
  out.push(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? " — " + detail : ""}`);
  if (!ok) failed = true;
};
const sh = (c) => {
  try {
    return execSync(c, { stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .trim();
  } catch {
    return null;
  }
};

const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const [maj, min] = process.versions.node.split(".").map(Number);
row(
  maj > 20 || (maj === 20 && min >= 19),
  "Node.js version",
  `v${process.versions.node} (need ${pkg.engines.node})`,
);
const npmV = sh("npm -v");
row(
  !!npmV,
  "npm available",
  npmV
    ? `v${npmV}`
    : "npm not found on PATH — reinstall Node.js from nodejs.org and tick 'Add to PATH'",
);
row(
  existsSync("node_modules"),
  "Dependencies installed",
  existsSync("node_modules") ? "" : "run: npm install",
);
row(
  existsSync(".npmrc") && /legacy-peer-deps=true/.test(readFileSync(".npmrc", "utf8")),
  ".npmrc present",
  "required for npm install to succeed",
);
const hasEnv = existsSync(".env") || existsSync(".dev.vars");
out.push(
  `${hasEnv ? "PASS" : "WARN"}  Environment file — ${hasEnv ? "found" : "optional: copy .env.example to .env to enable Alpaca equities"}`,
);
if (platform() === "win32") {
  const pol = sh('powershell -NoProfile -Command "Get-ExecutionPolicy"');
  row(
    pol !== "Restricted",
    "PowerShell execution policy",
    pol ??
      "unknown — if npm.ps1 is blocked use CMD or: Set-ExecutionPolicy -Scope CurrentUser RemoteSigned",
  );
}
console.log(out.join("\n"));
console.log(failed ? "\nResult: problems found." : "\nResult: environment OK.");
process.exit(failed ? 1 : 0);
