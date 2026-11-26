# Changelog

## 3.2.0 (2026-11-26)

### Changed
- The npm package is renamed from `homebridge-somfy-protect-alarm` to `homebridge-somfy-protect-v2`, since the plugin is no longer only an alarm. The code and the configuration are the same as 3.1.0 (`"platform": "SomfyProtect"` is unchanged). Uninstall the old package and install the new one; see "Upgrading" in the README. The old package is deprecated and will not get further releases. The GitHub repository is renamed to `homebridge-somfy-protect-v2` too (the old links redirect).

## 3.1.0 (2026-11-26)

Tested on a real account and Homebridge (as `3.1.0-beta.1`) before this release.

### Added
- Sensors (experimental, `exposeSensors`, on by default): Somfy smoke detectors become HomeKit smoke sensors; the alarm shows tampered (a device cover is open) and fault (a device lost its radio link, or a detector error). The devices are read at most every 30 s; a refused device list never affects the alarm. See the README for what Somfy does not provide (no open/closed state on the detectors).

## 3.0.0 (2026-11-26)

Tested on a real Somfy account and Homebridge (as a beta, `3.0.0-beta.1`) before this release.

### Changed (breaking)
- The plugin is now a Homebridge **dynamic platform** (it was an accessory plugin). Move the config block from `accessories` to `platforms` and use `"platform": "SomfyProtect"`; see "Upgrading from 2.x" in the README. HomeKit sees the alarm as a new accessory.
- Every home (site) of the Somfy account is added as its own security system, instead of one per config entry. The new `siteIds` list limits this; the old `siteId` is still read.
- One login, one token and one polling loop (with the existing backoff) serve all sites.

### Added
- A warning when the 2.x accessory entry is still present in `config.json`.
- Tests for the config validation, the platform (discovery, cache restore, removal of vanished sites) and several sites.
- `supports-hap` keyword.

## 2.0.1 (2026-11-26)

### Added
- The plugin logs a warning (once per value) when Somfy reports an `alarm.status` other than `none`. The values during a real trigger are not known yet, so they are not mapped to HomeKit; please report the logged value in issue #6.
- `scripts/live-check.mjs` prints the nested structure of the site's `alarm` and `mfa_*` fields.

### Verified
- Against a real owner account: the built-in OAuth client works, `expires_in` is in seconds (1800), and both JSON and form-encoded token requests are accepted.

## 2.0.0 (2026-11-26)

First release of the maintained continuation of `homebridge-somfy-protect` (last upstream release 1.1.2), published on npm as `homebridge-somfy-protect-alarm` because the original name belongs to the previous maintainer. The plugin config is unchanged. Major version because the supported Node.js versions changed.

### Fixed
- Uncaught `Request failed with status code 429` that killed the Homebridge child bridge. The token expiry was computed with `expires_in` (seconds) as milliseconds, so every API call refreshed the token and got rate limited.
- A failed token refresh now falls back to a password login; concurrent calls share one token request; a 401 triggers one re-login.
- Errors during initialization and polling no longer become unhandled rejections. Initialization and polling retry with exponential backoff and honour `Retry-After`.
- A failed arm/disarm no longer reports success to HomeKit.
- Credentials can no longer end up in logs through axios error objects.

### Changed
- Requires Node.js 22.12+ (22, 24, 26) and Homebridge 1.8+ or 2.x. Node 10 to 20 are no longer supported.
- No more `@ts-ignore`; no timing header is sent to Somfy any more; site ids are URL-encoded.
- Dependencies updated (axios 1.x, TypeScript 6, ESLint 10); `npm audit` is clean.
- The configuration is validated at startup; the password field is masked in Config UI X.
- HomeKit handlers use `onGet`/`onSet` and report "No Response" instead of a made-up state when the site is not ready.
- The npm package only contains the build output, schema, README and license.

### Added
- The OAuth token is cached on disk (`somfy-protect-token.json` in the Homebridge storage folder, mode 0600, bound to the account) so a restart does not log in again.
- Optional `clientId` / `clientSecret` config to override the built-in Somfy OAuth client, with a clear error when Somfy rejects the client (`invalid_client`).
- The plugin stops its timers on Homebridge shutdown; an unknown security level from Somfy keeps the previous state (with a single warning).
- Automated tests (`npm test`, 18 tests on `node:test`), run in CI.
- CI (Node 22/24/26), Dependabot, `SECURITY.md`, issue templates, and `scripts/live-check.mjs` to test the Somfy API with a real account.
