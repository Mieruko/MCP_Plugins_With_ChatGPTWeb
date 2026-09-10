let adminToken = '';

export function setAdminToken(value) {
  adminToken = String(value || '').trim();
}

export function getAdminToken() {
  return adminToken;
}

export async function api(url, options = {}) {
  const { method = 'GET', body, signal } = options;
  const response = await fetch(url, {
    method,
    signal,
    headers: {
      Authorization: `Bearer ${adminToken}`,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  let payload;
  try {
    payload = await response.json();
  } catch {
    payload = {};
  }
  if (!response.ok || payload?.ok === false) {
    throw new Error(payload?.error || `HTTP ${response.status}`);
  }
  return payload?.data ?? payload;
}