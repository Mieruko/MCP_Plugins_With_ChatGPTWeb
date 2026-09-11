let monacoPromise;
let themeReady = false;

function ensureLoader() {
  if (globalThis.require?.config) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const existing = document.querySelector('script[data-workbench-monaco-loader]');
    if (existing) {
      existing.addEventListener('load', () => resolve(), { once: true });
      existing.addEventListener('error', () => reject(new Error('Monaco loader failed to load')), { once: true });
      return;
    }
    const script = document.createElement('script');
    script.src = '/vendor/monaco/vs/loader.js';
    script.async = true;
    script.dataset.workbenchMonacoLoader = 'true';
    script.onload = () => resolve();
    script.onerror = () => reject(new Error('Monaco loader failed to load'));
    document.head.append(script);
  });
}

function setupTheme(monaco) {
  if (themeReady) {
    monaco.editor.setTheme('workbench-dark');
    return;
  }
  monaco.editor.defineTheme('workbench-dark', {
    base: 'vs-dark',
    inherit: true,
    rules: [
      // Palette sampled from Codex dark diff rendering.
      { token: 'comment', foreground: '8B949E', fontStyle: 'italic' },
      { token: 'keyword', foreground: 'E97375' },
      { token: 'keyword.control', foreground: 'E97375' },
      { token: 'keyword.operator', foreground: 'E97375' },
      { token: 'string', foreground: '93DF78' },
      { token: 'string.escape', foreground: '82BBC5' },
      { token: 'number', foreground: '82BBC5' },
      { token: 'type', foreground: 'AD6DFF' },
      { token: 'type.identifier', foreground: 'AD6DFF' },
      { token: 'class', foreground: 'AD6DFF' },
      { token: 'namespace', foreground: 'AD6DFF' },
      { token: 'variable', foreground: 'EF9847' },
      { token: 'variable.predefined', foreground: 'EF9847' },
      { token: 'identifier', foreground: 'EF9847' },
      { token: 'function', foreground: 'AD6DFF' },
      { token: 'function.call', foreground: 'AD6DFF' },
      { token: 'method', foreground: 'AD6DFF' },
      { token: 'delimiter', foreground: 'C9D1D9' },
      { token: 'operator', foreground: 'C9D1D9' },
      { token: 'tag', foreground: 'E97375' },
      { token: 'attribute.name', foreground: 'AD6DFF' },
      { token: 'attribute.value', foreground: '93DF78' },
      { token: 'regexp', foreground: '93DF78' },
    ],
    colors: {
      'editor.background': '#181818',
      'editor.foreground': '#c9d1d9',
      'editorLineNumber.foreground': '#6e7681',
      'editorLineNumber.activeForeground': '#c9d1d9',
      'editorCursor.foreground': '#c9d1d9',
      'editor.selectionBackground': '#264f78',
      'editor.inactiveSelectionBackground': '#1f3a50',
      'editor.lineHighlightBackground': '#202020',
      'editorGutter.background': '#181818',
      'editorWidget.background': '#202020',
      'editorWidget.border': '#343434',
      // Keep word-level diff paint visually identical to the line background.
      // Monaco still computes intraline changes, but we do not draw darker token boxes.
      'diffEditor.insertedTextBackground': '#223124',
      'diffEditor.removedTextBackground': '#44272b',
      'diffEditor.insertedLineBackground': '#223124',
      'diffEditor.removedLineBackground': '#44272b',
      'diffEditor.insertedTextBorder': '#00000000',
      'diffEditor.removedTextBorder': '#00000000',
      'diffEditorGutter.insertedLineBackground': '#5fc975',
      'diffEditorGutter.removedLineBackground': '#f85149',
      'diffEditor.unchangedRegionBackground': '#2a2a2a',
      'diffEditor.unchangedRegionForeground': '#9da5b4',
      'diffEditor.unchangedRegionShadow': '#00000066',
      'diffEditor.unchangedCodeBackground': '#181818',
      'diffEditor.diagonalFill': '#242424',
    },
  });
  monaco.editor.setTheme('workbench-dark');
  themeReady = true;
}

export function loadMonaco() {
  if (globalThis.monaco?.editor) {
    setupTheme(globalThis.monaco);
    return Promise.resolve(globalThis.monaco);
  }
  if (monacoPromise) return monacoPromise;
  monacoPromise = ensureLoader().then(() => new Promise((resolve, reject) => {
    if (!globalThis.require?.config) {
      reject(new Error('Monaco AMD loader is unavailable'));
      return;
    }
    globalThis.require.config({ paths: { vs: '/vendor/monaco/vs' } });
    globalThis.require([
      'vs/editor/editor.main',
      'vs/basic-languages/monaco.contribution',
    ], () => {
      if (!globalThis.monaco?.editor) {
        reject(new Error('Monaco editor failed to initialize'));
        return;
      }
      setupTheme(globalThis.monaco);
      resolve(globalThis.monaco);
    }, reject);
  })).catch(error => {
    monacoPromise = undefined;
    throw error;
  });
  return monacoPromise;
}

export function languageForPath(path = '') {
  const normalized = String(path).toLowerCase().replace(/\\/g, '/');
  const name = normalized.split('/').pop() || '';
  if (name === 'dockerfile') return 'dockerfile';
  if (name === 'makefile') return 'plaintext';
  const ext = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1) : '';
  return ({
    js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
    ts: 'typescript', tsx: 'typescript', mts: 'typescript', cts: 'typescript',
    json: 'json', jsonc: 'json',
    css: 'css', scss: 'scss', less: 'less',
    html: 'html', htm: 'html', vue: 'html', svelte: 'html',
    md: 'markdown', markdown: 'markdown',
    py: 'python', java: 'java', kt: 'kotlin', kts: 'kotlin',
    c: 'c', h: 'c', cc: 'cpp', cpp: 'cpp', cxx: 'cpp', hpp: 'cpp',
    cs: 'csharp', go: 'go', rs: 'rust', php: 'php', rb: 'ruby',
    sh: 'shell', bash: 'shell', zsh: 'shell', ps1: 'powershell',
    sql: 'sql', yaml: 'yaml', yml: 'yaml', xml: 'xml',
  })[ext] || 'plaintext';
}

export function reconstructUnifiedDiff(diff = '') {
  const original = [];
  const modified = [];
  const originalLineNumbers = [];
  const modifiedLineNumbers = [];
  const originalKinds = [];
  const modifiedKinds = [];
  const originalIntraline = [];
  const modifiedIntraline = [];
  let pendingRemovals = [];
  let pendingAdditions = [];
  let inHunk = false;
  let hunks = 0;
  let oldLine = null;
  let newLine = null;

  const fullTextRange = (entry, target) => {
    if (!entry?.text?.length) return;
    target.push({ line: entry.line, startColumn: 1, endColumn: entry.text.length + 1 });
  };

  const changedTextRanges = (before, after) => {
    let prefix = 0;
    const shared = Math.min(before.text.length, after.text.length);
    while (prefix < shared && before.text[prefix] === after.text[prefix]) prefix += 1;

    let suffix = 0;
    const beforeRemaining = before.text.length - prefix;
    const afterRemaining = after.text.length - prefix;
    while (
      suffix < beforeRemaining
      && suffix < afterRemaining
      && before.text[before.text.length - 1 - suffix] === after.text[after.text.length - 1 - suffix]
    ) suffix += 1;

    const beforeEnd = before.text.length - suffix;
    const afterEnd = after.text.length - suffix;
    if (beforeEnd > prefix) originalIntraline.push({ line: before.line, startColumn: prefix + 1, endColumn: beforeEnd + 1 });
    if (afterEnd > prefix) modifiedIntraline.push({ line: after.line, startColumn: prefix + 1, endColumn: afterEnd + 1 });
  };

  const flushChangeBlock = () => {
    const paired = Math.min(pendingRemovals.length, pendingAdditions.length);
    for (let index = 0; index < paired; index += 1) changedTextRanges(pendingRemovals[index], pendingAdditions[index]);
    pendingRemovals.slice(paired).forEach(entry => fullTextRange(entry, originalIntraline));
    pendingAdditions.slice(paired).forEach(entry => fullTextRange(entry, modifiedIntraline));
    pendingRemovals = [];
    pendingAdditions = [];
  };

  for (const line of String(diff).replace(/\r\n/g, '\n').split('\n')) {
    const hunk = line.match(/^@@\s+-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/);
    if (hunk) {
      flushChangeBlock();
      if (hunks > 0) {
        original.push('');
        modified.push('');
        originalLineNumbers.push(null);
        modifiedLineNumbers.push(null);
        originalKinds.push('gap');
        modifiedKinds.push('gap');
      }
      hunks += 1;
      inHunk = true;
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      continue;
    }
    if (!inHunk || line.startsWith('\\ No newline at end of file')) continue;
    if (line.startsWith('+') && !line.startsWith('+++')) {
      const text = line.slice(1);
      modified.push(text);
      modifiedLineNumbers.push(newLine++);
      modifiedKinds.push('add');
      pendingAdditions.push({ line: modified.length, text });
    }
    else if (line.startsWith('-') && !line.startsWith('---')) {
      const text = line.slice(1);
      original.push(text);
      originalLineNumbers.push(oldLine++);
      originalKinds.push('remove');
      pendingRemovals.push({ line: original.length, text });
    }
    else if (line.startsWith(' ')) {
      flushChangeBlock();
      original.push(line.slice(1));
      modified.push(line.slice(1));
      originalLineNumbers.push(oldLine++);
      modifiedLineNumbers.push(newLine++);
      originalKinds.push('context');
      modifiedKinds.push('context');
    }
  }
  flushChangeBlock();
  return {
    original: original.join('\n'),
    modified: modified.join('\n'),
    originalLineNumbers,
    modifiedLineNumbers,
    originalKinds,
    modifiedKinds,
    originalIntraline,
    modifiedIntraline,
    hunks,
    parsed: hunks > 0,
  };
}