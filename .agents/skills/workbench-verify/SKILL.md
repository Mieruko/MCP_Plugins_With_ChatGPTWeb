---
name: workbench-verify
description: Verify a Workbench implementation change with relevant build, regression, and MCP integration checks, and report evidence and remaining gaps.
metadata:
  origin: affaan-m/ecc
  source_revision: "8321021c54d670126ce3b2969d5deb880b4b0c2a"
---

# Verify a Workbench change

Inspect the diff and current package scripts to select checks for the changed behavior.

- Run `npm run build` for TypeScript changes. Use the relevant regression script for a local behavior change; use the HTTP MCP fixtures when registration, permissions, session routing, or result envelopes change.
- Run `npm test` before handing off a broad core change. Use `npm run test:integration` when the upstream MCP bridge changes; `test:all` also runs the aggregate readiness checks.
- Through LocalCode, start checks with `start_process` and an explicit working directory. Follow `process_output` using its returned cursor; do not restart a test just to retrieve its logs.
- Use isolated temporary servers and control directories. Do not restart the user's connected server while verifying.
- When a check fails, isolate whether the failure comes from the change or existing workspace state. Fix relevant regressions and rerun the affected checks.
- For permission-sensitive behavior, test the refusal or read-only path as well as the successful path. Never change live task permissions to make a test pass.

Report commands, exit results, material skipped coverage, and unresolved failures accurately. Match test scope to impact; static wording checks and repeated successful runs rarely add confidence.

Adapted for this repository from ECC [verification loop](https://github.com/affaan-m/ecc/tree/8321021c54d670126ce3b2969d5deb880b4b0c2a/skills/verification-loop).