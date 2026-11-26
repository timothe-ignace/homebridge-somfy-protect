# Security policy

## Supported versions

Only the latest release receives fixes.

## Reporting a vulnerability

Please do not open a public issue. Use GitHub's private reporting:
https://github.com/timothe-ignace/homebridge-somfy-protect/security/advisories/new

You should get an answer within a few days. This is a volunteer-maintained project.

## Things worth knowing

- The plugin logs in to Somfy with your account username and password, which Homebridge stores in plain text in `config.json`. Protect that file.
- The OAuth client id/secret in the source are the public ones from the Somfy mobile app, not secrets of yours.
- Credentials and tokens must never appear in logs. If you find a log line that leaks one, report it as a vulnerability.
