# Security Policy

## Reporting a vulnerability

If you discover a security vulnerability, please **do not** open a public issue.
Instead, use GitHub's private vulnerability reporting:

> Repository -> Security -> Report a vulnerability

Or email the maintainers privately at `security@submillisecond.com`. Provide:

- a description of the issue
- steps to reproduce
- the version (tag / commit) you observed it on
- any proof-of-concept code or output

We aim to acknowledge reports within **5 business days** and to publish a fix
or mitigation within **30 days** of acknowledgement, depending on severity.

## Supported versions

The latest tagged minor release receives security fixes. Older tags are
maintained on a best-effort basis only.

## Out of scope

- Findings against third-party endpoints the action pushes data to (Slack,
  Datadog, AWS, etc.) - those are the responsibility of the respective vendor.
- Vulnerabilities in user-supplied bench commands - the action runs whatever
  you tell it to; treat your bench command surface like any other CI script.
