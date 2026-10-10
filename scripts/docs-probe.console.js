// Deterministic Google Docs probe, v8.4 — verifies the menu-bar recovery.
//
// v8.3 found the cause of every "no visible clickable element matches
// [File / Format / …]" miss: Docs' full-screen mode sets `.docs-menubars` to
// display:none. The bar stays in the DOM with all ten labels, so a walk misses
// at step 1 and the error reads like a renamed menu. One Ctrl+Shift+F flipped
// the wrapper back to display:block and the same walk clicked Format ▸ Text.
//
// walkMenu now detects that state (no menu row visible anywhere AND a bar
// container present) and presses Ctrl+Shift+F once before giving up — only on
// that detection, never on a plain miss. This run checks that the recovery
// fires, that it is named in the step list, that a healthy bar costs nothing
// extra, and that docs_op still works straight after a reveal.
//
// NOTE: the run leaves the document with its menus VISIBLE, which is the
// healthy state — if the browser was in full-screen beforehand, it will not be
// afterwards.
//
// HOW TO RUN
//   1. Reload the extension (chrome://extensions → crazyAgent → reload) so the
//      new build is live, then open the crazyAgent side panel.
//   2. Right-click inside the panel → Inspect → Console.
//   3. Paste this whole file and press Enter (about 1 minute). Don't touch the
//      tab meanwhile.
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
    try {
      const out = await ba.toolText(name, args);
      return { call: name, args, ms: Date.now() - started, out: clipText(out) };
    } catch (err) {
      return { call: name, args, ms: Date.now() - started, error: clipText(String(err?.message ?? err), 700) };
    }
  };
  const js = async (expression) => {
    const r = await ba.tool("evaluate_js", { expression });
    const p = r.ok ? r.payload : r.error;
    const raw = typeof p === "string" ? p : JSON.stringify(p);
    const m = /\{[\s\S]*\}|\[[\s\S]*\]/.exec(raw ?? "");
    let parsed = null;
    if (m) {
      try {
        parsed = JSON.parse(m[0]);
        if (typeof parsed?.value === "string") parsed = JSON.parse(parsed.value);
        else if (typeof parsed?.result === "string") parsed = JSON.parse(parsed.result);
      } catch {}
    }
    return parsed ?? { raw: clipText(raw, 600) };
  };
  /** The one fact that matters: is the bar rendered, and is its wrapper hidden? */
  const barState = () =>
    js(`(() => {
      const vis = (e) => { const r = e.getBoundingClientRect(); const s = getComputedStyle(e); return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden'; };
      const box = (e) => { const r = e.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; };
      const bar = document.querySelector('.docs-menubar');
      const wrap = document.querySelector('.docs-menubars');
      let rows = 0;
      for (const el of document.querySelectorAll('.goog-menuitem, [role="menuitem"]')) if (vis(el)) rows++;
      return JSON.stringify({
        barRect: bar ? box(bar) : null,
        wrapperDisplay: wrap ? getComputedStyle(wrap).display : null,
        visibleMenuRows: rows,
      });
    })()`);

  const report = { version: 8.4, startedAt: new Date().toISOString(), userAgent: navigator.userAgent, stages: {} };
  const stage = async (name, fn) => {
    report.stages[name] = await fn();
    console.log(`[probe] ${name} done`);
  };

  console.log("[probe] opening a new doc…");
  report.open = await t("navigate", { url: "https://docs.new" });
  await sleep(6000);

  await stage("S1_baseline", async () => ({ state: await barState() }));

  await stage("S2_hide_the_bar", async () => {
    const key = await t("key", { key: "Control+Shift+f" });
    await sleep(1800);
    return { key: key.out ?? key.error, state: await barState(), expect: "wrapperDisplay none, visibleMenuRows 0" };
  });

  await stage("S3_walk_recovers", async () => {
    const walk = await t("menu_path", { path: ["Format", "Text"] });
    const state = await barState();
    await t("key", { key: "Escape" });
    await t("key", { key: "Escape" });
    const text = String(walk.out ?? walk.error ?? "");
    return {
      walk: clipText(text, 500),
      ms: walk.ms,
      state,
      succeeded: /^clicked/.test(text),
      reportedTheRecovery: /hidden \(full-screen mode\)/.test(text),
      expect: "succeeded true, reportedTheRecovery true, visibleMenuRows > 0",
    };
  });

  await stage("S4_healthy_bar_costs_nothing", async () => {
    const walk = await t("menu_path", { path: ["Insert", "Table"] });
    await t("key", { key: "Escape" });
    await t("key", { key: "Escape" });
    const text = String(walk.out ?? walk.error ?? "");
    return {
      walk: clipText(text, 400),
      ms: walk.ms,
      succeeded: /^clicked/.test(text),
      reportedTheRecovery: /hidden \(full-screen mode\)/.test(text),
      expect: "succeeded true, reportedTheRecovery FALSE — the bar was already up",
    };
  });

  await stage("S5_docs_op_after_a_reveal", async () => {
    const hide = await t("key", { key: "Control+Shift+f" });
    await sleep(1800);
    const hidden = await barState();
    const op = await t("docs_op", { op: "insert_table", rows: 2, cols: 2 });
    const after = await barState();
    await t("key", { key: "Escape" });
    return {
      hide: hide.out ?? hide.error,
      hidden,
      op: clipText(op.out ?? op.error, 500),
      after,
      expect: "hidden.visibleMenuRows 0, insert_table still reports a verified <table>, after.visibleMenuRows > 0",
    };
  });

  // Leave the menus up whatever happened above.
  const last = await barState();
  if (!last || last.visibleMenuRows === 0) {
    await t("key", { key: "Control+Shift+f" });
    await sleep(1500);
  }
  report.finalState = await barState();
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
