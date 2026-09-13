---
name: workbench-research
description: Evaluate an external library, MCP component, or agent workflow for adoption in this Workbench and propose a small, evidence-backed integration.
metadata:
  origin: affaan-m/ecc
  source_revision: "8321021c54d670126ce3b2969d5deb880b4b0c2a"
---

# Research before adopting a component

Read the local implementation and relevant tests first. Define the concrete capability that is missing before searching for a replacement.

- Inspect primary documentation and source at a pinned version or commit. Distinguish advertised features from implemented and tested behavior.
- Map dependencies, supported runtimes, licensing, installation destinations, and the files or settings an installer changes. Reading an installer does not require running it.
- Check compatibility with Windows, ChatGPT's exposed tool profile, task/worktree routing, and Workbench's Ask/Auto/Full policy. Do not assume another client's hooks or slash commands exist here.
- Compare reusing the existing implementation, adopting a small component, and building a narrow adapter. Prefer the choice that solves the requested problem with maintainable scope.
- Record source links, assumptions, unresolved gaps, and a practical acceptance test. For a larger integration, stage independent increments with a way to remove each one.
- Proceed with implementation when the user's request authorizes it; research alone does not authorize global installs, credential changes, or publishing.

For ECC updates, compare against the revision in the skill metadata and `docs/ecc-skills.md`. Revisit the selected files deliberately rather than importing a moving catalog wholesale.

Adapted for this repository from ECC [search first](https://github.com/affaan-m/ecc/tree/8321021c54d670126ce3b2969d5deb880b4b0c2a/skills/search-first).