#!/usr/bin/env node
// What the run-log archive says about where a run's time went.
//
//   node scripts/runlog-stats.mjs [export.jsonl ...]
//
// With no argument it reads the newest crazyagent-logs-*.jsonl in ~/Downloads
// (Run logs → Export JSONL writes them there). With two or more files it also
// prints a side-by-side comparison — that is the before/after check for the
// speed work: export, change one thing, export again, compare.
//
// Everything here is derived from the log alone. Each turn carries its own
// wall-clock duration, each tool call its durationMs, and the final stats line
// the token counts, the fixed prefix and (when the endpoint reports one) the
// prompt-cache read.
import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

function newestExport() {
  const dir = join(homedir(), "Downloads");
  const files = readdirSync(dir)
    .filter((f) => f.startsWith("crazyagent-logs-") && f.endsWith(".jsonl"))
    .map((f) => ({ f, t: readFileSync(join(dir, f), "utf8").length }))
    .sort();
  if (!files.length) throw new Error(`no crazyagent-logs-*.jsonl in ${dir}`);
  return join(dir, files[files.length - 1].f);
}

function load(path) {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
}

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const pct = (a, b) => (b ? `${Math.round((100 * a) / b)}%` : "—");
const secs = (ms) => `${(ms / 1000).toFixed(0)}s`;

/** Least-squares fit of turn latency against generated tokens. */
function fitLatency(turns) {
  const pts = turns
    .filter((t) => t.durationMs)
    .map((t) => ({
      // Output tokens the turn produced, from the text the model streamed
      // (reasoning included — it is generated and paid for like any other).
      x: ((t.reasoning?.length ?? 0) + (t.text?.length ?? 0)) / 4,
      y: Math.max(0, t.durationMs - t.tools.reduce((s, c) => s + (c.durationMs ?? 0), 0)),
    }));
  if (pts.length < 8) return null;
  const mx = mean(pts.map((p) => p.x));
  const my = mean(pts.map((p) => p.y));
  let num = 0;
  let den = 0;
  for (const p of pts) {
    num += (p.x - mx) * (p.y - my);
    den += (p.x - mx) ** 2;
  }
  const b = den ? num / den : 0;
  return { fixedMs: my - b * mx, tokPerSec: b > 0 ? 1000 / b : 0, n: pts.length };
}

function analyse(records) {
  const turns = records.flatMap((r) => r.turns ?? []);
  const tools = turns.flatMap((t) => t.tools ?? []);
  const stats = records.map((r) => (r.turns ?? []).find((t) => t.stats)?.stats).filter(Boolean);

  let llmMs = 0;
  let toolMs = 0;
  let screenshotOnly = 0;
  let withScreenshot = 0;
  let failedTurns = 0;
  const latencies = [];
  const ttfts = [];
  const decodes = [];
  const byTool = new Map();
  for (const t of turns) {
    const tm = (t.tools ?? []).reduce((s, c) => s + (c.durationMs ?? 0), 0);
    toolMs += tm;
    llmMs += Math.max(0, (t.durationMs ?? 0) - tm);
    if (t.durationMs) latencies.push(t.durationMs);
    if (t.ttftMs !== undefined) ttfts.push(t.ttftMs);
    if (t.decodeMs !== undefined) decodes.push(t.decodeMs);
    const names = (t.tools ?? []).map((c) => c.name);
    if (names.includes("screenshot")) {
      withScreenshot++;
      if (names.every((n) => n === "screenshot")) screenshotOnly++;
    }
    if ((t.tools ?? []).some((c) => c.ok === false)) failedTurns++;
    for (const c of t.tools ?? []) {
      const e = byTool.get(c.name) ?? { n: 0, ms: 0, max: 0, fail: 0 };
      e.n++;
      e.ms += c.durationMs ?? 0;
      e.max = Math.max(e.max, c.durationMs ?? 0);
      if (c.ok === false) e.fail++;
      byTool.set(c.name, e);
    }
  }
  latencies.sort((a, b) => a - b);
  ttfts.sort((a, b) => a - b);
  decodes.sort((a, b) => a - b);
  const q = (p) => latencies[Math.min(latencies.length - 1, Math.floor(p * latencies.length))] ?? 0;
  const qt = (xs, p) => xs[Math.min(xs.length - 1, Math.floor(p * xs.length))] ?? 0;
  const sum = (xs) => xs.reduce((s, x) => s + x, 0);

  const inputTokens = stats.reduce((s, x) => s + (x.inputTokens ?? 0), 0);
  const outputTokens = stats.reduce((s, x) => s + (x.outputTokens ?? 0), 0);
  const cached = stats.filter((x) => x.cachedInputTokens !== undefined);
  const cacheReported = cached.reduce((s, x) => s + x.cachedInputTokens, 0);
  const cacheInput = cached.reduce((s, x) => s + x.inputTokens, 0);

  return {
    runs: records.length,
    turns: turns.length,
    tools: tools.length,
    toolsPerTurn: tools.length / Math.max(1, turns.length),
    wallMs: turns.reduce((s, t) => s + (t.durationMs ?? 0), 0),
    llmMs,
    toolMs,
    steps: { p50: q(0.5), p90: q(0.9), p95: q(0.95), max: latencies.at(-1) ?? 0 },
    screenshotOnly,
    withScreenshot,
    failedTurns,
    byTool,
    ttft: ttfts.length
      ? { n: ttfts.length, p50: qt(ttfts, 0.5), p90: qt(ttfts, 0.9), total: sum(ttfts) }
      : null,
    decode: decodes.length
      ? { n: decodes.length, p50: qt(decodes, 0.5), p90: qt(decodes, 0.9), total: sum(decodes) }
      : null,
    inputTokens,
    outputTokens,
    cache: cached.length ? { tokens: cacheReported, input: cacheInput } : null,
    prefixTokens: stats.map((x) => x.prefixTokens).filter(Boolean).at(-1) ?? 0,
    fit: fitLatency(turns),
  };
}

function report(name, a) {
  console.log(`\n=== ${name} ===`);
  console.log(
    `${a.runs} runs · ${a.turns} turns · ${a.tools} tool calls · ${a.toolsPerTurn.toFixed(2)} tools/turn`,
  );
  const wall = a.llmMs + a.toolMs;
  console.log(
    `wall: ${secs(a.wallMs)}  |  LLM round trips ${secs(a.llmMs)} (${pct(a.llmMs, wall)})  |  tools ${secs(a.toolMs)} (${pct(a.toolMs, wall)})`,
  );
  console.log(
    `step latency: p50 ${secs(a.steps.p50)} · p90 ${secs(a.steps.p90)} · p95 ${secs(a.steps.p95)} · max ${secs(a.steps.max)}`,
  );
  // The TTFT/decode split attributes the LLM time: high TTFT with a small
  // decode means the round trip is paying for input (prefill an uncached
  // prompt or a slow queue); the reverse means reasoning/output is the cost.
  if (a.ttft) {
    console.log(
      `ttft: p50 ${secs(a.ttft.p50)} · p90 ${secs(a.ttft.p90)} · total ${secs(a.ttft.total)} (${a.ttft.n} turns measured)`,
    );
  } else {
    console.log("ttft: not measured (export predates turn timing)");
  }
  if (a.decode) {
    console.log(
      `decode: p50 ${secs(a.decode.p50)} · p90 ${secs(a.decode.p90)} · total ${secs(a.decode.total)}`,
    );
  }
  if (a.fit) {
    console.log(
      `fitted: ${(a.fit.fixedMs / 1000).toFixed(1)}s fixed per round trip + ${a.fit.tokPerSec.toFixed(0)} tok/s generation (n=${a.fit.n})`,
    );
  }
  console.log(
    `tokens: ${a.inputTokens.toLocaleString()} in / ${a.outputTokens.toLocaleString()} out`,
  );
  if (a.cache) {
    console.log(
      `cache: ${a.cache.tokens.toLocaleString()} of ${a.cache.input.toLocaleString()} input tokens served from cache (${pct(a.cache.tokens, a.cache.input)})`,
    );
  } else {
    console.log("cache: the endpoint reported no cache numbers for these runs");
  }
  if (a.prefixTokens) {
    console.log(
      `prefix: ${a.prefixTokens.toLocaleString()} tokens re-sent per step × ${a.turns} = ${(a.prefixTokens * a.turns).toLocaleString()} tokens of fixed cost`,
    );
  }
  console.log(
    `waste: ${a.screenshotOnly}/${a.turns} turns were screenshot-only (${pct(a.screenshotOnly, a.turns)}) · ${a.failedTurns} turns carried a failed call (${pct(a.failedTurns, a.turns)})`,
  );
  console.log("slowest tools:");
  for (const [n, e] of [...a.byTool].sort((x, y) => y[1].ms - x[1].ms).slice(0, 8)) {
    console.log(
      `  ${n.padEnd(16)} ${secs(e.ms).padStart(6)}  n=${String(e.n).padStart(4)}  avg=${String(Math.round(e.ms / e.n)).padStart(5)}ms  max=${secs(e.max).padStart(6)}  fail=${e.fail}`,
    );
  }
}

const paths = process.argv.slice(2);
const files = paths.length ? paths : [newestExport()];
const results = files.map((p) => [p.split("/").pop(), analyse(load(p))]);
for (const [name, a] of results) report(name, a);

if (results.length > 1) {
  const [before, after] = [results[0][1], results.at(-1)[1]];
  console.log("\n=== before → after ===");
  const row = (label, b, a, lowerIsBetter = true) => {
    const better = lowerIsBetter ? a < b : a > b;
    const delta = b ? ((a - b) / b) * 100 : 0;
    console.log(
      `  ${label.padEnd(24)} ${String(b).padStart(10)} → ${String(a).padStart(10)}  ${delta >= 0 ? "+" : ""}${delta.toFixed(0)}%${better ? "  better" : ""}`,
    );
  };
  row("wall (s)", Math.round(before.wallMs / 1000), Math.round(after.wallMs / 1000));
  row("tools per turn", +before.toolsPerTurn.toFixed(2), +after.toolsPerTurn.toFixed(2), false);
  row("turns", before.turns, after.turns);
  row("p50 step (s)", +(before.steps.p50 / 1000).toFixed(1), +(after.steps.p50 / 1000).toFixed(1));
  if (before.ttft && after.ttft) {
    row("p50 ttft (s)", +(before.ttft.p50 / 1000).toFixed(1), +(after.ttft.p50 / 1000).toFixed(1));
  }
  if (before.decode && after.decode) {
    row(
      "decode total (s)",
      Math.round(before.decode.total / 1000),
      Math.round(after.decode.total / 1000),
    );
  }
  row("screenshot-only turns", before.screenshotOnly, after.screenshotOnly);
  if (before.fit && after.fit) {
    row("fixed cost/step (s)", +(before.fit.fixedMs / 1000).toFixed(1), +(after.fit.fixedMs / 1000).toFixed(1));
  }
  if (before.cache && after.cache) {
    row(
      "cache hit %",
      Math.round((100 * before.cache.tokens) / before.cache.input),
      Math.round((100 * after.cache.tokens) / after.cache.input),
      false,
    );
  }
}