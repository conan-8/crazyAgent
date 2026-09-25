#!/usr/bin/env node
// Full verification suite: unit tests + every phase's acceptance smoke,
// sequentially (each smoke owns its own CDP port/profile). Exit 0 = green.
// Usage: node scripts/verify.mjs   (or: npm run verify)
import { spawnSync } from "node:child_process";

const steps = [
  ["unit tests (vitest)", "npx", ["vitest", "run"]],
  ["phase 2 — perception", "node", ["scripts/phase2-smoke.mjs"]],
  ["phase 3 — actions", "node", ["scripts/phase3-smoke.mjs"]],
  ["phase 4 — agent loop (both providers)", "node", ["scripts/phase4-smoke.mjs"]],
  ["phase 5+6 — UI & policy", "node", ["scripts/phase56-smoke.mjs"]],
  ["phase 7 — unlimited mode", "node", ["scripts/phase7-smoke.mjs"]],
  ["chat & history", "node", ["scripts/phase9-smoke.mjs"]],
  ["run logs (archive + export)", "node", ["scripts/phase10-smoke.mjs"]],
  ["madman mode", "node", ["scripts/madman-smoke.mjs"]],
  ["evaluate_js vs CSP", "node", ["scripts/evaluate-csp-smoke.mjs"]],
  ["jev fast decisions (sidecar)", "node", ["scripts/jev-smoke.mjs"]],
  ["self-improvement (coach lessons)", "node", ["scripts/lessons-smoke.mjs"]],
  ["phase 1 — lifecycle (quick)", "node", ["scripts/phase1-smoke.mjs", "quick"]],
];

const failures = [];
for (const [name, cmd, args] of steps) {
  console.log(`\n========== ${name} ==========`);
  const result = spawnSync(cmd, args, { stdio: "inherit" });
  if (result.status !== 0) {
    failures.push(name);
    console.log(`========== ${name}: FAILED ==========`);
  } else {
    console.log(`========== ${name}: ok ==========`);
  }
}

console.log("\n================ SUMMARY ================");
for (const name of steps.map((s) => s[0])) {
  console.log(` ${failures.includes(name) ? "FAIL" : " ok "}  ${name}`);
}
if (failures.length) {
  console.log(`\n${failures.length} suite(s) FAILED`);
  process.exit(1);
}
console.log("\nALL SUITES GREEN");
