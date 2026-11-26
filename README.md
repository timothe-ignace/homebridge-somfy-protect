
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

> **Migrating from `homebridge-somfy-protect`?** This is the maintained continuation of that unmaintained plugin, published under a new npm name. Uninstall the old one (`npm uninstall -g homebridge-somfy-protect`), install this one, and keep your config as is: the accessory is still `"accessory": "SomfyProtect"`.

Requirements: Node.js 22.12+ (22, 24 or 26) and Homebridge 1.8+ (Homebridge 2.x supported).

Then, add the following configuration to the `accessories` array in your Homebridge `config.json`.

```
{
  "accessory": "SomfyProtect",
  "name": "Somfy Protect",
  "username": "my.somfy@account.fr",
  "password": "my.somfy.account.password"
}
```

The credentials required in the configuration are the same ones you use in the official Somfy Protect app on your smartphone.

That's it! The plugin will automatically add your Somfy Protect alarm in your homekit accessories.

If your somfy account has multiple homes set up, you can specify which home the plugin should be using in the config by specifying the `siteId` attribute. You should see the list of available homes in the plugin logs (even if you have turned off logs). Your config should now look like this:

```
{
  "accessory": "SomfyProtect",
  "name": "Somfy Protect",
  "username": "my.somfy@account.fr",
  "password": "my.somfy.account.password",
  "siteId": "yoursiteid"
}
```

## Configuration fields

| Field | Required | Description |
|-------|----------|-------------|
| `accessory` | yes | Must be `SomfyProtect`. |
| `name` | yes | Accessory name shown in HomeKit. |
| `username` | yes | Your Somfy Protect account username. |
| `password` | yes | Your Somfy Protect account password. |
| `loggingAmount` | no | `0` = off (default), `1` = partial (state changes only), `2` = full. Other values fall back to `0`. |
| `siteId` | no | Site (home) to use when your account has several. Available IDs are listed in the plugin logs. |

If `username` or `password` is missing or empty, the plugin logs a clear error and does not connect, but Homebridge keeps running.

## Security notes

- Your Somfy password is stored **in plain text** in Homebridge's `config.json` (the Config UI X password field only masks it on screen). Restrict access to that file and do not share it or post it in issues.
- The OAuth client credentials contained in the source code are the public ones of the Somfy Protect mobile app. They are not secrets of this project.
- Two-factor authentication: this plugin has not been verified to work with accounts that have 2FA enabled, and no 2FA step is implemented. If login fails, try with an account without 2FA (untested).

## Requirements

Target: Node.js >= 20 and Homebridge 1.6+ or 2.x. (The exact supported versions are defined in `package.json`.)

## Troubleshooting

- **HTTP 429 / "Too many requests"**: Somfy is rate limiting your account or IP. Wait some minutes, avoid restarting Homebridge repeatedly, and avoid running other tools that log in to Somfy at the same time.
- **Accessory shows "No Response"**: the plugin could not (yet) read the state from Somfy. Check the Homebridge logs for login or site errors, and verify your credentials in the Somfy Protect app.
- **Wrong home used**: set `siteId` (see the plugin logs for the list of sites).

## Help & Support
Any feedback is welcome. For bugs, feature requests, open an issue here :)

## Dev
Use command `npm run watch` to start a homebridge server when developing the plugin. Config used by the plugin should be set up in the folder `~/.homebridge`.
