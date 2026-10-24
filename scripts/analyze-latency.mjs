#!/usr/bin/env node
// Latency breakdown for crazyAgent runs.
//
// Reconstructs, per turn (keyed on turnId so aborted/parallel turns align):
//   model = step/start -> assistant/message   (LLM round trip)
//   tool  = assistant/message -> tool/result  (browser round trip)
//   other = everything else (capture, prompt build, final plumbing, waiting)
//
// Usage: node scripts/analyze-latency.mjs [--runs N] [--detail] [--json]

import fs from "node:fs";
import path from "node:path";

const LOGS = path.resolve(".dsh-home/browser-agent/logs");
const argv = process.argv.slice(2);
const arg = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : dflt;
};
const count = Number(arg("runs", "4"));
const detail = argv.includes("--detail");
const asJson = argv.includes("--json");

const runs = fs
  .readdirSync(LOGS)
  .filter((d) => d.startsWith("run-"))
  .sort()
  .slice(-count);

const fmt = (n) => (n == null ? "-" : n >= 60000 ? `${(n / 60000).toFixed(1)}m` : `${(n / 1000).toFixed(1)}s`);
const pad = (s, n) => String(s).padEnd(n);

const out = [];

for (const run of runs) {
  const dir = path.join(LOGS, run);
  const evs = fs
    .readFileSync(path.join(dir, "events.jsonl"), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));

  const turns = new Map();
  const get = (id) => {
    if (!turns.has(id)) turns.set(id, { modelMs: 0, toolMs: 0, steps: 0, tools: {}, byName: {} });
    return turns.get(id);
  };

  let stepStart = null;
  let pending = null;
  const compaction = { n: 0, failed: 0, ms: 0 };
  const cStart = new Map();
  for (const e of evs) {
    const id = e.turnId;
    if (!id) continue;
    const ev = e?.data?.params?.event;
    if (!ev) continue;
    const t = Date.parse(e.time);
    const T = get(id);
    if (ev.type === "compaction/start") cStart.set(ev.data?.compactionId, t);
    else if (ev.type === "compaction/end") {
      const s0 = cStart.get(ev.data?.compactionId);
      if (s0 != null) {
        compaction.n++;
        compaction.ms += t - s0;
        if (ev.data?.error) compaction.failed++;
      }
    } else if (ev.type === "step/start") stepStart = t;
    else if (ev.type === "assistant/message") {
      T.steps++;
      if (stepStart) T.modelMs += t - stepStart;
      const call = (ev.data?.message?.content ?? []).find((c) => c.type === "tool-call");
      pending = call ? { name: call.name, at: t } : null;
    } else if (ev.type === "tool/result" && pending) {
      const d = t - pending.at;
      T.toolMs += d;
      T.tools[pending.name] = (T.tools[pending.name] ?? 0) + 1;
      T.byName[pending.name] = (T.byName[pending.name] ?? 0) + d;
      pending = null;
    }
  }

  const starts = evs.filter((e) => e.type === "turn.start");
  const ends = new Map(evs.filter((e) => e.type === "turn.end").map((e) => [e.turnId, e]));

  out.push({
    run,
    compaction,
    turns: starts.map((s) => {
      const end = ends.get(s.turnId);
      const tm = end?.data?.timings ?? {};
      const T = get(s.turnId);
      return {
        turnId: s.turnId,
        text: s.data?.userText ?? "",
        aborted: !!end?.data?.aborted,
        ok: end?.data?.ok,
        totalMs: tm.totalMs ?? null,
        modelMs: T.modelMs,
        toolMs: T.toolMs,
        steps: T.steps,
        tools: T.tools,
        toolMsByName: T.byName,
        autoCaptureMs: tm.autoCaptureMs ?? null,
        firstEventMs: tm.firstEventMs ?? null,
        promptTextBytes: tm.promptTextBytes ?? null,
        imageBytes: tm.imageBytes ?? null,
        images: tm.images ?? null,
      };
    }),
  });
}

if (asJson) {
  console.log(JSON.stringify(out, null, 2));
  process.exit(0);
}

const pct = (v, T) => (T ? `${Math.round((v / T) * 100)}%` : "-");

for (const r of out) {
  console.log(`\n=== ${r.run} (${r.turns.length} turns) ===`);
  for (const t of r.turns) {
    const other = t.totalMs != null ? t.totalMs - t.modelMs - t.toolMs : null;
    console.log(
      `\n"${t.text.slice(0, 60)}"${t.aborted ? " [ABORTED]" : ""}${t.ok === false && !t.aborted ? " [FAILED]" : ""}`
    );
    console.log(
      `  total ${pad(fmt(t.totalMs), 9)} model ${pad(fmt(t.modelMs), 8)} ${pad(pct(t.modelMs, t.totalMs), 5)} tool ${pad(fmt(t.toolMs), 8)} ${pad(pct(t.toolMs, t.totalMs), 5)} other ${pad(fmt(other), 8)} ${pct(other, t.totalMs)}`
    );
    console.log(
      `  steps=${pad(t.steps, 3)} capture=${pad(fmt(t.autoCaptureMs), 7)} firstEvent=${pad(fmt(t.firstEventMs), 7)} prompt=${t.promptTextBytes ?? "?"}B img=${t.imageBytes ? (t.imageBytes / 1024).toFixed(0) + "KB" : "0"}`
    );
    if (detail && Object.keys(t.tools).length) {
      console.log(
        "  " +
          Object.entries(t.tools)
            .map(([k, n]) => `${k}x${n} ${fmt(t.toolMsByName[k] ?? 0)}`)
            .join("; ")
      );
    }
  }
}

console.log(`\n=== PER RUN ===`);
console.log(`${"run".padEnd(40)} ${"turns".padStart(5)} ${"wall".padStart(9)} ${"model".padStart(9)} ${"tool".padStart(9)} ${"compact".padStart(9)}`);
let TW = 0, TMm = 0, TK = 0, TC = 0;
for (const r of out) {
  const done = r.turns.filter((t) => t.totalMs != null && !t.aborted);
  const w = done.reduce((a, t) => a + t.totalMs, 0);
  const m = done.reduce((a, t) => a + t.modelMs, 0);
  const k = done.reduce((a, t) => a + t.toolMs, 0);
  TW += w; TMm += m; TK += k; TC += r.compaction.ms;
  console.log(
    `${r.run.padEnd(40)} ${String(done.length).padStart(5)} ${fmt(w).padStart(9)} ${fmt(m).padStart(9)} ${fmt(k).padStart(9)} ${(fmt(r.compaction.ms) + " (" + r.compaction.n + ")").padStart(9)}`
  );
}
const all = out.flatMap((r) => r.turns).filter((t) => t.totalMs != null && !t.aborted);
const S = (f) => all.reduce((a, t) => a + (f(t) || 0), 0);
const T = S((t) => t.totalMs);
const M = S((t) => t.modelMs);
const K = S((t) => t.toolMs);
console.log(`\n=== AGGREGATE: ${all.length} completed turns across ${out.length} runs ===`);
console.log(`wall     ${pad(fmt(T), 9)} 100%`);
console.log(`  model  ${pad(fmt(M), 9)} ${pct(M, T)}   <- LLM round trips`);
console.log(`  tool   ${pad(fmt(K), 9)} ${pct(K, T)}   <- browser round trips`);
console.log(`  other  ${pad(fmt(T - M - K), 9)} ${pct(T - M - K, T)}   <- capture, prompt build, plumbing`);
console.log(
  `\navg/turn ${fmt(T / all.length)} | steps/turn ${(S((t) => t.steps) / all.length).toFixed(1)} | avg model/step ${fmt(M / S((t) => t.steps))} | avg tool/call ${fmt(K / Math.max(1, Object.values(all.reduce((a, t) => { for (const [k, v] of Object.entries(t.tools)) a[k] = (a[k] ?? 0) + v; return a; }, {})).reduce((x, y) => x + y, 0)))}`
);

const byTool = { n: 0, ms: 0, calls: {} };
for (const t of all)
  for (const [k, v] of Object.entries(t.tools)) {
    byTool.calls[k] ??= { n: 0, ms: 0 };
    byTool.calls[k].n += v;
    byTool.calls[k].ms += t.toolMsByName[k] ?? 0;
  }
console.log(`\ntool call cost (${all.length} turns):`);
for (const [k, v] of Object.entries(byTool.calls).sort((a, b) => b[1].ms - a[1].ms))
  console.log(`  ${pad(k, 24)} x${pad(v.n, 4)} ${pad(fmt(v.ms), 8)} avg ${fmt(v.ms / v.n)}`);

const av = all.filter((t) => t.steps).map((t) => t.modelMs / t.steps);
if (av.length)
  console.log(
    `\nmodel latency per step: min ${fmt(Math.min(...av))} mean ${fmt(av.reduce((a, b) => a + b, 0) / av.length)} max ${fmt(Math.max(...av))}`
  );