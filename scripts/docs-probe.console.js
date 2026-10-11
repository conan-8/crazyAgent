// Deterministic Google Docs probe, v10 — does docs_locate TYPE ITS OWN QUERY
// INTO THE DOCUMENT when Ctrl+F is swallowed?
//
// What v9 settled (measured, not inferred):
//   • The find-bar-residue theory is DEAD. After docs_locate the find bar is
//     absent from the DOM entirely (findbar.present false), focus is on the
//     editor sink iframe at y=-10000, and the fixture paragraph was untouched
//     by docs_locate + Control+Shift+Down + Escape + Control+Shift+Down:
//     wipedByLocate false, wipedByKeys false. On a CLEAN page it is safe.
//   • The click magnet is INNOCENT. The menu bar has 10 separate
//     role=menuitem boxes (Extensions x340-424, y34-57); the five logged clicks
//     at x353-391, y59 are all horizontally inside Extensions and 2px below its
//     bottom edge, with role=menubar (interactive:false) as the hit. Extensions
//     really was the nearest item. The fault was the model passing
//     screenshot-space numbers as space:"viewport".
//   • v9's S3 control was invalid: 8× Control+z undid the fixture to 0 chars, so
//     it measured nothing. There is no blind undo anywhere in v10.
//
// What is still open, and why this round exists:
//   findBarCaret (extension/src/background/tools/docs.ts:466) does
//       sendTrustedKey("Control+f");
//       sendTrustedText(phrase);          <-- no check that the bar opened
//   It types the search phrase BEFORE verifying a find bar exists. On a canvas
//   editor sendTrustedText sends real keystrokes to whatever is focused, and
//   with a live selection that REPLACES it. That is the only mechanism found
//   that can turn a paragraph into exactly the search phrase — which is what the
//   2026-10-10 run produced, down to the character.
//   v9 tested a clean page, where Ctrl+F works. The real run had clicked a
//   toolbar dropdown 8s earlier. So:
//     S2 — sample the find bar's DOM WHILE OPEN. The guard needs measured
//          selectors; v9 only ever sampled the closed state.
//     S3 — call docs_locate with a MENU OPEN. Is Ctrl+F swallowed, and does the
//          phrase land in the document?
//     S4 — the incident shape: a live selection over the paragraph PLUS an open
//          popup, then docs_locate. Replacement, not insertion.
//
// S3/S4 CAN DESTROY THE FIXTURE TEXT — that is the measurement. It happens in a
// brand-new throwaway doc the probe opens itself, never one you care about.
//
// HOW TO RUN
//   1. `npm run build`, then reload the extension (chrome://extensions →
//      crazyAgent → reload). A stale dist/ wastes the round.
//   2. Open the crazyAgent side panel → right-click inside it → Inspect →
//      Console.
//   3. Paste this whole file and press Enter (~2.5 minutes; the export reads are
//      paced ~10s apart — that is the rate limit, not a hang). Don't touch the
//      tab meanwhile.
//   4. The report is printed and copied to the clipboard; paste it back.
(async () => {
  const ba = window.__ba;
  if (!ba || typeof ba.toolText !== "function" || typeof ba.tool !== "function") {
    console.error("window.__ba missing — paste this into the crazyAgent SIDE PANEL's DevTools console");
    return;
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const clipText = (s, n = 1400) =>
    typeof s === "string" && s.length > n ? `${s.slice(0, n)}…[+${s.length - n}]` : s;
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

  // The export is rate-limited (~10/min → 429); a drowned run measures nothing.
  let lastRead = 0;
  const readText = async () => {
    const wait = 10_000 - (Date.now() - lastRead);
    if (wait > 0) await sleep(wait);
    const r = await t("docs_read", { format: "text" });
    lastRead = Date.now();
    return String(r.out ?? r.error ?? "");
  };
  const TAIL_MARK = "warmest laptop";
  const intact = (read) => read.includes(TAIL_MARK);

  // Shared prologue for every evaluate_js below, so the dumps stay readable.
  const PRELUDE = `
      const vis = (e) => { const r = e.getBoundingClientRect(); const s = getComputedStyle(e); return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden'; };
      const box = (e) => { const r = e.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; };
      const desc = (e) => ({ tag: e.tagName, id: e.id || null, cls: String(e.className || '').slice(0, 90), role: e.getAttribute && e.getAttribute('role'), aria: e.getAttribute && e.getAttribute('aria-label'), box: box(e) });
      const ae = document.activeElement;
      const sink = document.querySelector('iframe.docs-texteventtarget-iframe');
  `;

  /** S2's payload: what the find bar actually looks like in the DOM when OPEN. */
  const findbarDump = () =>
    js(`(() => {${PRELUDE}
      const findEls = [...document.querySelectorAll('[class*="find" i], [id*="find" i]')].filter(vis).slice(0, 12).map(desc);
      const inputs = [...document.querySelectorAll('input, textarea')].filter(vis).slice(0, 12)
        .map((e) => Object.assign(desc(e), { value: typeof e.value === 'string' ? e.value.slice(0, 40) : null, focused: e === ae }));
      return JSON.stringify({
        findEls,
        visibleInputs: inputs,
        activeElement: ae ? desc(ae) : null,
        activeIsSink: !!(sink && ae === sink),
      });
    })()`);

  /** Is a menu / dropdown / listbox open, and where is focus? */
  const popupState = () =>
    js(`(() => {${PRELUDE}
      const sel = '[role="menu"], .goog-menu, [role="listbox"], [class*="popup"][class*="menu"], [class*="dropdown"]';
      const menus = [...document.querySelectorAll(sel)].filter(vis).slice(0, 6)
        .map((e) => Object.assign(desc(e), { items: e.querySelectorAll('[role="menuitem"], .goog-menuitem').length }));
      return JSON.stringify({ openPopups: menus, activeElement: ae ? desc(ae) : null, activeIsSink: !!(sink && ae === sink) });
    })()`);

  /** A menu-bar label's measured centre — never hardcode coordinates. */
  const menuItemBox = async (label) => {
    const g = await js(`(() => {${PRELUDE}
      const bar = document.querySelector('.docs-menubar') || document.querySelector('.docs-menubars');
      const walk = (el, d) => !el || d > 2 ? [] : [...el.children].flatMap((c) => {
        const txt = (c.textContent || '').trim();
        return (txt.length > 0 && txt.length <= 14 && c.children.length === 0)
          ? [{ text: txt, box: box(c), visible: vis(c) }] : walk(c, d + 1);
      });
      return JSON.stringify(walk(bar, 0));
    })()`);
    const items = Array.isArray(g) ? g : [];
    const hit = items.find((i) => i.text === label && i.visible);
    return hit ? { x: hit.box.x + Math.round(hit.box.w / 2), y: hit.box.y + Math.round(hit.box.h / 2) } : null;
  };

  const report = { version: 10, startedAt: new Date().toISOString(), userAgent: navigator.userAgent, stages: {} };
  const stage = async (name, fn) => {
    console.log(`[probe] ${name} …`);
    report.stages[name] = await fn();
    console.log(`[probe] ${name} done`);
  };

  const PHRASE = "Zebra quartz lantern melody";
  const PARA = `${PHRASE}. She naps on the ${TAIL_MARK} and inspects each document with a single paw print.`;

  console.log("[probe] opening a new throwaway doc…");
  report.open = await t("navigate", { url: "https://docs.new" });
  await sleep(7000);

  // ---- S1: the fixture. Every later text stage depends on it. ----
  let ok = false;
  await stage("S1_fixture", async () => {
    const typed = await t("type", { text: PARA, expect: { text_landed: PHRASE } });
    await sleep(1200);
    const read = await readText();
    ok = intact(read) && read.includes(PHRASE);
    return {
      typed: clipText(typed.out ?? typed.error, 600),
      read: clipText(read, 600),
      built: ok,
      decides: "does the fixture paragraph exist, whole?",
      expected: "built true — the read contains BOTH the phrase and the tail",
    };
  });

  if (!ok) {
    report.aborted = "S1 fixture build FAILED — text stages skipped as meaningless";
    console.error(`[probe] ${report.aborted}`);
  } else {
    // ---- S2: what the find bar looks like WHILE OPEN. ----
    // v9 only ever sampled it closed, which is why the guard had no selectors.
    await stage("S2_findbar_while_open", async () => {
      const closedBefore = await findbarDump();
      const opened = await t("key", { key: "Control+f" });
      await sleep(1500);
      const whileOpen = await findbarDump();
      // A short harmless query, so the input's value and the counter are visible.
      const typed = await t("type", { text: "Zebra" });
      await sleep(1000);
      const withQuery = await findbarDump();
      await t("key", { key: "Escape" });
      await sleep(1200);
      const afterClose = await findbarDump();
      return {
        closedBefore,
        openKey: clipText(opened.out ?? opened.error, 300),
        whileOpen,
        typedQuery: clipText(typed.out ?? typed.error, 300),
        withQuery,
        afterClose,
        decides: "which selector identifies the find bar's INPUT when open, and what is activeElement then vs. when closed?",
        expected: "whileOpen/withQuery show a visible input (its real class/id) with activeElement on it; afterClose shows activeIsSink true and no such input. That pair is the guard's discriminator.",
      };
    });

    // ---- S3: docs_locate with a MENU OPEN. Is Ctrl+F swallowed? ----
    await stage("S3_locate_with_a_menu_open", async () => {
      const file = await menuItemBox("File");
      if (!file) return { skipped: "could not measure the File menu's box" };
      const click = await t("click_at", { space: "viewport", x: file.x, y: file.y });
      await sleep(1200);
      const menuOpen = await popupState();
      const locate = await t("docs_locate", { caret: "before", phrase: PHRASE });
      const after = await popupState();
      await t("key", { key: "Escape" });
      await sleep(1000);
      const read = await readText();
      return {
        fileMenuAt: file,
        click: clipText(click.out ?? click.error, 300),
        menuOpenBeforeLocate: menuOpen,
        locate: clipText(locate.out ?? locate.error, 500),
        focusAfterLocate: after,
        read: clipText(read, 700),
        tailSurvived: intact(read),
        phraseOccurrences: read.split(PHRASE).length - 1,
        decides: "with a menu open, does Ctrl+F fail so that sendTrustedText writes the QUERY into the document?",
        expected: "tailSurvived true and phraseOccurrences 1 => safe. tailSurvived false, or phraseOccurrences 2 => REPRODUCED: the query was typed into the doc.",
      };
    });

    // ---- S4: the incident shape. Selection live + popup open + docs_locate. ----
    await stage("S4_incident_shape", async () => {
      const read0 = await readText();
      if (!intact(read0)) {
        return {
          skipped: true,
          read: clipText(read0, 500),
          decides: "S4 needs the intact fixture",
          expected: "S3 already destroyed it — which is itself the answer, so S4 adds nothing",
        };
      }
      // A measured point on the paragraph, from the tool's own caret report,
      // then a triple-click to select it WITHOUT going through the find bar.
      const loc = await t("docs_locate", { caret: "before", phrase: PHRASE });
      const m = /at \((\d+),\s*(\d+)\)/.exec(String(loc.out ?? loc.error ?? ""));
      if (!m) return { skipped: "docs_locate reported no caretAt", locate: clipText(loc.out ?? loc.error, 400) };
      const at = { x: +m[1], y: +m[2] };
      const tri = await t("click_at", { space: "viewport", x: at.x, y: at.y, click_count: 3 });
      await sleep(900);
      // Now open a popup on top of the live selection, as the real run did.
      const file = await menuItemBox("File");
      const click = file ? await t("click_at", { space: "viewport", x: file.x, y: file.y }) : null;
      await sleep(1200);
      const popup = await popupState();
      const locate = await t("docs_locate", { caret: "before", phrase: PHRASE });
      await t("key", { key: "Escape" });
      await sleep(1000);
      const read = await readText();
      return {
        caretAt: at,
        tripleClick: clipText(tri.out ?? tri.error, 300),
        fileMenuAt: file,
        menuClick: clipText(click ? (click.out ?? click.error) : "no File box", 300),
        popupBeforeLocate: popup,
        locate: clipText(locate.out ?? locate.error, 500),
        read: clipText(read, 900),
        tailSurvived: intact(read),
        phraseOccurrences: read.split(PHRASE).length - 1,
        decides: "with a paragraph SELECTED and a popup open, does docs_locate replace the selection with its own query?",
        expected: "tailSurvived true => not reproduced. tailSurvived false with the paragraph reduced to the phrase => REPRODUCED, and findBarCaret needs a bar-present check before it types.",
      };
    });
  }

  // Leave the page calm whatever happened above.
  await t("key", { key: "Escape" });
  await sleep(600);
  report.finalPopup = await popupState();
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
