# V7 report — test notification: one-tap push proof

**Date:** 2026-11-17 · **Task:** shared task-21 · **Plan:** `MARATHON-V2-PLAN.md` §3.8 + §5 V7 + §6 (G9)
**Branch:** `v2/v7-pushtest` (worktree `/tmp/crazyagent-v2-v7-pushtest`), base main `51cb5c3` (V6 merged).
**Scope:** `POST /push/test` on the remote API, the `test` push type, the phone's Settings button showing the route's answer, and the proofs. **This does not make delivery happen** — it gives one-tap proof once `conan-evo-x3` has the service-account key and a companion restart (user action; still-unrun below).
**Status:** all gates green. No on-device work, no re-pairing, no delivery claims.

## What changed (three increments)

### `e1d6f15` — increment 1: the route + push type
- **`remote-push.mjs`:** `PUSH_TYPES` gains **`test`** — normal priority (high stays help/confirm/watch). Payload unchanged: **exactly** `{type, turnId, instanceId, sequence}`, all strings. Each test send uses a **fresh `test-<uuid>` turnId**, so the per-push dedupe (`turnId:type:ordinal`) never swallows a repeat; command idempotency lives at the route.
- **`remote-server.mjs`:** `POST /push/test {clientCommandId}` — authenticated like every route; `requireClientId` (8–128 `[A-Za-z0-9_-]`); **idempotent per command id** via `hub.rememberCommand('push-test', …)` — a replay returns the cached answer with `replayed:true` **without resending or consuming the rate limit** (cached check before the limiter, the established order); **`WindowLimiter` 1/minute** (`limits.pushTestsPerMinute`, 429 `RATE_LIMITED`, `retry-after: 60`).
- **Explicit answers, never errors for setup state:** no PushService / no FCM key → `200 {sent:0, failed:0, pruned:0, skipped:'not-configured'}`; zero registered devices → `skipped:'no-devices'`; otherwise the `notify` summary (`sent/failed/pruned`). Audit `push.test` carries counts only — no tokens.
- **Tests (+6):** 401/422/405; both explicit answers; exact payload shape + normal priority + fresh `test-` turnId + token-free audit; idempotent replay + 1/minute refusal + window expiry with a fresh turnId (the test harness gained an additive `now` option); failed/pruned counts under the **current** provider contract (`kind:'invalid-token'` — the old `permanent/status` shape is gone; the test caught the drift).

### `f2fec32` — increment 2: the phone
- **`PushMessage.Type.TEST`:** title **"crazyAgent test notification"**, text **"Push notifications reach this phone."** — generic wording only; the exact-shape parse still drops extra keys. **Notifier needs no change:** TEST is not in the urgent set, so it rides the existing `agent_turns` **normal-priority** channel.
- **`RemoteApi.sendTestPush(clientCommandId)`** → `POST push/test`.
- **`RemoteController.sendTestNotification()`:** LIVE+synced guard, `testPushInFlight`, idempotent command ID kept on an uncertain answer (same pattern as the marathon toggle). The route's answer becomes a plain-language notice: sent counts (+failed/pruned when >0) with "Delivery is not guaranteed until it appears on the phone.", or the explicit no-key / no-phones sentences; a 429 shows the refusal; an uncertain answer keeps the ID for the next tap.
- **Settings:** **"Send test notification"** button next to the push status — enabled in **every** push state while connected (the explicit answer is the point), with a loading state.
- **`FakeCompanion`:** `/push/test` route mirroring the real answers (idempotent, 1/minute window + reset control, refuse/lose controls).
- **Tests:** `PushMessageTest` (TEST parse/wording/per-turn notification id); `RemoteControllerTest` (+3): the route's answer for sent / no-devices / not-configured, the 429 refusal, uncertain same-ID retry.

### Increment 3 (this commit) — fake run + docs
- **Fake-companion route run** (portable `v7-evidence/drive.mjs`, isolated port 0 + own token): **ALL 7 CHECKS PASS** — 401 unauth, 422 bad id, explicit `not-configured` 200 with the exact `{sent,failed,pruned,skipped}` shape, cached `replayed:true` replay, 429 for a second distinct id within the minute, 405 wrong method.
- **`android/README.md`:** the V7 paragraph (button, route contract, normal channel, delivery still unproven).

## Gate results

| Gate | Result | Evidence |
|---|---|---|
| Baseline `npm test` at base (51cb5c3) | **1264/1264** | worktree run |
| `npm test` final (route + push-type tests) | **1270/1270 pass, 0 fail** | [`v7-evidence/npm-test.txt`](v7-evidence/npm-test.txt) |
| `./gradlew testDebugUnitTest lintDebug` | **BUILD SUCCESSFUL — 150 tests, 0 failures, 3 opt-in skips; lint clean** (147 prior + 3 controller tests; PushMessageTest extended in place) | [`v7-evidence/android-testDebugUnitTest-lintDebug.txt`](v7-evidence/android-testDebugUnitTest-lintDebug.txt) |
| Fake-companion route run (independent HTTP surface) | **ALL 7 CHECKS PASS** | [`v7-evidence/fake-companion-push-test.json`](v7-evidence/fake-companion-push-test.json) |

The **sent-path payload shape** (exact 4 string keys, `test` type, `test-<uuid>` turnId, normal priority) is proven by the npm route test with a fake FCM provider — the fake companion has no key, so its live answer is the explicit `not-configured` one, which is itself a gate.

## Old-APK compatibility

An M5/V6 APK drops the unknown `test` push type by design (exact-shape parse). No envelope or projection changes — push-only milestone; nothing else on the wire moved.

## Still unrun (user; V10 → docs/STATUS.md)

- **Actual delivery to the phone.** `conan-evo-x3` (the designated sender the phone stays paired with) needs the same service-account key and a companion restart before the app can register; then the Settings button gives one-tap proof. A provider success means FCM accepted the message, not that Android displayed it.
- The on-phone appearance of the test notification and the Settings button.

## Next

- V8-android reason display awaits lead's ping (after V4, part of core's task-22).