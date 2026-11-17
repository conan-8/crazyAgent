# V3 design notes — page identity for repeated work (§3.4, read-only design)

**Status:** DESIGN ONLY (lead: implement after V2 merge, branch `v2/v3-pagekey` from merged main, score vs V2 baseline). One main change: page-scoped repeated-work identity. Removes REPEAT_LOOP/REVISIT_HINT false suspects on multi-page work (the same click on different pages is not a revisit). Watcher stays report-only; REVISIT_HINT stays soft (never alerts alone).

## Provider result formats (verified in `packages/dsh-browser-extension/lib/index.js`)
- **Tab line** (view header in read_text/screenshot/tab results, L837/1891/1897): `tab <id> "<title>" <url>`. The URL is the token after the quoted title.
- **Navigate** (`navigateContent`, L1469): `navigated to <url>` / `navigated back to <url>` / `navigated forward to <url>` / `reloaded <url>` (target = `navigated.toUrl ?? requestedUrl`).
- **Clicked head** (L1289): `clicked label <N>: <role|tag|'element'> "<name>"` (name JSON-quoted).
- **Typed head** (L1374): `typed into [<N>] <description>`.
- **Tab switch** (`browser_tabs` op `tabs.activate`, L2929): returns a view whose header carries the new active tab's `tab <id> "<title>" <url>` line.

## 1. Page key (best-effort, ledger state)
- New ledger field `currentPageKey: string | null` (null = unknown). Updated on **every tool result** whose text names a URL, taking the **most recent** one:
  - `parsePageKey(text)`: try the tab line `/tab\s+\S+\s+"[^"]*"\s+(https?:\/\/\S+)/u` first; else navigate `/(?:navigated\s+(?:back\s+|forward\s+)?to|reloaded)\s+(https?:\/\/\S+)/u`. Return the URL or null.
  - If a result names a URL → `currentPageKey = url`. If it names none → **keep** the previous key (a click result doesn't change the page). Unknown stays unknown until a URL is seen.
- The page key is the **full URL** for grouping; the **digest** shows only the URL **path** (≤60 chars, `new URL(url).pathname`, fail-safe to the raw string clipped). Query/hash stripped for the digest (path identity); grouping uses the full URL (so query-distinct pages don't merge).
- Each **act** event records `pageKey` (the `currentPageKey` at result time) and `controlName` (parsed below). Observe/control events need no page key.

## 2. Control name (parsed from result heads)
- `parseControlName(name, head)`:
  - click family: `/clicked label\s+\d+:\s+\S+\s+"([^"]*)"/u` → the quoted name (group 1). If no quoted name, fall back to the role token.
  - type family: `/typed into\s+\[(\d+)\]/u` → the field label `N` (control identity = the label acted on).
  - other act tools: control name = null (grouped by tool+args only).
- The name is **untrusted text** → clipped (≤80 chars), control chars stripped, never rendered as markup (plain text in digest).

## 3. Page-scoped repeated-work grouping
- New aggregate map `pageActStats: Map<key, {count, ok, headsVary, firstHead, pageKey, tool, argsDigest, controlName}>` where `key = pageKey | toolFingerprint(name,args) | controlName`.
- Fed only by **effectful act** results (ok, not no-effect, not control) with a **known** pageKey. **Unknown pageKey → excluded** (fails toward silence, not false alerts). No-effect acts excluded (they feed NO_EFFECT, not revisits).
- Bounded like fingerprintStats (≤1000 keys; clip args/name).
- A **revisit** = a key with `count ≥ 2`, `ok ≥ 1`, `!headsVary` (same outcome). This is the page-scoped redo signature: the same effectful action on the same page against the same control with the same result.

## 4. REVISIT_HINT refinement (assess)
- Current: `mutationRevisit` from whole-turn `fingerprintStats` (`!readOnly && count≥3 && ok≥1 && !headsVary`) OR openFlat. 
- V3: the mutation-revisit branch becomes **page-scoped** — `pageRevisit = any pageActStats key with count≥2 && ok≥1 && !headsVary` (threshold drops 3→2 per §3.4 "two or more"; page+control scoping prevents multi-page false positives). openFlat branch unchanged (V4 owns continuation context).
- REVISIT_HINT still **suspect, never alerts alone**; brings judge forward; corroborates two-strike. Hard signals unchanged.
- **Navigation revisits stay digest-only** (`aggregates.navRevisits`), NOT corroboration (unchanged from v1).

## 5. Digest
- `aggregates.mutationRevisits` entries gain `pageKey` (URL **path** ≤60 chars) + `controlName` (clipped). `mutationRevisit` boolean now page-scoped. Keep `navRevisits` as-is. Digest stays ~200 tokens (bounded entries).

## 6. Invariants / edges
- Unknown page → no revisit counting (silence). Page key changes mid-turn → new group (a click repeated after navigating away is not a revisit). Same control name on different pages → different groups. No-effect clicks → NO_EFFECT, not revisits. Control/observe → excluded. Untrusted name/path → clipped plain text. Ledger pure; no I/O.

## 7. Test plan (npm test, cheapest first)
- `parsePageKey`: tab line URL extraction; navigate/back/forward/reload; no-URL result keeps previous key; unknown stays null; malformed → null.
- `parseControlName`: clicked label quoted name; missing name fallback; typed label; other tool null; untrusted clip.
- Page-scoped grouping: same click same page same outcome ×2 → revisit; same click **different page** → NOT a revisit (the multi-page false-positive fix); same page different control → not; no-effect excluded; unknown page excluded; observe/control excluded.
- REVISIT_HINT: page revisit ≥2 fires suspect (never hard); unknown page → no REVISIT_HINT from revisits; openFlat branch still works; nav revisits digest-only.
- Digest: mutationRevisits carry pageKey path ≤60 + controlName; bounded.
- Replay gate (after implement): V3 vs V2 baseline on tune k=3 (suspect ticks on multi-page healthy work should DROP; caught mean ≥V2; gated-fine FA worst 0); holdout once at milestone end.

## Open questions for lead (at implement go)
- Grouping URL: full URL (query-distinct) vs path-only? Design uses full URL for grouping, path for digest. Confirm.
- REVISIT_HINT threshold 2 (page-scoped) vs keeping 3: §3.4 says "two or more"; design uses 2. Confirm.
- Whether to also page-scope REPEAT_LOOP (the last-8 fingerprint loop) or leave it whole-window (V3 scope is REVISIT_HINT per §3.4; REPEAT_LOOP page-scoping may be V3+). Design leaves REPEAT_LOOP unchanged unless lead wants it.
