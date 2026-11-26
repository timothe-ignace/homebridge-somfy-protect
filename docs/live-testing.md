# Testing with a real Somfy account

The automated checks (CI) only build and lint. Nothing in the repo talks to the real Somfy API, so do these two steps before every release.

## 1. API check (about a minute, read-only)

```
git clone https://github.com/timothe-ignace/homebridge-somfy-protect && cd homebridge-somfy-protect
node scripts/live-check.mjs          # OAuth requests as JSON (what the plugin sends today)
node scripts/live-check.mjs --form   # same, form-encoded (what RFC 6749 specifies)
```

It asks for your Somfy username and password (hidden), or reads `SOMFY_USERNAME` / `SOMFY_PASSWORD`. It never prints tokens or the password and never changes the alarm state. It reports:

1. the password grant (HTTP status, `expires_in`, whether a refresh token is returned),
2. the refresh grant,
3. `GET /site` (your sites and their `security_level`),
4. the keys of the site object (use this to find the field for a triggered alarm),
5. the device count.

How to read it:
- `1. Password grant: HTTP 200` means the built-in OAuth client still works.
- `HTTP 400` / `401` with `invalid_client` means Somfy revoked the shared client (the plugin would then need user-supplied credentials). `invalid_grant` means wrong credentials, a child (non-owner) account, or an account without legacy login.
- `HTTP 429` means rate limiting; wait for the `Retry-After` and retry. Do not loop.
- If JSON works and `--form` fails (or the reverse), keep the one that works.

## 2. Plugin check in Homebridge

Build and install the current checkout into a Homebridge instance:

```
npm ci && npm run build && npm pack          # creates homebridge-somfy-protect-<version>.tgz
sudo npm install -g ./homebridge-somfy-protect-<version>.tgz     # or install the .tgz in your Homebridge's plugin folder
```

Set `"loggingAmount": 2` in the plugin config, restart Homebridge, and check:
- the log shows the site and no `429`; the token is requested once, not on every poll,
- arming, partially arming and disarming from the Home app is reflected in the Somfy app, and the reverse within about 10 s,
- let it run a few hours: no "Poll failed" burst, and a Homebridge restart does not crash the child bridge,
- with a wrong password, the plugin logs errors and keeps Homebridge running (no restart loop).

Attach the log (with `loggingAmount: 2`; the plugin is written to never log credentials or tokens, but skim it before posting) to any issue you open.
