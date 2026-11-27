# homebridge-somfy-protect: maintenance context

Maintained continuation of an unmaintained upstream project. Never open PRs against the upstream repository; work in this repository only.
Repository: `homebridge-somfy-protect-v2` (renamed from `homebridge-somfy-protect` in 3.2.0; the old URL redirects).
Homebridge dynamic platform plugin (TypeScript, since 3.0.0; an accessory plugin before) exposing the Somfy Protect (ex-MyFox) alarm of every site of an account as a HomeKit security system. Published on npm as `homebridge-somfy-protect-v2` (renamed from `homebridge-somfy-protect-alarm` in 3.2.0, which got 2.0.0 to 3.1.0; the original `homebridge-somfy-protect` belongs to the previous maintainer).
Auth: OAuth2 password grant at `sso.myfox.io` with the public Somfy mobile-app client id/secret (hardcoded in `src/lib/somfy_api.ts`, overridable with `clientId`/`clientSecret`); API at `https://api.myfox.io/v3`.

## Layout
- `src/index.ts`: dynamic platform (discovery, accessory cache, removal of vanished sites, legacy-config warning)
- `src/lib/config.ts`: `validateConfig`
- `src/lib/camera_shutter.ts`: HomeKit switch for the privacy shutter of an indoor camera (`shutter_state`; command `POST /v3/site/{id}/device/{id}/action` `shutter_open|shutter_close`, taken from other Somfy clients, tested only with mocks until a real run)
- `src/lib/devices.ts`, `src/lib/smoke_sensor.ts`: devices (`/site/{id}/device`) reduced to a view; HomeKit smoke sensor per smoke detector (`sp_risk_detector`); tamper (`cover_present` false) and fault (`device_lost`) show on the security system
- `src/lib/security_system.ts`: HomeKit security system characteristics for one site
- `src/lib/somfy_account.ts`: one account = one login, site discovery, one polling loop with backoff, commands
- `src/lib/homekit_somfy_site.ts`: `SomfySite` (state of one site), state mapping (`armed`->AWAY_ARM, `partial`->NIGHT_ARM, `disarmed`->DISARMED)
- `src/lib/somfy_events.ts`, `src/lib/somfy_event_handler.ts`: optional real-time WebSocket channel (`realtimeEvents`) and its mapping to site state (instant level change, triggered alarm)
- `src/lib/somfy_api.ts`: HTTP client, token handling and disk cache
- `config.schema.json`: Config UI X schema
- `test/`: `node:test` suite (network faked by stubbing `axios.create`), run with `npm test`
- `scripts/live-check.mjs`, `docs/live-testing.md`: read-only check against the real Somfy API

## History
2.0.0 (2026-11-26) fixed an uncaught `Request failed with status code 429` that killed the child bridge. Root causes:
- `hasExpired()` treated `expires_in` (seconds) as milliseconds, so the token was always expired and every call refreshed it, hammering SSO into 429.
- The token refresh was not awaited, and a failed refresh never fell back to a password login.
- No error handling around init/poll, so rejections became uncaught exceptions.
- axios errors (containing the password body) were logged.

Fixes: correct expiry, single-flight refresh, password-login fallback, one 401 retry, sanitized `SomfyAPIError`, private axios instance (30 s timeout), init and poll retry with jittered exponential backoff (cap 15 min, honours Retry-After), `setTargetState` never throws. Also: dependency upgrade (axios 1.x, TypeScript 6, ESLint 10, `npm audit` clean), Node `^22.12 || ^24 || ^26` and Homebridge `^1.8 || ^2` (breaking vs 1.x), startup config validation, HAP errors instead of made-up states, token cache on disk, tests, CI.
2.0.1 (2026-11-26) logs a warning when `alarm.status` is not `none`.
3.0.0 (2026-11-26) turned the plugin into a dynamic platform (all sites); tested as `3.0.0-beta.1` (published under the `beta` npm tag, the release workflow tags prereleases automatically) before the final release.
3.2.1 (2026-11-26) new package description; first release published by CI under the new name (check that the trusted publisher worked).
3.2.0 (2026-11-26) renamed the package to `homebridge-somfy-protect-v2` (same code and config as 3.1.0). The first publish of a new package name has to be manual (2FA), and the trusted publisher must then be registered on npmjs.com for the new name before the release workflow can publish it.
3.1.0 (2026-11-26) added experimental sensors (smoke detector, tamper, fault); tested as `3.1.0-beta.1` on a real account.
See `CHANGELOG.md` for the details.

## Releases
Bump the version in `package.json`, update `CHANGELOG.md`, merge (PR title `chore(release): X.Y.Z`), then `gh release create vX.Y.Z`. `.github/workflows/release.yml` publishes to npm through trusted publishing (OIDC, with provenance, no token). The trusted publisher is configured per package on npmjs.com and must match the repository (`timothe-ignace/homebridge-somfy-protect-v2`), the workflow filename `release.yml` and an empty environment; a mismatch gives `E403 OIDC permission denied`. First verified with 2.0.1. Run `scripts/live-check.mjs` before every release.

## Open items
Tracked as GitHub issues:
- #6 map `ALARM_TRIGGERED`: the value of `alarm.status` during a real trigger is unknown (it is `none` when idle). The plugin warns once about any other value; map it once someone reports it.
- #15 account requirements (owner vs child user, 2FA).
- #16 dynamic platform: done in 3.0.0 (design in the issue). Sensors: issue #34 (smoke sensor, tamper, fault; the `tag` detectors expose no open/closed state in the API). Applying for "Verified by Homebridge" (requires a dynamic platform) can now be requested (3.0.0 is released and was tested on a real account).
Not covered by tests yet: the token file persistence.

## Somfy API facts
Verified with a live owner account (2026-11-26):
- The built-in client still works. `expires_in` is 1800 (seconds), a refresh token is returned.
- JSON and form-encoded token requests are both accepted.
- `GET /site/{id}` has `security_level`, `alarm: {status}`, `domestic_alarm: []`, `mfa_enabled`/`mfa_available` and more. The password grant works even with `mfa_enabled: true`.

From research, not verified:
- The API is unofficial; it was never documented for Somfy Protect and can be revoked at any time. No official deprecation was found and no rate limits are documented.
- Other maintained projects use the same endpoints and client, and warn that repeated restarts without a cached token can hit token rate limits (the reason for the token cache).
- One fork moved to user-supplied OAuth credentials; the reason is unknown. The `clientId`/`clientSecret` options exist for that case.
- A 400 `invalid_grant` was once caused by special characters in the password being mangled by a YAML config, not by an API change.
- The account must reportedly be an owner account, not a child user (#15).

## Conventions
- Conventional Commits (`feat:`, `fix:`, `docs:`, `chore:`, `ci:`, `test:`, `refactor:`, `deps:`), enforced by commitlint locally (husky) and on PR titles in CI. Merges are squashes, so the PR title becomes the commit message.
- ESLint (flat config): double quotes, 2-space indent, max-len 140, no `any`, no `@ts-ignore`. `npm run lint`, `npm run build`, `npm test` must pass.
- Never log credentials or tokens; keep errors sanitized (`SomfyAPIError`). Secret scanning (gitleaks) runs in CI; the public Somfy mobile-app client secret is allowlisted in `.gitleaks.toml`.
- Default branch is `main`. Branch protection requires PRs and green CI. Squash or rebase merges only; merged branches are deleted automatically.
- Dependabot opens weekly PRs for npm and GitHub Actions; axios (the only runtime dependency) gets its own PR.
- Commits and PRs made with Claude Code carry the usual Co-Authored-By / "Generated with Claude Code" attribution.
