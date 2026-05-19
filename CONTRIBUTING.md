# Contributing

Thanks for considering a contribution.

## Quick rules

- Open an issue first for non-trivial changes so we can align on shape.
- Keep PRs focused; one concern per PR makes review tractable.
- Tests / smoke-tests for behaviour changes, not just refactors.
- Markdown and YAML stay ASCII-only (no em-dash / curly quotes).
- Java + Rust API parity is enforced where applicable - if you change one
  side, change the other.

## Local development

The actions are pure Node std-lib + composite YAML. No `npm install`. To run
an action locally:

```bash
INPUT_PATH=baseline.json CANDIDATE_PATH=cand.json node diff.js
```

Set the env vars the action's `action.yml` declares; the JS reads them and
behaves identically to a workflow invocation.

## Release flow

- Tag: `v<major>.<minor>.<patch>` semver.
- Move the floating `v<major>` tag to point at the latest `v<major>.x.y`
  after publishing (community convention; `actions/checkout` does this).
- Update `CHANGELOG.md`.
- For Marketplace-listed releases, tick the box on the GitHub release page.

## Licence

By contributing you agree your contributions are licensed under the
[MIT License](LICENSE).
