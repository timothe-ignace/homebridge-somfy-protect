<p align="center">

<img src="https://raw.githubusercontent.com/homebridge/branding/latest/logos/homebridge-wordmark-logo-vertical.png" width="150">

</p>

# Homebridge Somfy Protect

[![npm](https://img.shields.io/npm/v/homebridge-somfy-protect-alarm)](https://www.npmjs.com/package/homebridge-somfy-protect-alarm)

Control your **Somfy Protect** alarm (ex-MyFox) from Apple Home: arm, partially arm and disarm it, and see its state change when you use the Somfy app or the keypad.

- Your alarm shows up in the Home app as a security system (Away, Night, Off).
- Smoke detectors show up as smoke sensors.
- Works with the same email and password as the Somfy Protect app. No developer account, no API key.

> Unofficial plugin, not affiliated with Somfy.

## Install

In Homebridge UI, search for **Somfy Protect** and click Install. Or from a terminal:

```
npm install -g homebridge-somfy-protect-alarm
```

Needs Node.js 22.12 or newer and Homebridge 1.8 or newer (Homebridge 2 works).

## Set up

Open the plugin settings and enter the email and password of your Somfy Protect account. Or add this to the `platforms` list of your `config.json`:

```json
{
  "platform": "SomfyProtect",
  "name": "Somfy Protect",
  "username": "my.somfy@account.fr",
  "password": "my.somfy.account.password"
}
```

Restart Homebridge. Your alarm appears in the Home app within a few seconds.

Use the account that owns the alarm. An account of a user invited into someone else's home may not work (not verified).

## What you get in Home

| Somfy | In the Home app |
|-------|-----------------|
| Your alarm (one per home on your account) | Security system: Away, Night (partial) and Off |
| Smoke detector | Smoke sensor, with low battery and fault |
| A device cover opened, or a device that lost its link | Tamper and fault on the alarm |

Smoke sensors, tamper and fault are **experimental**: they follow what Somfy reports, but they have not been checked against a real fire or tamper event. Do not rely on them as your only smoke alarm.

Somfy's opening and vibration detectors do not report open or closed, so they cannot appear as door or window sensors. Sirens, keypads, remotes and cameras are not shown.

## Settings

| Setting | Default | What it does |
|---------|---------|--------------|
| `username`, `password` | required | Your Somfy Protect account. |
| `siteIds` | all homes | List of home (site) IDs to add. The IDs of your homes are written in the Homebridge log at startup. |
| `exposeSensors` | `true` | Add the smoke detectors, tamper and fault. `false` stops reading the devices. |
| `loggingAmount` | `0` | `0` off, `1` state changes, `2` everything. Use `2` when reporting a problem. |
| `clientId`, `clientSecret` | built in | Advanced: use your own Somfy OAuth client instead of the built-in one. Set both or neither. |

## Troubleshooting

- **"No Response" in Home**: the plugin could not read the state from Somfy yet. Look at the Homebridge log for a login or site error and check your email and password in the Somfy Protect app.
- **Too many requests (HTTP 429)**: Somfy is rate limiting you. Wait a few minutes, avoid restarting Homebridge in a loop, and stop other tools that log in to Somfy.
- **A home is missing, or one too many**: set `siteIds`.
- **Login fails on an account with two-factor authentication**: the plugin has no step for it and has not been verified with such accounts. Try an account without it.
- **Still stuck**: set `loggingAmount` to `2`, restart, and [open an issue](https://github.com/timothe-ignace/homebridge-somfy-protect/issues) with the log (the plugin never logs your password or tokens, but skim it first).

## Upgrading

A short history, so you know which steps apply to you:

| Version | What it is |
|---------|------------|
| 1.x | The original plugin, `homebridge-somfy-protect`, no longer maintained. |
| 2.x | The start of this fork, published as `homebridge-somfy-protect-alarm` because the original name belongs to the previous maintainer. Same config as 1.x, with fixes and updated dependencies. |
| 3.x | The plugin became a Homebridge *platform*, so the config format changed (below). It now adds every home of your account, plus the smoke sensors. |

<details>
<summary>From 2.x of this plugin</summary>

Change your `config.json` once:

1. Remove the `{"accessory": "SomfyProtect", ...}` entry from `accessories`.
2. Add the `{"platform": "SomfyProtect", ...}` entry shown in "Set up" to `platforms`. Your `username`, `password` and other settings carry over. A single `siteId` is still read, but `siteIds` is preferred.
3. Restart Homebridge. The log warns if the old entry is still there.

Home sees the alarm as a **new accessory**, so recreate the rooms, scenes and automations that used the old one, then remove the old accessory.

</details>

<details>
<summary>From the original <code>homebridge-somfy-protect</code> (1.x)</summary>

Uninstall the old plugin with `npm uninstall -g homebridge-somfy-protect`, install this one, and replace your old `accessories` entry with the `platforms` entry from "Set up" (same `username` and `password`). As above, Home sees the alarm as a new accessory.

</details>

## Good to know

- **Your password is stored in plain text** in Homebridge's `config.json` (Config UI X only hides it on screen). Restrict access to that file and never post it.
- **Restarts do not log in again.** The login token is cached in `somfy-protect-token.json` in the Homebridge storage folder (readable only by its owner; your password is not in it). Delete the file to force a new login.
- **No developer credentials.** The plugin signs in with the same public OAuth client as the Somfy mobile app, which is built into the source and is not a secret of this project. If Somfy ever revokes it, the log says `invalid_client`, and `clientId` / `clientSecret` let you provide another one.
- **Unofficial API.** Somfy does not document or support this API, so it can change without notice.
- **Gentle on Somfy.** One login serves all homes, and when Somfy answers with an error the plugin waits longer before trying again instead of repeating requests.

## Contributing

Bug reports and pull requests are welcome, see [CONTRIBUTING.md](CONTRIBUTING.md). To check your own account against the Somfy API, see [docs/live-testing.md](docs/live-testing.md). Security issues: [SECURITY.md](SECURITY.md).
