export const state = {
  data: null,
  health: null,
  agentCoordinator: null,
  integrationQueue: null,
  workspaceId: null,
  taskId: null,
  git: null,
  gitOverview: null,
  gitError: null,
  changes: [],
  changeByPath: new Map(),
  workspaceReview: null,
  workspaceReviewId: null,
  workspaceReviewExpanded: false,
  reviewCenterFilter: 'all',
  reviewedChanges: new Set(),
  connections: [],
  changeFilter: 'all',
  agentFilter: 'all',
  checkpoints: [],
  currentTreePath: '.',
  tabs: [],
  activeTabId: null,
  currentOperationId: null,
  currentOperationTaskId: null,
  currentCheckpointId: null,
  currentAgentSessionId: null,
  currentAgentId: null,
  connected: false,
};

export function currentWorkspace() {
  return state.data?.workspaces?.find(workspace => workspace.id === state.workspaceId) || null;
}

export function isBasic() {
  return currentWorkspace()?.experience === 'basic';
}

export function currentExperience() {
  return state.data?.experiences?.[state.workspaceId] || null;
}

export function currentTask() {
  return state.data?.tasks?.find(task => task.id === state.taskId) || null;
}

export function currentWorkspaceTasks() {
  const workspace = currentWorkspace();
  if (!workspace) return [];
  const workspacePath = String(workspace.path || '').replace(/\\/g, '/').replace(/\/$/, '').toLowerCase();
  return (state.data?.tasks || []).filter(task => {
    if (task.workspaceId === workspace.id) return true;
    if (task.workspaceId || !workspacePath) return false;
    const taskPath = String(task.workspace || '').replace(/\\/g, '/').replace(/\/$/, '').toLowerCase();
    return taskPath === workspacePath;
  });
}

export function currentWorkspaceOperations() {
  const taskIds = new Set(currentWorkspaceTasks().map(task => task.id));
  return (state.data?.operations || []).filter(operation => taskIds.has(operation.taskId)
    && (!isBasic() || operation.taskId === currentWorkspace()?.basicTaskId));
}

export function resetTaskView() {
  state.git = null;
  state.gitOverview = null;
  state.gitError = null;
  state.changes = [];
  state.changeByPath = new Map();
  state.workspaceReview = null;
  state.workspaceReviewId = null;
  state.workspaceReviewExpanded = false;
  state.integrationQueue = null;
  state.reviewCenterFilter = 'all';
  state.reviewedChanges = new Set();
  state.agentFilter = 'all';
  state.checkpoints = [];
  state.currentTreePath = '.';
  state.tabs = [];
  state.activeTabId = null;
  state.currentOperationId = null;
  state.currentOperationTaskId = null;
  state.currentCheckpointId = null;
  state.currentAgentSessionId = null;
  state.currentAgentId = null;
}
