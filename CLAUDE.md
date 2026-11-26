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

Three PRs, merge order matters: #1, then #2, then #3.
1. PR #1 `fix/429-crash-token-handling`: token expiry fix, single-flight refresh, fallback login, 401 retry, sanitized `SomfyAPIError`, private axios instance (30 s timeout), init retry with jittered backoff (cap 15 min, honours Retry-After), self-rescheduling poll with overlap guard, `setTargetState` never throws.
2. PR #2 `chore/update-dependencies`: v1.2.0. axios 0.24 -> 1.x, TS 6, ESLint 10 flat config, homebridge 2.5 dev dep. `npm audit` 19 -> 0. Node `^22.12 || ^24 || ^26` (breaking: drops Node 10-20), homebridge `^1.8 || ^2`. CI + Dependabot added. ESLint `no-explicit-any` and `ban-ts-comment` were disabled only to avoid conflicting with PR #1; re-enable.
3. PR #3 `fix/config-validation-hardening`: startup config validation, `onGet`/`onSet`, HAP errors instead of fake states, schema fixes (password masked, draft-07 `required`), npm package trimmed to 12 files, README.

## Open items / follow-ups
- Stop polling on Homebridge shutdown (needs a stop method on `HomekitSomfySite`).
- `ALARM_TRIGGERED` is never mapped; needs a real site response to find the field.
- OAuth body is sent as JSON, not form-encoded (works historically; needs a live account to test a change).
- Re-enable the two ESLint rules; remove `@ts-ignore` in axios interceptors.
- Verify the funding URL in package.json (it was a guess).
- Nothing has been tested against the real Somfy API; only mocked axios. Test with a live account after releasing.
- Possible Somfy API change: unconfirmed reports (docs page vanished, `error.unknown` on the oauth client page). Investigation in progress; see the section below once filled in.

## API status investigation
(pending)

## Conventions
- eslint: double quotes, 2-space indent, max-len 140.
- Commits end with the Co-Authored-By line; PR bodies end with the Claude Code line.
- `gh` must be logged in as `timothe-ignace` (the owner) to open PRs on the fork.
