# Project skills and the first ECC integration

This increment adds a task-scoped, read-only `skills` MCP tool and four concise workflows adapted for this repository from [ECC](https://github.com/affaan-m/ecc/tree/8321021c54d670126ce3b2969d5deb880b4b0c2a). Source revision: `8321021c54d670126ce3b2969d5deb880b4b0c2a`. Provenance and the upstream MIT notice are in [ecc-LICENSE.txt](ecc-LICENSE.txt).

## What is installed

| Skill ID in this repository | Purpose |
| --- | --- |
| `agents:workbench-mcp-design` | Tool contracts, task routing, bounded context |
| `agents:workbench-security-review` | Review authorization and trust boundaries |
| `agents:workbench-verify` | Build and targeted regression checks |
| `agents:workbench-research` | Evaluate dependencies and integrations |

These are repository-local workflows for developing Workbench. Another project receives its own skills, not these skills automatically. No global configuration, ECC installer, hook, observer, memory service, or automatic script execution is included.

## Discovery and use

Put `SKILL.md` inside a named folder below `.agents/skills/` or `.claude/skills/` in the task's execution workspace. Nested categories are supported up to four directory levels. Both sources are retained; duplicate names get distinct IDs (for example `agents:review` and `claude:review`) and a diagnostic.

```yaml
---
name: project-review
description: Review changes to this project's public API.
---
Your project-specific workflow.
```

YAML supports quoted scalars, comments, folded/literal multiline descriptions, and optional `metadata.origin` / `metadata.source_revision`. Required fields are a lowercase hyphenated name (up to 64 characters) and a nonempty string description. Unlike the previous loader, malformed or missing frontmatter is reported and skipped. YAML aliases and custom tags are rejected.

After starting the updated server, refresh the ChatGPT connector and open a new conversation to discover the new tool. Existing server processes keep their loaded code until restarted. In ChatGPT, a request such as “Dùng skill workbench-verify để kiểm tra thay đổi này” lets the agent discover and read the workflow; slash commands are unnecessary.

Example tool arguments:

```json
{"action":"list","query":"verify","limit":10}
{"action":"read","id":"agents:workbench-verify"}
```

- Each list response contains a revision, IDs, hashes, diagnostics, `complete`, and `next_cursor`. Continue with the same query and returned cursor. A changed catalog or query invalidates the cursor.
- Pass the returned revision as `expected_revision` when reading against a specific catalog.
- Read responses contain content, `sha256`, `next_offset`, and local Markdown reference hints. Continue using `offset: next_offset` and `expected_sha256` from the preceding response. A hash is required after offset zero; a changed document requires starting over.
- Read a supporting text file using `reference` relative to the skill folder, such as `references/testing.md`. Files must stay inside that folder; absolute paths, backslashes, colon paths, and `..` segments are rejected. External links are not fetched. Reference hints recognize simple inline Markdown links outside fenced code; they are not an exhaustive Markdown parser.
- The tool resolves the workspace from the pinned task at dispatch, including isolated worktrees. It has no workspace override argument. Its read-only classification permits use under Ask and workspace-only policies, subject to normal task access checks.

Initialization includes at most 12 short descriptions; full instructions are loaded on demand. Listing reflects edits without restarting. Initialization metadata is a session snapshot and can be refreshed through `skills(action: list)`.

## Limits and diagnostics

| Boundary | Limit |
| --- | --- |
| File | UTF-8 text, 64 KiB; frontmatter 8 KiB |
| Catalog | 512 skills, 4 MiB of documents, 4096 visited entries |
| Directory depth | Four levels below each skill source |
| List page | Default 20, maximum 50 |
| Read chunk | Default 12000, maximum 24000 UTF-16 code units |
| Diagnostics / reference hints | 100 / 32 |

A scan limit or unreadable/invalid skill marks the catalog incomplete. An absent ID in an incomplete catalog is reported differently from a confirmed miss. Check `diagnostics_truncated` when errors exceed the bound.

Symlink/junction paths and hard-linked files are rejected even in Full mode. References also pass the existing path policy, including control-state protection. This is a bounded document reader; it is not a process sandbox or an authorization channel. The filesystem checks reject stable link escapes but do not claim isolation from a malicious local process racing directory replacements.

## Maintenance and validation

Run `npm run test:skills` for parsing, pagination, content changes, references, scan limits, and live MCP task/permission checks. It uses temporary workspaces and an isolated server. The test is also included in `npm test` and `npm run test:all`.

The workflows contain original repository-specific wording informed by the cited ECC skills. Review changes against the pinned upstream revision before updating them. Hook parity, learned-memory integration, and external evaluators remain separate future work.