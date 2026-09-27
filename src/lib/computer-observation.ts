// Parse the full snapshot emitted by the pinned Playwright MCP version.
// Logs/timing are not UI identity. Unknown formats fail closed.
export function browserEvidence(text: string) {
  const url = /^- Page URL: (.+)$/m.exec(text)?.[1];
  const tree = /### Snapshot\s*\n```yaml\n([\s\S]*?)\n```/.exec(text)?.[1];
  if (!url || tree === undefined) return undefined;
  const tabs = /### Open tabs\n([\s\S]*?)(?=\n### |$)/.exec(text)?.[1] ?? "";
  const modal = /### Modal state\n([\s\S]*?)(?=\n### |$)/.exec(text)?.[1] ?? "";
  const dialogs = tree.split("\n").filter(line => /^\s*- (?:alert)?dialog\b/.test(line)).join("\n");
  return { url, tree, context: JSON.stringify([url, tabs, modal, dialogs]) };
}

export function browserTarget(text: string, target: string) {
  const evidence = browserEvidence(text);
  if (!evidence) return undefined;
  const lines = evidence.tree.split("\n");
  const indices = lines.flatMap((line, index) => line.includes(`[ref=${target}]`) ? [index] : []);
  if (indices.length !== 1) return undefined;
  const index = indices[0];
  const indent = lines[index].search(/\S/);
  let end = index + 1;
  while (end < lines.length && lines[end].search(/\S/) > indent) end++;
  // Include descendant properties such as link URL/option state and ancestor
  // identity, so a same-named control moved to another form is not equivalent.
  const ancestors: string[] = [];
  let depth = indent;
  for (let i = index - 1; i >= 0; i--) {
    const level = lines[i].search(/\S/);
    if (level >= 0 && level < depth) { ancestors.unshift(lines[i].trim().replace(/ \[active\]/g, "")); depth = level; }
  }
  // A successful click focuses its target; focus alone is not a new control.
  return JSON.stringify([evidence.context, ancestors, lines.slice(index, end).map(line => line.trim().replace(/ \[active\]/g, ""))]);
}

export function observationIdentity(text: string, browser: boolean) {
  const evidence = browser ? browserEvidence(text) : undefined;
  return evidence ? JSON.stringify([evidence.context, evidence.tree]) : text;
}
