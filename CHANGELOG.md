# Changelog

## 1.2.0 (unreleased)

Maintenance release after the original project went unmaintained. Published on npm as `homebridge-somfy-protect-alarm` (the original name belongs to the previous maintainer); the config is unchanged.

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
