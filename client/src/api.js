// Thin fetch wrapper. All API calls go through here.
//
// Base URL:
//   - In dev: VITE_API_URL is empty; fetch hits /api/* which Vite proxies to :3001.
//   - In prod: VITE_API_URL is empty (set in .env.production); fetch hits the same
//     origin where the Express server is serving both the API and the SPA.
//
// To create a debate, pass the keyphrase via the X-Debate-Key header (gathered
// from the user in the New Debate page in Prompt 17).

const API_BASE = import.meta.env.VITE_API_URL ?? '';

export class ApiError extends Error {
  constructor(message, { status, body } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
  }
}

/**
 * @param {string} path - path under /api, with leading slash. e.g. "/agents"
 * @param {object} [options]
 * @param {string} [options.method='GET']
 * @param {object} [options.body] - JSON-serializable
 * @param {Object<string,string>} [options.headers]
 * @param {AbortSignal} [options.signal]
 */
export async function fetchJson(path, options = {}) {
  const { method = 'GET', body, headers, signal } = options;

  const init = {
    method,
    signal,
    headers: {
      Accept: 'application/json',
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...headers,
    },
  };

  if (body !== undefined) {
    init.body = JSON.stringify(body);
  }

  const res = await fetch(`${API_BASE}/api${path}`, init);

  if (!res.ok) {
    let errBody;
    try {
      errBody = await res.json();
    } catch {
      errBody = null;
    }
    const message = errBody?.error ?? `Request failed (HTTP ${res.status})`;
    throw new ApiError(message, { status: res.status, body: errBody });
  }

  // 204 No Content fast path
  if (res.status === 204) return null;

  return res.json();
}

/**
 * Build a URL for the EventSource-style SSE endpoint of a debate.
 * EventSource hits the same origin in dev (via Vite proxy) and prod.
 */
export function debateStreamUrl(debateId) {
  return `${API_BASE}/api/debates/${encodeURIComponent(debateId)}/stream`;
}
