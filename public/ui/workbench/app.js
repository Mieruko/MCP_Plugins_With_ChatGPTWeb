import { api, getAdminToken, setAdminToken } from './api.js';
import { state, currentTask, currentWorkspace, resetTaskView } from './state.js';
import { $, basename, el, setStatus } from './dom.js';
import { loadTree, goUpTree, searchWorkspace } from './explorer.js';
import { hasUnsavedEditorChanges, reconcileEditorState, reloadActiveEditor, resetEditor, saveActiveEditor } from './editor.js';
import { commitStaged, decideCurrentOperation, loadChanges, openPrimaryReview, setAgentFilter, setChangeFilter, showChangesTab, stageAllChanges, unstageAllChanges } from './changes.js';
import { loadAgents } from './agents.js';
import { createCheckpoint, loadHistory, restoreCurrentCheckpoint } from './history.js';
import { loadProcesses, resetTerminal, setupTerminal } from './terminal.js';

let eventsController;
let refreshTimer;
let liveTimer;
let editingMcpServerId = null;
const SYSTEM_ENV_KEYS = [
  'WORKSPACE_PATH',
  'EXTRA_WORKSPACE_PATHS',
  'PORT',
  'ADMIN_PORT',
  'WORKBENCH_DEFAULT_MODE',
  'CHATGPT_TOOL_PROFILE',
  'SHELL_TIMEOUT',
  'CHECKPOINT_ENABLED',
  'MCP_UPSTREAM_CONFIG',
  'POST_EDIT_HOOKS_CONFIG',
];
const pendingScopes = new Set();
const pendingEventTaskIds = new Set();

function modeLabel(mode) {
  return mode === 'full' ? 'Full' : mode === 'auto' ? 'Auto' : 'Ask';
}

function workspaceKey(value) {
  return String(value || '').replace(/\\/g, '/').toLowerCase();
}

function selectedPolicyMode() {
  return document.querySelector('input[name="policy-mode"]:checked')?.value || 'ask';
}

function setSelectedPolicyMode(mode) {
  const input = document.querySelector(`input[name="policy-mode"][value="${mode}"]`);
  if (input) input.checked = true;
}

function closeDialog(id) {
  const dialog = $(id);
  if (dialog?.open) dialog.close();
}

function buildContextTaskRow(task, current = false) {
  const row = el('button', undefined, `context-list-button${current ? ' current' : ''}`);
  row.type = 'button';
  const copy = el('span', undefined, 'context-list-copy');
  copy.append(
    el('strong', task.title),
    el('small', current ? 'Current task · used for new ChatGPT sessions' : 'Switch to this task'),
  );
  row.append(
    el('i', '', 'context-list-marker'),
    copy,
    el('span', modeLabel(task.policy.mode), 'context-list-meta'),
  );
  row.onclick = () => {
    closeDialog('context-dialog');
    void switchTask(task.id).catch(error => setStatus(error.message));
  };
  return row;
}

function renderContextPanels() {
  const task = currentTask();
  const tasks = state.data?.tasks || [];
  const workspaces = state.data?.workspaces || [];
  const workspace = currentWorkspace();
  const workspacePath = workspace?.path || task?.workspace || '';
  const workspaceName = workspace?.name || (workspacePath ? basename(workspacePath) : 'No workspace');

  $('context-workspace-name').textContent = workspaceName;
  $('context-workspace-path').textContent = workspacePath || 'Add a workspace to start';

  const sameWorkspace = workspace
    ? tasks.filter(item => item.workspaceId === workspace.id || workspaceKey(item.workspace) === workspaceKey(workspace.path))
    : [];
  const taskRows = sameWorkspace.map(item => buildContextTaskRow(item, item.id === state.taskId));
  $('context-task-list').replaceChildren(...taskRows);
  if (!taskRows.length) $('context-task-list').append(el('p', 'No tasks in this workspace.', 'empty-copy'));

  const workspaceRows = workspaces.map(item => {
    const current = item.id === state.workspaceId;
    const count = tasks.filter(taskItem => taskItem.workspaceId === item.id || workspaceKey(taskItem.workspace) === workspaceKey(item.path)).length;
    const row = el('button', undefined, `context-list-button${current ? ' current' : ''}`);
    row.type = 'button';
    const copy = el('span', undefined, 'context-list-copy');
    copy.append(el('strong', item.name || basename(item.path)), el('small', item.path));
    row.append(
      el('i', '', 'context-list-marker'),
      copy,
      el('span', `${count} task${count === 1 ? '' : 's'}`, 'context-list-meta'),
    );
    row.onclick = () => {
      closeDialog('context-dialog');
      void switchWorkspace(item.id).catch(error => setStatus(error.message));
    };
    return row;
  });
  $('context-workspace-list').replaceChildren(...workspaceRows);
  if (!workspaceRows.length) $('context-workspace-list').append(el('p', 'No workspaces yet.', 'empty-copy'));

  $('new-task-workspace-summary').hidden = !workspace;
  $('new-task-workspace-field').hidden = Boolean(workspace);
  $('new-task-workspace-name').textContent = workspaceName;
  $('new-task-workspace-path').textContent = workspacePath || '—';
  $('new-task-workspace').value = workspacePath;

  $('permission-workspace-name').textContent = workspaceName;
  $('permission-workspace-path').textContent = workspacePath || '—';
  $('policy-scope-help').textContent = workspacePath
    ? `ChatGPT can only access files inside ${workspacePath}.`
    : 'ChatGPT can only access files inside this workspace.';

  $('settings-workspace-name').textContent = workspaceName;
  $('settings-workspace-path').textContent = workspacePath || '—';
  $('settings-permission-summary').textContent = task
    ? `${modeLabel(task.policy.mode)} · ${task.policy.workspaceOnly ? 'Restricted to workspace' : 'Machine access allowed'}`
    : 'No task selected';
  $('workspace-settings-permissions').disabled = !task;
  $('new-task-button').disabled = !workspace;
}

function renderHeader() {
  const task = currentTask();
  const workspace = currentWorkspace();
  if (!workspace) {
    $('workspace-name').textContent = 'No workspace';
    $('task-name').textContent = 'Add a workspace';
    $('workspace-path').textContent = 'No workspace selected';
    $('explorer-root-name').textContent = 'Workspace';
    $('policy-button').textContent = 'Ask';
    $('policy-button').disabled = true;
    renderContextPanels();
    return;
  }
  const workspaceName = workspace.name || basename(workspace.path);
  $('workspace-name').textContent = workspaceName;
  $('task-name').textContent = task?.title || 'No task';
  $('workspace-path').textContent = workspace.path;
  $('explorer-root-name').textContent = workspaceName;
  $('status-path').textContent = workspace.path;
  $('policy-button').disabled = !task;
  $('policy-button').textContent = task ? modeLabel(task.policy.mode) : 'No task';
  if (task) {
    setSelectedPolicyMode(task.policy.mode);
    $('policy-scope').checked = task.policy.workspaceOnly;
  }
  $('branch-name').textContent = state.git?.branch || '—';
  const head = state.git?.head_oid ? state.git.head_oid.slice(0, 8) : '';
  $('branch-meta').textContent = task ? (state.git ? `↑${state.git.ahead || 0} ↓${state.git.behind || 0}${head ? ` · ${head}` : ''}` : 'Git unavailable') : 'Create a task';
  $('status-workspace').replaceChildren(el('i', '', 'dot'), document.createTextNode(`${workspaceName} ready`));
  renderContextPanels();
}

function mcpConfigServer(id) {
  return state.health?.upstreamConfig?.servers?.find(server => server.id === id) || null;
}

function renderMcpSettings(health) {
  if (!health) return;
  const upstream = health.upstream || [];
  const connected = upstream.filter(server => server.health === 'connected').length;
  const publicUrl = health.public_base_url || '';
  $('mcp-dialog-server').textContent = `:${health.mcp_port || '—'}`;
  $('mcp-dialog-sessions').textContent = `${health.active_sessions || 0} active session${health.active_sessions === 1 ? '' : 's'}`;
  $('mcp-dialog-public').textContent = publicUrl ? publicUrl.replace(/^https?:\/\//, '') : 'Local only';
  $('mcp-dialog-profile').textContent = `${health.tool_profile || 'slim'} tool profile`;
  $('mcp-dialog-workspace').textContent = health.default_cwd || currentTask()?.workspace || '—';
  const bytes = health.instructions?.instruction_bytes;
  $('mcp-dialog-instructions').textContent = bytes ? `${Math.round(bytes / 1024)} KB injected context` : 'No summary';
  $('mcp-upstream-count').textContent = `${connected}/${upstream.length} connected`;
  $('settings-mcp-summary').textContent = `${health.active_sessions || 0} session${health.active_sessions === 1 ? '' : 's'} · ${upstream.length} upstream`;
  $('mcp-state').textContent = 'Online';
  $('mcp-dot').classList.remove('muted-dot');
  const rows = upstream.map(server => {
    const row = el('div', undefined, 'mcp-upstream-row');
    const copy = el('div', undefined, 'mcp-upstream-copy');
    copy.append(el('strong', server.name || server.id), el('span', `${server.transport || 'unknown'} · ${server.tool_count || 0} tools`));
    const status = el('span', server.health || 'unknown', `mcp-health ${server.health || 'unknown'}`);
    const actions = el('div', undefined, 'mcp-row-actions');
    const test = el('button', 'Test', 'mini-action');
    test.type = 'button';
    test.onclick = () => void testMcpServer(server.id).catch(error => setStatus(error.message));
    const edit = el('button', 'Edit', 'mini-action');
    edit.type = 'button';
    edit.onclick = () => openMcpServerDialog(mcpConfigServer(server.id));
    const remove = el('button', 'Delete', 'mini-action danger-mini');
    remove.type = 'button';
    remove.onclick = () => void deleteMcpServer(server.id).catch(error => setStatus(error.message));
    actions.append(test, edit, remove);
    row.append(copy, status, actions);
    return row;
  });
  $('mcp-upstream-list').replaceChildren(...rows);
  if (!rows.length) $('mcp-upstream-list').append(el('p', 'No upstream servers configured.', 'empty-copy'));
}

async function loadMcpSettings() {
  const [health, upstream] = await Promise.all([api('/health'), api('/api/upstream')]);
  health.upstreamConfig = upstream.config || { version: 1, servers: [] };
  state.health = health;
  renderMcpSettings(health);
  return health;
}

function updateMcpTransportFields() {
  const http = $('mcp-server-transport').value === 'http';
  $('mcp-command-field').hidden = http;
  $('mcp-args-field').hidden = http;
  $('mcp-cwd-field').hidden = http;
  $('mcp-url-field').hidden = !http;
}

function openMcpServerDialog(server = null) {
  editingMcpServerId = server?.id || null;
  $('mcp-server-dialog-title').textContent = server ? 'Edit server' : 'Add server';
  $('mcp-server-id').value = server?.id || '';
  $('mcp-server-id').readOnly = Boolean(server);
  $('mcp-server-name').value = server?.name || '';
  $('mcp-server-enabled').checked = server?.enabled !== false;
  $('mcp-server-transport').value = server?.transport || 'stdio';
  $('mcp-server-command').value = server?.command || '';
  $('mcp-server-args').value = JSON.stringify(server?.args || []);
  $('mcp-server-cwd').value = server?.cwd || '';
  $('mcp-server-url').value = server?.url || '';
  $('mcp-server-prefix').value = server?.tool_prefix || server?.id || '';
  $('mcp-server-expose').value = server?.expose || 'meta_only';
  $('mcp-server-tools').value = (server?.tools || []).join(', ');
  $('mcp-server-timeout').value = server?.idle_timeout_sec || 600;
  $('mcp-server-error').hidden = true;
  updateMcpTransportFields();
  $('mcp-server-dialog').showModal();
}

async function saveMcpServer() {
  const id = $('mcp-server-id').value.trim();
  if (!id) throw new Error('Server ID is required');
  let args;
  try { args = $('mcp-server-args').value.trim() ? JSON.parse($('mcp-server-args').value) : []; }
  catch { throw new Error('Args must be a valid JSON array'); }
  if (!Array.isArray(args)) throw new Error('Args must be a JSON array');
  const transport = $('mcp-server-transport').value;
  const server = {
    id,
    name: $('mcp-server-name').value.trim() || id,
    enabled: $('mcp-server-enabled').checked,
    transport,
    command: transport === 'stdio' ? ($('mcp-server-command').value.trim() || undefined) : undefined,
    args: transport === 'stdio' ? args : [],
    cwd: transport === 'stdio' ? ($('mcp-server-cwd').value.trim() || undefined) : undefined,
    url: transport === 'http' ? ($('mcp-server-url').value.trim() || undefined) : undefined,
    tool_prefix: $('mcp-server-prefix').value.trim() || undefined,
    expose: $('mcp-server-expose').value,
    tools: $('mcp-server-tools').value.split(',').map(value => value.trim()).filter(Boolean),
    idle_timeout_sec: Number($('mcp-server-timeout').value) || 600,
  };
  await api('/api/upstream', { method: 'POST', body: { server } });
  $('mcp-server-dialog').close();
  await loadMcpSettings();
  setStatus(editingMcpServerId ? 'MCP server updated' : 'MCP server added');
}

async function testMcpServer(id) {
  setStatus(`Testing ${id}…`);
  const result = await api(`/api/upstream/${encodeURIComponent(id)}/test`, { method: 'POST', body: {} });
  await loadMcpSettings();
  setStatus(result.status?.health === 'connected' ? `${id} connected` : `${id} test completed`);
}

async function deleteMcpServer(id) {
  if (!confirm(`Delete MCP server "${id}"?`)) return;
  await api(`/api/upstream/${encodeURIComponent(id)}`, { method: 'DELETE' });
  await loadMcpSettings();
  setStatus(`${id} deleted`);
}

async function loadMcpImportSources() {
  const result = await api('/api/import/sources');
  const rows = (result.sources || []).map(source => {
    const row = el('div', undefined, 'mcp-import-row');
    const copy = el('div', undefined, 'mcp-upstream-copy');
    copy.append(el('strong', source.label || source.source), el('span', `${source.server_count || 0} server(s) · ${source.path}`));
    const action = el('button', 'Import', 'mini-action');
    action.type = 'button';
    action.onclick = () => void importMcpSource(source.source, source.path).catch(error => setStatus(error.message));
    row.append(copy, action);
    return row;
  });
  $('mcp-import-list').replaceChildren(...rows);
  if (!rows.length) $('mcp-import-list').append(el('p', 'No local MCP configs found.', 'empty-copy'));
}

async function importMcpSource(source, path) {
  const result = await api(`/api/import/${encodeURIComponent(source)}`, { method: 'POST', body: { path, merge: true } });
  $('mcp-import-result').textContent = `Imported: ${(result.imported || []).join(', ') || 'no new servers'}`;
  await Promise.all([loadMcpSettings(), loadMcpImportSources()]);
  setStatus('MCP import complete');
}

async function importMcpFile() {
  const path = $('mcp-import-path').value.trim();
  if (!path) throw new Error('Config path is required');
  const result = await api('/api/import/file', { method: 'POST', body: { path, detect_as: $('mcp-import-source').value, merge: true } });
  $('mcp-import-result').textContent = `Imported: ${(result.imported || []).join(', ') || 'no new servers'}`;
  await loadMcpSettings();
  setStatus('MCP file imported');
}

function renderSystemEnv(data) {
  const values = data.values || {};
  $('system-env-path').textContent = data.path || '.env';
  const fields = SYSTEM_ENV_KEYS.map(key => {
    const label = el('label', undefined, 'field-label');
    label.append(document.createTextNode(key));
    const input = el('input');
    input.type = 'text';
    input.dataset.envKey = key;
    input.value = values[key] ?? '';
    label.append(input);
    return label;
  });
  $('system-env-grid').replaceChildren(...fields);
}

function renderOAuthRequests(requests) {
  $('oauth-request-count').textContent = `${requests.length} pending`;
  const rows = requests.map(request => {
    const row = el('div', undefined, 'oauth-request-row');
    const copy = el('div', undefined, 'oauth-request-copy');
    copy.append(
      el('strong', request.clientName || 'Connector request'),
      el('span', request.redirectUri || request.id || 'Pending OAuth request'),
      el('code', request.id || ''),
    );
    const actions = el('div', undefined, 'oauth-request-actions');
    const deny = el('button', 'Deny', 'mini-action danger-mini');
    deny.type = 'button';
    deny.onclick = () => void decideOAuthRequest(request.id, false).catch(error => setStatus(error.message));
    const approve = el('button', 'Approve', 'mini-action');
    approve.type = 'button';
    approve.onclick = () => void decideOAuthRequest(request.id, true).catch(error => setStatus(error.message));
    actions.append(deny, approve);
    row.append(copy, actions);
    return row;
  });
  $('oauth-request-list').replaceChildren(...rows);
  if (!rows.length) $('oauth-request-list').append(el('p', 'No pending connector requests.', 'empty-copy'));
}

async function decideOAuthRequest(id, approve) {
  await api(`/api/workbench/connections/${encodeURIComponent(id)}`, { method: 'POST', body: { approve } });
  await loadOAuthRequests();
  setStatus(approve ? 'Connector approved' : 'Connector denied');
}

async function loadOAuthRequests() {
  const requests = await api('/api/workbench/connections');
  renderOAuthRequests(requests || []);
  return requests || [];
}

async function loadSystemSettings() {
  $('system-error').hidden = true;
  const [env, context, health, requests] = await Promise.all([
    api('/api/config/env'),
    api('/api/instructions/preview'),
    api('/health'),
    api('/api/workbench/connections'),
  ]);
  renderSystemEnv(env);
  renderOAuthRequests(requests || []);
  $('system-context-meta').textContent = `${Math.round((context.total_chars || 0) / 1024)} KB${context.truncated ? ' · preview truncated' : ''}`;
  $('system-context-preview').textContent = context.preview || 'No injected project context.';
  $('system-health-preview').textContent = JSON.stringify(health, null, 2);
  return { env, context, health, requests };
}

async function saveSystemEnv() {
  const values = {};
  $('system-env-grid').querySelectorAll('[data-env-key]').forEach(input => {
    values[input.dataset.envKey] = input.value;
  });
  await api('/api/config/env', { method: 'PUT', body: { values } });
  await loadSystemSettings();
  setStatus('Environment saved');
}

function openSystemSettings() {
  $('system-dialog').showModal();
  void loadSystemSettings().catch(error => {
    $('system-error').textContent = error.message;
    $('system-error').hidden = false;
    setStatus(error.message);
  });
}

async function loadWorkbenchState() {
  const data = await api('/api/workbench');
  state.data = data;
  const workspaces = data.workspaces || [];
  const tasks = data.tasks || [];
  if (!workspaces.some(workspace => workspace.id === state.workspaceId)) {
    state.workspaceId = workspaces.some(workspace => workspace.id === data.selectedWorkspaceId)
      ? data.selectedWorkspaceId
      : workspaces[0]?.id || null;
  }
  const taskInWorkspace = task => task.workspaceId === state.workspaceId;
  if (!tasks.some(task => task.id === state.taskId && taskInWorkspace(task))) {
    state.taskId = tasks.some(task => task.id === data.selectedTaskId && taskInWorkspace(task))
      ? data.selectedTaskId
      : tasks.find(taskInWorkspace)?.id || null;
  }
  reconcileEditorState();
  return data;
}

async function fullRefresh() {
  setStatus('Refreshing…');
  const data = await loadWorkbenchState();
  renderHeader();
  if (!state.taskId) {
    resetTerminal();
    await loadAgents();
    setStatus('Create a task to start');
    return;
  }
  await Promise.allSettled([loadAgents(), loadMcpSettings()]);
  await loadChanges();
  renderHeader();
  await Promise.allSettled([loadTree(state.currentTreePath), loadHistory(), loadProcesses()]);
  renderHeader();
  setStatus('Ready');
}

async function connect(token) {
  setAdminToken(token);
  await fullRefresh();
  state.connected = true;
  sessionStorage.setItem('local-coder-admin-token', getAdminToken());
  $('connect-overlay').hidden = true;
  startEvents();
  clearInterval(liveTimer);
  liveTimer = setInterval(() => {
    if (!state.connected) return;
    void Promise.allSettled([loadAgents(), loadProcesses()]).then(renderHeader);
  }, 15000);
}

async function refreshTypedScopes(scopes, eventTaskIds) {
  const currentTaskId = state.taskId;
  const affectsCurrentTask = !eventTaskIds?.size || eventTaskIds.has(currentTaskId);
  const needsState = scopes.has('state') || scopes.has('workspaces') || scopes.has('tasks') || scopes.has('operations');
  if (scopes.has('state')) {
    await fullRefresh();
    return;
  }
  if (needsState) await loadWorkbenchState();
  if (!state.taskId) {
    renderHeader();
    await loadAgents();
    return;
  }
  const jobs = [];
  if (scopes.has('workspaces') || scopes.has('tasks') || scopes.has('operations')) jobs.push(loadAgents());
  if (affectsCurrentTask && (scopes.has('operations') || scopes.has('workspace'))) jobs.push(loadChanges());
  if (affectsCurrentTask && (scopes.has('operations') || scopes.has('workspace'))) jobs.push(loadProcesses());
  if (affectsCurrentTask && (scopes.has('operations') || scopes.has('checkpoints'))) jobs.push(loadHistory());
  if (affectsCurrentTask && scopes.has('workspace')) jobs.push(loadTree(state.currentTreePath));
  await Promise.allSettled(jobs);
  renderHeader();
  setStatus('Ready');
}

function scheduleTypedRefresh(change = {}) {
  if (change.reason === 'initial' && state.data) return;
  const scopes = Array.isArray(change.scopes) && change.scopes.length ? change.scopes : ['state'];
  for (const scope of scopes) pendingScopes.add(scope);
  if (change.taskId) pendingEventTaskIds.add(change.taskId);
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => {
    const scopes = new Set(pendingScopes);
    const taskIds = new Set(pendingEventTaskIds);
    pendingScopes.clear();
    pendingEventTaskIds.clear();
    void refreshTypedScopes(scopes, taskIds).catch(error => setStatus(error.message));
  }, 120);
}

async function startEvents() {
  eventsController?.abort();
  eventsController = new AbortController();
  try {
    const response = await fetch('/api/workbench/events', {
      headers: { Authorization: `Bearer ${getAdminToken()}` },
      signal: eventsController.signal,
    });
    if (!response.ok) throw new Error('Live updates unavailable');
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let pending = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      pending += decoder.decode(value, { stream: true });
      let end;
      while ((end = pending.indexOf('\n\n')) !== -1) {
        const frame = pending.slice(0, end); pending = pending.slice(end + 2);
        if (!frame.split('\n').includes('event: change')) continue;
        const dataLine = frame.split('\n').find(line => line.startsWith('data:'));
        if (!dataLine) { scheduleTypedRefresh(); continue; }
        try { scheduleTypedRefresh(JSON.parse(dataLine.slice(5).trim())); }
        catch { scheduleTypedRefresh(); }
      }
    }
  } catch (error) {
    if (error.name !== 'AbortError') setStatus('Live updates disconnected');
  }
}

async function switchTask(taskId) {
  if (!taskId || taskId === state.taskId) return;
  if (hasUnsavedEditorChanges() && !confirm('Switch task and discard unsaved or pending editor buffers?')) {
    return;
  }
  await api(`/api/workbench/tasks/${taskId}/select`, { method: 'POST', body: {} });
  state.taskId = taskId;
  resetTaskView();
  resetEditor();
  resetTerminal();
  await fullRefresh();
  setStatus('Task selected for this workspace and new ChatGPT sessions');
}

async function switchWorkspace(workspaceId) {
  if (!workspaceId || workspaceId === state.workspaceId) return;
  if (hasUnsavedEditorChanges() && !confirm('Switch workspace and discard unsaved or pending editor buffers?')) return;
  await api(`/api/workbench/workspaces/${workspaceId}/select`, { method: 'POST', body: {} });
  state.workspaceId = workspaceId;
  state.taskId = null;
  resetTaskView();
  resetEditor();
  resetTerminal();
  await fullRefresh();
  setStatus(currentTask() ? 'Workspace and task selected for new ChatGPT sessions' : 'Workspace selected · create a task to start');
}

function folderBrowserRow(name, path) {
  const button = el('button', undefined, 'folder-browser-row');
  button.type = 'button';
  button.append(el('span', '▱', 'folder-browser-icon'), el('strong', name), el('code', path));
  button.onclick = () => void loadFolderBrowser(path).catch(error => showWorkspaceError(error));
  return button;
}

function showWorkspaceError(error) {
  const target = $('add-workspace-error');
  target.textContent = error?.message || String(error);
  target.hidden = false;
  setStatus(target.textContent);
}

async function loadFolderBrowser(requestedPath = '') {
  const query = requestedPath ? `?path=${encodeURIComponent(requestedPath)}` : '';
  const result = await api(`/api/workbench/folders${query}`);
  $('folder-browser').hidden = false;
  $('folder-browser-path').textContent = result.path || 'Computer';
  $('folder-browser-up').disabled = !result.path;
  $('folder-browser-up').dataset.parent = result.parent || '';
  $('use-current-folder').disabled = !result.path;
  const rows = result.path
    ? (result.directories || []).map(directory => folderBrowserRow(directory.name, directory.path))
    : (result.roots || []).map(root => folderBrowserRow(root, root));
  $('folder-browser-list').replaceChildren(...rows);
  if (!rows.length) $('folder-browser-list').append(el('p', 'No subfolders found.', 'empty-copy'));
  if (result.path) {
    $('add-workspace-path').value = result.path;
    if (!$('add-workspace-name').value.trim()) $('add-workspace-name').value = basename(result.path);
  }
}

function openAddWorkspaceDialog() {
  $('add-workspace-path').value = '';
  $('add-workspace-name').value = '';
  $('add-workspace-error').hidden = true;
  $('folder-browser').hidden = true;
  $('folder-browser-list').replaceChildren(el('p', 'Choose a drive or folder.', 'empty-copy'));
  $('add-workspace-dialog').showModal();
  queueMicrotask(() => $('add-workspace-path').focus());
}

function setupEvents() {
  setupTerminal();
  $('connect-form').onsubmit = event => {
    event.preventDefault();
    const token = $('token').value.trim();
    $('connection-error').hidden = true;
    void connect(token).catch(error => {
      $('connection-error').textContent = error.message;
      $('connection-error').hidden = false;
    });
  };
  $('context-button').onclick = () => { renderContextPanels(); $('context-dialog').showModal(); };
  $('settings-button').onclick = () => { renderContextPanels(); $('workspace-settings-dialog').showModal(); };
  $('mcp-button').onclick = () => void loadMcpSettings().then(() => $('mcp-dialog').showModal()).catch(error => setStatus(error.message));
  $('policy-button').onclick = () => { renderHeader(); $('permissions-dialog').showModal(); };
  $('context-open-settings').onclick = () => {
    closeDialog('context-dialog');
    renderContextPanels();
    $('workspace-settings-dialog').showModal();
  };
  $('context-open-system').onclick = () => {
    closeDialog('context-dialog');
    openSystemSettings();
  };
  $('workspace-settings-permissions').onclick = () => {
    closeDialog('workspace-settings-dialog');
    renderHeader();
    $('permissions-dialog').showModal();
  };
  $('workspace-settings-mcp').onclick = () => {
    closeDialog('workspace-settings-dialog');
    void loadMcpSettings().then(() => $('mcp-dialog').showModal()).catch(error => setStatus(error.message));
  };
  $('workspace-settings-system').onclick = () => {
    closeDialog('workspace-settings-dialog');
    openSystemSettings();
  };
  $('refresh-mcp-settings').onclick = () => void loadMcpSettings().catch(error => setStatus(error.message));
  $('mcp-open-system').onclick = () => {
    closeDialog('mcp-dialog');
    openSystemSettings();
  };
  $('mcp-add-server').onclick = () => openMcpServerDialog();
  $('mcp-open-import').onclick = () => {
    $('mcp-import-result').textContent = '';
    $('mcp-import-dialog').showModal();
    void loadMcpImportSources().catch(error => setStatus(error.message));
  };
  $('mcp-refresh-import').onclick = () => void loadMcpImportSources().catch(error => setStatus(error.message));
  $('mcp-import-file').onclick = () => void importMcpFile().catch(error => { $('mcp-import-result').textContent = error.message; setStatus(error.message); });
  $('mcp-server-transport').onchange = updateMcpTransportFields;
  $('mcp-save-server').onclick = () => void saveMcpServer().catch(error => {
    $('mcp-server-error').textContent = error.message;
    $('mcp-server-error').hidden = false;
  });
  $('save-system-env').onclick = () => void saveSystemEnv().catch(error => {
    $('system-error').textContent = error.message;
    $('system-error').hidden = false;
  });
  $('refresh-system').onclick = () => void loadSystemSettings().catch(error => {
    $('system-error').textContent = error.message;
    $('system-error').hidden = false;
  });
  $('add-workspace-button').onclick = () => {
    closeDialog('context-dialog');
    openAddWorkspaceDialog();
  };
  $('browse-workspace').onclick = () => void loadFolderBrowser($('add-workspace-path').value.trim()).catch(error => {
    if ($('add-workspace-path').value.trim()) showWorkspaceError(error);
    else void loadFolderBrowser('').catch(showWorkspaceError);
  });
  $('folder-browser-up').onclick = () => void loadFolderBrowser($('folder-browser-up').dataset.parent || '').catch(showWorkspaceError);
  $('use-current-folder').onclick = () => {
    if (!$('add-workspace-path').value.trim()) return;
    $('folder-browser').hidden = true;
    $('add-workspace-error').hidden = true;
    if (!$('add-workspace-name').value.trim()) $('add-workspace-name').value = basename($('add-workspace-path').value.trim());
    $('add-workspace-name').focus();
  };
  $('add-workspace-path').oninput = () => {
    $('add-workspace-error').hidden = true;
    if (!$('add-workspace-name').value.trim()) $('add-workspace-name').placeholder = basename($('add-workspace-path').value.trim() || 'workspace');
  };
  $('create-workspace').onclick = () => void (async () => {
    const workspacePath = $('add-workspace-path').value.trim();
    const name = $('add-workspace-name').value.trim();
    if (!workspacePath) throw new Error('Choose a workspace folder.');
    const workspace = await api('/api/workbench/workspaces', { method: 'POST', body: { name, path: workspacePath } });
    await api(`/api/workbench/workspaces/${workspace.id}/select`, { method: 'POST', body: {} });
    state.workspaceId = workspace.id;
    state.taskId = null;
    resetTaskView();
    resetEditor();
    resetTerminal();
    $('add-workspace-dialog').close();
    await fullRefresh();
    setStatus('Workspace added · create a task when you are ready');
  })().catch(showWorkspaceError);
  $('new-task-button').onclick = () => {
    renderContextPanels();
    $('new-task-title').value = '';
    closeDialog('context-dialog');
    $('new-task-dialog').showModal();
    queueMicrotask(() => $('new-task-title').focus());
  };
  document.querySelectorAll('[data-close-dialog]').forEach(button => {
    button.onclick = () => $(button.dataset.closeDialog).close();
  });
  $('tree-refresh').onclick = () => void loadTree(state.currentTreePath).catch(error => setStatus(error.message));
  $('tree-up').onclick = () => void goUpTree().catch(error => setStatus(error.message));
  $('reload-editor').onclick = () => void reloadActiveEditor().catch(error => setStatus(error.message));
  $('save-editor').onclick = () => void saveActiveEditor().catch(error => setStatus(error.message));
  $('refresh-changes').onclick = () => void loadChanges().then(renderHeader).catch(error => setStatus(error.message));
  $('search-toggle').onclick = () => {
    $('search-panel').hidden = !$('search-panel').hidden;
    if (!$('search-panel').hidden) $('search-query').focus();
  };
  let searchTimer;
  $('search-query').oninput = () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => void searchWorkspace($('search-query').value).catch(error => setStatus(error.message)), 220);
  };
  document.querySelectorAll('.filter-chip').forEach(button => button.onclick = () => setChangeFilter(button.dataset.filter));
  $('agent-change-filter').onchange = () => setAgentFilter($('agent-change-filter').value);
  document.querySelectorAll('.changes-tab').forEach(button => button.onclick = () => showChangesTab(button.dataset.tab));
  $('stage-all').onclick = () => void stageAllChanges().catch(error => setStatus(error.message));
  $('unstage-all').onclick = () => void unstageAllChanges().catch(error => setStatus(error.message));
  $('commit-message').oninput = () => {
    $('commit-button').disabled = !state.changes.some(change => change.staged) || !$('commit-message').value.trim();
  };
  $('commit-form').onsubmit = event => {
    event.preventDefault();
    void commitStaged($('commit-message').value).catch(error => setStatus(error.message));
  };
  $('create-checkpoint-inline').onclick = () => void createCheckpoint().catch(error => setStatus(error.message));
  $('restore-checkpoint').onclick = () => void restoreCurrentCheckpoint().catch(error => setStatus(error.message));
  $('review-button').onclick = () => void openPrimaryReview().catch(error => setStatus(error.message));
  $('approve-operation').onclick = () => void decideCurrentOperation(true).catch(error => { $('review-error').textContent = error.message; $('review-error').hidden = false; });
  $('deny-operation').onclick = () => void decideCurrentOperation(false).catch(error => { $('review-error').textContent = error.message; $('review-error').hidden = false; });
  $('save-policy').onclick = () => void (async () => {
    const task = currentTask(); if (!task) return;
    if (!$('policy-scope').checked && !confirm('Cho phép task truy cập ngoài workspace theo quyền của process chạy server?')) return;
    await api(`/api/workbench/tasks/${task.id}/policy`, { method: 'PUT', body: { mode: selectedPolicyMode(), workspaceOnly: $('policy-scope').checked } });
    $('permissions-dialog').close(); await fullRefresh();
  })().catch(error => setStatus(error.message));
  $('create-task').onclick = () => void (async () => {
    const title = $('new-task-title').value.trim();
    const workspace = currentWorkspace();
    const workspacePath = workspace?.path || $('new-task-workspace').value.trim();
    if (!title) throw new Error('Enter a task name.');
    if (!workspace && !workspacePath) throw new Error('Choose a workspace first.');
    const task = await api('/api/workbench/tasks', {
      method: 'POST',
      body: workspace ? { title, workspaceId: workspace.id } : { title, workspace: workspacePath },
    });
    await api(`/api/workbench/tasks/${task.id}/select`, { method: 'POST', body: {} });
    state.workspaceId = task.workspaceId || state.workspaceId;
    state.taskId = task.id;
    resetTaskView();
    resetEditor();
    resetTerminal();
    $('new-task-dialog').close();
    await fullRefresh();
    setStatus('New task created and selected for new ChatGPT sessions');
  })().catch(error => setStatus(error.message));
  window.addEventListener('workbench:git-updated', renderHeader);
  window.addEventListener('workbench:refresh-request', event => scheduleTypedRefresh(event.detail || { scopes: ['state'] }));
  window.addEventListener('workbench:switch-task', event => void switchTask(event.detail?.taskId).catch(error => setStatus(error.message)));
  window.addEventListener('workbench:show-agent-changes', event => {
    const { taskId, sessionId } = event.detail || {};
    if (!taskId || !sessionId) return;
    if (taskId !== state.taskId) {
      void switchTask(taskId).then(() => {
        state.agentFilter = sessionId;
        setAgentFilter(sessionId);
        showChangesTab('changes');
      }).catch(error => setStatus(error.message));
      return;
    }
    setAgentFilter(sessionId);
    showChangesTab('changes');
  });
}

async function bootstrap() {
  setupEvents();
  const saved = sessionStorage.getItem('local-coder-admin-token');
  if (!saved) return;
  $('token').value = saved;
  try {
    await connect(saved);
  } catch (error) {
    sessionStorage.removeItem('local-coder-admin-token');
    $('connection-error').textContent = error.message;
    $('connection-error').hidden = false;
  }
}

void bootstrap();