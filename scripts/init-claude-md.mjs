/**
 * Generate starter CLAUDE.md (Claude Code /init style).
 * Usage: node scripts/init-claude-md.mjs [project-dir]
 */
import fs from "fs/promises";
import path from "path";

const root = path.resolve(process.argv[2] || process.cwd());
const target = path.join(root, "CLAUDE.md");

async function exists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function detectStack() {
  const hints = [];
  if (await exists(path.join(root, "package.json"))) {
    try {
      const pkg = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf-8"));
      const scripts = pkg.scripts || {};
      if (scripts.dev) hints.push(`npm run dev`);
      if (scripts.build) hints.push(`npm run build`);
      if (scripts.test) hints.push(`npm test`);
      if (scripts.lint) hints.push(`npm run lint`);
    } catch {}
    hints.push("Node.js project");
  }
  if (await exists(path.join(root, "composer.json"))) {
    hints.push("PHP / Composer");
    if (await exists(path.join(root, "artisan"))) hints.push("php artisan serve");
  }
  if (await exists(path.join(root, "pyproject.toml"))) hints.push("Python (pyproject.toml)");
  return [...new Set(hints)];
}

const stack = await detectStack();

const template = `# ${path.basename(root)} — Project Guide

## Overview
<!-- Describe what this project does in 2-3 sentences -->

## Dev commands
${stack.length ? stack.map((c) => `- \`${c}\``).join("\n") : "- <!-- add build/test commands -->"}

## Code style
- Match existing patterns in the repo
- Run tests/lint before finishing a task

## Architecture
<!-- Key directories and how they connect -->

## ChatGPT + Codex MCP
- WORKSPACE_PATH should point to this directory
- Tag connector **@Local Coder** in every ChatGPT message
`;

if (await exists(target)) {
  console.log(`CLAUDE.md already exists: ${target}`);
  console.log("Refine it manually or delete and re-run.");
  process.exit(0);
}

await fs.writeFile(target, template, "utf-8");
console.log(`Created ${target}`);
console.log("Edit Overview and Architecture, then restart MCP server.");