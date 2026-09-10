export const state = {
  data: null,
  health: null,
  workspaceId: null,
  taskId: null,
  git: null,
  gitError: null,
  changes: [],
  changeByPath: new Map(),
  changeFilter: 'all',
  agentFilter: 'all',
  checkpoints: [],
  currentTreePath: '.',
  tabs: [],
  activeTabId: null,
  currentOperationId: null,
  currentCheckpointId: null,
  currentAgentSessionId: null,
  connected: false,
};

export function currentWorkspace() {
  return state.data?.workspaces?.find(workspace => workspace.id === state.workspaceId) || null;
}

export function currentTask() {
  return state.data?.tasks?.find(task => task.id === state.taskId) || null;
}

export function resetTaskView() {
  state.git = null;
  state.gitError = null;
  state.changes = [];
  state.changeByPath = new Map();
  state.agentFilter = 'all';
  state.checkpoints = [];
  state.currentTreePath = '.';
  state.tabs = [];
  state.activeTabId = null;
  state.currentOperationId = null;
  state.currentCheckpointId = null;
  state.currentAgentSessionId = null;
}