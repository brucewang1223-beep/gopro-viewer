/** Thin fetch wrappers for the local server API. */

async function request(url, opts = {}) {
  const res = await fetch(url, { headers: { Accept: 'application/json', ...(opts.body ? { 'Content-Type': 'application/json' } : {}) }, ...opts });
  const text = await res.text();
  let body;
  try { body = text ? JSON.parse(text) : null; } catch { body = { error: text }; }
  if (!res.ok) throw new Error(body?.error || `${res.status} ${res.statusText}`);
  return body;
}

export const api = {
  config: () => request('/api/config'),
  library: () => request('/api/library'),
  rescan: () => request('/api/rescan', { method: 'POST' }),
  addRoot: (path) => request('/api/roots', { method: 'POST', body: JSON.stringify({ path }) }),
  removeRoot: (id) => request(`/api/roots/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  telemetry: (recordingId) => request(`/api/recordings/${encodeURIComponent(recordingId)}/telemetry`),
  importSource: () => request('/api/import'),
  chooseImportFolder: (current) => request('/api/import/choose-folder', { method: 'POST', body: JSON.stringify({ current }) }),
  startImport: (body) => request('/api/import', { method: 'POST', body: JSON.stringify(body) }),
  importJob: () => request('/api/import/job'),
  cancelImport: () => request('/api/import/job', { method: 'DELETE' }),
  deleteImported: (keys) => request('/api/import/delete', { method: 'POST', body: JSON.stringify({ keys }) }),
  mediaUrl: (fileId) => `/api/media/${encodeURIComponent(fileId)}`,
  thumbUrl: (fileId) => `/api/thumb/${encodeURIComponent(fileId)}`,
  exportUrl: (recordingId, kind, stream) => `/api/recordings/${encodeURIComponent(recordingId)}/export.${kind}${stream ? `?stream=${stream}` : ''}`,
};
