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
  if (!browser) {
    const evidence = windowsEvidence(text);
    if (!evidence) throw new Error("COMPUTER_OBSERVE_FORMAT: unsupported, incomplete or ambiguous Windows snapshot");
    return evidence.identity;
  }
  const evidence = browser ? browserEvidence(text) : undefined;
  return evidence ? JSON.stringify([evidence.context, evidence.tree]) : text;
}

// Windows-MCP 0.8.6 renders coordinates, not its internal array labels. Never
// infer those array indices from semantic-tree order: they are different orders.
// Our labels index only the authorized window's observed coordinate targets.
export function decodeWindowsSnapshotText(text: string): string {
  // FastMCP serializes a list[str] return as one JSON text block; when an
  // Image is also present it may emit native blocks instead. Decode only these
  // known text envelopes, never arbitrary objects or recursive JSON payloads.
  const trimmed = text.trim();
  if (trimmed.startsWith('[') || trimmed.startsWith('"')) {
    try {
      const value: unknown = JSON.parse(trimmed);
      if (typeof value === "string") text = value;
      else if (Array.isArray(value) && value.length === 1 && typeof value[0] === "string") text = value[0];
    } catch { /* The strict snapshot parser below rejects unsupported formats. */ }
  }
  return text.replace(/\r\n/g, "\n");
}

export function windowsEvidence(text: string, onFailure?: (reason: string) => void) {
  const fail = (reason: string) => { onFailure?.(reason); return undefined; };
  text = decodeWindowsSnapshotText(text);
  const section = (start: string, end: string) => new RegExp(`(?:^|\\n)[ \\t]*${start}:\\s*\\n([\\s\\S]*?)(?=\\n[ \\t]*${end}:)`).exec(text)?.[1].trim();
  const desktop = section("Active Desktop", "All Desktops");
  const focused = section("Focused Window", "Opened Windows");
  const opened = section("Opened Windows", "UI Tree");
  const tree = /(?:^|\n)[ \t]*UI Tree:\s*\n([\s\S]*)/.exec(text)?.[1].trimEnd();
  if (!desktop || !focused || !opened || !tree) return fail("missing_sections");
  if (/\[truncated:/.test(tree)) return fail("tree_truncated");
  if (focused === "No active window found") return fail("no_focused_window");
  if (/^No elements(?: found)?\.?$/.test(tree.trim())) return fail("tree_empty");
  const windowRow = /^(.*?)\s+(\d+)\s+(Normal|Maximized|Minimized|Hidden)\s+(\d+)\s+(\d+)\s+(\d+)$/;
  const windowHeader = /^Name\s+Depth\s+Status\s+Width\s+Height\s+Handle$/;
  const rows = focused.split("\n").map(line => line.trim());
  if (rows.length !== 3 || !windowHeader.test(rows[0])) return fail("focused_window_table");
  const window = windowRow.exec(rows[2]);
  if (!window || !window[1]) return fail("focused_window_row");
  if (["Minimized", "Hidden"].includes(window[3])) return fail("focused_window_not_visible");
  const title = window[1];
  // Background title text may tick, but a new window/overlay, changed stacking
  // depth or size must still invalidate an observation.
  const background: string[][] = [];
  if (opened !== "No windows found") {
    const otherRows = opened.split("\n").map(line => line.trim());
    if (otherRows.length < 3 || !windowHeader.test(otherRows[0])) return fail("background_window_table");
    for (const row of otherRows.slice(2)) {
      const parsed = windowRow.exec(row);
      if (!parsed) return fail("background_window_row");
      background.push(parsed.slice(2));
    }
    background.sort((a, b) => a[4].localeCompare(b[4]));
  }
  const lines = tree.split("\n");
  const matches = lines.flatMap((line, i) => /^[ │]*[├└]── window "/.test(line) && line.slice(line.indexOf('window "')) === `window "${title}"` ? [i] : []);
  if (matches.length !== 1) return fail(matches.length ? "ambiguous_window_tree" : "focused_window_tree_missing");
  const index = matches[0];
  const depth = lines[index].search(/[├└]/);
  let end = index + 1;
  while (end < lines.length && lines[end].search(/[├└]/) > depth) end++;
  // Sibling windows/taskbar clocks, cursor and screenshot metadata are not the
  // focused app's UI. Preserve its hierarchy, focus/value/state and coordinates.
  const appTree = lines.slice(index, end).map(line => line.slice(depth).replace(/│/g, " ").replace(/├/g, "└")).join("\n");
  const targets = appTree.split("\n").flatMap(line => {
    const hit = /[├└]── \((-?\d+),\s*(-?\d+)\) (.+\[action: [^\]]+\].*)$/.exec(line);
    return hit ? [{ loc: [Number(hit[1]), Number(hit[2])], description: hit[3] }] : [];
  }).map((target, label) => ({ label, ...target }));
  const contentTargets = targets.filter(t => !/^(?:title bar|menu bar|menu item)|^(?:button "(?:Minimize|Maximize|Restore|Close)"|button "(?:Thu nhỏ|Phóng to|Đóng)")\s/.test(t.description));
  return { title, handle: window[6], targets, contentTargets: contentTargets.length,
    readiness: contentTargets.length ? "controls_available" : "frame_only",
    identity: JSON.stringify([desktop, window.slice(1), background, appTree]) };
}

export function windowsParseDiagnostics(raw: string) {
  const text = decodeWindowsSnapshotText(raw);
  const missing_sections = ["Active Desktop", "All Desktops", "Focused Window", "Opened Windows", "UI Tree"]
    .filter(name => !new RegExp(`(?:^|\\n)[ \\t]*${name}:`).test(text));
  let reason = "unknown";
  windowsEvidence(raw, value => { reason = value; });
  return { reason, missing_sections, text_chars: text.length, json_decoded: text !== raw.replace(/\r\n/g, "\n") };
}

export function windowsChangeDiagnostics(previous: string, current: string) {
  const before = windowsEvidence(previous), after = windowsEvidence(current);
  if (!before || !after) return { reason: "snapshot_not_comparable" };
  const a = JSON.parse(before.identity), b = JSON.parse(after.identity);
  const sections = ["desktop", "focused_window", "window_layout", "app_controls"];
  const changed_sections = sections.filter((_, i) => JSON.stringify(a[i]) !== JSON.stringify(b[i]));
  const left = String(a[3]).split("\n"), right = String(b[3]).split("\n");
  const changedLines = Array.from({ length: Math.max(left.length, right.length) }, (_, i) => i).filter(i => left[i] !== right[i]);
  return { changed_sections, expected_handle: before.handle, current_handle: after.handle,
    target_counts: [before.targets.length, after.targets.length], changed_control_lines: changedLines.length,
    changed_line_indices: changedLines.slice(0, 8), details_redacted: true };
}
