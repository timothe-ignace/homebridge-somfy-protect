# Contributing

Thanks for helping. This is a Homebridge plugin for the Somfy Protect (ex-MyFox) alarm.

## Setup
```
npm ci            # also installs the git hooks (husky)
npm run lint
npm run build
npm test
```
Node.js 22.12 or newer. Tests fake the network; nothing in CI talks to the real Somfy API. To check a change against a real account, use `scripts/live-check.mjs` (see `docs/live-testing.md`).

## Rules
- **Conventional Commits** for commit messages and PR titles: `feat:`, `fix:`, `docs:`, `chore:`, `ci:`, `test:`, `refactor:`, with an optional scope (`fix(auth): ...`). The `commit-msg` hook and the `pr-title` CI job check this. PRs are squash-merged, so the PR title is what lands on `main`.
- Code style is enforced by ESLint (`npm run lint`, zero warnings): double quotes, 2-space indent, max line length 140, no `any`, no `@ts-ignore`.
- Add or update tests for behaviour changes.
- Never log or commit credentials or tokens. Secret scanning (gitleaks) runs in CI.
- User-visible changes go in `CHANGELOG.md`.

## Pull requests
Open them against `main` from a branch; CI (Node 22, 24, 26), the PR title check, the secret scan and CodeQL must pass.

## Releases (maintainers)
Bump the version, update `CHANGELOG.md`, merge (PR title `chore(release): X.Y.Z`), then `gh release create vX.Y.Z`. The release workflow publishes to npm with trusted publishing.

## Security
Report vulnerabilities privately, see `SECURITY.md`.
