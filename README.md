
<p align="center">

<img src="https://github.com/homebridge/branding/raw/master/logos/homebridge-wordmark-logo-vertical.png" width="150">

</p>

Unofficial [Homebridge](https://github.com/homebridge/homebridge) plugin to integrate the Somfy Protect home security system with HomeKit.

## Usage

Configure the plugin in your Homebridge `config.json` file or via the popular [Config UI X plugin](https://github.com/oznu/homebridge-config-ui-x) which I recommend for easiest usage.

Either install and configure the plugin using Config UI X or install it manually by running the following command:

```
npm install -g homebridge-somfy-protect-alarm
```

> **Migrating from `homebridge-somfy-protect`?** This is the maintained continuation of that unmaintained plugin, published under a new npm name. Uninstall the old one (`npm uninstall -g homebridge-somfy-protect`), install this one, and follow "Upgrading from 2.x" below (the config format changed in 3.0.0).

Requirements: Node.js 22.12+ (22, 24 or 26) and Homebridge 1.8+ (Homebridge 2.x supported).

Then, add the following configuration to the `platforms` array in your Homebridge `config.json` (or use the plugin settings in Config UI X).

```
{
  "platform": "SomfyProtect",
  "name": "Somfy Protect",
  "username": "my.somfy@account.fr",
  "password": "my.somfy.account.password"
}
```

The credentials required in the configuration are the same ones you use in the official Somfy Protect app on your smartphone.

That's it! The plugin adds one alarm (security system) to HomeKit for **every home** of your Somfy account. The homes found are listed in the plugin logs. To add only some of them, list their site IDs:

```
{
  "platform": "SomfyProtect",
  "name": "Somfy Protect",
  "username": "my.somfy@account.fr",
  "password": "my.somfy.account.password",
  "siteIds": ["yoursiteid"]
}
```

## Upgrading from 2.x

Version 3.0.0 is a Homebridge *platform* (it was an *accessory* plugin). You have to change your `config.json` once:

1. Remove the `{"accessory": "SomfyProtect", ...}` entry from the `accessories` array.
2. Add the `{"platform": "SomfyProtect", ...}` entry above to the `platforms` array. The same `username`, `password`, `loggingAmount`, `clientId` and `clientSecret` keys work. A single `siteId` is still understood, but `siteIds` (a list) is preferred.
3. Restart Homebridge. The plugin warns in the log if the old entry is still there.

HomeKit will see the alarm as a **new accessory**: rooms, scenes and automations that used the old one have to be set up again, and the old accessory can be removed from the Home app.

## Configuration fields

| Field | Required | Description |
|-------|----------|-------------|
| `platform` | yes | Must be `SomfyProtect`. |
| `name` | yes | Name of the platform in the Homebridge log. The accessories are named after your Somfy homes. |
| `username` | yes | Your Somfy Protect account username. |
| `password` | yes | Your Somfy Protect account password. |
| `loggingAmount` | no | `0` = off (default), `1` = partial (state changes only), `2` = full. Other values fall back to `0`. |
| `siteIds` | no | List of the homes (sites) to add. Empty or missing: all homes of the account. Available IDs are listed in the plugin logs. |
| `exposeSensors` | no | `true` (default): your smoke detectors appear as HomeKit smoke sensors, and the alarm shows tamper and fault status. `false`: the devices are not read at all. **Experimental**, see below. |
| `clientId` / `clientSecret` | no | Override the built-in OAuth client (the public Somfy mobile app client). Must be set together. Useful if Somfy revokes the built-in client (the log then reports `invalid_client`). |

If `username` or `password` is missing or empty, the plugin logs a clear error and does not connect, but Homebridge keeps running.

## Sensors (experimental)

With `exposeSensors` on (the default), the plugin also reads the devices of each home (at most every 30 seconds):

- **Smoke detectors** become HomeKit smoke sensors (smoke detected, low battery, fault).
- The **alarm** shows *tampered* when a device cover is reported open, and *fault* when a device lost its radio link or a smoke detector reports an internal error.

What Somfy does **not** provide: the opening and vibration detectors ("tags") report no open or closed state, so they cannot be shown as door or window sensors. Sirens, keypads, the box, remotes and cameras report only battery and connectivity (cameras also a shutter state) and are not exposed.

This was built from the structure Somfy returns on a real account. The values reported during a real smoke or tamper event have not been verified, so treat the sensors as a bonus and not as your only smoke alarm. Please report what you see.

## Security notes

- The OAuth token is cached in `somfy-protect-token.json` in the Homebridge storage folder (file mode 0600, bound to the account and client) so restarts do not log in again. Delete the file to force a new login. Your password is never written to it.
- Your Somfy password is stored **in plain text** in Homebridge's `config.json` (the Config UI X password field only masks it on screen). Restrict access to that file and do not share it or post it in issues.
- The OAuth client credentials contained in the source code are the public ones of the Somfy Protect mobile app. They are not secrets of this project.
- Two-factor authentication: this plugin has not been verified to work with accounts that have 2FA enabled, and no 2FA step is implemented. If login fails, try with an account without 2FA (untested).

## Troubleshooting

- **HTTP 429 / "Too many requests"**: Somfy is rate limiting your account or IP. Wait some minutes, avoid restarting Homebridge repeatedly, and avoid running other tools that log in to Somfy at the same time.
- **Accessory shows "No Response"**: the plugin could not (yet) read the state from Somfy. Check the Homebridge logs for login or site errors, and verify your credentials in the Somfy Protect app.
- **A home is missing, or one too many**: set `siteIds` (see the plugin logs for the list of sites).
- **Two alarms, or errors about "accessory" after upgrading**: the old `accessories` entry is still in `config.json`, see "Upgrading from 2.x".

## Help & Support
Any feedback is welcome. For bugs, feature requests, open an issue here :)

## Dev
Use command `npm run watch` to start a homebridge server when developing the plugin. Config used by the plugin should be set up in the folder `~/.homebridge`.
