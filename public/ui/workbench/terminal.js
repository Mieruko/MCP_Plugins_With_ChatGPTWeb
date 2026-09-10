import { api } from './api.js';
import { state } from './state.js';
import { $, setStatus } from './dom.js';

const CLIENT_LOG_LIMIT = 250_000;
const views = new Map();
let selectedProcessId = null;
let selectedTaskId = null;
let streamAbort = null;
let streamGeneration = 0;
let streamingProcessId = null;
let shellOutputActive = false;
let paused = false;
let follow = true;
let newLines = 0;

function nearBottom(node) {
  return node.scrollHeight - node.scrollTop - node.clientHeight < 28;
}

function lineCount(text) {
  if (!text) return 0;
  return Math.max(1, (text.match(/\n/g) || []).length);
}

function viewFor(id) {
  let view = views.get(id);
  if (!view) {
    view = { cursor: null, text: '', initialized: false, running: null, exitCode: null, hasMore: false, dropped: false };
    views.set(id, view);
  }
  return view;
}

function setNewLines(count) {
  newLines = count;
  const badge = $('terminal-new-lines');
  badge.hidden = count <= 0;
  badge.textContent = `${count} new`;
}

function renderCurrent(forceLatest = false) {
  if (!selectedProcessId) return;
  const output = $('terminal-output');
  const view = viewFor(selectedProcessId);
  const keepTop = output.scrollTop;
  output.textContent = view.text || 'Process has not produced output yet.';
  if (forceLatest || follow) output.scrollTop = output.scrollHeight;
  else output.scrollTop = keepTop;
  setNewLines(0);
}

function appendChunk(view, chunk) {
  if (!chunk) return;
  const output = $('terminal-output');
  const isCurrent = Boolean(selectedProcessId && views.get(selectedProcessId) === view);
  const wasNearBottom = isCurrent && nearBottom(output);
  const beforeLength = view.text.length;
  view.text += chunk;
  let truncated = false;
  if (view.text.length > CLIENT_LOG_LIMIT) {
    view.text = `[client log truncated to latest ${CLIENT_LOG_LIMIT} chars]\n${view.text.slice(-CLIENT_LOG_LIMIT)}`;
    truncated = true;
  }
  if (!isCurrent) return;
  if (paused) {
    setNewLines(newLines + lineCount(chunk));
    return;
  }
  if (truncated || (beforeLength === 0 && output.textContent === 'Process has not produced output yet.')) output.textContent = view.text;
  else output.append(document.createTextNode(chunk));
  if (follow && wasNearBottom) output.scrollTop = output.scrollHeight;
  else if (!follow) setNewLines(newLines + lineCount(chunk));
}

function applyProcessOutput(view, result) {
  let chunk = '';
  if (result.dropped && !view.dropped) {
    chunk += '[output gap: older process log was evicted]\n';
    view.dropped = true;
  }
  if (result.stdout) chunk += result.stdout;
  if (result.stderr) {
    if (chunk && !chunk.endsWith('\n')) chunk += '\n';
    chunk += `[stderr]\n${result.stderr}`;
  }
  appendChunk(view, chunk);
  view.cursor = result.cursor || view.cursor;
  view.initialized = true;
  view.running = Boolean(result.running);
  view.exitCode = result.exit_code ?? null;
  view.hasMore = Boolean(result.has_more);
  if (selectedProcessId && views.get(selectedProcessId) === view) {
    $('terminal-state').textContent = view.running ? '● running' : `exit ${view.exitCode ?? '—'}`;
    $('terminal-stop').disabled = !view.running;
  }
}

function outputUrl(taskId, processId, view) {
  const params = new URLSearchParams({ tail: '20000' });
  if (view.initialized && view.cursor) {
    params.set('stdout_cursor', String(view.cursor.stdout));
    params.set('stderr_cursor', String(view.cursor.stderr));
    params.set('wait_ms', view.hasMore ? '0' : '10000');
  }
  return `/api/workbench/tasks/${encodeURIComponent(taskId)}/processes/${encodeURIComponent(processId)}/output?${params}`;
}

async function streamProcess(taskId, processId) {
  streamAbort?.abort();
  const controller = new AbortController();
  streamAbort = controller;
  const generation = ++streamGeneration;
  const view = viewFor(processId);
  streamingProcessId = processId;
  try {
    while (!controller.signal.aborted && generation === streamGeneration && selectedTaskId === taskId && selectedProcessId === processId) {
      const result = await api(outputUrl(taskId, processId, view), { signal: controller.signal });
      if (controller.signal.aborted || generation !== streamGeneration) return;
      applyProcessOutput(view, result);
      if (!result.running && !result.has_more) break;
    }
  } catch (error) {
    if (error.name !== 'AbortError' && selectedProcessId === processId) {
      $('terminal-state').textContent = 'Output unavailable';
      appendChunk(view, `\n[stream error] ${error.message}\n`);
    }
  } finally {
    if (generation === streamGeneration) {
      streamingProcessId = null;
      if (streamAbort === controller) streamAbort = null;
    }
  }
}

function renderProcessOptions(processes) {
  const select = $('terminal-process-select');
  const options = [Object.assign(document.createElement('option'), { value: '', textContent: 'No process' })];
  for (const process of processes) {
    const prefix = process.running ? '●' : `×${process.exit_code ?? ''}`;
    options.push(Object.assign(document.createElement('option'), {
      value: process.id,
      textContent: `${prefix} ${process.command}`,
      title: `${process.id} · ${process.cwd}`,
    }));
  }
  select.replaceChildren(...options);
  select.value = selectedProcessId || '';
}

export function selectProcess(id) {
  streamGeneration += 1;
  streamAbort?.abort();
  streamAbort = null;
  streamingProcessId = null;
  shellOutputActive = false;
  selectedProcessId = id || null;
  selectedTaskId = selectedProcessId ? state.taskId : null;
  setNewLines(0);
  $('terminal-process-select').value = selectedProcessId || '';
  if (!selectedProcessId || !state.taskId) {
    $('terminal-output').textContent = 'No process selected.';
    $('terminal-state').textContent = 'Ready';
    $('terminal-stop').disabled = true;
    return;
  }
  const view = viewFor(selectedProcessId);
  $('terminal-output').textContent = view.text || 'Process has not produced output yet.';
  $('terminal-state').textContent = view.running === false ? `exit ${view.exitCode ?? '—'}` : 'Connecting…';
  $('terminal-stop').disabled = view.running === false;
  if (follow) $('terminal-output').scrollTop = $('terminal-output').scrollHeight;
  void streamProcess(selectedTaskId, selectedProcessId);
}

export async function loadProcesses(options = {}) {
  if (!state.taskId) { resetTerminal(); return; }
  const taskId = state.taskId;
  const result = await api(`/api/workbench/tasks/${encodeURIComponent(taskId)}/processes`);
  if (state.taskId !== taskId) return;
  const processes = result.processes || [];
  $('terminal-process-count').textContent = `${processes.length} job${processes.length === 1 ? '' : 's'}`;
  const ids = new Set(processes.map(process => process.id));
  const preferred = options.selectId && ids.has(options.selectId) ? options.selectId
    : selectedProcessId && ids.has(selectedProcessId) ? selectedProcessId
    : processes.length ? processes[processes.length - 1].id : null;
  if (selectedProcessId && !ids.has(selectedProcessId)) {
    views.delete(selectedProcessId);
    selectedProcessId = null;
    selectedTaskId = null;
  }
  renderProcessOptions(processes);
  if (shellOutputActive && !options.selectId && !selectedProcessId) return;
  if (preferred !== selectedProcessId) {
    selectProcess(preferred);
    return;
  }
  if (!selectedProcessId) {
    selectProcess(null);
    return;
  }
  const process = processes.find(item => item.id === selectedProcessId);
  if (!process) return;
  const view = viewFor(selectedProcessId);
  view.running = process.running;
  view.exitCode = process.exit_code ?? null;
  $('terminal-state').textContent = process.running ? '● running' : `exit ${process.exit_code ?? '—'}`;
  $('terminal-stop').disabled = !process.running;
  if (process.running && streamingProcessId !== selectedProcessId) {
    selectedTaskId = taskId;
    void streamProcess(taskId, selectedProcessId);
  }
}

async function runOnce(command) {
  const taskId = state.taskId;
  if (!taskId) return;
  setStatus('Running command…');
  const result = await api(`/api/workbench/tasks/${encodeURIComponent(taskId)}/shell`, { method: 'POST', body: { command } });
  if (state.taskId !== taskId) return;
  streamGeneration += 1;
  streamAbort?.abort();
  streamAbort = null;
  streamingProcessId = null;
  selectedProcessId = null;
  selectedTaskId = null;
  shellOutputActive = true;
  $('terminal-process-select').value = '';
  const text = [`› ${command}`, result.stdout || '', result.stderr ? `[stderr]\n${result.stderr}` : '', `exit ${result.exit_code}`].filter(Boolean).join('\n');
  $('terminal-output').textContent = text;
  $('terminal-state').textContent = `shell · exit ${result.exit_code}`;
  $('terminal-stop').disabled = true;
  $('terminal-output').scrollTop = $('terminal-output').scrollHeight;
  setNewLines(0);
  setStatus(`Command exit ${result.exit_code}`);
}

async function startBackground(command) {
  const taskId = state.taskId;
  if (!taskId) return;
  setStatus('Starting background process…');
  const started = await api(`/api/workbench/tasks/${encodeURIComponent(taskId)}/processes`, { method: 'POST', body: { command, yield_time_ms: 300 } });
  if (state.taskId !== taskId) return;
  await loadProcesses({ selectId: started.id });
  setStatus(`Started ${started.id}`);
}

export function resetTerminal() {
  streamGeneration += 1;
  streamAbort?.abort();
  streamAbort = null;
  streamingProcessId = null;
  selectedProcessId = null;
  selectedTaskId = null;
  shellOutputActive = false;
  views.clear();
  paused = false;
  follow = true;
  newLines = 0;
  if ($('terminal-new-lines')) setNewLines(0);
  if ($('terminal-follow')) $('terminal-follow').checked = true;
  if ($('terminal-pause')) { $('terminal-pause').textContent = 'Pause'; $('terminal-pause').classList.remove('active'); }
  if ($('terminal-process-select')) $('terminal-process-select').replaceChildren(Object.assign(document.createElement('option'), { value: '', textContent: 'No process' }));
  if ($('terminal-process-count')) $('terminal-process-count').textContent = '0 jobs';
  if ($('terminal-state')) $('terminal-state').textContent = 'Ready';
  if ($('terminal-stop')) $('terminal-stop').disabled = true;
  if ($('terminal-output')) $('terminal-output').textContent = 'No process selected.';
}

export function setupTerminal() {
  $('terminal-process-select').onchange = () => selectProcess($('terminal-process-select').value);
  $('terminal-follow').onchange = () => {
    follow = $('terminal-follow').checked;
    if (follow) renderCurrent(true);
  };
  $('terminal-output').onscroll = () => {
    if (follow && !nearBottom($('terminal-output'))) {
      follow = false;
      $('terminal-follow').checked = false;
    }
  };
  $('terminal-pause').onclick = () => {
    paused = !paused;
    $('terminal-pause').textContent = paused ? 'Resume' : 'Pause';
    $('terminal-pause').classList.toggle('active', paused);
    if (!paused && selectedProcessId) renderCurrent(false);
  };
  $('terminal-latest').onclick = () => {
    paused = false;
    follow = true;
    $('terminal-follow').checked = true;
    $('terminal-pause').textContent = 'Pause';
    $('terminal-pause').classList.remove('active');
    if (selectedProcessId) renderCurrent(true);
    else $('terminal-output').scrollTop = $('terminal-output').scrollHeight;
  };
  $('terminal-stop').onclick = () => void (async () => {
    if (!state.taskId || !selectedProcessId) return;
    await api(`/api/workbench/tasks/${encodeURIComponent(state.taskId)}/processes/${encodeURIComponent(selectedProcessId)}/stop`, { method: 'POST', body: { force: false } });
    await loadProcesses({ selectId: selectedProcessId });
  })().catch(error => setStatus(error.message));
  $('terminal-toggle').onclick = () => {
    const collapsed = $('terminal-panel').classList.toggle('collapsed');
    $('terminal-toggle').textContent = collapsed ? '⌃' : '⌄';
    $('terminal-toggle').title = collapsed ? 'Expand terminal' : 'Collapse terminal';
  };
  $('terminal-command-form').onsubmit = event => {
    event.preventDefault();
    const command = $('terminal-command').value.trim();
    if (command) void runOnce(command).catch(error => setStatus(error.message));
  };
  $('terminal-start').onclick = () => {
    const command = $('terminal-command').value.trim();
    if (command) void startBackground(command).catch(error => setStatus(error.message));
  };
}