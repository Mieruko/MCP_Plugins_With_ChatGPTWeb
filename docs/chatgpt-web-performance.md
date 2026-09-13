# ChatGPT web performance design

Decision: optimize ordinary ChatGPT web MCP calls, with no additional model, API key,
experimental client capability, or runtime dependency. Keep the default `slim` profile.

## Implemented

1. GET/SSE no longer shares the session operation queue with POST tool calls.
   Cancellation/other notifications also bypass that queue. Ordinary POST requests
   remain ordered; this change does not make arbitrary writes execute concurrently.
   Recovery loopback requests have a 10-second deadline and drain their response bodies.
2. `inspect_code` handles up to 12 independent read/grep/glob operations in one call,
   at most four concurrently. Results preserve input order and report per-item errors.
   Reads include line numbers, a source SHA-256, range continuation, and path rules.
   Rules are deduplicated within each response. No cross-call content cache can serve
   stale code. A read is capped at 1 MiB and rejects binary/non-regular files.
3. `start_process` waits up to `yield_time_ms` (default 1000, maximum 10000) and returns
   initial output, completion status, and a cursor. `process_output` accepts that
   cursor and `wait_ms` (default 0, maximum 10000), waking on output, exit or cancellation.
   No cursor retains the old tail behavior. Default tail is now 8000 characters per
   stream. Log storage is bounded to 400,000 characters per stream, even for one large chunk.
4. Prompt and connector instructions favor batching, explicit command cwd, multi-file
   patches and cursor waits. `stop_process` is exposed in slim so jobs can be cancelled.
5. `task_handoff` is exposed in the slim profile and remains task/session bound. Reads do
   not claim Basic write control. Updates pass through Workbench dispatch: Ask creates one
   pending operation, Auto/Full can update this narrow task metadata after lifecycle/writer
   checks, and approval replay executes the original request once. File Undo does not claim
   to restore handoff metadata.
6. Auto memory now selects the newest complete dated notes within the configured line/byte
   budget instead of taking the beginning of `MEMORY.md`. Oversized notes are truncated only
   at valid UTF-8 character boundaries. Legacy free-form files fall back to a marked newest
   tail. Omitted history remains on disk and the instruction block tells the agent how to
   inspect it. Session initialization reads memory from the task's pinned execution root.
7. `workbench()` now defaults to a compact `view=summary`. It includes task/execution/policy,
   experience/write control, capabilities, pending/running/failed counts, a bounded attention
   list and a bounded handoff excerpt. It does not include old diff bodies, command arguments
   or operation results. `view=history` is explicit, defaults to 10 entries, caps at 30 and
   uses a task-bound cursor. `operation_id` keeps the dedicated approval-result path.

## Continuity workflow

For a new ChatGPT Web conversation attached to an existing task:

1. Call `workbench()` for the current binding and compact state.
2. Call `task_handoff(action=read)` for the full current handoff.
3. Complete a small coherent milestone and run its relevant tests.
4. Update `task_handoff` with verified progress and the next concrete step.
5. Use `remember` only for reusable project knowledge/decisions, not as a duplicate activity log.

Pending approvals are never resubmitted automatically. A denied/expired operation does not
write the handoff. The server cannot create a new ChatGPT conversation, increase ChatGPT
context/quota, or force another conversation to continue.

## Examples

Call `inspect_code` with:

```json
{
  "requests": [
    { "kind": "read", "path": "src/index.ts", "offset": 150, "limit": 80 },
    { "kind": "read", "path": "src/lib/mcp-session-manager.ts" },
    { "kind": "grep", "path": "src", "pattern": "createSessionManager", "glob": "*.ts" }
  ],
  "max_chars": 24000
}
```

`max_chars` bounds content plus rules, not JSON metadata. Read output is shared fairly
after rules. `truncated=true` requires a narrower range; a truncated read deliberately
omits `next_offset` because a character cut could split a source line. Search results
have fixed result limits (60 lines for grep, 50 paths for glob); they are not exhaustive.
Set `workspace_root` for another project's rules; relative request paths still resolve
from the configured default workspace. Use absolute paths when changing projects.

Call `start_process` with an explicit `working_directory`. If `running` is true, pass
its `id` and `cursor` to `process_output` with `wait_ms: 10000`. Always carry forward
the returned cursor. `has_more` means unread buffered output remains; `dropped` means
the cursor predates retained output. Cursors are absolute UTF-16 character offsets
for stdout and stderr, not byte offsets. Without a cursor, `wait_ms` waits for output
arriving after the call and then returns the current tail.

Jobs and log cursors survive new MCP sessions in the same server process, not a server
restart. Job exit codes are those of the shell; PowerShell can normalize a failing native
command's code. A SHA-256 is informational, not an enforced precondition on existing
edit tools. Session cwd still exists for backward compatibility; explicit cwd avoids
depending on shared implicit shell state.

## Why this scope

The observed SSE queue stall is a correctness bug, not a model-speed issue. After fixing
it, reducing network/model round trips has a more direct payoff than adding more tools.
A typed read batch preserves read-only tool semantics and has less execution complexity
than an arbitrary JavaScript Code Mode. Code Mode, LSP and repository maps remain future
experiments, not prerequisites for this release. Do not assume API programmatic tool
calling, MCP Sampling or experimental Tasks is available to a ChatGPT web connector.

## Verification and rollout

`npm run test:chatgpt` builds and tests a separate server bound to test ports with a
temporary workspace. It checks both MCP route aliases with an open SSE stream,
batched inspection, output budgets, cursor eviction, background completion/failure,
and stale-session recovery. `npm test` includes this regression suite.

Continuity coverage is also part of `npm test`: `test-auto-memory.mjs` checks recent-note
selection, line/byte budgets, UTF-8 safety, legacy fallback and invalid configuration;
`test-continuity.mjs` exercises real slim HTTP MCP handoff permissions, task/workspace and
execution-root isolation, summary/history pagination and operation lookup; and
`test-handoff-expiry.mjs` proves an expired approval never invokes or writes the handoff.

On the same synthetic fixture of 30 completed operations with long review bodies, the
legacy default workbench response measured 23,309 text bytes (26,666 JSON-result bytes).
The compact summary measured 1,449 text bytes (1,654 JSON-result bytes): a 93.8% reduction
in text payload bytes. This is a local MCP payload measurement, not a token count or a
ChatGPT latency/model-quality benchmark.

These tests measure the local transport and tool contracts. They do not measure ChatGPT
reasoning time, remote tunnel latency or approval UI delays. For an end-to-end comparison,
use the same model, project snapshot and task prompts before/after. Record completion
time, tool-call count, errors/retries and correctness; compare repeated runs.

After deploying the built server, refresh the connector's tool definitions and use a new
conversation. An old connector snapshot may omit `task_handoff`, `inspect_code`, or the new
workbench view/cursor inputs.
No `.env` edits or tunnel restart are needed just to build and test this change.

References consulted:
- https://developers.openai.com/plugins/plan/tools
- https://developers.openai.com/api/docs/guides/developer-mode
- https://modelcontextprotocol.io/specification/2025-11-25/basic/transports
