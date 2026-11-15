# Contributing

Issues and pull requests are welcome. For security problems, see [SECURITY.md](SECURITY.md) instead.

## Setup

Requires Node.js 22.13+ (tests use the built-in `node:sqlite`).

```sh
npm ci
npm test          # node --test against the SDK's mock host; no TREK or Sure needed
npm run validate  # manifest checks the registry runs
npm run dev       # hot-reloaded local TREK frame (trek-plugin-sdk dev)
```

`npm run dev` keeps state in `.trek-dev/` and may use `dev-fixtures.json`; both are gitignored
because they can hold real ledger data. Never commit them, and never commit real Sure URLs, API
keys or transaction exports in tests: use `sure.example.com` and synthetic data.

## Pull requests

- Keep the plugin read-only toward Sure: no non-`GET` requests.
- Don't add permissions to `trek-plugin.json` without explaining why in the PR and the README's
  Permissions table.
- Add or update a test in `test/plugin.test.js` for behaviour changes.
- CI (`npm test`, `npm run validate`) must pass.

## Releases

Releases are cut by the maintainer with `trek-plugin publish --sign`, which packs, signs and
opens the registry PR. Contributors don't need a signing key.
