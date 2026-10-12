// Harness audit probe, v1 — falsify the weakness list in a live tab.
//
// WHAT THIS IS FOR
//   The audit produced ~60 claimed weaknesses. Most are source-level, but seven
//   are falsifiable from a real page in one paste. This probe tests exactly
//   those seven and reports CONFIRMED (the weakness is real) / FALSIFIED (the
//   page disproves it) / UNPROVEN (needs an instrument we do not have here).
//   Nothing here is inferred from reading code — each section names the claim,
//   the file:line it came from, and the measurement.
//
// THE SEVEN
//   A  Refs have no epoch and renumber on every collect      registry.ts:227
//   B  isVisible walks no ancestor — hidden nodes get refs   registry.ts:136
//   C  INTERACTIVE misses listener-driven click targets      registry.ts:37
//   D  checked state never reaches the snapshot text         perception.ts:235
//   E  in-viewport screenshot pixels are undetectable        shared/coords.ts:458
//   F  apply_style verifies class="title" literally          shared/docs-ops.ts:291
//   G  text_landed matches PAGE text, not document text      tools/expect.ts:73
//
// SAFETY
//   Read-only except A, which inserts one <button> into the page's DOM and
//   removes it again before the section returns. It is not part of any document
//   model, so nothing is saved. F reads /export?format=html once — that endpoint
//   is rate limited (~10/min), so do not paste this twice inside a minute.
//   G runs `expect` once against text that is already on screen. No typing, no
//   clicking, no navigation, no network writes.
//
// HOW TO RUN
//   1. `npm run build`, then reload the extension (chrome://extensions →
//      crazyAgent → reload). A stale dist/ measures the old code.
//   2. Open the crazyAgent side panel → right-click inside it → Inspect →
//      Console.
//   3. Paste this whole file and press Enter (~30s). Don't touch the tab.
//   4. The report is printed and copied to the clipboard; paste it back.
(async () => {
  const ba = window.__ba;
  if (!ba || typeof ba.toolText !== "function" || typeof ba.tool !== "function") {
    console.error("window.__ba missing — paste this into the crazyAgent SIDE PANEL's DevTools console");
    return;
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const clip = (s, n = 600) =>
    typeof s === "string" && s.length > n ? `${s.slice(0, n)}…[+${s.length - n}]` : s;
  const say = (s) => {
    console.log(s);
    out.push(s);
  };

  const out = [];
  const results = [];

  /** evaluate_js and parse whatever it returned back into a JS value. */
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
    return parsed ?? { raw: clip(raw, 400) };
  };

  /** The model-facing snapshot text — this is what the agent actually reads. */
  const snapshot = async () => String((await ba.toolText("snapshot", {})) ?? "");

  /** Pull the ordered (ref, name) pairs out of a snapshot's text. */
  const refLines = (snap) =>
    snap
      .split("\n")
      .map((l) => /^\s*(\d+)\s+(\S.*)$/.exec(l))
      .filter(Boolean)
      .map((m) => ({ ref: Number(m[1]), tail: m[2].trim() }));

  const record = (id, claim, verdict, evidence) => {
    results.push({ id, claim, verdict, evidence });
    say(`\n[${id}] ${claim}`);
    say(`     → ${verdict}`);
    for (const e of [].concat(evidence)) say(`       ${e}`);
  };

  say("harness audit probe v1");
  say(`page: ${location.href.slice(0, 90)}`);

  // ---------------------------------------------------------------- A
  // Claim: registry.ts:227 — collect() does `#registrations.clear()` and
  // renumbers `ref = String(n)` in DOM order on EVERY snapshot, so a ref held
  // across one snapshot is not a stable handle to an element.
  // Test: snapshot, insert one synthetic button as the first candidate,
  // snapshot again. If every existing ref shifts by one, refs are positions.
  {
    const TAG = "AUDITPROBE-ZZ";
    let verdict = "UNPROVEN";
    const ev = [];
    try {
      const before = refLines(await snapshot());
      await js(
        `(() => { const b = document.createElement('button'); b.id = '__audit_probe__'; b.setAttribute('role','button'); b.textContent = ${JSON.stringify(TAG)}; b.style.cssText = 'position:fixed;left:0;top:0;z-index:2147483647'; (document.body || document.documentElement).prepend(b); return JSON.stringify({ inserted: true }); })()`,
      );
      await sleep(150);
      const after = refLines(await snapshot());
      const removed = await js(
        `(() => { const b = document.getElementById('__audit_probe__'); if (b) b.remove(); return JSON.stringify({ removed: !document.getElementById('__audit_probe__') }); })()`,
      );

      const at = after.find((l) => l.tail.includes(TAG));
      ev.push(`before: ${before.length} refs, after: ${after.length} refs`);
      if (!at) {
        ev.push("the synthetic button produced no ref at all (hidden or not collected)");
        verdict = "UNPROVEN";
      } else {
        ev.push(`synthetic button landed at ref ${at.ref}`);
        // The marker must be the FIRST candidate, so every prior ref shifts by 1.
        const idxAfter = after.indexOf(at);
        const tailAfter = after.slice(idxAfter + 1).map((l) => l.tail);
        const tailBefore = before.map((l) => l.tail);
        const shifted =
          tailAfter.length === tailBefore.length &&
          tailAfter.every((v, i) => v === tailBefore[i]);
        const firstNow = after[0]?.tail?.includes(TAG);
        ev.push(`after the insert, ref 1 is ${firstNow ? "the marker" : clip(after[0]?.tail, 60)}`);
        ev.push(
          shifted
            ? `every pre-existing ref moved +1 (${tailBefore.length} elements renumbered)`
            : "the old and new name sequences did not align by a constant shift",
        );
        verdict = shifted ? "CONFIRMED" : "FALSIFIED";
        if (shifted) {
          ev.push(
            `a model still holding 'ref 5' now addresses whatever slid into position 5 — the handle is a position, not an identity`,
          );
        }
      }
      ev.push(`marker cleanup: ${JSON.stringify(removed)}`);
    } catch (err) {
      ev.push(`threw: ${clip(String(err?.message ?? err), 200)}`);
    }
    record("A", "refs renumber on every snapshot (registry.ts:227) — no epoch", verdict, ev);
  }

  await sleep(100);

  // ---------------------------------------------------------------- B
  // Claim: registry.ts:136 isVisible checks `el.hidden` plus the element's OWN
  // computed display/visibility. A node inside a display:none ancestor still
  // computes display:block, so it passes and gets a ref with box:null — and
  // formatSnapshot prints no box, so it is indistinguishable from a live control.
  {
    const r = await js(`(() => {
      const all = [...document.querySelectorAll('*')];
      let hiddenByAncestor = 0; const samples = [];
      for (const el of all) {
        if ((el).hidden) continue;
        const s = getComputedStyle(el);
        if (s.display === 'none' || s.visibility === 'hidden') continue;
        let p = el.parentElement, blocked = false;
        while (p) { const ps = getComputedStyle(p); if (ps.display === 'none' || ps.visibility === 'hidden') { blocked = true; break; } p = p.parentElement; }
        if (!blocked) continue;
        hiddenByAncestor++;
        if (samples.length < 4) samples.push(el.tagName + (el.id ? '#' + el.id : '') + ' "' + (el.textContent || '').trim().slice(0, 24) + '"');
      }
      return JSON.stringify({ total: all.length, hiddenByAncestor, samples });
    })()`);
    const n = r.hiddenByAncestor ?? 0;
    record(
      "B",
      "isVisible has no ancestor walk (registry.ts:136) — hidden nodes get refs",
      n > 0 ? "CONFIRMED" : "FALSIFIED",
      [
        `${n} element(s) pass the per-element visibility test while sitting inside a display:none/visibility:hidden ancestor`,
        ...(r.samples?.length ? [`e.g. ${r.samples.join(" | ")}`] : []),
        n > 0
          ? "each of these would be issued a ref with box:null, and formatSnapshot prints no box"
          : "this page has none — try a page with a closed dropdown or a collapsed wizard step",
      ],
    );
  }

  await sleep(100);

  // ---------------------------------------------------------------- C
  // Claim: registry.ts:37 — INTERACTIVE is a static-markup allowlist
  // (a[href], button, input, [onclick], [role=…]). A <div> wired with
  // addEventListener has none of those, so it gets no ref, is invisible to the
  // snapshot, and nearestInteractive calls it non-interactive for the magnet
  // and the policy probe too.
  // Proxy: an element the user can obviously click (cursor:pointer, or a
  // click-ish role) that the allowlist does not match.
  {
    const r = await js(`(() => {
      const INTERACTIVE = ['a[href]','button','input','select','textarea','summary','[contenteditable="true"]','[contenteditable=""]','[contenteditable="plaintext-only"]','[contenteditable]:not([contenteditable="false"])','[role="button"]','[role="link"]','[role="textbox"]','[role="checkbox"]','[role="radio"]','[role="combobox"]','[role="menuitem"]','[role="tab"]','[role="switch"]','[onclick]'].join(', ');
      const all = [...document.querySelectorAll('body *')].slice(0, 12000);
      const missed = []; let pointer = 0, missedCount = 0;
      for (const el of all) {
        const s = getComputedStyle(el);
        if (s.cursor !== 'pointer') continue;
        pointer++;
        // A wrapper whose child is the real target is not a gap.
        if (el.matches(INTERACTIVE) || el.querySelector(INTERACTIVE)) continue;
        missedCount++;
        if (missed.length < 6) missed.push(el.tagName + (el.className ? '.' + String(el.className).split(' ')[0] : '') + ' "' + (el.textContent || '').trim().slice(0, 26) + '"');
      }
      return JSON.stringify({ scanned: all.length, cursorPointer: pointer, missedCount, missed });
    })()`);
    const n = r.missedCount ?? 0;
    record(
      "C",
      "INTERACTIVE misses listener-driven click targets (registry.ts:37)",
      n > 0 ? "CONFIRMED" : "FALSIFIED",
      [
        `${r.cursorPointer ?? "?"} elements render as clickable (cursor:pointer); ${n} of them match NONE of the 20 INTERACTIVE selectors`,
        ...(r.missed?.length ? [`e.g. ${r.missed.join(" | ")}`] : []),
        n > 0
          ? "these get no ref, are absent from the snapshot, and the magnet + policy probe call them non-interactive"
          : "nothing missed on this page — try a React SPA (Gmail, Instagram DMs)",
      ],
    );
  }

  await sleep(100);

  // ---------------------------------------------------------------- D
  // Claim: perception.ts:235 formatSnapshot builds
  // bits = [ref, tag[type], name, disabled?, editable?, value?] — ElementInfo.checked
  // is collected but never rendered, so checked and unchecked are identical text.
  {
    const dom = await js(`(() => {
      const els = [...document.querySelectorAll('input[type=checkbox], input[type=radio], [role=checkbox], [role=radio], [role=switch]')];
      const checked = els.filter(e => e.checked === true || e.getAttribute('aria-checked') === 'true');
      return JSON.stringify({ total: els.length, checked: checked.length });
    })()`);
    const snap = await snapshot();
    const saysChecked = /\bchecked\b/i.test(snap);
    const verdict =
      dom.total === 0 ? "UNPROVEN" : saysChecked ? "FALSIFIED" : "CONFIRMED";
    record(
      "D",
      "checked state never reaches the snapshot text (perception.ts:235)",
      verdict,
      [
        `page has ${dom.total} checkbox/radio/switch control(s), ${dom.checked} currently on`,
        `the snapshot text ${saysChecked ? "DOES" : "does NOT"} contain the word 'checked'`,
        dom.total === 0
          ? "no controls on this page to compare — open Settings or a form"
          : saysChecked
            ? "the renderer does carry state after all"
            : `${dom.checked} on / ${dom.total - dom.checked} off are indistinguishable to the model`,
      ],
    );
  }

  await sleep(100);

  // ---------------------------------------------------------------- E
  // Claim: shared/coords.ts:458 looksLikeShotPixels does `if (!outside) return
  // false` — a screenshot-space point that happens to land INSIDE the viewport
  // is never reinterpreted, and is dispatched as CSS px instead.
  {
    const vp = await js(`(() => JSON.stringify({ w: window.innerWidth, h: window.innerHeight, dpr: window.devicePixelRatio || 1 }))()`);
    const IMAGE_CAP = 1280;
    const vw = vp.w || 0;
    const vh = vp.h || 0;
    // The capture is downscaled to at most IMAGE_CAP wide (perception.ts).
    const shotW = Math.min(IMAGE_CAP, Math.round(vw * (vp.dpr || 1)));
    const scale = vw ? shotW / vw : 1;
    const ambiguous = Math.abs(scale - 1) > 0.02;
    record(
      "E",
      "in-viewport screenshot pixels are undetectable (shared/coords.ts:458)",
      ambiguous ? "CONFIRMED" : "UNPROVEN",
      [
        `viewport ${vw}x${vh} CSS px at dpr ${vp.dpr}; capture is capped at ${IMAGE_CAP}px wide`,
        `implied scale image→viewport ≈ ${scale.toFixed(3)}`,
        ambiguous
          ? `an image point in [0..${vw}]x[0..${vh}] is a VALID viewport point too, so looksLikeShotPixels returns false and it is dispatched raw — off by ${((1 / scale - 1) * 100).toFixed(0)}%`
          : "scale is 1.0 here, so the two spaces coincide on this viewport and the bug cannot fire — widen/zoom the window and rerun",
        "the ambiguity is structural: no heuristic can separate two spaces that overlap; the tool needs an explicit space tag",
      ],
    );
  }

  await sleep(100);

  // ---------------------------------------------------------------- F
  // Claim: shared/docs-ops.ts:291 verifies Title/Subtitle with the literal
  // 'class="title"', but Docs exports class="c3 c18 title" — so the check can
  // never pass and apply_style reports NOT VERIFIED no matter what happened.
  {
    let verdict = "UNPROVEN";
    const ev = [];
    try {
      const r = await js(`(() => {
        const id = (location.pathname.match(/\\/d\\/([^/]+)/) || [])[1];
        if (!id) return JSON.stringify({ ok: false, why: 'not a /d/<id> document url' });
        return fetch('/export?format=html', { credentials: 'include' })
          .then(res => res.text())
          .then(html => {
            const literal = html.includes('class="title"');
            const anyTitleClass = /class="[^"]*\\btitle\\b/.test(html);
            const anySubtitleClass = /class="[^"]*\\bsubtitle\\b/.test(html);
            const titleTags = (html.match(/<h1[^>]*>/g) || []).length;
            return JSON.stringify({ ok: true, len: html.length, literal, anyTitleClass, anySubtitleClass, titleTags });
          });
      })()`);
      if (r && r.ok === false) {
        ev.push(r.why);
      } else {
        ev.push(`export is ${r.len} chars; a <h1> appears ${r.titleTags} time(s)`);
        ev.push(`literal 'class="title"' present: ${r.literal}`);
        ev.push(`class="…title…" present: ${r.anyTitleClass}; subtitle: ${r.anySubtitleClass}`);
        if (r.anyTitleClass && !r.literal) {
          verdict = "CONFIRMED";
          ev.push(
            "the export marks the style with a compound class, so the literal needle in docs-ops.ts:291 can never match — apply_style reports NOT VERIFIED even when it worked",
          );
          ev.push("fix: match class=\"[^\"]*\\btitle\\b instead of the literal");
        } else if (r.literal) {
          verdict = "FALSIFIED";
          ev.push("this export really does carry class=\"title\" — the needle is fine here");
        } else {
          verdict = "UNPROVEN";
          ev.push("no Title-styled paragraph is in this document — style one, then rerun just this section");
        }
      }
    } catch (err) {
      ev.push(`threw: ${clip(String(err?.message ?? err), 200)}`);
    }
    record("F", "apply_style verifies class=\"title\" literally (shared/docs-ops.ts:291)", verdict, ev);
  }

  await sleep(100);

  // ---------------------------------------------------------------- G
  // Claim: tools/expect.ts:73 — text_landed matches against ctx.observationText,
  // i.e. the whole PAGE digest, not the document body. A rename that lands in
  // the wrong box still "verifies".
  // Test: search for a string that is definitely on screen as UI chrome and
  // definitely NOT in the document body. If expect passes, the haystack is
  // page-wide.
  {
    let verdict = "UNPROVEN";
    const ev = [];
    try {
      // Find a word in the toolbar/menus that cannot be document text.
      const probe = await js(`(() => {
        const cands = ['File','Edit','View','Insert','Format','Tools','Extensions','Help'];
        const body = (document.body.innerText || '');
        const chrome = cands.find(w => {
          const inUi = [...document.querySelectorAll('[role=menuitem],[role=menu],[role=menubar],button')]
            .some(e => (e.textContent || '').trim() === w);
          return inUi && !new RegExp('\\\\b' + w + '\\\\b').test(body);
        });
        return JSON.stringify({ word: chrome || null });
      })()`);
      if (!probe.word) {
        ev.push("could not isolate a UI-only word on this page (all menu words also appear in the body text)");
      } else {
        const res = await ba.tool("expect", { text_landed: probe.word });
        const txt = JSON.stringify(res?.payload ?? res);
        const passed = /contains/i.test(txt) && !/does NOT contain/i.test(txt);
        ev.push(`probe word: "${probe.word}" — present as UI chrome, absent from the document body`);
        ev.push(`expect{text_landed:"${probe.word}"} → ${clip(txt, 220)}`);
        verdict = passed ? "CONFIRMED" : "FALSIFIED";
        ev.push(
          passed
            ? "expect verified UI chrome as if it were document text — the haystack is page-wide"
            : "expect did not accept UI chrome — the haystack is narrower than claimed",
        );
      }
    } catch (err) {
      ev.push(`threw: ${clip(String(err?.message ?? err), 200)}`);
    }
    record("G", "text_landed matches PAGE text, not document text (tools/expect.ts:73)", verdict, ev);
  }

  // ---------------------------------------------------------------- report
  const counts = { CONFIRMED: 0, FALSIFIED: 0, UNPROVEN: 0 };
  for (const r of results) counts[r.verdict] = (counts[r.verdict] ?? 0) + 1;
  say("\n================ SUMMARY ================");
  for (const r of results) say(` ${r.verdict.padEnd(9)} ${r.id}  ${r.claim}`);
  say(
    `\n${counts.CONFIRMED} confirmed · ${counts.FALSIFIED} falsified · ${counts.UNPROVEN} unproven`,
  );
  say("UNPROVEN = the instrument could not decide it here, not that the claim is wrong.");
  say("Not testable from a console at all: the policy gate's first-step-only probe (coords.ts:464),");
  say("the rescue-repair bypass (sw.ts:1447), and ref re-identity across re-renders (needs the registry).");

  const text = out.join("\n");
  try {
    await navigator.clipboard.writeText(text);
    console.log("\n(report copied to clipboard)");
  } catch {
    console.log("\n(clipboard blocked — select the report above and copy it)");
  }
})();
