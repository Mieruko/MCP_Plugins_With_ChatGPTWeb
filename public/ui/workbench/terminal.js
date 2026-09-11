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
    view = { cursor: null, text: '', initialized: false, running: null, exitCode: null, hasMore: false, dropped: false, command: '', cwd: '' };
    views.set(id, view);
  }
  return view;
}

function setNewLines(count) {
  newLines = count;
  const badge = $('process-console-new-lines');
  badge.hidden = count <= 0;
  badge.textContent = `${count} new`;
}

function renderCurrent(forceLatest = false) {
  if (!selectedProcessId) return;
  const output = $('process-console-output');
  const view = viewFor(selectedProcessId);
  const keepTop = output.scrollTop;
  output.textContent = view.text || 'Process has not produced output yet.';
  if (forceLatest || follow) output.scrollTop = output.scrollHeight;
  else output.scrollTop = keepTop;
  setNewLines(0);
}

function appendChunk(view, chunk) {
  if (!chunk) return;
  const output = $('process-console-output');
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
    $('process-console-state').textContent = view.running ? '● running' : `exit ${view.exitCode ?? '—'}`;
    $('process-console-stop').disabled = !view.running;
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
      $('process-console-state').textContent = 'Output unavailable';
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
  const select = $('process-console-select');
  const options = [Object.assign(document.createElement('option'), { value: '', textContent: 'No running process' })];
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
  selectedProcessId = id || null;
  selectedTaskId = selectedProcessId ? state.taskId : null;
  setNewLines(0);
  $('process-console-select').value = selectedProcessId || '';
  if (!selectedProcessId || !state.taskId) {
    $('process-console-current').textContent = '—';
    $('process-console-output').textContent = 'No process selected.';
    $('process-console-state').textContent = 'Ready';
    $('process-console-stop').disabled = true;
    return;
  }
  const view = viewFor(selectedProcessId);
  $('process-console-current').textContent = view.command || selectedProcessId;
  $('process-console-current').title = view.cwd ? `${view.command} · ${view.cwd}` : view.command;
  $('process-console-output').textContent = view.text || 'Process has not produced output yet.';
  $('process-console-state').textContent = view.running === false ? `exit ${view.exitCode ?? '—'}` : 'Connecting…';
  $('process-console-stop').disabled = view.running === false;
  if (follow) $('process-console-output').scrollTop = $('process-console-output').scrollHeight;
  void streamProcess(selectedTaskId, selectedProcessId);
}

export async function loadProcesses(options = {}) {
  if (!state.taskId) { resetProcessConsole(); return; }
  const taskId = state.taskId;
  const result = await api(`/api/workbench/tasks/${encodeURIComponent(taskId)}/processes`);
  if (state.taskId !== taskId) return;
  const processes = (result.processes || []).filter(process => process.running);
  const panel = $('process-console');
  panel.hidden = processes.length === 0;
  $('process-console-count').textContent = `${processes.length} running`;
  for (const process of processes) {
    const view = viewFor(process.id);
    view.command = process.command || '';
    view.cwd = process.cwd || '';
    view.running = true;
    view.exitCode = null;
  }
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
  view.command = process.command || view.command;
  view.cwd = process.cwd || view.cwd;
  $('process-console-current').textContent = view.command || process.id;
  $('process-console-current').title = view.cwd ? `${view.command} · ${view.cwd}` : view.command;
  $('process-console-state').textContent = '● running';
  $('process-console-stop').disabled = false;
  if (process.running && streamingProcessId !== selectedProcessId) {
    selectedTaskId = taskId;
    void streamProcess(taskId, selectedProcessId);
  }
}

export function resetProcessConsole() {
  streamGeneration += 1;
  streamAbort?.abort();
  streamAbort = null;
  streamingProcessId = null;
  selectedProcessId = null;
  selectedTaskId = null;
  views.clear();
  paused = false;
  follow = true;
  newLines = 0;
  if ($('process-console')) { $('process-console').hidden = true; $('process-console').classList.remove('expanded'); }
  if ($('process-console-new-lines')) setNewLines(0);
  if ($('process-console-follow')) $('process-console-follow').checked = true;
  if ($('process-console-pause')) { $('process-console-pause').textContent = 'Pause'; $('process-console-pause').classList.remove('active'); }
  if ($('process-console-toggle')) { $('process-console-toggle').textContent = 'Logs'; $('process-console-toggle').setAttribute('aria-expanded', 'false'); }
  if ($('process-console-select')) $('process-console-select').replaceChildren(Object.assign(document.createElement('option'), { value: '', textContent: 'No running process' }));
  if ($('process-console-count')) $('process-console-count').textContent = '0 running';
  if ($('process-console-current')) $('process-console-current').textContent = '—';
  if ($('process-console-state')) $('process-console-state').textContent = 'Ready';
  if ($('process-console-stop')) $('process-console-stop').disabled = true;
  if ($('process-console-output')) $('process-console-output').textContent = 'No process selected.';
}

export function setupProcessConsole() {
  $('process-console-select').onchange = () => selectProcess($('process-console-select').value);
  $('process-console-follow').onchange = () => {
    follow = $('process-console-follow').checked;
    if (follow) renderCurrent(true);
  };
  $('process-console-output').onscroll = () => {
    if (follow && !nearBottom($('process-console-output'))) {
      follow = false;
      $('process-console-follow').checked = false;
    }
  };
  $('process-console-pause').onclick = () => {
    paused = !paused;
    $('process-console-pause').textContent = paused ? 'Resume' : 'Pause';
    $('process-console-pause').classList.toggle('active', paused);
    if (!paused && selectedProcessId) renderCurrent(false);
  };
  $('process-console-latest').onclick = () => {
    paused = false;
    follow = true;
    $('process-console-follow').checked = true;
    $('process-console-pause').textContent = 'Pause';
    $('process-console-pause').classList.remove('active');
    if (selectedProcessId) renderCurrent(true);
    else $('process-console-output').scrollTop = $('process-console-output').scrollHeight;
  };
  $('process-console-stop').onclick = () => void (async () => {
    if (!state.taskId || !selectedProcessId) return;
    $('process-console-stop').disabled = true;
    setStatus('Stopping process…');
    await api(`/api/workbench/tasks/${encodeURIComponent(state.taskId)}/processes/${encodeURIComponent(selectedProcessId)}/stop`, { method: 'POST', body: { force: false } });
    await loadProcesses();
    setStatus('Process stopped');
  })().catch(error => setStatus(error.message));
  $('process-console-toggle').onclick = () => {
    const panel = $('process-console');
    const expanded = panel.classList.toggle('expanded');
    $('process-console-toggle').textContent = expanded ? 'Hide logs' : 'Logs';
    $('process-console-toggle').setAttribute('aria-expanded', String(expanded));
    if (expanded && selectedProcessId) renderCurrent(true);
  };
}