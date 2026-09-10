const LEGACY_RECENT_WINDOW_MS = 15_000;

function sessionOperations(sessionId, operations = []) {
  return operations.filter(operation => operation.sessionId === sessionId);
}

export function isLiveAgentSession(session, operations = [], now = Date.now()) {
  const related = sessionOperations(session.id, operations);
  if (related.some(operation => ['pending', 'running'].includes(operation.status))) return true;

  if (session.active === true) return true;
  if (session.connected === true) return true;
  if (Number(session.liveConnections || 0) > 0) return true;
  if (Number(session.inFlightRequests || 0) > 0) return true;

  const hasPresenceTelemetry = ['active', 'connected', 'liveConnections', 'inFlightRequests']
    .some(key => Object.prototype.hasOwnProperty.call(session, key));
  if (hasPresenceTelemetry) return false;

  // Compatibility with a backend process that has not been restarted yet.
  // Missing telemetry must never make every recoverable session look active.
  const lastAccess = new Date(session.lastAccessedAt).getTime();
  return Number.isFinite(lastAccess) && now - lastAccess <= LEGACY_RECENT_WINDOW_MS;
}

export function liveAgentPriority(session, operations = []) {
  const related = sessionOperations(session.id, operations);
  if (Number(session.inFlightRequests || 0) > 0 || session.state === 'working' || related.some(operation => operation.status === 'running')) return 0;
  if (related.some(operation => operation.status === 'pending')) return 1;
  if (session.connected === true || session.state === 'connected' || Number(session.liveConnections || 0) > 0) return 2;
  return 3;
}