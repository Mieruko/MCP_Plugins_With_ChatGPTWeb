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

These tests measure the local transport and tool contracts. They do not measure ChatGPT
reasoning time, remote tunnel latency or approval UI delays. For an end-to-end comparison,
use the same model, project snapshot and task prompts before/after. Record completion
time, tool-call count, errors/retries and correctness; compare repeated runs.

After deploying the built server, refresh the connector's tool definitions and use a new
conversation. An old connector snapshot may omit `inspect_code` and the new cursor inputs.
No `.env` edits or tunnel restart are needed just to build and test this change.

References consulted:
- https://developers.openai.com/plugins/plan/tools
- https://developers.openai.com/api/docs/guides/developer-mode
- https://modelcontextprotocol.io/specification/2025-11-25/basic/transports
