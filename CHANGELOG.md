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
- Dependencies updated (axios 1.x, TypeScript 6, ESLint 10); `npm audit` is clean.
- The configuration is validated at startup; the password field is masked in Config UI X.
- HomeKit handlers use `onGet`/`onSet` and report "No Response" instead of a made-up state when the site is not ready.
- The npm package only contains the build output, schema, README and license.

### Added
- CI (Node 22/24/26), Dependabot, `SECURITY.md`, issue templates, and `scripts/live-check.mjs` to test the Somfy API with a real account.
