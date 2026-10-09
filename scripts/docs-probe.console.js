// Deterministic Google Docs probe, v7 — the sideways cell escape.
//
// v6 verified the vertical repair (Q14: `before` at a first-column cell start
// stayed in the cell, note said so) and the fast paths (Q16 mid-paragraph, Q17
// mid-cell, both unrepaired and correct). It also measured the gap: Q18's
// `before` on a SECOND-column cell put the caret at (566,323) — the end of the
// cell to the LEFT — so the letter landed there. A sideways step keeps the
// caret on the same line, which is why the line comparison missed it.
//
// The fix: one arrow key never moves a caret further than a character unless it
// crossed a cell edge, so the two caret reads around the step-back now also
// compare x against the caret height. When they disagree that far, the step
// back is already on the match edge and the collapse stops there.
//
// Q18 re-runs the case that failed, and Q19 is its mirror (`after` at a
// first-column cell's end, which steps sideways into the next cell). Q14–Q17
// are regressions: the repaired vertical case and both fast paths.
//
// v7.1: the v7 run exposed an off-by-one in that change — the collapse returned
// without its final step toward, so EVERY caret mode landed one character
// inside the match (mPid, aHaa, zzTz, dKdd, eeSe) and docs_table's before-table
// route typed all six fill values into the paragraph above the table. The
// keystroke is restored; this run re-checks all six cases and the fill itself.
//
// HOW TO RUN
//   1. Reload the extension (chrome://extensions → crazyAgent → reload) so the
//      new build is live, then open the crazyAgent side panel.
//   2. Right-click inside the panel → Inspect → Console.
//   3. Paste this whole file and press Enter. It opens a NEW doc (docs.new) in
//      the agent's tab and runs Q14–Q19 (about 2–3 minutes; export reads are
//      paced to stay under Google's rate limit). Don't touch the tab meanwhile.
//   4. The report is printed and copied to the clipboard; paste it back.
(async () => {
  const ba = window.__ba;
  if (!ba || typeof ba.toolText !== "function" || typeof ba.tool !== "function") {
    console.error("window.__ba missing — paste this into the crazyAgent SIDE PANEL's DevTools console");
    return;
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const clipText = (s, n = 1200) => (typeof s === "string" && s.length > n ? `${s.slice(0, n)}…[+${s.length - n}]` : s);
  const t = async (name, args = {}) => {
    const started = Date.now();
    if (name === "key" || name === "type") {
      // Action tools resolve with {ok, data}: the input route is one level down.
      const r = await ba.tool(name, args);
      const d = r?.ok && r.payload && typeof r.payload === "object" ? r.payload.data : null;
      return {
        call: name,
        args,
        ms: Date.now() - started,
        route: d && typeof d === "object" ? (d.mode ?? "dom") : "?",
        ...(r?.ok ? {} : { error: clipText(String(r?.error ?? ""), 300) }),
      };
    }
    const out = await ba.toolText(name, args);
    return { call: name, args, ms: Date.now() - started, out: clipText(out) };
  };
  // Export reads are rate-limited (~10/min) and the tools read the export too,
  // so the probe paces its own reads AND leaves gaps around every table step.
  let lastRead = 0;
  const read = async (format = "outline") => {
    const wait = Math.max(3000, 9000 - (Date.now() - lastRead));
    await sleep(wait);
    lastRead = Date.now();
    return ba.toolText("docs_read", { format, max_chars: 6000 });
  };
  const clear = async () => {
    await ba.toolText("key", { key: "Escape" });
    await ba.toolText("key", { key: "Control+a" });
    await ba.toolText("key", { key: "Backspace" });
    await sleep(400);
  };

  const report = { version: 7.1, startedAt: new Date().toISOString(), userAgent: navigator.userAgent, probes: {} };
  const probe = async (id, decides, fn) => {
    const steps = [];
    const step = async (name, args) => {
      const s = await t(name, args);
      steps.push(s);
      return s.out;
    };
    let verdict;
    try {
      verdict = await fn(step);
    } catch (err) {
      verdict = { error: String(err?.stack ?? err) };
    }
    report.probes[id] = { decides, steps, ...verdict };
    console.log(`[probe] ${id} done`, verdict);
  };

  console.log("[probe] opening a new doc…");
  report.open = await t("navigate", { url: "https://docs.new" });
  await sleep(4000);
  await clear();

  // One document, built once, that holds every case: an ordinary paragraph with
  // a mid-line phrase, and a 3×2 table whose cells hold a cell-start phrase in
  // column 1 ("aaa"), a mid-cell phrase ("bbb"), a cell-end phrase in the last
  // column ("zzz"), a second-column cell start ("ddd") and a first-column cell
  // end ("eee") — the two sideways cases.
  console.log("[probe] building the fixture…");
  await ba.toolText("type", { text: "para mid para" });
  await ba.toolText("key", { key: "Enter" });
  report.build = {
    insert: clipText(await ba.toolText("docs_op", { op: "insert_table", rows: 3, cols: 2 }), 400),
  };
  await sleep(8000);
  report.build.fill = clipText(
    await ba.toolText("docs_table", {
      op: "fill",
      table: 1,
      rows: [["aaa bbb", "zzz"], ["ccc", "ddd"], ["eee", "fff"]],
    }),
    400,
  );
  await sleep(9000);

  // v7 ran all six trials against a fixture whose fill had NOT landed, so every
  // letter went into the paragraph above the table and the trials measured
  // nothing. Skip them when the build did not verify.
  const fixtureOk = !/NOT VERIFIED|ERROR/i.test(String(report.build.fill ?? ""));
  if (!fixtureOk) {
    report.aborted =
      "the fixture did not build (see build.fill) — trials skipped: they would only type into the wrong place";
  }

  // Each trial: locate with a caret mode, type one letter, and record what the
  // locate said (its note names a repair) plus the letter that was typed. The
  // outline at the end is the verdict on all of them.
  const trial = async (id, decides, phrase, caret, letter, expected) => {
    if (!fixtureOk) return;
    await probe(id, decides, async (step) => {
      const located = await step("docs_locate", { phrase, caret });
      await step("type", { text: letter });
      return {
        locate: clipText(located, 700),
        typed: letter,
        expected,
        repaired: /cell or line edge/.test(String(located ?? "")),
      };
    });
    await sleep(1200);
  };

  await trial(
    "Q14",
    "caret:'before' on a phrase at a CELL START — does the caret stay in the cell now?",
    "aaa",
    "before",
    "H",
    "r1: Haaa bbb | zzz  (repaired: true)",
  );
  await trial(
    "Q15",
    "caret:'after' on a phrase at a LAST-column CELL END — v6 needed no repair here and was correct",
    "zzz",
    "after",
    "T",
    "r1: … | zzzT  (repaired: false is fine, as long as the T is in the cell)",
  );
  await trial(
    "Q16",
    "caret:'before' mid-paragraph — the fast path must be unchanged",
    "mid",
    "before",
    "P",
    "P: para Pmid para  (repaired: false)",
  );
  await trial(
    "Q17",
    "caret:'before' MID-CELL — the fast path, inside a table",
    "bbb",
    "before",
    "G",
    "r1: Haaa Gbbb | zzzT  (repaired: false)",
  );
  await trial(
    "Q18",
    "caret:'before' at the start of a SECOND-column cell — v6 left the caret at the end of the cell to the left",
    "ddd",
    "before",
    "K",
    "r2: ccc | Kddd  (repaired: true)",
  );
  await trial(
    "Q19",
    "caret:'after' at the end of a FIRST-column cell — the sideways mirror",
    "eee",
    "after",
    "S",
    "r3: eeeS | fff  (repaired: true)",
  );

  report.outline = clipText(await read("outline"), 1400);
  report.expectedOutline =
    "P: para Pmid para · TABLE 1 (3 rows × 2 cols) r1: Haaa Gbbb | zzzT · r2: ccc | Kddd · r3: eeeS | fff — every letter inside the cell it was aimed at";

  report.finishedAt = new Date().toISOString();
  const json = JSON.stringify(report, null, 2);
  console.log(json);
  try {
    copy(json);
    console.log("[probe] report copied to the clipboard — paste it into the chat");
  } catch {
    console.log("[probe] copy() unavailable — select the JSON above and copy it");
  }
})();
