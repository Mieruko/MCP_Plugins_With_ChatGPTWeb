const labels = new Map();
let nextLabel = 1;

export function primeAgentLabels(sessions = []) {
  for (const session of sessions) agentLabel(session.id);
}

export function agentLabel(sessionId) {
  if (!sessionId) return 'Local / external';
  if (!labels.has(sessionId)) labels.set(sessionId, `ChatGPT #${nextLabel++}`);
  return labels.get(sessionId);
}