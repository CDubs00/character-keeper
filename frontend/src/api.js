const BASE = process.env.REACT_APP_API_URL || '';

// ---------------------------------------------------------------------------
// fetchWithRetry
//
// iOS Safari can suspend the JS engine mid-fetch when the app is backgrounded.
// When it resumes, the fetch is still in-flight but the TCP connection is dead
// and the AbortController timer was also frozen — so it never fires. The fetch
// hangs indefinitely.
//
// This wrapper gives every API call:
//   • cache: 'no-store'  — prevents iOS returning a stale cached response from
//                          a previous session after resume
//   • a 12s timeout per attempt — short enough to surface failure quickly
//   • one automatic retry — catches the "first attempt was the frozen one"
//     case without making the user hit Retry manually
//
// The timeout is per-attempt, not shared, so a retry gets a full fresh window.
// ---------------------------------------------------------------------------
async function fetchWithRetry(url, options = {}, attempts = 2) {
  const merged = {
    credentials: 'include',
    cache: 'no-store',
    ...options,
  };

  for (let i = 0; i < attempts; i++) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 12000);

    // Honour any signal the caller already attached (e.g. loadRoster's own
    // AbortController). If either signal fires, the fetch aborts.
    const signal = merged.signal
      ? anySignal([merged.signal, ac.signal])
      : ac.signal;

    try {
      const r = await fetch(url, { ...merged, signal });
      clearTimeout(timer);
      return r;
    } catch (err) {
      clearTimeout(timer);
      // Only retry on abort/network errors, not on things like CORS failures.
      // On the last attempt, re-throw so the caller (handle()) sees a real error.
      if (i < attempts - 1 && (err.name === 'AbortError' || err.name === 'TypeError')) {
        continue;
      }
      throw err;
    }
  }
}

// Combines multiple AbortSignals so the fetch aborts if ANY of them fire.
// A simplified polyfill for AbortSignal.any(), which isn't available on older
// iOS Safari versions.
function anySignal(signals) {
  const ac = new AbortController();
  for (const s of signals) {
    if (s.aborted) { ac.abort(); break; }
    s.addEventListener('abort', () => ac.abort(), { once: true });
  }
  return ac.signal;
}

async function handle(r) {
  if (r.ok) {
    if (r.status === 204) return null;
    const text = await r.text();
    return text ? JSON.parse(text) : null;
  }

  let message = `Request failed (${r.status})`;
  try {
    const body = await r.json();
    if (body && body.error) message = body.error;
  } catch { /* keep generic message */ }
  return { error: message, status: r.status };
}

export const api = {
  async getCharacters() {
    return handle(await fetchWithRetry(`${BASE}/api/characters`));
  },
  async search(q) {
    return handle(await fetchWithRetry(`${BASE}/api/search?q=${encodeURIComponent(q)}`));
  },
  async getVersion() {
    return handle(await fetchWithRetry(`${BASE}/api/version`));
  },
  async getCharacter(id) {
    return handle(await fetchWithRetry(`${BASE}/api/characters/${id}`));
  },
  async saveCharacter(id, data) {
    return handle(await fetchWithRetry(`${BASE}/api/characters/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    }));
  },
  async deleteCharacter(id) {
    return handle(await fetchWithRetry(`${BASE}/api/characters/${id}`, { method: 'DELETE' }));
  },
  async exportCharacter(id) {
    return fetch(`${BASE}/api/characters/${id}/export`, {
      credentials: 'include',
      cache: 'no-store',
    });
  },
  async getRolls(id) {
    return handle(await fetchWithRetry(`${BASE}/api/characters/${id}/rolls`));
  },
  async listAttachments(id) {
    return handle(await fetchWithRetry(`${BASE}/api/characters/${id}/attachments`));
  },
  async checkAttachmentDuplicate(id, sha) {
    return handle(await fetchWithRetry(`${BASE}/api/characters/${id}/attachments?sha=${encodeURIComponent(sha)}`));
  },
  async uploadAttachment(id, file) {
    const form = new FormData();
    form.append('file', file);
    return handle(await fetchWithRetry(`${BASE}/api/characters/${id}/attachments`, { method: 'POST', body: form }));
  },
  async deleteAttachment(id, key) {
    return handle(await fetchWithRetry(`${BASE}/api/characters/${id}/attachments/${key}`, { method: 'DELETE' }));
  },
  async deletePortrait(id) {
  return handle(await fetchWithRetry(`${BASE}/api/characters/${id}/portrait`, { method: 'DELETE' }));
  },
  attachmentUrl(id, key) {
    return `${BASE}/api/characters/${id}/attachments/${key}`;
  },
  async setCharacterStatus(id, status) {
    return handle(await fetchWithRetry(`${BASE}/api/characters/${id}/status`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status }),
    }));
  },
  async joinCampaign(id, campaignCode) {
    return handle(await fetchWithRetry(`${BASE}/api/characters/${id}/campaign/join`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ campaignCode }),
    }));
  },
  async leaveCampaign(id) {
    return handle(await fetchWithRetry(`${BASE}/api/characters/${id}/campaign/leave`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    }));
  },
  async setCampaignStatus(id, status) {
    return handle(await fetchWithRetry(`${BASE}/api/campaigns/${id}/status`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status }),
    }));
  },
  async getUsers() {
    return handle(await fetchWithRetry(`${BASE}/api/users`));
  },
  async createUser(data) {
    return handle(await fetchWithRetry(`${BASE}/api/users`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    }));
  },
  async updateUser(username, changes) {
    return handle(await fetchWithRetry(`${BASE}/api/users/${encodeURIComponent(username)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(changes),
    }));
  },
  async deleteUser(username) {
    return handle(await fetchWithRetry(`${BASE}/api/users/${encodeURIComponent(username)}`, { method: 'DELETE' }));
  },
  async getSettings() {
    return handle(await fetchWithRetry(`${BASE}/api/settings`));
  },
  async updateSettings(patch) {
    return handle(await fetchWithRetry(`${BASE}/api/settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    }));
  },
  async setMyTheme(theme) {
    return handle(await fetchWithRetry(`${BASE}/api/me/preferences`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ theme }),
    }));
  },
  async setMySortBy(sortBy) {
    return handle(await fetchWithRetry(`${BASE}/api/me/preferences`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sortBy }),
    }));
  },
  async getSchema(systemId) {
    return handle(await fetchWithRetry(`${BASE}/api/schema/${systemId}`));
  },
  async getSheets() {
    return handle(await fetchWithRetry(`${BASE}/api/sheets`));
  },
  async getSheetInfo(sheetId) {
    return handle(await fetchWithRetry(`${BASE}/api/sheets/${sheetId}/info`));
  },
  async getAllSheets() {
    return handle(await fetchWithRetry(`${BASE}/api/sheets?all=1`));
  },
  async setSheetEnabled(sheetId, enabled) {
    return handle(await fetchWithRetry(`${BASE}/api/sheets/${sheetId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled }),
    }));
  },
  async deleteSheet(sheetId) {
    return handle(await fetchWithRetry(`${BASE}/api/sheets/${sheetId}`, { method: 'DELETE' }));
  },
  async refreshSheets() {
    return handle(await fetchWithRetry(`${BASE}/api/sheets/refresh`, { method: 'POST' }));
  },
  async getSheetSchema(sheetId) {
    return handle(await fetchWithRetry(`${BASE}/api/sheets/${sheetId}/schema`));
  },
  async createCharacter(id, data) {
    return handle(await fetchWithRetry(`${BASE}/api/characters/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    }));
  },
};

export const slugify = (name) =>
  (name || 'character')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);

export const newId = (name) => {
  const rand = Math.random().toString(36).slice(2, 7);
  return `${slugify(name)}-${rand}`;
};