// frontend/src/components/shared/Worlds.jsx
//
// The Worlds landing page — the GM's entry into the world-building side of the
// app ("Keep"). Reached from the user dropdown (GM-only) via the /worlds route.
//
// This is deliberately a full PAGE, not a Modal like Campaigns. Worlds are the
// root of a growing surface (lore categories, entries, sessions later), so they
// need real page real estate a dialog can't give. It mirrors the visual grammar
// of CampaignsModal — same eyebrow/heading, same card rows, same inline-create
// panel, same archived-collapsible — but rebuilt as page markup so it doesn't
// reach into CharacterList's module-private Modal/inputStyle helpers.
//
// Everything here talks to the World CRUD endpoints through the api.js wrappers
// (getWorlds / createWorld / updateWorld / deleteWorld / setWorldStatus). A
// World today is owner-only: the GM who made it is the only one who sees it.
// Members, packs, systemId, lore and the rest arrive in later steps; this page
// is just create / rename / describe / archive / delete of the World record.

import React, { useState, useEffect } from 'react';
import ActionMenu from './ActionMenu';
import { api } from '../../api';

// Local style constants mirroring CharacterList's inputStyle. Kept local rather
// than imported because inputStyle is module-private to CharacterList; copying
// the handful of lines is cheaper and lower-risk than refactoring it into a
// shared module (which would mean editing CharacterList).
const inputStyle = {
  width: '100%',
  background: 'var(--bg-input)',
  border: '1px solid var(--border)',
  borderRadius: '2px',
  padding: '0.4rem 0.6rem',
  color: 'var(--text-primary)',
  fontFamily: 'var(--font-body)',
  fontSize: '0.95rem',
  outline: 'none',
};

const labelStyle = {
  fontFamily: 'var(--font-mono)', fontSize: '0.65rem', color: 'var(--text-dim)',
  display: 'block', marginBottom: '0.25rem', letterSpacing: '0.05em',
};

export default function Worlds({ user, onBack }) {
  const [worlds,   setWorlds]   = useState([]);
  const [loading,  setLoading]  = useState(true);
  const [showArchived, setShowArchived] = useState(false);

  // Create/edit share one panel. `editing` holds the id being edited, or the
  // string 'new' when creating, or null when the panel is closed. Name and
  // description are the two editable fields (both settled as day-one fields).
  const [editing,     setEditing]     = useState(null);
  const [draftName,   setDraftName]   = useState('');
  const [draftDesc,   setDraftDesc]   = useState('');
  const [busy,        setBusy]        = useState(false);

  useEffect(() => {
    let alive = true;
    api.getWorlds()
      .then(list => { if (alive) setWorlds(Array.isArray(list) ? list : []); })
      .catch(() => { if (alive) setWorlds([]); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, []);

  const openCreate = () => {
    setEditing('new');
    setDraftName('');
    setDraftDesc('');
  };

  const openEdit = (w) => {
    setEditing(w.id);
    setDraftName(w.name || '');
    setDraftDesc(w.description || '');
  };

  const closePanel = () => {
    setEditing(null);
    setDraftName('');
    setDraftDesc('');
  };

  const handleSave = async () => {
    const name = draftName.trim();
    if (!name || busy) return;
    setBusy(true);
    try {
      if (editing === 'new') {
        const res = await api.createWorld({ name, description: draftDesc.trim() });
        if (res && res.id) setWorlds(prev => [...prev, res]);
      } else {
        const res = await api.updateWorld(editing, { name, description: draftDesc.trim() });
        if (res && res.id) {
          setWorlds(prev => prev.map(w => (w.id === editing ? { ...w, ...res } : w)));
        }
      }
      closePanel();
    } finally {
      setBusy(false);
    }
  };

  const handleArchive = async (w) => {
    const next = w.status === 'archived' ? 'active' : 'archived';
    const res = await api.setWorldStatus(w.id, next);
    if (res && res.status) {
      setWorlds(prev => prev.map(x => (x.id === w.id ? { ...x, status: next } : x)));
    }
  };

  const handleDelete = async (w) => {
    if (!window.confirm(`Delete world "${w.name}"? This cannot be undone.`)) return;
    const res = await api.deleteWorld(w.id);
    if (res && res.ok) setWorlds(prev => prev.filter(x => x.id !== w.id));
  };

  const active   = worlds.filter(w => w.status !== 'archived');
  const archived = worlds.filter(w => w.status === 'archived');

  const renderRow = (w) => (
    <div key={w.id} style={{
      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      padding: '0.75rem 0.9rem',
      border: '1px solid var(--border)',
      borderRadius: '2px',
      background: 'var(--bg-raised)',
      gap: '1rem',
    }}>
      <div style={{ opacity: w.status === 'archived' ? 0.55 : 1, minWidth: 0, flex: '1 1 auto' }}>
        <div style={{ fontFamily: 'var(--font-body)', fontSize: '1.05rem', color: 'var(--text-accent)', letterSpacing: '0.02em' }}>
          {w.name}
        </div>
        {w.description && (
          <div style={{
            fontFamily: 'var(--font-body)', fontSize: '0.85rem', color: 'var(--text-primary)',
            marginTop: '0.2rem', lineHeight: 1.35,
            overflow: 'hidden', textOverflow: 'ellipsis',
            display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical',
          }}>
            {w.description}
          </div>
        )}
        {w.status === 'archived' && (
          <div style={{ fontFamily: 'var(--font-mono)', fontSize: '0.6rem', color: 'var(--text-dim)', letterSpacing: '0.1em', textTransform: 'uppercase', marginTop: '0.3rem' }}>
            Archived
          </div>
        )}
      </div>
      <ActionMenu items={[
        { label: 'Edit', onClick: () => openEdit(w) },
        { label: w.status === 'archived' ? 'Restore' : 'Archive',
          onClick: () => handleArchive(w) },
        { label: 'Delete', danger: true, onClick: () => handleDelete(w) },
      ]} />
    </div>
  );

  return (
    <div style={{ maxWidth: 720, margin: '0 auto', padding: '2rem 1rem' }}>

      {/* Header — mirrors CharacterList's eyebrow + heading + action row */}
      <div style={{ marginBottom: '2rem' }}>
        <div style={{ fontFamily: 'var(--font-mono)', fontSize: '0.65rem', color: 'var(--text-dim)', letterSpacing: '0.15em', textTransform: 'uppercase', marginBottom: '0.25rem' }}>
          Character Keeper
        </div>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '1rem' }}>
          <h1 style={{ fontSize: '1.8rem', color: 'var(--text-accent)', letterSpacing: '0.05em', lineHeight: 1.1 }}>Worlds</h1>
          <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', flexWrap: 'wrap' }}>
            {!editing && (
              <button className="btn-primary" onClick={openCreate}>+ New World</button>
            )}
            <button className="btn-ghost" onClick={onBack}>← Characters</button>
          </div>
        </div>
      </div>

      {/* divider */}
      <div style={{ height: '1px', background: 'linear-gradient(90deg, var(--accent), transparent)', marginBottom: '1.5rem' }} />

      {loading && (
        <div style={{ color: 'var(--text-dim)', fontFamily: 'var(--font-mono)', fontSize: '0.8rem' }}>Loading…</div>
      )}

      {!loading && worlds.length === 0 && !editing && (
        <div style={{ color: 'var(--text-dim)', fontSize: '0.9rem', textAlign: 'center', padding: '2rem 0' }}>
          No worlds yet. Create one to start building.
        </div>
      )}

      {/* Create/edit panel */}
      {editing && (
        <div style={{ border: '1px solid var(--border)', borderRadius: '2px', padding: '1.25rem', background: 'var(--bg-raised)', marginBottom: '1.5rem' }}>
          <div style={{ fontFamily: 'var(--font-mono)', fontSize: '0.65rem', color: 'var(--text-dim)', letterSpacing: '0.1em', textTransform: 'uppercase', marginBottom: '1rem' }}>
            {editing === 'new' ? 'New World' : 'Edit World'}
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
            <div>
              <label style={labelStyle}>World Name</label>
              <input
                type="text" value={draftName} onChange={e => setDraftName(e.target.value)}
                placeholder="e.g. The Shattered Realms" style={inputStyle}
                onKeyDown={e => e.key === 'Enter' && handleSave()} autoFocus
              />
            </div>
            <div>
              <label style={labelStyle}>Description</label>
              <textarea
                value={draftDesc} onChange={e => setDraftDesc(e.target.value)}
                placeholder="A one-line blurb — what is this world?"
                rows={3}
                style={{ ...inputStyle, resize: 'vertical', fontFamily: 'var(--font-body)' }}
              />
            </div>
            <div style={{ display: 'flex', gap: '0.5rem' }}>
              <button className="btn-primary" onClick={handleSave} disabled={!draftName.trim() || busy}>
                {busy ? 'Saving…' : (editing === 'new' ? 'Create' : 'Save')}
              </button>
              <button className="btn-ghost" onClick={closePanel} disabled={busy}>Cancel</button>
            </div>
          </div>
        </div>
      )}

      {/* World list */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
        {active.map(renderRow)}

        {archived.length > 0 && (
          <div style={{ marginTop: active.length ? '0.5rem' : 0 }}>
            <button type="button" onClick={() => setShowArchived(v => !v)}
              style={{
                display: 'flex', alignItems: 'center', gap: '0.4rem', width: '100%',
                background: 'transparent', border: 'none', cursor: 'pointer', padding: '0.4rem 0',
                fontFamily: 'var(--font-mono)', fontSize: '0.65rem', color: 'var(--text-dim)',
                letterSpacing: '0.1em', textTransform: 'uppercase',
              }}>
              <span style={{ fontSize: '0.8em' }}>{showArchived ? '▾' : '▸'}</span>
              Archived Worlds ({archived.length})
            </button>
            {showArchived && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', marginTop: '0.5rem' }}>
                {archived.map(renderRow)}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
