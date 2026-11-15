# Security policy

## Reporting a vulnerability

Please **do not open a public issue** for security problems. Report them privately via
[GitHub security advisories](https://github.com/hermanmak/trek-plugin-sure-sync/security/advisories/new).

Include the plugin version, TREK version, and steps to reproduce. You should get an
acknowledgement within a week.

## Supported versions

Only the latest release receives fixes.

## Security model

- The plugin only ever sends `GET` requests to Sure (`/api/v1/{accounts,categories,tags,transactions}`), refuses redirects, and never writes to Sure.
- The Sure URL and API key are **instance-scoped** settings that only a TREK admin can set. The key is stored encrypted by TREK and is never returned to the browser.
- Browsing the ledger (`/candidates`) and importing (`/import`) are **admin-only**, so a trip member can never enumerate the operator's card history with the instance key. Trip editors keep the read-only **Imported** view for their own trips.
- Outbound traffic is limited to hosts the TREK admin adds under **Allowed hosts** (`operatorEgress`); no external host is bundled.
- Trip routes act only on the caller's current trip and require TREK's `budget_edit` permission for writes.
