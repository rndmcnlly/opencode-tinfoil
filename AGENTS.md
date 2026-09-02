# AGENTS.md

This repository contains `opencode-tinfoil`, a generic OpenCode plugin for
Tinfoil's verified inference transport.

- Keep direct Tinfoil account use first-class and the package independent of
  any particular reverse proxy or downstream service operator.
- Do not add downstream-service URLs, credentials, model catalogs, or branding.
- Preserve the fail-closed invariant: inference content must never fall back to
  ordinary `fetch` when attestation or encrypted transport fails.
- Pin the `tinfoil` runtime dependency exactly so transport changes are reviewed
  before release.
- Do not publish, commit, or push unless explicitly requested.
