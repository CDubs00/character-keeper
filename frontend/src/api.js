const BASE = process.env.REACT_APP_API_URL || '';

// ---------------------------------------------------------------------------
// Response handling
//
// Every endpoint returns JSON on success and a { error } envelope on failure.
// A bare `r.json()` ignores the HTTP status, so a 403 {error:'Forbidden'} came
// back looking exactly like real data — which is how a "Forbidden" response
// ended up being rendered as a character with an "Unknown Sheet".
//
// `handle` normalises this in one place:
//   • success            → parsed JSON (null for 204 / empty bodies)
//   • any non-2xx status → a guaranteed { error, status } object, regardless of
//                          what the server actually sent (a JSON {error}, an
//                          empty body, or non-JSON like an HTML 500 page)
//
// It deliberately does NOT throw. The rest of the app already detects failures
// with `if (res?.error)`, so returning an envelope keeps every existing caller
// working. Callers that need to branch on the *kind* of failure can read
// `res.status` (401 / 403 / 404 …) — that's what the character loader uses to
// show a "no access" screen instead of the misleading "sheet not found" one.
// ---------------------------------------------------------------------------
async function handle(r) {
  if (r.ok) {
    if (r.status === 204) return null;          // No Content
    const text = await r.text();
    return text ? JSON.parse(text) : null;      // tolerate an empty 200 body
  }

  let message = `Request failed (${r.status})`;
  try {
    const body = await r.json();
    if (body && body.error) message = body.error;
  } catch {
    /* error body wasn't JSON (or was empty) — keep the generic message */
  }
  return { error: message, status: r.status };
}

export const api = {
  async getCharacters() {
    return handle(await fetch(`${BASE}/api/characters`));
  },
  async search(q) {
    return handle(await fetch(`${BASE}/api/search?q=${encodeURIComponent(q)}`));
  },
  async getVersion() {
    return handle(await fetch(`${BASE}/api/version`));
  },
  async getCharacter(id) {
    return handle(await fetch(`${BASE}/api/characters/${id}`));
  },
  async saveCharacter(id, data) {
    return handle(await fetch(`${BASE}/api/characters/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    }));
  },
  async deleteCharacter(id) {
    return handle(await fetch(`${BASE}/api/characters/${id}`, { method: 'DELETE' }));
  },
  async exportCharacter(id) {
    // The body is a file download (JSON or ZIP), not the usual {...}/{error}
    // envelope, so this returns the raw Response and skips handle(). The caller
    // reads the blob and the Content-Disposition filename.
    return fetch(`${BASE}/api/characters/${id}/export`);
  },
  async getRolls(id) {
    return handle(await fetch(`${BASE}/api/characters/${id}/rolls`));
  },
  // --- Attachments -----------------------------------------------------------
  async listAttachments(id) {
    return handle(await fetch(`${BASE}/api/characters/${id}/attachments`));
  },
  async checkAttachmentDuplicate(id, sha) {
    // Asks the server "do you already have a file with this sha-256?" so the UI
    // can show the non-blocking duplicate warning before committing the upload.
    return handle(await fetch(`${BASE}/api/characters/${id}/attachments?sha=${encodeURIComponent(sha)}`));
  },
  async uploadAttachment(id, file) {
    const form = new FormData();
    form.append('file', file);
    // Intentionally no Content-Type header — the browser sets the multipart
    // boundary itself. Setting it manually breaks the upload.
    return handle(await fetch(`${BASE}/api/characters/${id}/attachments`, { method: 'POST', body: form }));
  },
  async deleteAttachment(id, key) {
    return handle(await fetch(`${BASE}/api/characters/${id}/attachments/${key}`, { method: 'DELETE' }));
  },
  attachmentUrl(id, key) {
    // Direct URL for <img>, the pdf <iframe>, and downloads. Same-origin, so the
    // session cookie rides along automatically; the server enforces visibility.
    return `${BASE}/api/characters/${id}/attachments/${key}`;
  },
  async setCharacterStatus(id, status) {
    return handle(await fetch(`${BASE}/api/characters/${id}/status`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status }),
    }));
  },
  async joinCampaign(id, campaignCode) {
    return handle(await fetch(`${BASE}/api/characters/${id}/campaign/join`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ campaignCode }),
    }));
  },
  async leaveCampaign(id) {
    return handle(await fetch(`${BASE}/api/characters/${id}/campaign/leave`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    }));
  },
  async setCampaignStatus(id, status) {
    return handle(await fetch(`${BASE}/api/campaigns/${id}/status`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status }),
    }));
  },
  async getUsers() {
    return handle(await fetch(`${BASE}/api/users`));
  },
  async createUser(data) {
    return handle(await fetch(`${BASE}/api/users`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    }));
  },
  async updateUser(username, changes) {
    return handle(await fetch(`${BASE}/api/users/${encodeURIComponent(username)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(changes),
    }));
  },
  async deleteUser(username) {
    return handle(await fetch(`${BASE}/api/users/${encodeURIComponent(username)}`, {
      method: 'DELETE',
    }));
  },
  async getSettings() {
    return handle(await fetch(`${BASE}/api/settings`));
  },
  async updateSettings(patch) {
    return handle(await fetch(`${BASE}/api/settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    }));
  },
  async setMyTheme(theme) {
    return handle(await fetch(`${BASE}/api/me/preferences`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ theme }),
    }));
  },
  async setMySortBy(sortBy) {
    return handle(await fetch(`${BASE}/api/me/preferences`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sortBy }),
    }));
  },
  async getSchema(systemId) {
    return handle(await fetch(`${BASE}/api/schema/${systemId}`));
  },
  async getSheets() {
    return handle(await fetch(`${BASE}/api/sheets`));
  },
  async getSheetSchema(sheetId) {
    return handle(await fetch(`${BASE}/api/sheets/${sheetId}/schema`));
  },
  async createCharacter(id, data) {
    // saveCharacter already handles PUT (create or update); this is just an alias
    // for clarity at the call site in CharacterList.
    return handle(await fetch(`${BASE}/api/characters/${id}`, {
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
