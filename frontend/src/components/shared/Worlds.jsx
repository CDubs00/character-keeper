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

import React, { useState, useEffect, useRef } from 'react';
import ActionMenu from './ActionMenu';
import WorldSettingsModal from './WorldSettingsModal';
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

export default function Worlds({ user, onBack, onOpenWorld }) {
  const [worlds,   setWorlds]   = useState([]);
  const [loading,  setLoading]  = useState(true);
  const [showArchived, setShowArchived] = useState(false);

  // The inline panel now only CREATES a world. `editing` holds the string 'new'
  // when the create panel is open, or null when it's closed. Editing an existing
  // world (name/description/backdrop) moved into the consolidated World Settings
  // modal (§4.7b), opened from the row's "…" → Settings.
  const [editing,     setEditing]     = useState(null);
  const [draftName,   setDraftName]   = useState('');
  const [draftDesc,   setDraftDesc]   = useState('');
  const [busy,        setBusy]        = useState(false);

  // Consolidated World Settings modal (§4.7b): holds the worldId whose settings
  // are open, or null when closed. Opened at the General section from the row menu.
  const [settingsFor, setSettingsFor] = useState(null);

  // Backdrop (optional per-world image). We STAGE the choice in the form and only
  // commit it on Save — because a brand-new world has no id to upload against
  // until createWorld returns one. `file` is a freshly-picked File (upload it),
  // `url` is the existing saved backdrop (edit mode), `remove` flags "clear the
  // existing one on save". `preview` is a local object-URL for instant feedback.
  const [bdFile,    setBdFile]    = useState(null);
  const [bdPreview, setBdPreview] = useState(null);
  const [bdUrl,     setBdUrl]     = useState(null);
  const [bdRemove,  setBdRemove]  = useState(false);
  const fileRef = useRef(null);

  // Revoke a local preview object-URL when it's replaced or the panel closes, so
  // we don't leak blob URLs.
  useEffect(() => () => { if (bdPreview) URL.revokeObjectURL(bdPreview); }, [bdPreview]);

  useEffect(() => {
    let alive = true;
    api.getWorlds()
      .then(list => { if (alive) setWorlds(Array.isArray(list) ? list : []); })
      .catch(() => { if (alive) setWorlds([]); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, []);

  const resetBackdropDraft = (url = null) => {
    setBdFile(null);
    setBdPreview(prev => { if (prev) URL.revokeObjectURL(prev); return null; });
    setBdUrl(url);
    setBdRemove(false);
    if (fileRef.current) fileRef.current.value = '';
  };

  const openCreate = () => {
    setEditing('new');
    setDraftName('');
    setDraftDesc('');
    resetBackdropDraft(null);
  };

  const closePanel = () => {
    setEditing(null);
    setDraftName('');
    setDraftDesc('');
    resetBackdropDraft(null);
  };

  // Stage a picked image: hold the File and show a local preview. Nothing is
  // uploaded until Save.
  const pickBackdrop = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setBdFile(file);
    setBdRemove(false);
    setBdPreview(prev => { if (prev) URL.revokeObjectURL(prev); return URL.createObjectURL(file); });
  };

  // Clear the backdrop: forget any staged file, and (if the world already had one)
  // flag it for removal on save.
  const clearBackdrop = () => {
    setBdFile(null);
    setBdPreview(prev => { if (prev) URL.revokeObjectURL(prev); return null; });
    if (fileRef.current) fileRef.current.value = '';
    if (bdUrl) setBdRemove(true);
  };

  // What to show in the form preview: the freshly-picked image wins, else the
  // saved one (unless flagged for removal).
  const shownBackdrop = bdPreview || (bdRemove ? null : bdUrl);

  const handleSave = async () => {
    const name = draftName.trim();
    if (!name || busy) return;
    setBusy(true);
    try {
      // 1) Create or update the world record itself.
      let saved = null;
      if (editing === 'new') {
        saved = await api.createWorld({ name, description: draftDesc.trim() });
      } else {
        saved = await api.updateWorld(editing, { name, description: draftDesc.trim() });
      }
      if (!saved || !saved.id) return;

      // 2) Commit the backdrop against the now-known world id: upload a staged
      //    file, or delete an existing one the user cleared. The returned
      //    { backdrop } URL is merged so cards/detail pick it up immediately.
      let backdrop = saved.backdrop ?? null;
      if (bdFile) {
        const r = await api.uploadWorldBackdrop(saved.id, bdFile);
        if (r && !r.error) backdrop = r.backdrop;
      } else if (bdRemove) {
        const r = await api.deleteWorldBackdrop(saved.id);
        if (r && !r.error) backdrop = null;
      }
      const finalWorld = { ...saved, backdrop };

      setWorlds(prev => editing === 'new'
        ? [...prev, finalWorld]
        : prev.map(w => (w.id === editing ? { ...w, ...finalWorld } : w)));
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

  // Only GMs create/manage worlds. A world carries the viewer's `role` (§4.8):
  // 'owner' (mine) or a member tier (read|propose|write). Member worlds are
  // read-only here — no ActionMenu, a role badge instead — and open read-only.
  const isGM = !!(user?.gm || user?.admin);
  const isOwner = (w) => (w.role ? w.role === 'owner' : true);
  const ROLE_BADGE = { read: 'Read', propose: 'Read · propose', write: 'Read · write' };

  const renderRow = (w) => (
    <div key={w.id} style={{
      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      padding: '0.75rem 0.9rem',
      border: '1px solid var(--border)',
      borderRadius: '2px',
      background: 'var(--bg-raised)',
      gap: '1rem',
      position: 'relative',
    }}>
      {/* Faint backdrop banner — same muted treatment as the detail view: the
          image, then a themed scrim over it, so worlds are distinguishable at a
          glance without the text ever sitting on the raw image.

          The clip lives on THIS wrapper (its own `overflow: hidden` + matching
          radius), NOT on the row. Previously the row itself was clipped, which
          also chopped off the ActionMenu dropdown — it couldn't extend past the
          row edge and appeared to open "inside" the box. Clipping only the
          backdrop layers keeps the banner rounded while letting the menu escape. */}
      {w.backdrop && (
        <div aria-hidden="true" style={{
          position: 'absolute', inset: 0, borderRadius: '2px', overflow: 'hidden', pointerEvents: 'none',
        }}>
          <div style={{
            position: 'absolute', inset: 0,
            backgroundImage: `url("${w.backdrop}")`, backgroundSize: 'cover', backgroundPosition: 'center',
          }} />
          <div style={{ position: 'absolute', inset: 0, background: 'var(--bg-raised)', opacity: 0.8 }} />
        </div>
      )}
      <div
        onClick={() => onOpenWorld && onOpenWorld(w.id)}
        role="button"
        title="Open world"
        style={{ opacity: w.status === 'archived' ? 0.55 : 1, minWidth: 0, flex: '1 1 auto', cursor: onOpenWorld ? 'pointer' : 'default', position: 'relative', zIndex: 1 }}
      >
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
      {isOwner(w) ? (
        <span style={{ position: 'relative', zIndex: 1, flex: '0 0 auto' }}>
          <ActionMenu items={[
            { label: 'Settings', onClick: () => setSettingsFor(w.id) },
            { label: w.status === 'archived' ? 'Restore' : 'Archive',
              onClick: () => handleArchive(w) },
            { label: 'Delete', danger: true, onClick: () => handleDelete(w) },
          ]} />
        </span>
      ) : (
        // Member world — no management, just a role badge so it's clear this is
        // shared with you, not yours. Read-only detail view enforces the rest.
        <span title={`You have ${ROLE_BADGE[w.role] || w.role} access`} style={{
          position: 'relative', zIndex: 1, flex: '0 0 auto',
          fontFamily: 'var(--font-mono)', fontSize: '0.6rem', letterSpacing: '0.08em',
          textTransform: 'uppercase', color: 'var(--text-dim)',
          border: '1px solid var(--border)', borderRadius: '999px', padding: '0.2rem 0.55rem', whiteSpace: 'nowrap',
        }}>
          {ROLE_BADGE[w.role] || w.role}
        </span>
      )}
    </div>
  );

  return (
    <div style={{ maxWidth: 720, margin: '0 auto', padding: '2rem 1rem' }}>

      {/* Header — mirrors CharacterList's eyebrow + heading + action row */}
      <div style={{ marginBottom: '2rem' }}>
        <div style={{ fontFamily: 'var(--font-mono)', fontSize: '0.65rem', color: 'var(--text-dim)', letterSpacing: '0.15em', textTransform: 'uppercase', marginBottom: '0.25rem' }}>
          Keep
        </div>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '1rem' }}>
          <h1 style={{ fontSize: '1.8rem', color: 'var(--text-accent)', letterSpacing: '0.05em', lineHeight: 1.1 }}>Worlds</h1>
          <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', flexWrap: 'wrap' }}>
            {isGM && !editing && (
              <button className="btn-primary" onClick={openCreate}>+ New World</button>
            )}
            <button className="btn-ghost" onClick={onBack}>← Home</button>
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

            {/* Backdrop image (optional). Portrait-style upload: pick a file, see
                a live preview, Save commits it. The app mutes it automatically
                everywhere it's shown, so there's nothing to configure here. */}
            <div>
              <label style={labelStyle}>Backdrop image (optional)</label>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap' }}>
                <div style={{
                  width: 84, height: 112, flex: '0 0 auto', borderRadius: '2px',
                  border: '1px solid var(--border)', overflow: 'hidden',
                  background: 'var(--bg-input)', position: 'relative',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                }}>
                  {shownBackdrop
                    ? <img src={shownBackdrop} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                    : <span style={{ fontFamily: 'var(--font-mono)', fontSize: '0.55rem', color: 'var(--text-dim)', textAlign: 'center', padding: '0 0.3rem', letterSpacing: '0.05em' }}>NO IMAGE</span>}
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
                  <input ref={fileRef} type="file" accept="image/*" onChange={pickBackdrop} style={{ display: 'none' }} />
                  <button type="button" className="btn-ghost" onClick={() => fileRef.current && fileRef.current.click()}>
                    {shownBackdrop ? 'Change image' : 'Choose image'}
                  </button>
                  {shownBackdrop && (
                    <button type="button" className="btn-ghost" onClick={clearBackdrop}
                      style={{ color: 'var(--danger)' }}>Remove</button>
                  )}
                </div>
              </div>
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

      {/* Consolidated world settings (§4.7b): General / Access / Categories /
          Broken links. Opened at General from the row "…" menu. onSaved carries
          the updated world so the card reflects a rename/backdrop change at once. */}
      {settingsFor && (
        <WorldSettingsModal
          worldId={settingsFor}
          initialSection="general"
          onClose={() => setSettingsFor(null)}
          onSaved={(payload) => {
            if (payload?.world) {
              setWorlds(prev => prev.map(w => (w.id === payload.world.id ? { ...w, ...payload.world } : w)));
            }
          }}
        />
      )}
    </div>
  );
}
