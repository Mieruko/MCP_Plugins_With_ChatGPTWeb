import { api } from './api.js';
import { state, currentTask, currentWorkspace, isBasic, resetTaskView } from './state.js';
import { renderExperience, setupExperience } from './experience.js';
import { $, basename, el, setStatus } from './dom.js';
import { hasUnsavedEditorChanges, reconcileEditorState, reloadActiveEditor, resetEditor, saveActiveEditor } from './editor.js';
import { closeReviewCenter, commitStaged, createBranch, decideCurrentOperation, fetchBranches, loadChanges, loadConnections, openBranchDialog, openReviewCenter, reviewNextChange, runEnvironmentPrimaryAction, setAgentFilter, setChangeFilter, setReviewCenterFilter, showChangesTab, stageAllChanges, stageReviewedChanges, unstageAllChanges } from './changes.js';
import { loadAgents } from './agents.js';
import { loadIntegrationQueue, openIntegrationQueue, saveIntegrationDependencies } from './integration.js';
import { createCheckpoint, loadHistory, restoreCurrentCheckpoint } from './history.js';
import { loadProcesses, resetProcessConsole, setupProcessConsole } from './terminal.js';
import { setupChatSessions } from './chat-sessions.js';

let eventsSource;
let refreshTimer;
let liveTimer;
let fallbackRevision = 0;
let workbenchLoadGeneration = 0;
let editingMcpServerId = null;
let workspaceSourceMode = 'local';
let folderBrowserTarget = 'local';
let cloneFolderTouched = false;
let workspaceDialogMode = 'add';
let relocationWorkspaceId = null;
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
  if (isBasic()) return mode === 'full' ? 'Full access' : mode === 'auto' ? 'Approve for me' : 'Ask for approval';
  return mode === 'full' ? 'Full access' : mode === 'auto' ? 'Approve for me' : 'Ask for approval';
}

function taskLifecycleLabel(value) {
  if (value === 'ready_to_merge') return 'Ready to merge';
  if (value === 'blocked') return 'Blocked';
  if (value === 'merged') return 'Merged';
  if (value === 'completed') return 'Completed';
  if (value === 'archived') return 'Archived';
  return 'Open';
}

function taskAcceptsAgentWork(task) {
  return task?.lifecycle === 'open' || task?.lifecycle === 'blocked' || !task?.lifecycle;
}

function taskCanStaySelected(task) {
  return taskAcceptsAgentWork(task) || task?.lifecycle === 'ready_to_merge';
}

function workspaceKey(value) {
  return String(value || '').replace(/\\/g, '/').toLowerCase();
}

function workspaceAvailabilityLabel(workspace) {
  if (workspace?.availability === 'missing') return 'Missing';
  if (workspace?.availability === 'unavailable') return 'Unavailable';
  return 'Ready';
}

function workspaceIsReady(workspace = currentWorkspace()) {
  return Boolean(workspace) && (!workspace.availability || workspace.availability === 'ready');
}

function parentFolderPath(value) {
  const normalized = String(value || '').replace(/[\\/]+$/, '');
  const index = Math.max(normalized.lastIndexOf('\\'), normalized.lastIndexOf('/'));
  if (index < 0) return '';
  if (/^[A-Za-z]:$/.test(normalized.slice(0, index))) return `${normalized.slice(0, index)}\\`;
  return normalized.slice(0, index) || normalized;
}

function selectedPolicyMode() {
  return document.querySelector('input[name="policy-mode"]:checked')?.value || 'ask';
}

function selectedTaskEnvironment() {
  return document.querySelector('input[name="task-environment"]:checked')?.value || 'local';
}

function setSelectedPolicyMode(mode) {
  const input = document.querySelector(`input[name="policy-mode"][value="${mode}"]`);
  if (input) input.checked = true;
}

function updatePolicyScopeHelp() {
  const task = currentTask();
  const executionPath = task?.execution?.path || currentWorkspace()?.path || '';
  const restricted = Boolean($('policy-scope')?.checked);
  $('policy-scope-help').textContent = restricted
    ? (executionPath ? `Files and commands stay inside ${executionPath}.` : 'Files and commands stay inside this workspace.')
    : 'Machine scope allows authorized commands and paths outside this workspace using the server process permissions.';
}

function closeDialog(id) {
  const dialog = $(id);
  if (dialog?.open) dialog.close();
}

function buildContextTaskRow(task, current = false) {
  const row = el('button', undefined, `context-list-button${current ? ' current' : ''}`);
  row.type = 'button';
  const copy = el('span', undefined, 'context-list-copy');
  const lifecycle = taskLifecycleLabel(task.lifecycle);
  const detail = taskAcceptsAgentWork(task)
    ? `${lifecycle} · ${current ? 'Current task' : 'Switch to this task'}`
    : `${lifecycle} · integration state`;
  copy.append(
    el('strong', task.title),
    el('small', detail),
  );
  row.append(
    el('i', '', 'context-list-marker'),
    copy,
    el('span', modeLabel(task.policy.mode), 'context-list-meta'),
  );
  const selectable = taskAcceptsAgentWork(task);
  row.disabled = !selectable;
  row.onclick = selectable ? () => {
    closeDialog('context-dialog');
    void switchTask(task.id).catch(error => setStatus(error.message));
  } : null;
  return row;
}

function renderContextPanels() {
  const task = currentTask();
  const tasks = state.data?.tasks || [];
  const workspaces = state.data?.workspaces || [];
  const workspace = currentWorkspace();
  const workspacePath = workspace?.path || task?.workspace || '';
  const executionPath = task?.execution?.path || workspacePath;
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
    const missing = item.availability && item.availability !== 'ready';
    const row = el('button', undefined, `context-list-button${current ? ' current' : ''}${missing ? ' workspace-missing' : ''}`);
    row.type = 'button';
    const copy = el('span', undefined, 'context-list-copy');
    copy.append(el('strong', item.name || basename(item.path)), el('small', missing ? `${workspaceAvailabilityLabel(item)} · ${item.path}` : item.path));
    row.append(
      el('i', '', `context-list-marker${missing ? ' attention-dot' : ''}`),
      copy,
      el('span', missing ? workspaceAvailabilityLabel(item) : item.experience === 'basic' ? 'Basic' : `${count} task${count === 1 ? '' : 's'}`, 'context-list-meta'),
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
  $('permission-workspace-path').textContent = executionPath || '—';
  updatePolicyScopeHelp();

  $('settings-workspace-name').textContent = workspaceName;
  $('settings-workspace-path').textContent = workspacePath || '—';
  const availability = $('settings-workspace-availability');
  availability.textContent = workspaceAvailabilityLabel(workspace);
  availability.className = `workspace-availability ${workspace?.availability || 'ready'}`;
  $('workspace-settings-locate-copy').textContent = workspace?.availability === 'missing'
    ? 'Project folder was not found. Locate the existing folder to keep this workspace, tasks and history.'
    : workspace?.availability === 'unavailable'
      ? 'The project folder is currently unavailable. Choose another existing folder if the project moved.'
      : 'Change the folder this workspace points to. Files are not moved.';
  $('settings-permission-summary').textContent = task
    ? `${modeLabel(task.policy.mode)} · ${task.policy.workspaceOnly ? 'Restricted to workspace' : 'Machine access allowed'}`
    : 'No task selected';
  $('workspace-settings-experience').disabled = !workspaceIsReady(workspace);
  $('workspace-settings-permissions').disabled = !task || !workspaceIsReady(workspace);
  $('workspace-settings-locate').disabled = !workspace;
  $('workspace-settings-remove').disabled = !workspace;
  $('new-task-button').disabled = !workspaceIsReady(workspace);
}

function renderHeader() {
  renderExperience();
  const task = currentTask();
  const workspace = currentWorkspace();
  if (!workspace) {
    $('workspace-name').textContent = 'No workspace';
    $('task-name').textContent = 'Add a workspace';
    $('workspace-path').textContent = 'No workspace selected';
    $('policy-button').textContent = 'Ask';
    $('policy-button').disabled = true;
    renderTaskBrief();
    renderContextPanels();
    return;
  }
  const workspaceName = workspace.name || basename(workspace.path);
  $('workspace-name').textContent = workspaceName;
  $('task-name').textContent = task?.title || 'No task';
  $('workspace-path').textContent = workspace.path;
  $('status-path').textContent = workspace.path;
  const ready = workspaceIsReady(workspace);
  $('policy-button').disabled = !task || !ready;
  $('policy-button').textContent = task ? modeLabel(task.policy.mode) : 'No task';
  if (task) {
    setSelectedPolicyMode(task.policy.mode);
    $('policy-scope').checked = task.policy.workspaceOnly;
    updatePolicyScopeHelp();
  }
  const availability = workspaceAvailabilityLabel(workspace);
  $('status-workspace').replaceChildren(
    el('i', '', `dot${ready ? '' : ' attention-dot'}`),
    document.createTextNode(ready ? `${workspaceName} ready` : `${workspaceName} ${availability.toLowerCase()}`),
  );
  renderTaskBrief();
  renderContextPanels();
}

function renderTaskBrief() {
  const task = currentTask();
  const description = $('task-description');
  const handoffCard = $('task-handoff-card');
  const handoffButton = $('task-handoff-edit');
  if (!description || !handoffCard || !handoffButton) return;
  description.textContent = task?.description || 'Add a description so every agent starts with the same scope.';
  $('task-brief-edit').disabled = !task;
  handoffButton.disabled = !task;
  handoffButton.textContent = task?.handoff ? 'Update handoff' : 'Create handoff';
  handoffCard.hidden = !task?.handoff;
  if (!task?.handoff) return;
  $('task-handoff-summary').textContent = task.handoff.summary;
  $('task-handoff-time').textContent = new Date(task.handoff.updatedAt).toLocaleString();
  const items = (task.handoff.nextSteps || []).map(step => el('li', step));
  $('task-handoff-next').replaceChildren(...items);
  $('task-handoff-next').hidden = !items.length;
}

function mcpConfigServer(id) {
  return state.health?.upstreamConfig?.servers?.find(server => server.id === id) || null;
}

function renderMcpSettings(health) {
  if (!health) return;
  const upstream = health.upstream || [];
  const connected = upstream.filter(server => server.health === 'connected').length;
  const publicUrl = health.public_base_url || '';
  const chatgpt = health.chatgpt || { status: 'not_connected', connected: false, active_sessions: 0, pending_approvals: 0 };
  const connectionMode = health.connection_mode || 'local';
  const modeLabel = connectionMode === 'cloudflare'
    ? 'Cloudflare Quick Tunnel'
    : connectionMode === 'openai'
      ? 'OpenAI Secure Tunnel'
      : 'Local only';
  $('mcp-dialog-local-status').textContent = health.status === 'ok' ? 'Ready' : 'Unavailable';
  $('mcp-dialog-server').textContent = `127.0.0.1:${health.mcp_port || '—'}/mcp`;
  $('mcp-dialog-sessions').textContent = `${health.active_sessions || 0} active session${health.active_sessions === 1 ? '' : 's'}`;
  $('mcp-dialog-connection-mode').textContent = modeLabel;
  const publicUrlNode = $('mcp-dialog-public-url');
  const showPublicUrl = connectionMode === 'cloudflare' && Boolean(publicUrl);
  publicUrlNode.hidden = !showPublicUrl;
  publicUrlNode.textContent = showPublicUrl ? publicUrl : '—';
  const chatgptDot = $('mcp-dialog-chatgpt-dot');
  chatgptDot.classList.remove('muted-dot', 'attention-dot');
  $('mcp-review-connection').hidden = true;
  if (chatgpt.status === 'connected') {
    $('mcp-dialog-chatgpt-status').textContent = 'Connected';
    $('mcp-dialog-chatgpt-detail').textContent = `${chatgpt.active_sessions || 0} active ChatGPT session${chatgpt.active_sessions === 1 ? '' : 's'}`;
  } else if (chatgpt.status === 'approval_required') {
    $('mcp-dialog-chatgpt-status').textContent = 'Approval required';
    $('mcp-dialog-chatgpt-detail').textContent = `${chatgpt.pending_approvals || 1} connection request${chatgpt.pending_approvals === 1 ? '' : 's'} waiting for approval.`;
    chatgptDot.classList.add('attention-dot');
    $('mcp-review-connection').hidden = false;
  } else {
    $('mcp-dialog-chatgpt-status').textContent = 'Not connected';
    $('mcp-dialog-chatgpt-detail').textContent = connectionMode === 'local'
      ? 'Local MCP is ready, but no public ChatGPT connection is configured.'
      : 'Waiting for ChatGPT to connect.';
    chatgptDot.classList.add('muted-dot');
  }
  $('mcp-upstream-count').textContent = upstream.length ? `${connected}/${upstream.length} connected` : 'None configured';
  $('settings-mcp-summary').textContent = `${chatgpt.connected ? 'ChatGPT connected' : 'ChatGPT not connected'} · ${upstream.length} upstream`;
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
  const generation = ++workbenchLoadGeneration;
  const previousTaskId = state.taskId;
  const data = await api('/api/workbench');
  if (generation !== workbenchLoadGeneration) return state.data || data;
  state.data = data;
  state.liveRevision = Math.max(state.liveRevision || 0, Number(data.revision || 0));
  const workspaces = data.workspaces || [];
  const tasks = data.tasks || [];
  if (!workspaces.some(workspace => workspace.id === state.workspaceId)) {
    state.workspaceId = workspaces.some(workspace => workspace.id === data.selectedWorkspaceId)
      ? data.selectedWorkspaceId
      : workspaces[0]?.id || null;
  }
  const taskInWorkspace = task => task.workspaceId === state.workspaceId;
  if (isBasic()) state.taskId = currentWorkspace().basicTaskId || null;
  const selectableTaskInWorkspace = task => taskInWorkspace(task) && taskAcceptsAgentWork(task);
  if (!tasks.some(task => task.id === state.taskId && taskInWorkspace(task) && taskCanStaySelected(task))) {
    state.taskId = tasks.some(task => task.id === data.selectedTaskId && selectableTaskInWorkspace(task))
      ? data.selectedTaskId
      : tasks.find(selectableTaskInWorkspace)?.id || null;
  }
  if (previousTaskId && state.taskId !== previousTaskId && !hasUnsavedEditorChanges()) {
    resetTaskView();
    resetEditor();
    resetProcessConsole();
  }
  reconcileEditorState();
  return data;
}

async function fullRefresh() {
  setStatus('Refreshing…');
  const data = await loadWorkbenchState();
  renderHeader();
  const workspace = currentWorkspace();
  if (workspace && !workspaceIsReady(workspace)) {
    resetTaskView();
    resetEditor();
    resetProcessConsole();
    closeReviewCenter();
    await Promise.allSettled([loadConnections(), loadMcpSettings(), state.taskId ? loadProcesses() : Promise.resolve()]);
    renderHeader();
    setStatus(workspace.availability === 'missing'
      ? `Project folder missing · locate ${workspace.name || basename(workspace.path)} to continue`
      : `Project folder unavailable · check ${workspace.path}`);
    return data;
  }
  await Promise.all([loadConnections(), isBasic() ? Promise.resolve() : loadIntegrationQueue()]);
  if (!state.taskId) {
    resetProcessConsole();
    await loadAgents();
    setStatus(currentWorkspace() ? 'Create a task to start' : 'Add a project folder to start');
    return;
  }
  await Promise.allSettled([loadAgents(), loadMcpSettings()]);
  await loadChanges();
  renderHeader();
  await Promise.allSettled([loadHistory(), loadProcesses()]);
  renderHeader();
  setStatus('Ready');
}

async function connect() {
  await fullRefresh();
  state.connected = true;
  fallbackRevision = Number(state.liveRevision || 0);
  startEvents();
  clearInterval(liveTimer);
  liveTimer = setInterval(() => {
    if (!state.connected) return;
    const before = currentWorkspace()?.availability || 'ready';
    const beforeRevision = fallbackRevision;
    void loadWorkbenchState().then(data => {
      const serverRevision = Number(data?.revision || state.liveRevision || 0);
      const revisionChanged = serverRevision !== beforeRevision;
      fallbackRevision = Math.max(fallbackRevision, serverRevision);
      const after = currentWorkspace()?.availability || 'ready';
      if (before !== after) return fullRefresh();
      if (!workspaceIsReady()) {
        renderHeader();
        return Promise.allSettled([loadConnections(), state.taskId ? loadProcesses() : Promise.resolve()]);
      }
      const jobs = [loadAgents(), loadProcesses(), loadConnections()];
      if (revisionChanged) jobs.push(loadChanges(), loadHistory());
      return Promise.allSettled(jobs).then(renderHeader);
    }).catch(error => setStatus(error.message));
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
  if (currentWorkspace() && !workspaceIsReady()) {
    renderHeader();
    resetTaskView();
    resetEditor();
    resetProcessConsole();
    await Promise.allSettled([loadConnections(), state.taskId ? loadProcesses() : Promise.resolve()]);
    setStatus(currentWorkspace().availability === 'missing' ? 'Project folder missing · use Locate folder' : 'Project folder unavailable');
    return;
  }
  if (!state.taskId) {
    renderHeader();
    await Promise.all([loadAgents(), loadIntegrationQueue()]);
    return;
  }
  const workspaceTaskIds = new Set((state.data?.tasks || [])
    .filter(task => task.workspaceId === state.workspaceId)
    .map(task => task.id));
  const affectsCurrentWorkspace = !eventTaskIds?.size || [...eventTaskIds].some(taskId => workspaceTaskIds.has(taskId));
  const jobs = [];
  if (scopes.has('workspaces') || scopes.has('tasks') || scopes.has('operations')) jobs.push(loadAgents());
  if (affectsCurrentWorkspace && (scopes.has('workspaces') || scopes.has('tasks') || scopes.has('workspace'))) jobs.push(loadIntegrationQueue());
  if (affectsCurrentWorkspace && (scopes.has('operations') || scopes.has('workspace'))) jobs.push(loadChanges());
  if (affectsCurrentTask && (scopes.has('operations') || scopes.has('workspace'))) jobs.push(loadProcesses());
  if (affectsCurrentWorkspace && (scopes.has('operations') || scopes.has('checkpoints'))) jobs.push(loadHistory());
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

function startEvents() {
  eventsSource?.close();
  const after = Number(state.liveRevision || 0);
  eventsSource = new EventSource(`/api/workbench/events?afterRevision=${encodeURIComponent(after)}`, { withCredentials: true });
  eventsSource.addEventListener('change', event => {
    let change = {};
    try { change = JSON.parse(event.data || '{}'); } catch {}
    const revision = Number(change.revision || event.lastEventId || 0);
    const previous = Number(state.liveRevision || 0);
    if (change.reason === 'revision-gap' || (revision > previous + 1 && previous > 0)) {
      state.liveRevision = revision;
      void fullRefresh().catch(error => setStatus(error.message));
      return;
    }
    if (revision > previous) state.liveRevision = revision;
    scheduleTypedRefresh(change);
  });
  eventsSource.onopen = () => {
    if (state.connected) setStatus('Ready');
  };
  eventsSource.onerror = () => {
    setStatus('Live updates disconnected · reconnecting…');
  };
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
  resetProcessConsole();
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
  resetProcessConsole();
  await fullRefresh();
  setStatus(currentTask() ? 'Workspace and task selected for new ChatGPT sessions' : 'Workspace selected · create a task to start');
}

async function removeCurrentWorkspace() {
  const workspace = currentWorkspace();
  if (!workspace) return;
  if (hasUnsavedEditorChanges() && !confirm('Remove this workspace and discard unsaved or pending editor buffers? Project files already saved on disk will not be deleted.')) return;
  const taskCount = (state.data?.tasks || []).filter(task => task.workspaceId === workspace.id).length;
  const name = workspace.name || basename(workspace.path);
  const confirmed = confirm(
    `Remove "${name}" from Workbench?\n\n`
    + `This removes ${taskCount} task${taskCount === 1 ? '' : 's'} and saved Workbench history for this workspace.\n`
    + `Project files at ${workspace.path} will NOT be deleted.\n\n`
    + 'This Workbench metadata removal cannot be undone.'
  );
  if (!confirmed) return;
  const errorTarget = $('workspace-remove-error');
  errorTarget.hidden = true;
  const button = $('workspace-settings-remove');
  button.disabled = true;
  button.textContent = 'Removing…';
  try {
    const result = await api(`/api/workbench/workspaces/${encodeURIComponent(workspace.id)}`, { method: 'DELETE', body: {} });
    closeDialog('workspace-settings-dialog');
    state.workspaceId = result.selectedWorkspaceId || null;
    state.taskId = result.selectedTaskId || null;
    resetTaskView();
    resetEditor();
    resetProcessConsole();
    await fullRefresh();
    setStatus(`${name} removed from Workbench · project files kept on disk`);
  } catch (error) {
    errorTarget.textContent = error.message;
    errorTarget.hidden = false;
    setStatus(error.message);
  } finally {
    button.textContent = 'Remove';
    button.disabled = !currentWorkspace();
  }
}

function folderBrowserRow(name, path) {
  const button = el('button', undefined, 'folder-browser-row');
  button.type = 'button';
  button.append(el('span', '▱', 'folder-browser-icon'), el('strong', name), el('code', path));
  button.onclick = () => void loadFolderBrowser(path).catch(error => showWorkspaceError(error));
  return button;
}

function inferCloneFolderName(repository) {
  const trimmed = String(repository || '').trim().replace(/[\\/]+$/, '');
  const tail = trimmed.split(/[\\/:]/).filter(Boolean).pop() || '';
  return tail.replace(/\.git$/i, '');
}

function setWorkspaceSourceMode(mode) {
  workspaceSourceMode = mode === 'clone' ? 'clone' : 'local';
  const cloning = workspaceSourceMode === 'clone';
  $('workspace-local-panel').hidden = cloning;
  $('workspace-clone-panel').hidden = !cloning;
  $('workspace-source-local').classList.toggle('active', !cloning);
  $('workspace-source-clone').classList.toggle('active', cloning);
  $('workspace-source-local').setAttribute('aria-selected', String(!cloning));
  $('workspace-source-clone').setAttribute('aria-selected', String(cloning));
  $('create-workspace').textContent = cloning ? 'Clone & Open' : 'Add workspace';
  $('workspace-safety-copy').textContent = cloning
    ? 'Workbench clones with your existing Git credentials, then registers the new folder. Removing the workspace later will not delete the cloned project.'
    : 'This only registers the folder in Local Coder. Your project files are not moved or deleted.';
  $('folder-browser').hidden = true;
  $('add-workspace-error').hidden = true;
  queueMicrotask(() => (cloning ? $('clone-workspace-repository') : $('add-workspace-path')).focus());
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
    if (folderBrowserTarget === 'clone') {
      $('clone-workspace-parent').value = result.path;
    } else {
      $('add-workspace-path').value = result.path;
      if (workspaceDialogMode !== 'relocate' && !$('add-workspace-name').value.trim()) $('add-workspace-name').value = basename(result.path);
    }
  }
}

function openAddWorkspaceDialog() {
  workspaceDialogMode = 'add';
  relocationWorkspaceId = null;
  $('add-workspace-heading').textContent = 'Add workspace';
  $('add-workspace-subtitle').textContent = 'Open a local project folder or clone a Git repository.';
  $('workspace-source-tabs').hidden = false;
  $('workspace-name-field').hidden = false;
  $('add-workspace-path').value = '';
  $('clone-workspace-repository').value = '';
  $('clone-workspace-parent').value = '';
  $('clone-workspace-folder').value = '';
  $('clone-workspace-branch').value = '';
  $('add-workspace-name').value = '';
  cloneFolderTouched = false;
  folderBrowserTarget = 'local';
  $('add-workspace-error').hidden = true;
  $('folder-browser').hidden = true;
  $('folder-browser-list').replaceChildren(el('p', 'Choose a drive or folder.', 'empty-copy'));
  setWorkspaceSourceMode('local');
  $('add-workspace-dialog').showModal();
  queueMicrotask(() => $('add-workspace-path').focus());
}

function openRelocateWorkspaceDialog(workspace) {
  if (!workspace) return;
  workspaceDialogMode = 'relocate';
  relocationWorkspaceId = workspace.id;
  workspaceSourceMode = 'local';
  folderBrowserTarget = 'local';
  cloneFolderTouched = false;
  $('add-workspace-heading').textContent = workspace.availability === 'missing' ? 'Locate project folder' : 'Change project folder';
  $('add-workspace-subtitle').textContent = `Point "${workspace.name || basename(workspace.path)}" to its existing project folder.`;
  $('workspace-source-tabs').hidden = true;
  $('workspace-name-field').hidden = true;
  $('workspace-local-panel').hidden = false;
  $('workspace-clone-panel').hidden = true;
  $('add-workspace-path').value = workspace.path || '';
  $('add-workspace-error').hidden = true;
  $('folder-browser').hidden = true;
  $('folder-browser-list').replaceChildren(el('p', 'Choose the existing project folder.', 'empty-copy'));
  $('workspace-safety-copy').textContent = 'Only the Workbench pointer changes. Tasks and history stay with this workspace; project files are never moved or deleted.';
  $('create-workspace').textContent = 'Use folder';
  $('add-workspace-dialog').showModal();
  const parent = parentFolderPath(workspace.path);
  if (parent) void loadFolderBrowser(parent).catch(() => {});
  queueMicrotask(() => $('add-workspace-path').focus());
}

function setupEvents() {
  setupExperience(fullRefresh);
  setupProcessConsole();
  $('context-button').onclick = () => { renderContextPanels(); $('context-dialog').showModal(); };
  $('settings-button').onclick = () => { renderContextPanels(); $('workspace-remove-error').hidden = true; $('workspace-settings-dialog').showModal(); };
  $('mcp-button').onclick = () => void loadMcpSettings().then(() => $('mcp-dialog').showModal()).catch(error => setStatus(error.message));
  $('chatgpt-button').onclick = () => void loadMcpSettings().then(() => $('mcp-dialog').showModal()).catch(error => setStatus(error.message));
  $('integration-button').onclick = () => void openIntegrationQueue().catch(error => setStatus(error.message));
  $('integration-refresh').onclick = () => void loadIntegrationQueue().catch(error => setStatus(error.message));
  $('integration-dependency-save').onclick = () => void saveIntegrationDependencies().catch(error => setStatus(error.message));
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
  $('workspace-settings-locate').onclick = () => {
    const workspace = currentWorkspace();
    if (!workspace) return;
    closeDialog('workspace-settings-dialog');
    openRelocateWorkspaceDialog(workspace);
  };
  $('workspace-settings-remove').onclick = () => void removeCurrentWorkspace();
  $('refresh-mcp-settings').onclick = () => void loadMcpSettings().catch(error => setStatus(error.message));
  $('mcp-review-connection').onclick = () => {
    closeDialog('mcp-dialog');
    openSystemSettings();
  };
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
  $('workspace-source-local').onclick = () => setWorkspaceSourceMode('local');
  $('workspace-source-clone').onclick = () => setWorkspaceSourceMode('clone');
  $('browse-workspace').onclick = () => {
    folderBrowserTarget = 'local';
    const requested = $('add-workspace-path').value.trim();
    void loadFolderBrowser(requested).catch(error => {
      if (workspaceDialogMode === 'relocate' && requested) {
        const parent = parentFolderPath(requested);
        if (parent && parent !== requested) {
          void loadFolderBrowser(parent).catch(showWorkspaceError);
          return;
        }
      }
      if (requested) showWorkspaceError(error);
      else void loadFolderBrowser('').catch(showWorkspaceError);
    });
  };
  $('browse-clone-parent').onclick = () => {
    folderBrowserTarget = 'clone';
    void loadFolderBrowser($('clone-workspace-parent').value.trim()).catch(error => {
      if ($('clone-workspace-parent').value.trim()) showWorkspaceError(error);
      else void loadFolderBrowser('').catch(showWorkspaceError);
    });
  };
  $('folder-browser-up').onclick = () => void loadFolderBrowser($('folder-browser-up').dataset.parent || '').catch(showWorkspaceError);
  $('use-current-folder').onclick = () => {
    const selectedPath = folderBrowserTarget === 'clone' ? $('clone-workspace-parent').value.trim() : $('add-workspace-path').value.trim();
    if (!selectedPath) return;
    $('folder-browser').hidden = true;
    $('add-workspace-error').hidden = true;
    if (folderBrowserTarget === 'clone') $('clone-workspace-folder').focus();
    else if (workspaceDialogMode === 'relocate') $('create-workspace').focus();
    else {
      if (!$('add-workspace-name').value.trim()) $('add-workspace-name').value = basename(selectedPath);
      $('add-workspace-name').focus();
    }
  };
  $('add-workspace-path').oninput = () => {
    $('add-workspace-error').hidden = true;
    if (!$('add-workspace-name').value.trim()) $('add-workspace-name').placeholder = basename($('add-workspace-path').value.trim() || 'workspace');
  };
  $('clone-workspace-repository').oninput = () => {
    $('add-workspace-error').hidden = true;
    const inferred = inferCloneFolderName($('clone-workspace-repository').value);
    if (!cloneFolderTouched) $('clone-workspace-folder').value = inferred;
    if (!$('add-workspace-name').value.trim()) $('add-workspace-name').placeholder = inferred || 'workspace';
  };
  $('clone-workspace-folder').oninput = () => { cloneFolderTouched = true; $('add-workspace-error').hidden = true; };
  $('clone-workspace-parent').oninput = () => { $('add-workspace-error').hidden = true; };
  $('create-workspace').onclick = () => void (async () => {
    const submit = $('create-workspace');
    if (submit.disabled) return;
    const name = $('add-workspace-name').value.trim();
    const relocating = workspaceDialogMode === 'relocate';
    const cloning = !relocating && workspaceSourceMode === 'clone';
    const workspacePath = $('add-workspace-path').value.trim();
    const repository = $('clone-workspace-repository').value.trim();
    const destinationParent = $('clone-workspace-parent').value.trim();
    const folderName = $('clone-workspace-folder').value.trim();
    const branch = $('clone-workspace-branch').value.trim();
    if (cloning && !repository) throw new Error('Enter a Git repository URL or path.');
    if (cloning && !destinationParent) throw new Error('Choose where the repository should be cloned.');
    if (!cloning && !workspacePath) throw new Error('Choose a workspace folder.');
    if (relocating && !relocationWorkspaceId) throw new Error('Workspace to relocate is no longer available.');
    $('add-workspace-error').hidden = true;
    submit.disabled = true;
    submit.textContent = relocating ? 'Locating…' : cloning ? 'Cloning…' : 'Adding…';
    let workspace;
    try {
      if (relocating) {
        const result = await api(`/api/workbench/workspaces/${encodeURIComponent(relocationWorkspaceId)}/path`, {
          method: 'PUT',
          body: { path: workspacePath },
        });
        workspace = result.workspace;
        state.workspaceId = workspace.id;
      } else if (cloning) {
        const result = await api('/api/workbench/workspaces/clone', {
          method: 'POST',
          body: { repository, destinationParent, ...(folderName ? { folderName } : {}), ...(branch ? { branch } : {}), name },
        });
        workspace = result.workspace;
        state.workspaceId = result.selectedWorkspaceId || workspace.id;
        state.taskId = result.selectedTaskId || null;
      } else {
        workspace = await api('/api/workbench/workspaces', { method: 'POST', body: { name, path: workspacePath } });
        await api(`/api/workbench/workspaces/${workspace.id}/select`, { method: 'POST', body: {} });
        state.workspaceId = workspace.id;
        state.taskId = null;
      }
      resetTaskView();
      resetEditor();
      resetProcessConsole();
      $('add-workspace-dialog').close();
    } finally {
      submit.disabled = false;
      submit.textContent = relocating ? 'Use folder' : workspaceSourceMode === 'clone' ? 'Clone & Open' : 'Add workspace';
    }
    try {
      await fullRefresh();
      setStatus(relocating
        ? `Workspace relocated · ${workspace.path}`
        : cloning
        ? (isBasic() ? 'Repository cloned · project ready for ChatGPT' : 'Repository cloned and opened · create a task when you are ready')
        : (isBasic() ? 'Project ready · connect ChatGPT to start' : 'Workspace added · create a task when you are ready'));
    } catch (error) {
      setStatus(`${relocating ? 'Workspace relocated' : cloning ? 'Repository cloned' : 'Workspace added'} · refresh failed: ${error.message}`);
      scheduleTypedRefresh({ scopes: ['state'] });
    }
  })().catch(showWorkspaceError);
  $('new-task-button').onclick = () => {
    renderContextPanels();
    $('new-task-title').value = '';
    $('new-task-description').value = '';
    $('new-task-error').hidden = true;
    const local = document.querySelector('input[name="task-environment"][value="local"]');
    const worktree = document.querySelector('input[name="task-environment"][value="worktree"]');
    const preferParallel = Boolean(state.taskId && !state.gitError && state.git);
    if (local) local.checked = !preferParallel;
    if (worktree) worktree.checked = preferParallel;
    $('new-task-starting-ref-field').hidden = !preferParallel;
    $('new-task-assign-agent').checked = preferParallel;
    $('new-task-starting-ref').value = state.git?.branch || 'main';
    closeDialog('context-dialog');
    $('new-task-dialog').showModal();
    queueMicrotask(() => $('new-task-title').focus());
  };
  $('task-brief-edit').onclick = () => {
    const task = currentTask(); if (!task) return;
    $('task-description-input').value = task.description || '';
    $('task-description-error').hidden = true;
    $('task-description-dialog').showModal();
  };
  $('task-handoff-edit').onclick = () => {
    const task = currentTask(); if (!task) return;
    $('task-handoff-summary-input').value = task.handoff?.summary || '';
    $('task-handoff-next-input').value = (task.handoff?.nextSteps || []).join('\n');
    $('task-handoff-notes-input').value = task.handoff?.notes || '';
    $('task-handoff-error').hidden = true;
    $('task-handoff-dialog').showModal();
  };
  document.querySelectorAll('[data-close-dialog]').forEach(button => {
    button.onclick = () => $(button.dataset.closeDialog).close();
  });
  $('reload-editor').onclick = () => void reloadActiveEditor().catch(error => setStatus(error.message));
  $('save-editor').onclick = () => void saveActiveEditor().catch(error => setStatus(error.message));
  $('refresh-changes').onclick = () => void loadChanges().then(renderHeader).catch(error => setStatus(error.message));
  $('environment-refresh').onclick = () => void loadChanges().then(renderHeader).catch(error => setStatus(error.message));
  $('environment-changes').onclick = () => openReviewCenter();
  $('environment-branch').onclick = () => void openBranchDialog().catch(error => setStatus(error.message));
  $('environment-primary-action').onclick = () => void runEnvironmentPrimaryAction().catch(error => setStatus(error.message));
  $('branch-fetch').onclick = () => void fetchBranches().catch(error => {
    $('branch-dialog-error').textContent = error.message;
    $('branch-dialog-error').hidden = false;
    setStatus(error.message);
  });
  $('branch-create').onclick = () => void createBranch().catch(error => {
    $('branch-dialog-error').textContent = error.message;
    $('branch-dialog-error').hidden = false;
    setStatus(error.message);
  });
  document.querySelectorAll('input[name="task-environment"]').forEach(input => {
    input.onchange = () => {
      const parallel = selectedTaskEnvironment() === 'worktree';
      $('new-task-starting-ref-field').hidden = !parallel;
      $('new-task-assign-agent').checked = parallel;
      if (!$('new-task-starting-ref').value.trim()) $('new-task-starting-ref').value = state.git?.branch || 'main';
    };
  });
  document.querySelectorAll('input[name="policy-mode"]').forEach(input => {
    input.onchange = () => {
      $('policy-scope').checked = selectedPolicyMode() !== 'full';
      updatePolicyScopeHelp();
    };
  });
  $('policy-scope').onchange = updatePolicyScopeHelp;
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
  $('review-button').onclick = () => openReviewCenter();
  $('review-center-close').onclick = () => closeReviewCenter();
  document.querySelectorAll('.review-center-filter').forEach(button => button.onclick = () => setReviewCenterFilter(button.dataset.reviewFilter));
  $('review-center-next').onclick = () => void reviewNextChange().catch(error => setStatus(error.message));
  $('review-center-stage-reviewed').onclick = () => void stageReviewedChanges().catch(error => setStatus(error.message));
  $('approve-operation').onclick = () => void decideCurrentOperation(true).catch(error => { $('review-error').textContent = error.message; $('review-error').hidden = false; });
  $('deny-operation').onclick = () => void decideCurrentOperation(false).catch(error => { $('review-error').textContent = error.message; $('review-error').hidden = false; });
  $('save-policy').onclick = () => void (async () => {
    const task = currentTask(); if (!task) return;
    if (!$('policy-scope').checked && !confirm('Cho phép task truy cập ngoài workspace theo quyền của process chạy server?')) return;
    await api(`/api/workbench/tasks/${task.id}/policy`, { method: 'PUT', body: { mode: selectedPolicyMode(), workspaceOnly: $('policy-scope').checked } });
    $('permissions-dialog').close(); await fullRefresh();
  })().catch(error => setStatus(error.message));
  $('save-task-description').onclick = () => void (async () => {
    const task = currentTask(); if (!task) return;
    await api(`/api/workbench/tasks/${task.id}/description`, { method: 'PUT', body: { description: $('task-description-input').value } });
    $('task-description-dialog').close();
    await fullRefresh();
    setStatus('Task description updated');
  })().catch(error => { $('task-description-error').textContent = error.message; $('task-description-error').hidden = false; });
  $('save-task-handoff').onclick = () => void (async () => {
    const task = currentTask(); if (!task) return;
    const summary = $('task-handoff-summary-input').value.trim();
    if (!summary) throw new Error('Describe the current state before saving the handoff.');
    const nextSteps = $('task-handoff-next-input').value.split(/\r?\n/).map(item => item.trim()).filter(Boolean);
    await api(`/api/workbench/tasks/${task.id}/handoff`, { method: 'PUT', body: { summary, nextSteps, notes: $('task-handoff-notes-input').value } });
    $('task-handoff-dialog').close();
    await fullRefresh();
    setStatus('Handoff saved for the next agent');
  })().catch(error => { $('task-handoff-error').textContent = error.message; $('task-handoff-error').hidden = false; });
  $('create-task').onclick = () => void (async () => {
    const submit = $('create-task');
    if (submit.disabled) return;
    const title = $('new-task-title').value.trim();
    const description = $('new-task-description').value.trim();
    const workspace = currentWorkspace();
    const workspacePath = workspace?.path || $('new-task-workspace').value.trim();
    const environmentMode = selectedTaskEnvironment();
    const startingRef = $('new-task-starting-ref').value.trim() || state.git?.branch || 'HEAD';
    const assignNextChatgpt = $('new-task-assign-agent').checked;
    if (!title) throw new Error('Enter a task name.');
    if (!workspace && !workspacePath) throw new Error('Choose a workspace first.');
    $('new-task-error').hidden = true;
    submit.disabled = true;
    submit.textContent = 'Creating…';
    let task;
    try {
      task = await api('/api/workbench/tasks', {
        method: 'POST',
        body: {
          ...(workspace ? { title, workspaceId: workspace.id } : { title, workspace: workspacePath }),
          environment: environmentMode === 'worktree' ? { mode: 'worktree', startingRef } : { mode: 'local' },
          kind: environmentMode === 'worktree' ? 'parallel' : 'standard',
          assignNextChatgpt,
          description,
        },
      });
      await api(`/api/workbench/tasks/${task.id}/select`, { method: 'POST', body: {} });
      state.workspaceId = task.workspaceId || state.workspaceId;
      state.taskId = task.id;
      resetTaskView();
      resetEditor();
      resetProcessConsole();
      $('new-task-dialog').close();
    } finally {
      submit.disabled = false;
      submit.textContent = 'Create task';
    }
    try {
      await fullRefresh();
      setStatus(assignNextChatgpt ? 'Task created · waiting for the next ChatGPT session' : 'New task created and selected');
    } catch (error) {
      setStatus(`Task created · refresh failed: ${error.message}`);
      scheduleTypedRefresh({ scopes: ['state'] });
    }
  })().catch(error => {
    $('new-task-error').textContent = error?.message || String(error);
    $('new-task-error').hidden = false;
    setStatus($('new-task-error').textContent);
  });
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
  setupChatSessions();
  try {
    const fragment = new URLSearchParams(location.hash.replace(/^#/, ''));
    const bootstrapToken = fragment.get('bootstrap');
    if (bootstrapToken) {
      history.replaceState(null, '', `${location.pathname}${location.search}`);
      const response = await fetch('/api/workbench/session', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ bootstrapToken }),
      });
      if (!response.ok) throw new Error('Local Workbench authentication failed. Restart with npm start.');
    }
    await connect();
  } catch (error) {
    state.connected = false;
    setStatus(error?.message || 'Workbench authentication unavailable. Restart with npm start.');
  }
}

window.addEventListener('beforeunload', () => {
  if (eventsSource) {
    eventsSource.close();
    eventsSource = null;
  }
  if (liveTimer) {
    clearInterval(liveTimer);
    liveTimer = null;
  }
  if (refreshTimer) {
    clearTimeout(refreshTimer);
    refreshTimer = null;
  }
});

void bootstrap();
