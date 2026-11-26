# homebridge-somfy-protect: maintenance context

Fork: `timothe-ignace/homebridge-somfy-protect` (upstream `alxscms/` is unmaintained; never target it with PRs).
Homebridge accessory plugin (TypeScript) exposing a Somfy Protect (ex-MyFox) alarm as a HomeKit security system.
Auth: OAuth2 password grant at `sso.myfox.io` with the public Somfy mobile-app client id/secret (hardcoded in `src/lib/somfy_api.ts`); API at `https://api.myfox.io/v3`.

## Layout
- `src/index.ts`: accessory, HomeKit characteristics, config handling
- `src/lib/somfy_api.ts`: HTTP client, token handling
- `src/lib/homekit_somfy_site.ts`: init, polling, state mapping (`armed`->AWAY_ARM, `partial`->NIGHT_ARM, `disarmed`->DISARMED)
- `config.schema.json`: Config UI X schema

## Work done on 2026-11-26 (takeover of the unmaintained project)
Trigger: users hit an uncaught `Request failed with status code 429` that killed the child bridge (restarted 5 times, then dead).

Root causes found:
- `hasExpired()` treated `expires_in` (seconds) as ms, so the token was always expired and every call refreshed it. That hammered SSO into 429.
- `getNewToken()` was not awaited, and a failed refresh never fell back to a password login.
- No error handling around init/poll, so rejections became uncaught exceptions.
- axios errors (containing the password body) were logged.

All three PRs are MERGED into main (squash, in order #1, #2, #3; CI green on Node 22/24/26). Release 2.0.0 (version bumped from 1.2.0 because of the Node floor change and new name) is not yet published to npm; it will be published as `homebridge-somfy-protect-alarm` (the original npm name belongs to the previous maintainer, chosen by the user on 2026-11-26). Publishing is tracked in issue #14.
1. PR #1 `fix/429-crash-token-handling`: token expiry fix, single-flight refresh, fallback login, 401 retry, sanitized `SomfyAPIError`, private axios instance (30 s timeout), init retry with jittered backoff (cap 15 min, honours Retry-After), self-rescheduling poll with overlap guard, `setTargetState` never throws.
2. PR #2 `chore/update-dependencies`: v1.2.0. axios 0.24 -> 1.x, TS 6, ESLint 10 flat config, homebridge 2.5 dev dep. `npm audit` 19 -> 0. Node `^22.12 || ^24 || ^26` (breaking: drops Node 10-20), homebridge `^1.8 || ^2`. CI + Dependabot added. ESLint `no-explicit-any` and `ban-ts-comment` were disabled only to avoid conflicting with PR #1; re-enable once the `@ts-ignore`s in the axios interceptors are removed.
3. PR #3 `fix/config-validation-hardening`: startup config validation, `onGet`/`onSet`, HAP errors instead of fake states, schema fixes (password masked, draft-07 `required`), npm package trimmed to 12 files, README.

## Open items / follow-ups
Done since the first three PRs (merged 2026-11-26): #4 repo hygiene, #17 npm name, #18 lint cleanup + rename, #19 shutdown + unknown levels, #20 token cache + client config, #21 test suite (`npm test`).
Still open as GitHub issues:
- #6 map `ALARM_TRIGGERED`: needs the site object keys from `node scripts/live-check.mjs`.
- #8 form-encoded OAuth body: compare `live-check` with and without `--form`.
- #14 publish to npm as `homebridge-somfy-protect-alarm` (first publish manual with 2FA, then register the npm trusted publisher for `release.yml`; no token needed, then a GitHub release `v2.0.0`).
- #15 account requirements (owner vs child, 2FA); #16 dynamic platform plugin (discussion).
Not covered by tests yet: config validation (`validateConfig` lives in `src/index.ts`) and the token file persistence.

## API status investigation
Research on 2026-11-26 (WebSearch/WebFetch by a subagent; moderate confidence, nothing tested live):
- No official deprecation found. The api.myfox.io docs page was redirected in 2023; Somfy staff said the MyFox API is not for Somfy Protect systems, so the API is unofficial/unsupported and can be revoked at any time.
- `Minims/somfy-protect-api` and `Minims/SomfyProtect2MQTT` (Python, active, issues dated Nov 2026) use the same token URL, password grant and hardcoded client credentials, and the same endpoints. Indirect evidence the flow still works.
- The "error.unknown" report is from Feb 2022 and about creating API clients; not evidence of a change.
- No documented rate limits. SomfyProtect2MQTT warns repeated restarts without a cached token can hit token rate limits (consistent with the 429 root cause fixed here).
- The fork `jay-d-tyler/homebridge-somfy-protect` 2.3.x now requires user-supplied OAuth client id/secret; its issue #4 (25 Nov 2026) says users without developer credentials broke. Reason for dropping hardcoded credentials unknown.
- A 400 `invalid_grant` (Jan 2025) was caused by special characters in the password mangled by YAML, not an API change. Sending the token request form-encoded may be more robust.
- Account must reportedly be an owner account, not a child user.
- Not found: any 2FA/SSO migration affecting the password grant; the site field for a triggered alarm (maybe `alarm_status`, from memory, unverified); `alarm/stop` and `panic` endpoints exist.
Only verifiable with a live account: that the hardcoded client still gets a token (one POST to the token URL), the real `GET /site/{id}` fields, token lifetime, 2FA status.

## Conventions
- eslint: double quotes, 2-space indent, max-len 140.
- Commits end with the Co-Authored-By line; PR bodies end with the Claude Code line.
- Default branch is `main` (renamed from `master` on 2026-11-26). Branch protection requires PRs + green CI (admin can bypass). Squash or rebase merges only; merged branches auto-delete.
- Test with a real account via `scripts/live-check.mjs` and `docs/live-testing.md` before every release.
- `gh` must be logged in as `timothe-ignace` (the owner) to open PRs on the fork.
