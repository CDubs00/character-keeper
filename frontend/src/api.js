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
  async updateAttachment(id, key, text) {
    return handle(await fetchWithRetry(`${BASE}/api/characters/${id}/attachments/${key}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'text/plain' },
      body: text,
    }));
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
    async getWorlds() {
    return handle(await fetchWithRetry(`${BASE}/api/worlds`));
  },
  // One world + the viewer's `role` (§4.8): 'owner' or a member tier
  // (read|propose|write). 404 for anyone with no access. The read-only world view
  // drives its chrome off this role — the server is the gate, not the client.
  async getWorld(id) {
    return handle(await fetchWithRetry(`${BASE}/api/worlds/${id}`));
  },
  async createWorld(data) {
    return handle(await fetchWithRetry(`${BASE}/api/worlds`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    }));
  },
  async updateWorld(id, data) {
    return handle(await fetchWithRetry(`${BASE}/api/worlds/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    }));
  },
  async deleteWorld(id) {
    return handle(await fetchWithRetry(`${BASE}/api/worlds/${id}`, { method: 'DELETE' }));
  },
  async setWorldStatus(id, status) {
    return handle(await fetchWithRetry(`${BASE}/api/worlds/${id}/status`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status }),
    }));
  },
  // Backdrop image — multipart, exactly like a character portrait. Returns
  // { backdrop } (the served URL) on success.
  async uploadWorldBackdrop(id, file) {
    const form = new FormData();
    form.append('backdrop', file);
    return handle(await fetchWithRetry(`${BASE}/api/worlds/${id}/backdrop`, { method: 'POST', body: form }));
  },
  async deleteWorldBackdrop(id) {
    return handle(await fetchWithRetry(`${BASE}/api/worlds/${id}/backdrop`, { method: 'DELETE' }));
  },
  // --- Keep: campaign↔world link + world access ledger (§4.7) --------------
  // Campaigns: create/update carry an optional worldId (a world the GM owns, or
  // null for standalone). Create stays where the campaign UI is; this wrapper
  // covers editing the link on an existing campaign.
  async createCampaign(data) {
    return handle(await fetchWithRetry(`${BASE}/api/campaigns`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    }));
  },
  async updateCampaign(id, data) {
    return handle(await fetchWithRetry(`${BASE}/api/campaigns/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    }));
  },
  // World members ledger — GM/owner only. getWorldMembers returns the enriched
  // list (user + tier + their characters in this world's campaigns).
  async getWorldMembers(worldId) {
    return handle(await fetchWithRetry(`${BASE}/api/worlds/${worldId}/members`));
  },
  // Campaigns attached to this world (§4.10) — owner-only, read-only display list
  // (name, join code, owner, character/member counts). Returns { campaigns: [...] }.
  async getWorldCampaigns(worldId) {
    return handle(await fetchWithRetry(`${BASE}/api/worlds/${worldId}/campaigns`));
  },
  // The campaign overview (Wave A). The one campaign route a non-owner may call:
  // a player with a character in the campaign gets it with the join code removed
  // and ||fog|| stripped from the prose; anyone else gets 404, never 403.
  async getCampaignOverview(campaignId) {
    return handle(await fetchWithRetry(`${BASE}/api/campaigns/${campaignId}/overview`));
  },
  async setWorldMemberTier(worldId, userId, tier) {
    return handle(await fetchWithRetry(`${BASE}/api/worlds/${worldId}/members/${encodeURIComponent(userId)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tier }),
    }));
  },
  async revokeWorldMember(worldId, userId) {
    return handle(await fetchWithRetry(`${BASE}/api/worlds/${worldId}/members/${encodeURIComponent(userId)}`, { method: 'DELETE' }));
  },
  async kickCampaignCharacter(worldId, campaignId, charId) {
    return handle(await fetchWithRetry(`${BASE}/api/worlds/${worldId}/campaigns/${campaignId}/characters/${charId}`, { method: 'DELETE' }));
  },
  // --- Keep: lore categories + entries + history --------------------------
  async getWorldCategories(worldId) {
    return handle(await fetchWithRetry(`${BASE}/api/worlds/${worldId}/categories`));
  },
  // The world's RESOLVED calendar — its own GM-authored one, else its pack's
  // template, else { calendar: null }. Member-readable so any tier can format
  // in-world dates.
  async getWorldCalendar(worldId) {
    return handle(await fetchWithRetry(`${BASE}/api/worlds/${worldId}/calendar`));
  },
  // ---- Sessions (Wave B) ----------------------------------------------------
  // The campaign play log. Returns { role, sessions } already serialized for the
  // caller: a player receives only shared records, with prep absent by
  // construction rather than filtered out here. Never re-derive access client-side.
  async getCampaignSessions(campaignId) {
    return handle(await fetchWithRetry(`${BASE}/api/campaigns/${campaignId}/sessions`));
  },
  // Start a session (owner only). The number is assigned server-side as max+1.
  async createSession(campaignId, body) {
    return handle(await fetchWithRetry(`${BASE}/api/campaigns/${campaignId}/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
    }));
  },
  // Update a session (owner only). Absent keys are left alone, so a partial patch
  // is safe. Returns the GM view of the saved record.
  async updateSession(campaignId, sessionId, body) {
    return handle(await fetchWithRetry(`${BASE}/api/campaigns/${campaignId}/sessions/${sessionId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
    }));
  },
  async deleteSession(campaignId, sessionId) {
    return handle(await fetchWithRetry(`${BASE}/api/campaigns/${campaignId}/sessions/${sessionId}`, {
      method: 'DELETE',
    }));
  },

  // Session attachments. Owner sees every asset (hidden + shared); a player sees
  // only shared ones on a session they can already see. `visibility` on upload
  // defaults server-side to 'hidden' if omitted.
  async getSessionAssets(campaignId, sessionId) {
    return handle(await fetchWithRetry(`${BASE}/api/campaigns/${campaignId}/sessions/${sessionId}/assets`));
  },
  async uploadSessionAsset(campaignId, sessionId, file, visibility) {
    const form = new FormData();
    form.append('file', file);
    if (visibility) form.append('visibility', visibility);
    return handle(await fetchWithRetry(`${BASE}/api/campaigns/${campaignId}/sessions/${sessionId}/assets`, { method: 'POST', body: form }));
  },
  async setSessionAssetVisibility(campaignId, sessionId, key, visibility) {
    return handle(await fetchWithRetry(`${BASE}/api/campaigns/${campaignId}/sessions/${sessionId}/assets/${key}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ visibility }),
    }));
  },
  async deleteSessionAsset(campaignId, sessionId, key) {
    return handle(await fetchWithRetry(`${BASE}/api/campaigns/${campaignId}/sessions/${sessionId}/assets/${key}`, { method: 'DELETE' }));
  },
  sessionAssetUrl(campaignId, sessionId, key) {
    return `${BASE}/api/campaigns/${campaignId}/sessions/${sessionId}/assets/${key}`;
  },

  // Update the world's calendar settings (owner only). Pass any subset — only the
  // keys present are touched, so a toggle can send { hidden: true } alone:
  //   { calendar } — the world's own calendar; null clears it back to the template
  //   { source }   — 'pack' | 'builtin', which template to use when not forked
  //   { hidden }   — display toggle only; the calendar still resolves server-side,
  //                  so stored in-world dates are never touched
  // Returns the resolved { calendar, hidden, source }.
  async setWorldCalendar(worldId, patch) {
    return handle(await fetchWithRetry(`${BASE}/api/worlds/${worldId}/calendar`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch || {}),
    }));
  },
  // Per-world category overrides (rename + hide). Returns the merged category list.
  async setWorldCategoryConfig(worldId, config) {
    return handle(await fetchWithRetry(`${BASE}/api/worlds/${worldId}/categories/config`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ config }),
    }));
  },
  async getLore(worldId, category) {
    const q = category ? `?category=${encodeURIComponent(category)}` : '';
    return handle(await fetchWithRetry(`${BASE}/api/worlds/${worldId}/lore${q}`));
  },
  async getLoreEntry(worldId, entryId) {
    return handle(await fetchWithRetry(`${BASE}/api/worlds/${worldId}/lore/${entryId}`));
  },
  async createLore(worldId, data) {
    return handle(await fetchWithRetry(`${BASE}/api/worlds/${worldId}/lore`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    }));
  },
  async updateLore(worldId, entryId, data) {
    return handle(await fetchWithRetry(`${BASE}/api/worlds/${worldId}/lore/${entryId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    }));
  },
  async deleteLore(worldId, entryId) {
    return handle(await fetchWithRetry(`${BASE}/api/worlds/${worldId}/lore/${entryId}`, { method: 'DELETE' }));
  },
  async getLoreHistory(worldId, entryId) {
    return handle(await fetchWithRetry(`${BASE}/api/worlds/${worldId}/lore/${entryId}/history`));
  },
  async restoreLore(worldId, entryId, index) {
    return handle(await fetchWithRetry(`${BASE}/api/worlds/${worldId}/lore/${entryId}/restore`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ index }),
    }));
  },
  // --- Keep: proposals (§4.9 — propose tier: suggested edits, GM-approved) --
  // A member with the `propose` tier submits suggested edits that never touch the
  // entry; the owner reviews a world-wide queue and approves/rejects. All gating
  // is server-side off the viewer's world role.
  async createProposal(worldId, entryId, data) {
    return handle(await fetchWithRetry(`${BASE}/api/worlds/${worldId}/lore/${entryId}/proposals`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    }));
  },
  // Per-entry proposals: owner gets all; a proposer gets only their own.
  async getEntryProposals(worldId, entryId) {
    return handle(await fetchWithRetry(`${BASE}/api/worlds/${worldId}/lore/${entryId}/proposals`));
  },
  // World-wide PENDING queue — owner-only (the GM's review list).
  async getWorldProposals(worldId) {
    return handle(await fetchWithRetry(`${BASE}/api/worlds/${worldId}/proposals`));
  },
  // Approve applies the (optionally GM-edited) name/fields through the normal
  // update path, so history records the pre-edit snapshot. Owner-only.
  async approveProposal(worldId, entryId, proposalId, data) {
    return handle(await fetchWithRetry(`${BASE}/api/worlds/${worldId}/lore/${entryId}/proposals/${proposalId}/approve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data || {}),
    }));
  },
  async rejectProposal(worldId, entryId, proposalId) {
    return handle(await fetchWithRetry(`${BASE}/api/worlds/${worldId}/lore/${entryId}/proposals/${proposalId}/reject`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    }));
  },

  // --- Keep: per-entry lore assets (inline images + attachments) ----------
  // One store per lore entry, same file-type allowlist as character
  // attachments, served app-origin through a guarded route.
  async getLoreAssets(worldId, entryId) {
    return handle(await fetchWithRetry(`${BASE}/api/worlds/${worldId}/lore/${entryId}/assets`));
  },
  async uploadLoreAsset(worldId, entryId, file) {
    const form = new FormData();
    form.append('file', file);
    return handle(await fetchWithRetry(`${BASE}/api/worlds/${worldId}/lore/${entryId}/assets`, { method: 'POST', body: form }));
  },
  async deleteLoreAsset(worldId, entryId, key) {
    return handle(await fetchWithRetry(`${BASE}/api/worlds/${worldId}/lore/${entryId}/assets/${key}`, { method: 'DELETE' }));
  },
  // Absolute (BASE-prefixed) URL for an asset blob — used as an <img>/<a> src.
  // The inline-image markdown a body stores is `![alt](<this>)`, so it must work
  // both same-origin (BASE='') and against a split dev API origin.
  loreAssetUrl(worldId, entryId, key) {
    return `${BASE}/api/worlds/${worldId}/lore/${entryId}/assets/${key}`;
  },

  // --- Keep: world landing page + world-level asset store (§4k) -----------
  // `landing` is app-owned — set only through this route, never a world PUT body.
  async setWorldLanding(worldId, landing) {
    return handle(await fetchWithRetry(`${BASE}/api/worlds/${worldId}/landing`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ landing }),
    }));
  },
  // One asset store per world (landing-page images + attachments), same allowlist
  // as lore/character attachments, served app-origin through a guarded route.
  async getWorldAssets(worldId) {
    return handle(await fetchWithRetry(`${BASE}/api/worlds/${worldId}/assets`));
  },
  async uploadWorldAsset(worldId, file) {
    const form = new FormData();
    form.append('file', file);
    return handle(await fetchWithRetry(`${BASE}/api/worlds/${worldId}/assets`, { method: 'POST', body: form }));
  },
  async deleteWorldAsset(worldId, key) {
    return handle(await fetchWithRetry(`${BASE}/api/worlds/${worldId}/assets/${key}`, { method: 'DELETE' }));
  },
  worldAssetUrl(worldId, key) {
    return `${BASE}/api/worlds/${worldId}/assets/${key}`;
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
  async setMyDiceScale(diceScale) {
  return handle(await fetchWithRetry(`${BASE}/api/me/preferences`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ diceScale }),
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
  async getAssignableUsers() {
    return handle(await fetchWithRetry(`${BASE}/api/users/assignable`));
  },
  async transferCharacter(id, newOwner) {
    return handle(await fetchWithRetry(`${BASE}/api/characters/${id}/transfer`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ newOwner }),
    }));
  },
  async getLogs() {
    return handle(await fetchWithRetry(`${BASE}/api/admin/logs`));
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