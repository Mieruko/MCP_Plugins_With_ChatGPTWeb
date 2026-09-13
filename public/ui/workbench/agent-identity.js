import { state } from './state.js';

const labels = new Map();
let nextLabel = 1;

function taskTitleForSession(sessionId) {
  const binding = (state.data?.agentBindings || []).find(item => item.sessionId === sessionId);
  if (!binding) return '';
  return (state.data?.tasks || []).find(task => task.id === binding.taskId)?.title || '';
}

export function primeAgentLabels(sessions = []) {
  for (const session of sessions) agentLabel(session.id);
}

export function agentLabel(sessionId) {
  if (!sessionId) return 'Local / external';
  const taskTitle = taskTitleForSession(sessionId);
  if (taskTitle) return taskTitle;
  if (!labels.has(sessionId)) labels.set(sessionId, `ChatGPT #${nextLabel++}`);
  return labels.get(sessionId);
}