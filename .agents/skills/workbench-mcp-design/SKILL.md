---
name: workbench-mcp-design
description: Design or change this Workbench's MCP tools, session routing, or tool outputs with task-scoped permissions and bounded context.
metadata:
  origin: affaan-m/ecc
  source_revision: "8321021c54d670126ce3b2969d5deb880b4b0c2a"
---

# Workbench MCP design

Trace the requested behavior through tool registration, dispatch, execution context, and the implementation before editing.

- Register tools through `src/server-factory.ts` so Workbench wraps the handler. Classify the capability in `src/lib/workbench.ts`; annotations describe behavior but do not grant permission.
- Resolve paths from the active task execution context. A process-wide default or caller-supplied workspace must not replace the pinned task or worktree.
- Use narrow Zod arguments and the existing `toolResult` / `toolError` envelope. For partial results, expose per-item errors and a usable continuation cursor; keep payloads bounded.
- Add a tool to the slim profile only when it belongs in the everyday ChatGPT workflow. Keep initialization to discovery metadata and fetch detailed material on demand.
- Preserve the pending-operation lifecycle: approval executes the original request. Do not add automatic resubmission or a shell fallback around a refusal.

Validate a changed boundary through the real MCP session/dispatch path, including Ask mode and two task workspaces when routing changes. Keep new fixtures isolated from the running server and its control directory.

Explain the new observable behavior, relevant compatibility changes, and the checks actually run.

Adapted for this repository from ECC [MCP server patterns](https://github.com/affaan-m/ecc/tree/8321021c54d670126ce3b2969d5deb880b4b0c2a/skills/mcp-server-patterns) and [agent harness construction](https://github.com/affaan-m/ecc/tree/8321021c54d670126ce3b2969d5deb880b4b0c2a/skills/agent-harness-construction).