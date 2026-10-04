# Input layer plan — making click / drag / scroll REALLY good

> **Status:** P0 accuracy + reliability items 1, 2, 6 and speed item 12 are
> **implemented**, plus the vision-first additions from the Oct 4 run
> post-mortem: **`type_at`** (click caret → select → type in one trusted
> sequence — the primary doc-editing move), **zoom/region screenshots**
> (`screenshot zoom:2..4` or x/y/w/h crops at native resolution;
> space:'screenshot' resolves against crops too), **atomic
> `select:'all'`** in `type`/`type_at` (select-all + insert can no longer be
> split by a focus shift — the duplication bug), and **`input_sequence`**
> (item 13: up to 24 chained click/hover/key/type/wait steps in ONE call —
> menu paths and table fills; coordinates resolve at execution time).
> Wheel/scroll_until (4, 5), drag upgrades (8, 9), observe/expect (10, 11)
> and the gauntlet (14) remain.

Companion to `docs/gdocs-cursor-plan.md` (which covers Google Docs editing and
the skill/tool delivery fixes). This one is about the pointer itself: every
stroke the agent sends should land where intended, work on any surface, and
cost as few round trips as possible. Grounded in the current code; each item
names its site.

## Landed (clicking: accurate + fast)

- **`space:"screenshot"`** on `click_at`/`hover_at`/`drag_at`/`element_at`:
  the model points at pixels of the screenshot it is looking at, the tool
  converts to viewport CSS px (`shared/coords.ts`
  `screenshotToViewportPoint`; conversion at resolve time in
  `tools/coords.ts` `fromScreenshotSpace`, using CDP
  `Page.getLayoutMetrics` with the capture-time dims as fallback). Every
  viewport capture (screenshot AND blind shots) records its image dims +
  viewport CSS dims (`tools/perception.ts` `recordViewportShot`), and the
  screenshot result now says the image size and the space:'screenshot'
  pointing recipe. The policy probe (`probeElementAt`) converts with the
  stored dims so gated clicks keep working in image space.
- **Best-effort probe**: a dead content script no longer refuses the click —
  bounds check falls back to CDP layout metrics, the stroke still lands, and
  the result says `hit: "unknown (no content script at that point …)"` with
  the after-probe skipped (one round trip saved). `element_at` reports
  "unknown" instead of INJECTION-FAILED.
- **Ref-mode scroll-into-view**: `click_at`/`hover_at`/`drag_at` with a ref
  scroll it into view (`behavior:"instant"`) before measuring
  (`content/actions.ts` `#resolvePoint scroll` flag) — off-screen refs no
  longer bounds-error. Looking resolves (`element_at`, policy probe) don't
  scroll.
- **Activation caching**: `ensureTabActive` skips the 120ms settle unless
  ownership actually changed (same tab within 2s = free), and only focuses
  the window when it isn't — sequences of trusted strokes no longer pay
  120ms each (`tools/trusted-input.ts`).

## Where the layer stands today

- Strokes go through CDP `Input.dispatchMouseEvent` (trusted, isTrusted:true)
  — the right primitive. `planDrag` already interpolates 12 points
  (`shared/coords.ts:213`). Ref/frame-local/raw-coord modes all resolve to
  viewport CSS px (`content/actions.ts:249` walks the frameElement chain).
- `scroll` is DOM-only: `window.scrollBy` / `scrollIntoView` via the content
  script (`content/actions.ts:102`). It cannot scroll Google Docs, Maps,
  Figma or any app with its own inner scroller, and it dies with the content
  script.
- The screenshot the model points at is **downscaled to ≤1280px wide**
  (`downscaleJpeg`, `tools/perception.ts:288`) from a device-pixel capture,
  and the result never says the image size, viewport CSS size, or DPR. A
  vision model pointing at "x≈640 on the image" mis-clicks by the unknown
  scale factor. This is the quiet systematic error in every coordinate click.
- Each coordinate call pays: probe round trip + `ensureTabActive` (~120ms
  settle, `tools/trusted-input.ts:32`) + strokes + after-probe + the loop's
  auto-settled full snapshot. Fine for one click; brutal for cursor-heavy
  sequences.

## P0 — accuracy: the click lands where the model meant

### 1. Screenshot-space coordinates (the big one)

The model's natural reference frame is the screenshot it is looking at, not
the viewport. Make that a first-class input:

- `screenshot` result reports `{ image: WxH, viewport_css: WxH, dpr }` next
  to the staged id.
- `click_at` / `hover_at` / `drag_at` / `element_at` accept
  `space: "screenshot"` (x/y in image pixels) and convert in-tool:
  `css = image_px × (viewport_css / image)`. The model points at exactly what
  it sees; the tool owns the math. Same conversion Claude in Chrome does
  internally.
- Also mention the scale in the downscale path's result text so even
  viewport-space guesses improve.

### 2. Ref-mode `click_at` scrolls into view first

`#resolvePoint` reads `getBoundingClientRect()` where the element sits — an
off-screen ref resolves to an out-of-viewport point and the call fails with a
bounds error. Fix: in ref mode, `scrollIntoView({block:"center"})` → short
settle → recompute the rect → stroke. A ref should always be clickable.

### 3. Post-move verification (cheap, report-only)

After the final `mouseMoved`, one `elementFromPoint` re-probe confirms what
is actually under the cursor before pressing. On mismatch (target moved —
SPA re-render), re-resolve once and adjust. Report both; don't loop.

## P0 — scrolling: the weakest link

### 4. Real wheel input (`scroll_at`)

`Input.dispatchMouseEvent` with `type: "mouseWheel"`, `deltaX/deltaY`, at a
point. This is what canvas apps and inner scrollers actually listen to —
`window.scrollBy` is a no-op in Google Docs' editor and friends, and needs
no content script at all (fits the best-effort-probe philosophy):

- Args: `x/y` (default: viewport center — the wheel hits whatever scroller
  is under the point, which is exactly right), `delta_y` (default ~600),
  `delta_x`, optional `steps` to split into smooth increments for
  momentum/inertia-sensitive UIs.
- Result reports scroll position before/after (`scrollY` + max, from the
  probe when available; "unprobeable" otherwise) so the model knows whether
  it moved and how much is left.

### 5. `scroll_until` — the composite that kills the round-trip chain

The scroll→snapshot→scroll→snapshot loop is 4–10 turns on long pages. One
tool instead:

```json
{ "to_text": "References", "direction": "down", "max_steps": 20 }
{ "to_ref": "3#14" }
{ "to_edge": "bottom" }
```

Internal loop: wheel ~600px → settle ~250ms → probe (text search /
registry lookup / scroll-position-at-edge) → repeat until found or steps
exhausted. Returns what it found and where. All probing is best-effort with
wheel as the actuator, so it works on Docs and dead-content-script pages.

## P1 — reliability when layers are down

(Carried over from `gdocs-cursor-plan.md`, repeated because they are pointer
prerequisites.)

### 6. Best-effort probe in the coordinate tools

Probe failure ≠ click failure. Content script missing but CDP up ⇒ stroke
anyway, report `hit: "unknown (no content script at this point)"`. Policy
already handles null probes (`probeElementAt` returns null today).

### 7. Inject-on-demand in `runContentAction`

`"actions-not-loaded"` ⇒ programmatically inject the content bundle into
that frame and retry once. `content/main.ts` is idempotent by design.

## P1 — drag quality

### 8. A drag that real apps accept

Current plan: move → down → 12 interpolated moves → up, 12ms apart. What
real drag sources additionally need:

- **Hold after mousedown** (~150–300ms) before the first move — sortable
  lists, Docs image resize handles and most canvas apps arm the drag on a
  threshold; an instant move reads as a sloppy click.
- **A beat before release** at the destination — drop targets highlight on
  the last hover; instant release can miss the drop.
- **Configurable**: `duration_ms`, `steps`, `hold_ms`, `button`,
  `modifiers` (Shift = axis-lock in design tools, Ctrl = copy-drag in some).
  Pure change in `shared/coords.ts` `planDrag` + stroke timing in
  `tools/coords.ts`.

### 9. Drag truthfulness + HTML5 DnD fallback

CDP mouse strokes drive *mouse-based* DnD (canvas apps, most JS libraries)
but not reliable HTML5 `draggable="true"` DnD. So:

1. Before the stroke, install a one-shot `dragstart` listener via
   `evaluate_js`; after the stroke, report `dragstartFired: true/false`.
2. If false and the source probe showed `draggable="true"`, fall back to the
   synthetic sequence (`DragEvent` + `DataTransfer` for
   dragstart/dragenter/dragover/drop/dragend) via `evaluate_js`, and say
   which route ran. The result always answers "did the drag take?" instead
   of leaving the model to guess.

## P1 — per-call overhead (speed and tokens)

### 10. `observe` param on input tools

`observe: "none" | "hit" | "snapshot"` (default: current behavior). The loop
already defers the auto-settled snapshot to the last call of a batch
(`agent/loop.ts:41`); this extends the same idea across turns for
cursor-heavy sequences — the model takes one snapshot when *it* wants it,
not after every stroke.

### 11. `expect` postcondition on every input tool

```json
{ "x": 640, "y": 380, "expect": { "text": "Comment saved", "timeout_ms": 3000 } }
```

After the strokes, run the existing `wait_for` machinery and report
pass/fail. Merges the verify step into the action — one round trip saved per
click/drag, and the failure signal arrives with the state that caused it.

### 12. Activation caching

`ensureTabActive` pays ~120ms (`ACTIVATE_SETTLE_MS`) on every trusted call,
including sequences on an already-front tab. Cache "tab X of window Y is
front" per run; only re-activate (and re-settle) when the target tab
actually changed.

### 13. `input_sequence` (from the gdocs plan)

Ordered `[{click_at}, {type}, {key}, {scroll_at}, {wait_ms}]` in one call,
one observation — the natural consumer of everything above.

## P2 — measurement (what "REALLY good" means)

There is no scroll/drag fixture today (`e2e/fixture/` has canvas-click but
nothing for wheel, drag, or scroll-until). Without a hit-rate number, every
"tuning" change is vibes.

### 14. Cursor gauntlet fixture + smoke

`e2e/fixture/cursor-gauntlet.html`:

- **Target grid**: 8×8 canvas-painted targets, each recording where the
  click landed (canvas-relative, isTrusted) ⇒ **hit-rate metric**: intended
  vs actual, assert ±2px at 1.0 and 2.0 DPR, and through `space:"screenshot"`.
- **Inner scroller**: a div with `overflow:auto` and 200 items, impervious
  to `window.scrollBy` ⇒ wheel and `scroll_until` tests (find item 150;
  report steps taken).
- **Mouse-based sortable** (mousedown DnD, like typical JS libs) ⇒ drag
  reorders, assert order after.
- **`draggable="true"` HTML5 zone** ⇒ asserts the fallback path reports
  truthfully and the drop lands.
- **Range slider + hover-tooltip target** ⇒ drag precision + hover.

`scripts/cursor-smoke.mjs` runs it headless against the loaded extension and
prints the hit-rate table — the before/after number for every change above.

## Suggested order

1. **Wheel + `scroll_until`** (4, 5) — biggest capability gap; Docs/Maps
   scrolling simply does not exist today.
2. **Screenshot-space coords** (1) — biggest accuracy win; small, contained
   change (one conversion + plumbing through `resolveTarget`).
3. **Best-effort probe + inject-on-demand** (6, 7) — unblocks the cursor on
   the exact pages that need it.
4. **Drag hold/beat + DnD truth** (8, 9).
5. **Ref scroll-into-view, post-move verify** (2, 3).
6. **Overhead: observe/expect/activation cache** (10–12), with
   `input_sequence` (13) as the consumer.
7. **Gauntlet fixture + smoke** (14) built alongside, not after — each
   change lands with its number.

## Deliberate non-goals

- **No human-mimicry mouse paths** (bezier curves, jitter): the agent drives
  the user's own browser on their own sites — no anti-bot benefit, pure
  latency cost.
- **No per-key typing** anywhere in the sequence machinery:
  `Input.insertText` already types whole strings in one shot.
- **Keep DOM scroll for refs**: `scrollIntoView` on a ref stays the precise
  route when a ref exists; wheel is for surfaces and exploration.
