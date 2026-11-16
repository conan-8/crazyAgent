# Tailscale least-privilege review — 2026-11-16 (C5)

Read-only review on `conan-expertbook`; no configuration changed, nothing restarted, no tokens/keys/auth URLs printed or used. Completes the "Review the Tailscale ACL for least privilege" item pending in `HANDOFF-QUICK.md` / `plan-temporary.md` C5, as far as it can be done without admin-console credentials.

## Verdict

Everything locally verifiable **matches the intended design** (docs/REMOTE-ACCESS.md §13.3): tailnet-only Serve of 17873, Funnel off, bridge loopback-only, 401 without a token, `/bridge` 404 through Serve. The remaining least-privilege gap is the **tailnet ACL itself**, which lives in the admin console and could not be read here; local hints suggest it is still default allow-all.

## What is actually exposed (evidence)

- Tailscale 1.104.6; tailscaled active+enabled; node online, no health warnings.
- `tailscale serve status`: exactly one route — `https://conan-expertbook.tail11f47e.ts.net` **(tailnet only)**, `/` → `http://127.0.0.1:17873`. No TCP/UDP forwards. `tailscale funnel status`: same tailnet-only config → **Funnel OFF** (the node carries the account-level funnel capability but nothing is funnel-configured).
- Serve's 443 listener binds only to `tailscale0` (IPv4 100.96.64.4 + IPv6), per `ss -tlnp`.
- `crazyagent.service`: active since 2026-11-15 23:29:58 EST, enabled, `Linger=yes`, `ExecStart=companion/index.mjs --remote`, `CRAZYAGENT_REMOTE_PUBLIC_HOST=conan-expertbook.tail11f47e.ts.net`. Installed unit identical to `config/crazyagent.service`; no secrets in the unit.
- Listeners 17871 (bridge), 17873 (remote API), 3080 (DSH web GUI) are **all 127.0.0.1-only**; direct connects to the tailnet IP on all three refused (curl exit 7) — confirmed from the network side, not just `ss`.
- Live unauthenticated probes (GET only, no token): `/remote/v1/state` → 401 `UNAUTHORIZED` locally and through Serve (system-trust TLS, no `-k`); `/bridge` through Serve → 404 `NOT_FOUND`.
- Credential hygiene: `remote-token`, `token`, `fcm-service-account.json`, `settings.json` all mode 0600 owner conan (metadata only; contents never read). `push-devices.json` absent — expected, the phone is paired with `conan-evo-x3`.
- Peers: 6 devices, all under the same account, all expected — conan-expertbook (self), conan-evo-x3 (online; designated push sender), Conan's S25 Edge (android, online; the phone), Expertbook (windows, offline 81 d), GRL-AL20 (android, offline 82 d; the stale node the docs already note), Huan's MacBook Air (macOS, offline). **No unexpected peers**, no device tags, no exit nodes, no subnet routes.
- Node prefs: RunSSH=false, RunWebClient=false, no advertised routes/tags, no exit node, ShieldsUp=false, self AllowedIPs = own /32 + /128 only, key expiry enabled (self expires 2027-02-23). Tailnet Lock not enabled.
- Other tailnet-reachable surface (NOT crazyAgent): tailscaled PeerAPI on tailscale0 (internal taildrop/file-sharing); `msctl web --host 0.0.0.0 --port 8080` and `spotifyd` on `*:46169` (identified via /proc socket-inode match) — wildcard binds, reachable from LAN and, under an allow-all ACL, from every tailnet peer. RustDesk service active (documented separate takeover path; out of scope).

## Recommendations (user-side unless noted)

1. **ACL (admin console → Access controls):** implement the docs §10/§13.1 grant — tag the host (e.g. `tag:agent-host`) and the phone (`tag:phone`), grant only phone→host `tcp:443`, deny other peers to the host. All 6 devices belong to the SAME user account, so a user-scoped grant alone cannot isolate the phone; **device tags are required**. No node carries tags today, which strongly suggests the recommended grant was never applied and the tailnet is still default allow-all.
2. Housekeeping: remove or expire the two stale nodes (GRL-AL20 82 d, Expertbook windows 81 d) if unused; keep key expiry on (already on); enable account 2FA (not verifiable locally); Tailnet Lock is optional hardening, currently off.
3. Keep Funnel off; do not add Serve routes for 17871 or 3080 (none exist today).
4. Outside crazyAgent but relevant: bind `msctl web` (8080, also LAN-exposed) and `spotifyd` (46169) to loopback if remote access is not needed, or restrict them in the ACL; under allow-all every peer can also reach tailscaled's PeerAPI/taildrop — disable file-sharing via ACL if unused.
5. No change needed to crazyAgent itself.

## Could not be verified (check in the admin console)

- The actual ACL/grants JSON (no credentials here; no local ACL file exists). Verify: default allow-all vs grants, whether any peer can reach host ports beyond 443, device approval status, account 2FA, other nodes' key-expiry settings.
- Authenticated API behavior and phone-side TLS/app behavior (no token used, by design; probes were host-originated only).
- Root-owned socket owners (no sudo); port 46169 positively identified as spotifyd via /proc; no unexplained listeners remain.
