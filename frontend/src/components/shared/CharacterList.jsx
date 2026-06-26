import React, { useEffect, useState, useRef, useMemo, useCallback } from 'react';
import { api, newId, slugify } from '../../api';
import ActionMenu from './ActionMenu';
import ShareModal from './ShareModal';
import { THEMES, applyTheme } from '../../theme';
import { GearIcon, SwordsIcon, PaletteIcon, SignOutIcon, ShareIcon,
         SkullIcon, BoxIcon, PauseIcon, SunsetIcon, PlayIcon, SearchIcon } from './Icons';
import VersionTag from './VersionTag';
import ExportStage from '../ExportStage';   // adjust if your tree differs — same folder as SheetRenderer.jsx
import { Toast } from './UI';           // wherever UI.jsx actually lives for this file
import { zipSync, strToU8 } from 'fflate';    

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000); // let the download actually read it first
}

// One complete export: tab images (skipped tabs already excluded) + portrait +
// character JSON + sessions as Markdown.
async function buildExportZip(base, tabs, char, rolls) {
  const files = {};

  for (let i = 0; i < tabs.length; i++) {
    const t = tabs[i];
    const suffix = t.label ? slugify(t.label) : String(i + 1);
    files[`${base}-${suffix}.png`] = new Uint8Array(await t.blob.arrayBuffer());
  }

  if (char.portrait) {
    try {
      const res = await fetch(char.portrait, { credentials: 'include' });
      if (res.ok) {
        const ext = (char.portrait.split('?')[0].split('.').pop() || 'png').toLowerCase();
        files[`${base}-portrait.${ext}`] = new Uint8Array(await (await res.blob()).arrayBuffer());
      }
    } catch { /* portrait optional */ }
  }

  // JSON = the envelope; sessions go out as the .md (mirrors the on-disk split,
  // and keeps the giant session log from bloating the json too). attachments is a
  // sidecar manifest — its blobs are fetched and bundled separately below, so it
  // comes out of the envelope here too.
  const { sessions, attachments, ...envelope } = char;
  files[`${base}.json`] = strToU8(JSON.stringify(envelope, null, 2));

  const md = buildSessionsMarkdown(sessions);
  if (md.trim()) files[`${base}-sessions.md`] = strToU8(md);

  // Rolls live in their own sidecar (server.js's roll log), not the character
  // envelope, so they're passed in separately rather than destructured off
  // `char` like sessions above.
  const rollsMd = buildRollsMarkdown(rolls);
  if (rollsMd.trim()) files[`${base}-rolls.md`] = strToU8(rollsMd);

  // Attachments. The manifest (char.attachments, a built-in sidecar) lists them;
  // fetch each blob from its authenticated URL and drop it under attachments/ with
  // its real filename. The server-side export does the same — this client export
  // builds the zip in the browser, so without this loop it never sees the blobs.
  const atts = Array.isArray(attachments) ? attachments : [];
  if (atts.length) {
    files['attachments/manifest.json'] = strToU8(JSON.stringify(atts, null, 2));
    const used = new Set();
    const uniqueName = (name) => {
      let candidate = String(name || 'file').replace(/[\/\\\r\n]/g, '_');
      if (used.has(candidate)) {
        const dot  = candidate.lastIndexOf('.');
        const stem = dot > 0 ? candidate.slice(0, dot) : candidate;
        const ext  = dot > 0 ? candidate.slice(dot) : '';
        let i = 2;
        do { candidate = `${stem} (${i++})${ext}`; } while (used.has(candidate));
      }
      used.add(candidate);
      return candidate;
    };
    for (const a of atts) {
      try {
        const res = await fetch(api.attachmentUrl(char.id, a.key), { credentials: 'include' });
        if (res.ok) {
          files[`attachments/${uniqueName(a.name || a.key)}`] =
            new Uint8Array(await (await res.blob()).arrayBuffer());
        }
      } catch { /* skip a single failed attachment, keep the rest of the export */ }
    }
  }

  return new Blob([zipSync(files, { level: 0 })], { type: 'application/zip' });
}

// Render the sessions sidecar to Markdown: one `## date` block per session,
// fixed sub-sections, separated by `---`. Newest first.
function buildSessionsMarkdown(sessions) {
  const list = (Array.isArray(sessions) ? sessions : [])
    .slice()
    .sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));

  const block = (s) => [
    `### ${(s.date || 'Undated').trim()}`,
    `#### Session Notes`,
    (s.notes || '').trim(),
    ``,
    `##### To-Do`,
    (s.todos || '').trim(),
    ``,
    `##### Loot`,
    (s.loot || '').trim(),
    ``,
    `##### NPC's`,
    (s.npcs || '').trim(),
    ``,
    `##### Miscellaneous`,
    (s.misc || '').trim(),
  ].join('\n');

  return list.map(block).join('\n\n---\n\n') + '\n';
}

// Render the roll log to Markdown: one bullet per roll, newest first. Mirrors
// buildSessionsMarkdown's "return '' for nothing to show" contract so the
// `if (md.trim())` gate in buildExportZip works the same way for both.
function buildRollsMarkdown(rolls) {
  const list = (Array.isArray(rolls) ? rolls : [])
    .slice()
    .sort((a, b) => String(b.rolledAt || '').localeCompare(String(a.rolledAt || '')));
  if (list.length === 0) return '';

  const formatDice = (dice) =>
    Object.entries(dice || {})
      .sort((a, b) => parseInt(a[0].slice(1), 10) - parseInt(b[0].slice(1), 10))
      .map(([die, vals]) => `${die}: ${vals.join(', ')}`)
      .join(', ');

  const line = (r) => {
    const when = r.rolledAt ? new Date(r.rolledAt).toLocaleString() : 'Unknown time';
    const mod  = r.modifier ? (r.modifier > 0 ? ` +${r.modifier}` : ` ${r.modifier}`) : '';
    const tag  = r.source ? ` — ${r.source}` : '';
    return `- **${r.total}**${tag} (${formatDice(r.dice)}${mod}) — ${when}`;
  };

  return ['## Roll Log', '', ...list.map(line)].join('\n') + '\n';
}

// const handleExportSessions = async (c) => {
//   const full = await api.getCharacter(c.id);
//   if (!full || full.error) { window.alert('Could not load that character to export.'); return; }
//   const sessions = Array.isArray(full.sessions) ? full.sessions : [];
//   if (sessions.length === 0) { window.alert('This character has no session notes to export.'); return; }
//   const blob = new Blob([buildSessionsMarkdown(sessions)], { type: 'text/markdown' });
//   downloadBlob(blob, `${slugify(c.name || 'character')}-sessions.md`);
// };

// ─── Shared modal shell ───────────────────────────────────────────────────────
function Modal({ title, subtitle, onClose, children, footer, hideCancel }) {
  return (
    <div style={{
      position: 'fixed', inset: 0,
      background: 'rgba(0,0,0,0.75)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      zIndex: 1000,
      padding: '1rem',                      // keep the dialog off the screen edges
    }}>
      <div style={{
        background: 'var(--bg-surface)',
        border: '1px solid var(--border)',
        borderRadius: '4px',
        width: '100%',
        maxWidth: '500px',
        maxHeight: 'calc(100vh - 2rem)',     // never taller than the viewport
        display: 'flex',
        flexDirection: 'column',             // header / body / footer stack vertically
        boxShadow: '0 8px 32px rgba(0,0,0,0.4)',
      }}>
        {/* Header — fixed, never scrolls away */}
        <div style={{ padding: '2rem 2rem 1rem', flex: '0 0 auto' }}>
          <div style={{ fontFamily: 'var(--font-mono)', fontSize: '0.65rem', color: 'var(--text-dim)', letterSpacing: '0.15em', textTransform: 'uppercase', marginBottom: '0.35rem' }}>
            {subtitle}
          </div>
          <h2 style={{ fontSize: '1.3rem', color: 'var(--text-accent)', margin: 0 }}>
            {title}
          </h2>
        </div>

        {/* Body — the ONLY part that scrolls when content overflows */}
        <div style={{ padding: '0 2rem', flex: '1 1 auto', overflowY: 'auto', minHeight: 0 }}>
          {children}
        </div>

        {/* Footer — fixed, so Close/Cancel stay reachable no matter how long the body is */}
        <div style={{ display: 'flex', gap: '0.75rem', justifyContent: 'flex-end', padding: '1rem 2rem 2rem', flex: '0 0 auto' }}>
          {footer}
          {!hideCancel && <button className="btn-ghost" onClick={onClose}>Cancel</button>}
        </div>
      </div>
    </div>
  );
}

// ─── Shared text input style ──────────────────────────────────────────────────
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

// ─── Character status ─────────────────────────────────────────────────────────
const STATUS = {
  active:   { label: 'Active',   Icon: null },
  inactive: { label: 'Inactive', Icon: PauseIcon },
  archived: { label: 'Inactive', Icon: PauseIcon }, // legacy alias
  deceased: { label: 'Deceased', Icon: SkullIcon },
  retired:  { label: 'Retired',  Icon: SunsetIcon },
  shelved:  { label: 'Shelved',  Icon: BoxIcon },
};
const isActive = (s) => !s || s === 'active';
const statusMeta = (s) => STATUS[s] || STATUS.active;

// Icon + label helper for menu items
const iconLabel = (Icon, text) => (
  <span style={{ display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
    <Icon size={18} /> {text}
  </span>
);

// ─── New Character Modal ──────────────────────────────────────────────────────
function NewCharacterModal({ onConfirm, onCancel }) {
  const [sheets,   setSheets]   = useState([]);
  const [loading,  setLoading]  = useState(true);
  const [selected, setSelected] = useState(null);
  const [name,     setName]     = useState('');

  useEffect(() => {
    fetch('/api/sheets', { credentials: 'include' })
      .then(r => r.json())
      .then(data => {
        // Server already filters to enabled + present-on-disk; we just sort.
        // Alphabetical by name (locale-aware) — matches the user list ordering
        // in the admin panel for consistency.
        const sorted = (Array.isArray(data) ? data : [])
          .filter(s => s.enabled !== false)
          .sort((a, b) => (a.name || '').localeCompare(b.name || ''));
        setSheets(sorted);
        if (sorted.length === 1) setSelected(sorted[0].sheetId);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  const sheet   = sheets.find(s => s.sheetId === selected);
  const canCreate = selected && name.trim().length > 0;

  const handleConfirm = () => {
    if (canCreate) onConfirm(sheet, name.trim());
  };

  return (
    <Modal title="New Character" subtitle="Character Keeper" onClose={onCancel} footer={
      <button
        className="btn-primary"
        onClick={handleConfirm}
        disabled={!canCreate}
        style={{ opacity: canCreate ? 1 : 0.4 }}
      >
        Create Character
      </button>
    }>
      {/* Name field */}
      <div style={{ marginBottom: '1rem' }}>
        <label style={{ fontFamily: 'var(--font-mono)', fontSize: '0.65rem', color: 'var(--text-dim)', display: 'block', marginBottom: '0.3rem', letterSpacing: '0.1em', textTransform: 'uppercase' }}>
          Character Name
        </label>
        <input
          type="text"
          value={name}
          onChange={e => setName(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && canCreate && handleConfirm()}
          placeholder="e.g. Hot Pie"
          style={inputStyle}
          autoFocus
        />
      </div>

      {/* System picker */}
      <div style={{ marginBottom: '0.5rem' }}>
        <label style={{ fontFamily: 'var(--font-mono)', fontSize: '0.65rem', color: 'var(--text-dim)', display: 'block', marginBottom: '0.5rem', letterSpacing: '0.1em', textTransform: 'uppercase' }}>
          Game System
        </label>
        {loading && <div style={{ color: 'var(--text-dim)', fontFamily: 'var(--font-mono)', fontSize: '0.8rem' }}>Loading…</div>}
        {!loading && sheets.length === 0 && (
          <div style={{ color: 'var(--text-dim)', fontSize: '0.9rem' }}>
            No sheet bundles available. Drop a bundle into <code>/bundles</code> and refresh in the admin panel.
          </div>
        )}

        {/* Bounded inner scroll. The list is allowed to grow up to ~40% of the
            viewport before it scrolls on its own — keeps the name field and
            Create button reachable no matter how many bundles you have. */}
        <div style={{
          display: 'flex',
          flexDirection: 'column',
          gap: '0.4rem',
          maxHeight: 'clamp(10rem, 40vh, 22rem)',
          overflowY: 'auto',
          // Tiny inner padding so the focus ring / hover border isn't clipped
          // by the scroll container's right edge.
          paddingRight: sheets.length > 4 ? '0.25rem' : 0,
        }}>
          {sheets.map(s => (
            <div
              key={s.sheetId}
              onClick={() => setSelected(s.sheetId)}
              style={{
                padding: '0.6rem 0.8rem',
                border: `1px solid ${selected === s.sheetId ? 'var(--accent)' : 'var(--border)'}`,
                borderRadius: '2px',
                cursor: 'pointer',
                background: selected === s.sheetId ? 'rgba(180,140,60,0.08)' : 'transparent',
                transition: 'border-color 0.15s',
                flex: '0 0 auto',                  // don't let flex shrink rows when scrolling
              }}
            >
              <div style={{ fontFamily: 'var(--font-body)', fontSize: '0.95rem', color: 'var(--text-primary)' }}>{s.name}</div>
              {s.version && <div style={{ fontFamily: 'var(--font-mono)', fontSize: '0.65rem', color: 'var(--text-dim)', marginTop: '2px' }}>v{s.version}</div>}
            </div>
          ))}
        </div>
      </div>
    </Modal>
  );
}

// ─── Rename Modal ─────────────────────────────────────────────────────────────
function RenameModal({ character, onConfirm, onCancel }) {
  const [name,     setName]     = useState(character.name || '');
  const [working,  setWorking]  = useState(false);
  const [error,    setError]    = useState('');

  const handleConfirm = async () => {
    const trimmed = name.trim();
    if (!trimmed || trimmed === character.name) { onCancel(); return; }
    setWorking(true);
    setError('');
    const res = await fetch(`/api/characters/${character.id}/rename`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: trimmed }),
    });
    if (res.ok) {
      const data = await res.json();
      onConfirm(character.id, data.id, data.name);
    } else {
      setError('Rename failed. Please try again.');
      setWorking(false);
    }
  };

  return (
    <Modal title="Rename Character" subtitle={`Currently: ${character.name || 'Unnamed'}`} onClose={onCancel} footer={
      <button
        className="btn-primary"
        onClick={handleConfirm}
        disabled={working || !name.trim() || name.trim() === character.name}
        style={{ opacity: (name.trim() && name.trim() !== character.name) ? 1 : 0.4 }}
      >
        {working ? 'Renaming…' : 'Rename'}
      </button>
    }>
      <input
        type="text"
        value={name}
        onChange={e => setName(e.target.value)}
        onKeyDown={e => e.key === 'Enter' && handleConfirm()}
        style={inputStyle}
        autoFocus
      />
      {error && <div style={{ color: 'var(--red)', fontFamily: 'var(--font-mono)', fontSize: '0.75rem', marginTop: '0.5rem' }}>{error}</div>}
    </Modal>
  );
}

// ─── Admin Panel ──────────────────────────────────────────────────────────────
function RoleChip({ label, active, onClick, disabled }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={disabled ? "You can't change your own admin role" : undefined}
      style={{
        fontFamily: 'var(--font-mono)',
        fontSize: '0.58rem',
        letterSpacing: '0.1em',
        textTransform: 'uppercase',
        padding: '0.18rem 0.5rem',
        borderRadius: '2px',
        cursor: disabled ? 'default' : 'pointer',
        border: '1px solid ' + (active ? 'var(--accent)' : 'var(--border)'),
        background: active ? 'var(--accent-glow)' : 'transparent',
        color: active ? 'var(--text-accent)' : 'var(--text-dim)',
        opacity: disabled ? 0.45 : 1,
        transition: 'all 0.12s',
      }}
    >
      {label}
    </button>
  );
}

// Reusable swatch row — used for both the personal picker and the admin default.
function ThemeSwatches({ value, onPick }) {
  return (
    <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap' }}>
      {Object.entries(THEMES).map(([key, t]) => {
        const active = value === key;
        return (
          <button key={key} type="button" onClick={() => onPick(key)}
            style={{
              display: 'flex', alignItems: 'center', gap: '0.4rem',
              padding: '0.3rem 0.6rem', borderRadius: '2px', cursor: 'pointer',
              fontFamily: 'var(--font-body)', fontSize: '0.85rem',
              border: '1px solid ' + (active ? 'var(--accent)' : 'var(--border)'),
              background: active ? 'var(--accent-glow)' : 'var(--bg-raised)',
              color: active ? 'var(--text-accent)' : 'var(--text-secondary)',
            }}>
            <span style={{ width: '0.8rem', height: '0.8rem', borderRadius: '50%', background: t.vars['--accent'], border: '1px solid rgba(0,0,0,0.3)' }} />
            {t.label}
          </button>
        );
      })}
    </div>
  );
}

// Sort option definitions — label is what's shown, value is what's persisted
// and what `sortChars` (below) switches on. Keep this the single source of
// truth so adding a future option (e.g. once createdAt exists) is one line.
const SORT_OPTIONS = [
  { value: 'updatedAt', label: 'Recently Modified' },
  { value: 'name',      label: 'Name (A–Z)' },
];

// Reusable sort-order row — same shape as ThemeSwatches so Appearance reads
// as one consistent picker pattern rather than two different UI idioms.
function SortOptions({ value, onPick }) {
  return (
    <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap' }}>
      {SORT_OPTIONS.map(({ value: key, label }) => {
        const active = value === key;
        return (
          <button key={key} type="button" onClick={() => onPick(key)}
            style={{
              padding: '0.3rem 0.6rem', borderRadius: '2px', cursor: 'pointer',
              fontFamily: 'var(--font-body)', fontSize: '0.85rem',
              border: '1px solid ' + (active ? 'var(--accent)' : 'var(--border)'),
              background: active ? 'var(--accent-glow)' : 'var(--bg-raised)',
              color: active ? 'var(--text-accent)' : 'var(--text-secondary)',
            }}>
            {label}
          </button>
        );
      })}
    </div>
  );
}

// Sorts a character array in place-safe fashion (returns a new array) per the
// user's chosen order. `updatedAt` is ISO and sorts correctly as a string, so
// no Date parsing is needed; missing values sort last rather than crashing
// localeCompare or throwing off newest-first ordering.
function sortChars(list, sortBy) {
  const sorted = [...list];
  if (sortBy === 'name') {
    sorted.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  } else {
    // 'updatedAt' (default) — newest first; characters missing the field
    // (shouldn't happen post-creation, but defensive) sort to the bottom.
    sorted.sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
  }
  return sorted;
}

// Personal theme picker — available to every user from the header menu.
function AppearanceModal({ user, onUser, onClose }) {
  const [theme, setTheme]   = useState(user?.theme  || 'tavern');
  const [sortBy, setSortBy] = useState(user?.sortBy || 'updatedAt');

  const pick = async (key) => {
    setTheme(key);
    applyTheme(key);                                   // instant, for this user only
    onUser?.(u => ({ ...(u || {}), theme: key }));     // keep App's user in sync
    await api.setMyTheme(key);                         // persist to this user's record
  };

  const pickSort = async (key) => {
    setSortBy(key);
    onUser?.(u => ({ ...(u || {}), sortBy: key }));    // keep App's user in sync — CharacterList reads user.sortBy
    await api.setMySortBy(key);                        // persist to this user's record
  };

  return (
    <Modal title="Appearance" subtitle="Your Theme" onClose={onClose} hideCancel
      footer={<button className="btn-ghost" onClick={onClose}>Close</button>}>
      <div style={{ fontFamily: 'var(--font-body)', fontSize: '0.85rem', color: 'var(--text-secondary)', marginBottom: '0.75rem' }}>
        Choose a theme for yourself — this only changes how the app looks for you.
      </div>
      <ThemeSwatches value={theme} onPick={pick} />

      <div style={{ fontFamily: 'var(--font-mono)', fontSize: '0.65rem', color: 'var(--text-dim)', letterSpacing: '0.12em', textTransform: 'uppercase', margin: '1.25rem 0 0.5rem' }}>
        Sort Characters By
      </div>
      <SortOptions value={sortBy} onPick={pickSort} />
    </Modal>
  );
}

// ──────────────────────────────────────────────────────────────────────────────
// AdminModal — three tabs: Settings, Users, Sheets.
//
// Why tabs rather than collapsible sections: the panel does three unrelated
// jobs (app config, user management, sheet registry) and each grows on its
// own axis. Tabs scope what's on screen to one job, so adding a new user
// doesn't push settings off the top and the user list doesn't grow without
// bound inside one shared scroll.
//
// Each tab manages its own state and its own data load. The shell only owns
// the active-tab selection and the close button.
// ──────────────────────────────────────────────────────────────────────────────
function AdminTabs({ active, onChange }) {
  const tabs = [
    { id: 'settings', label: 'Settings' },
    { id: 'users',    label: 'Users'    },
    { id: 'sheets',   label: 'Sheets'   },
  ];
  return (
    <div role="tablist" style={{
      display: 'flex',
      gap: '0.25rem',
      borderBottom: '1px solid var(--border)',
      marginBottom: '1rem',
      // Sticks the tab bar to the top of the modal body so it stays visible
      // when a tab's own content scrolls.
      position: 'sticky', top: 0,
      background: 'var(--bg-surface)',
      zIndex: 1,
    }}>
      {tabs.map(t => {
        const isActive = t.id === active;
        return (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={isActive}
            onClick={() => onChange(t.id)}
            style={{
              padding: '0.55rem 0.9rem',
              cursor: 'pointer',
              background: 'transparent',
              border: 'none',
              borderBottom: '2px solid ' + (isActive ? 'var(--accent)' : 'transparent'),
              color: isActive ? 'var(--text-accent)' : 'var(--text-dim)',
              fontFamily: 'var(--font-mono)',
              fontSize: '0.7rem',
              letterSpacing: '0.12em',
              textTransform: 'uppercase',
              transition: 'all 0.12s',
              // Overlap the parent's bottom border so the active underline sits
              // flush rather than floating a pixel above it.
              marginBottom: '-1px',
            }}
          >
            {t.label}
          </button>
        );
      })}
    </div>
  );
}

// ── Settings tab ───────────────────────────────────────────────────────────
function AdminSettingsTab({ settings, setSettings, setError }) {
  const toggleLinks = async () => {
    const next = !settings.allowExternalLinks;
    setSettings(s => ({ ...s, allowExternalLinks: next }));   // optimistic
    const res = await api.updateSettings({ allowExternalLinks: next });
    if (res?.error) { setSettings(s => ({ ...s, allowExternalLinks: !next })); setError(res.error); }
  };

  const toggleAttachments = async () => {
    const next = !settings.allowAttachments;
    setSettings(s => ({ ...s, allowAttachments: next }));     // optimistic
    const res = await api.updateSettings({ allowAttachments: next });
    if (res?.error) { setSettings(s => ({ ...s, allowAttachments: !next })); setError(res.error); }
  };

  const pickTheme = async (key) => {
    setSettings(s => ({ ...s, theme: key }));           // default for share pages / new users
    const res = await api.updateSettings({ theme: key });
    if (res?.error) setError(res.error);
  };

  return (
    <div>
      <div style={{ marginBottom: '0.9rem' }}>
        <div style={{ fontFamily: 'var(--font-body)', fontSize: '0.85rem', color: 'var(--text-secondary)', marginBottom: '0.2rem' }}>Default theme</div>
        <div style={{ fontFamily: 'var(--font-mono)', fontSize: '0.6rem', color: 'var(--text-dim)', marginBottom: '0.4rem' }}>
          Used for share pages and users who haven't picked their own.
        </div>
        <ThemeSwatches value={settings.theme} onPick={pickTheme} />
      </div>

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.75rem' }}>
        <div>
          <div style={{ fontFamily: 'var(--font-body)', fontSize: '0.85rem', color: 'var(--text-secondary)' }}>Allow external links in sheets</div>
          <div style={{ fontFamily: 'var(--font-mono)', fontSize: '0.6rem', color: 'var(--text-dim)', marginTop: '0.1rem' }}>
            When off, off-site links in sheet content render as plain text.
          </div>
        </div>
        <button type="button" onClick={toggleLinks} role="switch" aria-checked={settings.allowExternalLinks}
          title={settings.allowExternalLinks ? 'External links allowed' : 'External links blocked'}
          style={{
            flexShrink: 0, width: '2.6rem', height: '1.4rem', borderRadius: '1rem', cursor: 'pointer',
            border: '1px solid ' + (settings.allowExternalLinks ? 'var(--accent)' : 'var(--border)'),
            background: settings.allowExternalLinks ? 'var(--accent-glow)' : 'var(--bg-input)',
            position: 'relative', transition: 'all 0.15s',
          }}>
          <span style={{
            position: 'absolute', top: '50%', transform: 'translateY(-50%)',
            left: settings.allowExternalLinks ? 'calc(100% - 1.15rem)' : '0.15rem',
            width: '1rem', height: '1rem', borderRadius: '50%',
            background: settings.allowExternalLinks ? 'var(--accent)' : 'var(--text-dim)',
            transition: 'all 0.15s',
          }} />
        </button>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.75rem', marginTop: '0.9rem' }}>
        <div>
          <div style={{ fontFamily: 'var(--font-body)', fontSize: '0.85rem', color: 'var(--text-secondary)' }}>Allow file attachments</div>
          <div style={{ fontFamily: 'var(--font-mono)', fontSize: '0.6rem', color: 'var(--text-dim)', marginTop: '0.1rem' }}>
            Lets players keep PDFs, docs, spreadsheets and images with a character.
          </div>
        </div>
        <button type="button" onClick={toggleAttachments} role="switch" aria-checked={settings.allowAttachments}
          title={settings.allowAttachments ? 'Attachments allowed' : 'Attachments disabled'}
          style={{
            flexShrink: 0, width: '2.6rem', height: '1.4rem', borderRadius: '1rem', cursor: 'pointer',
            border: '1px solid ' + (settings.allowAttachments ? 'var(--accent)' : 'var(--border)'),
            background: settings.allowAttachments ? 'var(--accent-glow)' : 'var(--bg-input)',
            position: 'relative', transition: 'all 0.15s',
          }}>
          <span style={{
            position: 'absolute', top: '50%', transform: 'translateY(-50%)',
            left: settings.allowAttachments ? 'calc(100% - 1.15rem)' : '0.15rem',
            width: '1rem', height: '1rem', borderRadius: '50%',
            background: settings.allowAttachments ? 'var(--accent)' : 'var(--text-dim)',
            transition: 'all 0.15s',
          }} />
        </button>
      </div>
    </div>
  );
}

// ── Users tab ──────────────────────────────────────────────────────────────
function AdminUsersTab({ currentUser, setError }) {
  const [users,    setUsers]    = useState([]);
  const [loading,  setLoading]  = useState(true);
  const [filter,   setFilter]   = useState('');
  const [newName,  setNewName]  = useState('');
  const [newPass,  setNewPass]  = useState('');
  const [newRoles, setNewRoles] = useState({ admin: false, gm: false, player: true });
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    api.getUsers().then(u => {
      setUsers(Array.isArray(u) ? u : []);
      setLoading(false);
    });
  }, []);

  const isSelf = (u) => u.username === currentUser?.username;

  // Filter first (case-insensitive substring), then alphabetize, then pin self
  // to the top. Self pins even when the filter would otherwise have hidden it
  // — no: we pin only if self is still in the filtered set. Filtering self out
  // is a valid user action ("show me everyone except me"), so we respect it.
  const orderedUsers = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    const filtered = needle
      ? users.filter(u => u.username.toLowerCase().includes(needle))
      : users.slice();
    filtered.sort((a, b) => a.username.localeCompare(b.username));
    const selfIdx = filtered.findIndex(isSelf);
    if (selfIdx > 0) {
      const [self] = filtered.splice(selfIdx, 1);
      filtered.unshift(self);
    }
    return filtered;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [users, filter, currentUser?.username]);

  const toggleRole = async (u, role) => {
    if (role === 'admin' && isSelf(u)) return; // mirror backend self-lockout guard
    const next = !u[role];
    setUsers(prev => prev.map(x => (x.username === u.username ? { ...x, [role]: next } : x))); // optimistic
    const res = await api.updateUser(u.username, { [role]: next });
    if (res?.error) {
      setUsers(prev => prev.map(x => (x.username === u.username ? { ...x, [role]: !next } : x))); // revert
      setError(res.error);
    }
  };

  const resetPassword = async (u) => {
    const pw = window.prompt(`Set a new password for "${u.username}":`);
    if (!pw) return;
    const res = await api.updateUser(u.username, { password: pw });
    if (res?.error) setError(res.error);
    else window.alert(`Password updated for ${u.username}.`);
  };

  const removeUser = async (u) => {
    if (!window.confirm(`Delete user "${u.username}"? This cannot be undone.`)) return;
    const res = await api.deleteUser(u.username);
    if (res?.ok) setUsers(prev => prev.filter(x => x.username !== u.username));
    else setError(res?.error || 'Could not delete user.');
  };

  const createUser = async () => {
    const username = newName.trim();
    if (!username || !newPass || creating) return;
    setCreating(true);
    setError('');
    const res = await api.createUser({ username, password: newPass, ...newRoles });
    setCreating(false);
    if (res?.username) {
      setUsers(prev => [...prev, res]);
      setNewName('');
      setNewPass('');
      setNewRoles({ admin: false, gm: false, player: true });
    } else {
      setError(res?.error || 'Could not create user.');
    }
  };

  const canCreate = newName.trim() && newPass && !creating;

  return (
    <div>
      {/* Filter row — substring match, case-insensitive. No debounce; even at
          hundreds of users the cost is trivial. */}
      <input
        type="text"
        value={filter}
        onChange={e => setFilter(e.target.value)}
        placeholder={`Filter ${users.length} user${users.length === 1 ? '' : 's'}…`}
        style={{ ...inputStyle, marginBottom: '0.6rem' }}
      />

      {loading ? (
        <div style={{ color: 'var(--text-dim)', fontSize: '0.9rem' }}>Loading users…</div>
      ) : orderedUsers.length === 0 ? (
        <div style={{ color: 'var(--text-dim)', fontSize: '0.85rem', fontFamily: 'var(--font-mono)' }}>
          No matches.
        </div>
      ) : (
        // Bounded inner scroll. The list is the part that grows with N; we cap
        // it so Create User stays visible at the bottom of the modal. clamp()
        // keeps it sensible on both phone and desktop heights.
        <div style={{
          display: 'flex',
          flexDirection: 'column',
          gap: '0.5rem',
          maxHeight: 'clamp(12rem, 45vh, 26rem)',
          overflowY: 'auto',
          paddingRight: orderedUsers.length > 4 ? '0.25rem' : 0,
        }}>
          {orderedUsers.map(u => (
            <div
              key={u.username}
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: '0.75rem',
                flexWrap: 'wrap',
                padding: '0.6rem 0.75rem',
                background: 'var(--bg-raised)',
                border: '1px solid ' + (isSelf(u) ? 'var(--accent-glow)' : 'var(--border)'),
                borderRadius: '2px',
                flex: '0 0 auto',
              }}
            >
              <div style={{ minWidth: '5rem' }}>
                <span style={{ fontFamily: 'var(--font-body)', fontSize: '0.95rem', color: 'var(--text-primary)' }}>
                  {u.username}
                </span>
                {isSelf(u) && (
                  <span style={{ fontFamily: 'var(--font-mono)', fontSize: '0.58rem', color: 'var(--text-dim)', marginLeft: '0.5rem', letterSpacing: '0.1em' }}>
                    YOU
                  </span>
                )}
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', marginLeft: 'auto' }}>
                <RoleChip label="Admin"  active={!!u.admin}  disabled={isSelf(u)} onClick={() => toggleRole(u, 'admin')} />
                <RoleChip label="GM"     active={!!u.gm}     onClick={() => toggleRole(u, 'gm')} />
                <RoleChip label="Player" active={!!u.player} onClick={() => toggleRole(u, 'player')} />
                <ActionMenu
                  items={[
                    { label: 'Reset Password', onClick: () => resetPassword(u) },
                    !isSelf(u) && { label: 'Delete', danger: true, onClick: () => removeUser(u) },
                  ]}
                />
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Create user — stays put below the (scrollable) list. */}
      <div style={{ marginTop: '1.25rem', paddingTop: '1rem', borderTop: '1px solid var(--border)' }}>
        <div style={{ fontFamily: 'var(--font-mono)', fontSize: '0.65rem', color: 'var(--text-dim)', letterSpacing: '0.12em', textTransform: 'uppercase', marginBottom: '0.6rem' }}>
          Create User
        </div>
        <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', marginBottom: '0.6rem' }}>
          <input
            placeholder="username"
            value={newName}
            onChange={e => setNewName(e.target.value)}
            style={{ ...inputStyle, flex: '1 1 8rem' }}
          />
          <input
            placeholder="password"
            type="password"
            value={newPass}
            onChange={e => setNewPass(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') createUser(); }}
            style={{ ...inputStyle, flex: '1 1 8rem' }}
          />
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', flexWrap: 'wrap' }}>
          <RoleChip label="Admin"  active={newRoles.admin}  onClick={() => setNewRoles(r => ({ ...r, admin: !r.admin }))} />
          <RoleChip label="GM"     active={newRoles.gm}     onClick={() => setNewRoles(r => ({ ...r, gm: !r.gm }))} />
          <RoleChip label="Player" active={newRoles.player} onClick={() => setNewRoles(r => ({ ...r, player: !r.player }))} />
          <button
            className="btn-primary"
            onClick={createUser}
            disabled={!canCreate}
            style={{ marginLeft: 'auto', opacity: canCreate ? 1 : 0.4 }}
          >
            {creating ? 'Creating…' : '+ Create'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Sheets tab ─────────────────────────────────────────────────────────────
// Loads the full registry via ?all=1 so disabled rows show up too. Each row
// exposes an enable/disable toggle and a delete action (registry-only — the
// bundle folder on disk is preserved). The Refresh button re-runs the bundle
// scan so a freshly dropped-in bundle folder shows up without a restart.
function AdminSheetsTab({ setError }) {
  const [sheets,     setSheets]     = useState([]);
  const [loading,    setLoading]    = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshMsg, setRefreshMsg] = useState('');

  const load = async () => {
    const data = await api.getAllSheets();
    if (data?.error) {
      setError(data.error);
      setSheets([]);
    } else {
      setSheets(Array.isArray(data) ? data : []);
    }
    setLoading(false);
  };

  useEffect(() => { load(); /* eslint-disable-next-line */ }, []);

  // Alphabetical by name. No self-pinning concept here — every row is equal.
  const ordered = useMemo(
    () => [...sheets].sort((a, b) => (a.name || '').localeCompare(b.name || '')),
    [sheets]
  );

  const refresh = async () => {
    setRefreshing(true);
    setRefreshMsg('');
    const res = await api.refreshSheets();
    setRefreshing(false);
    if (res?.error) {
      setError(res.error);
      return;
    }
    // Re-pull the registry to pick up any new rows the scan added.
    await load();
    const added = res?.added?.length || 0;
    setRefreshMsg(added ? `Found ${added} new bundle${added === 1 ? '' : 's'}.` : 'No new bundles found.');
    // Fade the toast after a few seconds so it doesn't sit there forever.
    setTimeout(() => setRefreshMsg(''), 3500);
  };

  const toggleEnabled = async (s) => {
    const next = !s.enabled;
    setSheets(prev => prev.map(x => x.sheetId === s.sheetId ? { ...x, enabled: next } : x)); // optimistic
    const res = await api.setSheetEnabled(s.sheetId, next);
    if (res?.error) {
      setSheets(prev => prev.map(x => x.sheetId === s.sheetId ? { ...x, enabled: !next } : x)); // revert
      setError(res.error);
    }
  };

  const remove = async (s) => {
    // Two distinct cases. If the folder is on disk, this is a true destructive
    // delete (bundle + registry row gone, characters using it stop rendering).
    // If the folder was already missing, we're just cleaning up an orphan row.
    const msg = s.present
      ? `Delete "${s.name}"?\n\nThis removes the bundle folder AND its registry entry. Any character built on this sheet will fail to render. This cannot be undone.`
      : `Remove "${s.name}" from the registry?\n\nThe bundle folder is already gone — this just clears the orphan row.`;
    if (!window.confirm(msg)) return;
    const res = await api.deleteSheet(s.sheetId);
    if (res?.ok) setSheets(prev => prev.filter(x => x.sheetId !== s.sheetId));
    else setError(res?.error || 'Could not remove sheet.');
  };

  return (
    <div>
      {/* Refresh action — discovers new bundle folders without a restart. */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', marginBottom: '0.7rem' }}>
        <button
          type="button"
          className="btn-ghost"
          onClick={refresh}
          disabled={refreshing}
          style={{ opacity: refreshing ? 0.6 : 1 }}
        >
          {refreshing ? 'Scanning…' : 'Refresh Bundles'}
        </button>
        {refreshMsg && (
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: '0.7rem', color: 'var(--text-dim)' }}>
            {refreshMsg}
          </span>
        )}
      </div>

      {loading ? (
        <div style={{ color: 'var(--text-dim)', fontSize: '0.9rem' }}>Loading sheets…</div>
      ) : ordered.length === 0 ? (
        <div style={{ color: 'var(--text-dim)', fontSize: '0.85rem' }}>
          No bundles registered. Drop a bundle folder into <code>/bundles</code> and Refresh.
        </div>
      ) : (
        <div style={{
          display: 'flex',
          flexDirection: 'column',
          gap: '0.5rem',
          maxHeight: 'clamp(12rem, 45vh, 26rem)',
          overflowY: 'auto',
          paddingRight: ordered.length > 4 ? '0.25rem' : 0,
        }}>
          {ordered.map(s => (
            <div
              key={s.sheetId}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '0.75rem',
                flexWrap: 'wrap',
                padding: '0.6rem 0.75rem',
                background: 'var(--bg-raised)',
                border: '1px solid var(--border)',
                borderRadius: '2px',
                flex: '0 0 auto',
                // Visually dim disabled rows so the state reads at a glance
                // even when the toggle is off-screen on a narrow modal.
                opacity: s.enabled ? 1 : 0.55,
              }}
            >
              <div style={{ minWidth: '8rem', flex: '1 1 auto' }}>
                <div style={{ fontFamily: 'var(--font-body)', fontSize: '0.95rem', color: 'var(--text-primary)' }}>
                  {s.name}
                  {!s.present && (
                    <span title="Bundle folder not found on disk — only registry row remains"
                      style={{
                        fontFamily: 'var(--font-mono)', fontSize: '0.55rem',
                        color: 'var(--red)', marginLeft: '0.5rem',
                        letterSpacing: '0.1em', textTransform: 'uppercase',
                      }}>
                      MISSING
                    </span>
                  )}
                </div>
                <div style={{ fontFamily: 'var(--font-mono)', fontSize: '0.6rem', color: 'var(--text-dim)', marginTop: '2px' }}>
                  v{s.version || '0.0.0'} · {s.folder}/
                </div>
              </div>

              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginLeft: 'auto' }}>
                {/* Toggle reuses the same switch shape as the settings-tab toggles. */}
                <button type="button" onClick={() => toggleEnabled(s)} role="switch" aria-checked={!!s.enabled}
                  title={s.enabled ? 'Enabled — visible in New Character' : 'Disabled — hidden from New Character'}
                  style={{
                    flexShrink: 0, width: '2.6rem', height: '1.4rem', borderRadius: '1rem', cursor: 'pointer',
                    border: '1px solid ' + (s.enabled ? 'var(--accent)' : 'var(--border)'),
                    background: s.enabled ? 'var(--accent-glow)' : 'var(--bg-input)',
                    position: 'relative', transition: 'all 0.15s',
                  }}>
                  <span style={{
                    position: 'absolute', top: '50%', transform: 'translateY(-50%)',
                    left: s.enabled ? 'calc(100% - 1.15rem)' : '0.15rem',
                    width: '1rem', height: '1rem', borderRadius: '50%',
                    background: s.enabled ? 'var(--accent)' : 'var(--text-dim)',
                    transition: 'all 0.15s',
                  }} />
                </button>
                <ActionMenu items={[{ label: 'Delete', danger: true, onClick: () => remove(s) }]} />
              </div>
            </div>
          ))}
        </div>
      )}

      <div style={{ marginTop: '0.9rem', fontFamily: 'var(--font-mono)', fontSize: '0.6rem', color: 'var(--text-dim)', lineHeight: 1.6 }}>
        Disable hides a bundle from the New Character picker — existing characters
        that use it keep working. Delete removes both the bundle folder and the
        registry row; any character built on a deleted bundle will fail to render.
      </div>
    </div>
  );
}

// ── Shell ──────────────────────────────────────────────────────────────────
function AdminModal({ currentUser, onClose }) {
  const [tab,      setTab]      = useState('settings');
  const [error,    setError]    = useState('');
  const [settings, setSettings] = useState({ theme: 'tavern', allowExternalLinks: false, allowAttachments: false });

  // Settings load lives in the shell because both the Settings tab and any
  // future tab might want to read app-level config. Tab components receive
  // settings via props rather than each fetching them independently.
  useEffect(() => {
    api.getSettings().then(s => { if (s && !s.error) setSettings(s); }).catch(() => {});
  }, []);

  return (
    <Modal
      title="Admin Panel"
      subtitle="Settings · Users · Sheets"
      onClose={onClose}
      hideCancel
      footer={<button className="btn-ghost" onClick={onClose}>Close</button>}
    >
      <AdminTabs active={tab} onChange={setTab} />

      {error && (
        <div style={{ color: 'var(--red)', fontSize: '0.85rem', marginBottom: '0.75rem' }}>{error}</div>
      )}

      {tab === 'settings' && (
        <AdminSettingsTab settings={settings} setSettings={setSettings} setError={setError} />
      )}
      {tab === 'users' && (
        <AdminUsersTab currentUser={currentUser} setError={setError} />
      )}
      {tab === 'sheets' && (
        <AdminSheetsTab setError={setError} />
      )}
    </Modal>
  );
}

function CampaignsModal({ onClose, onStatusChange }) {
  const [campaigns, setCampaigns] = useState([]);
  const [sheets,    setSheets]    = useState([]);
  const [loading,   setLoading]   = useState(true);
  const [creating,  setCreating]  = useState(false);
  const [newName,   setNewName]   = useState('');
  const [newSheet,  setNewSheet]  = useState('');
  const [showArchived, setShowArchived] = useState(false);

  useEffect(() => {
    Promise.all([
      fetch('/api/campaigns', { credentials: 'include' }).then(r => r.json()),
      fetch('/api/sheets',    { credentials: 'include' }).then(r => r.json()),
    ]).then(([camps, sh]) => {
      setCampaigns(camps);
      const enabled = sh.filter(s => s.enabled !== false);
      setSheets(enabled);
      if (enabled.length === 1) setNewSheet(enabled[0].sheetId);
      setLoading(false);
    }).catch(() => setLoading(false));
  }, []);

  const handleCreate = async () => {
    if (!newName.trim()) return;
    const sheet = sheets.find(s => s.sheetId === newSheet);
    const res   = await fetch('/api/campaigns', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: newName.trim(), sheetId: sheet?.sheetId || null, sheetName: sheet?.name || null }),
    });
    if (res.ok) {
      const campaign = await res.json();
      setCampaigns(prev => [...prev, campaign]);
      setNewName('');
      setCreating(false);
    }
  };

  const handleDelete = async (id) => {
    if (!window.confirm('Delete this campaign?')) return;
    await fetch(`/api/campaigns/${id}`, { method: 'DELETE', credentials: 'include' });
    setCampaigns(prev => prev.filter(c => c.id !== id));
  };

  const handleArchive = async (id, status) => {
    const res = await api.setCampaignStatus(id, status);
    if (res && res.status) {
      setCampaigns(prev => prev.map(c => (c.id === id ? { ...c, status } : c)));
      onStatusChange?.(id, status);   // keep the roster grouping in sync
    }
  };

  const active   = campaigns.filter(c => c.status !== 'archived');
  const archived = campaigns.filter(c => c.status === 'archived');

  const renderRow = (c) => (
    <div key={c.id} style={{
      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      padding: '0.6rem 0.75rem',
      border: '1px solid var(--border)',
      borderRadius: '2px',
      background: 'var(--bg-raised)',
    }}>
      <div style={{ opacity: c.status === 'archived' ? 0.55 : 1 }}>
        <div style={{ fontFamily: 'var(--font-body)', fontSize: '0.95rem', color: 'var(--text-primary)' }}>{c.name}</div>
        {(c.sheetName || c.status === 'archived') && (
          <div style={{ fontFamily: 'var(--font-mono)', fontSize: '0.65rem', color: 'var(--text-dim)', marginTop: '0.15rem' }}>
            {c.sheetName}
            {c.status === 'archived' && (
              <span style={{ letterSpacing: '0.1em', textTransform: 'uppercase' }}>{c.sheetName ? ' · ' : ''}Archived</span>
            )}
          </div>
        )}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
        <div style={{ textAlign: 'right', opacity: c.status === 'archived' ? 0.55 : 1 }}>
          <div style={{ fontFamily: 'var(--font-mono)', fontSize: '0.6rem', color: 'var(--text-dim)', letterSpacing: '0.05em' }}>Join Code</div>
          <div style={{ fontFamily: 'var(--font-mono)', fontSize: '0.9rem', color: 'var(--accent)', letterSpacing: '0.15em', fontWeight: 700 }}>{c.joinCode}</div>
        </div>
        <ActionMenu items={[
          { label: c.status === 'archived' ? 'Restore' : 'Archive',
            onClick: () => handleArchive(c.id, c.status === 'archived' ? 'active' : 'archived') },
          { label: 'Delete', danger: true, onClick: () => handleDelete(c.id) },
        ]} />
      </div>
    </div>
  );

  return (
    <Modal
      title="Campaigns"
      subtitle="GM Panel"
      onClose={onClose}
      hideCancel={creating}
      footer={creating ? null : (
        <button className="btn-primary" onClick={() => setCreating(true)}>+ Create Campaign</button>
      )}
    >
      {loading && <div style={{ color: 'var(--text-dim)', fontFamily: 'var(--font-mono)', fontSize: '0.8rem' }}>Loading…</div>}

      {!loading && campaigns.length === 0 && !creating && (
        <div style={{ color: 'var(--text-dim)', fontSize: '0.9rem', textAlign: 'center', padding: '1rem 0' }}>
          No campaigns yet.
        </div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem', marginBottom: creating ? '1rem' : 0 }}>
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
              Archived Campaigns ({archived.length})
            </button>
            {showArchived && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem', marginTop: '0.4rem' }}>
                {archived.map(renderRow)}
              </div>
            )}
          </div>
        )}
      </div>

      {creating && (
        <div style={{ border: '1px solid var(--border)', borderRadius: '2px', padding: '1rem', background: 'var(--bg-raised)' }}>
          <div style={{ fontFamily: 'var(--font-mono)', fontSize: '0.65rem', color: 'var(--text-dim)', letterSpacing: '0.1em', textTransform: 'uppercase', marginBottom: '0.75rem' }}>New Campaign</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
            <div>
              <label style={{ fontFamily: 'var(--font-mono)', fontSize: '0.65rem', color: 'var(--text-dim)', display: 'block', marginBottom: '0.25rem' }}>Campaign Name</label>
              <input type="text" value={newName} onChange={e => setNewName(e.target.value)}
                placeholder="e.g. The Shattered Throne" style={inputStyle}
                onKeyDown={e => e.key === 'Enter' && handleCreate()} autoFocus />
            </div>
            {sheets.length > 1 && (
              <div>
                <label style={{ fontFamily: 'var(--font-mono)', fontSize: '0.65rem', color: 'var(--text-dim)', display: 'block', marginBottom: '0.25rem' }}>Game System</label>
                <select value={newSheet} onChange={e => setNewSheet(e.target.value)} style={inputStyle}>
                  <option value="">— Any system —</option>
                  {sheets.map(s => <option key={s.sheetId} value={s.sheetId}>{s.name}</option>)}
                </select>
              </div>
            )}
            <div style={{ display: 'flex', gap: '0.5rem' }}>
              <button className="btn-primary" onClick={handleCreate} disabled={!newName.trim()}>Create</button>
              <button className="btn-ghost" onClick={() => { setCreating(false); setNewName(''); }}>Cancel</button>
            </div>
          </div>
        </div>
      )}
    </Modal>
  );
}

// ─── Add to Campaign Modal ────────────────────────────────────────────────────
function AddCampaignModal({ character, onJoin, onCancel }) {
  const [code,  setCode]  = useState('');
  const [error, setError] = useState('');
  const [busy,  setBusy]  = useState(false);

  const submit = async () => {
    const trimmed = code.trim();
    if (!trimmed || busy) return;
    setBusy(true); setError('');
    const res = await api.joinCampaign(character.id, trimmed);
    setBusy(false);
    if (res && res.campaignId) {
      onJoin(character.id, res.campaignId, res.campaignName);
    } else {
      setError(res?.error || 'Could not join — check the code and try again.');
    }
  };

  return (
    <Modal title="Add to Campaign" subtitle={character.name || 'Character'} onClose={onCancel} footer={
      <button className="btn-primary" onClick={submit} disabled={!code.trim() || busy}
        style={{ opacity: code.trim() && !busy ? 1 : 0.4 }}>
        {busy ? 'Joining…' : 'Join Campaign'}
      </button>
    }>
      <label style={{ fontFamily: 'var(--font-mono)', fontSize: '0.65rem', color: 'var(--text-dim)', display: 'block', marginBottom: '0.3rem', letterSpacing: '0.1em', textTransform: 'uppercase' }}>
        Invite Code
      </label>
      <input type="text" value={code}
        onChange={e => { setCode(e.target.value); setError(''); }}
        onKeyDown={e => e.key === 'Enter' && submit()}
        placeholder="e.g. JQ2YER" style={inputStyle} autoFocus />
      {error && <div style={{ color: 'var(--red)', fontSize: '0.8rem', marginTop: '0.5rem' }}>{error}</div>}
    </Modal>
  );
}

// ─── Status Modal ─────────────────────────────────────────────────────────────
// Single entry point for taking a character off-roster (or re-classifying one
// that already is). Mirrors the planned Export modal pattern: one menu item
// in the dropdown, one modal here that picks the flavor.
//
// The options deliberately omit "Active" — restoring is handled by the
// dedicated Restore menu item so the common case stays one click. The modal
// is for the off-roster choices only.
function StatusModal({ character, onSelect, onCancel }) {
  const options = [
    { value: 'active',   label: 'Active',   desc: 'On the roster, currently playable', Icon: PlayIcon   },
    { value: 'inactive', label: 'Inactive', desc: 'On hold, no specific ending',       Icon: PauseIcon  },
    { value: 'deceased', label: 'Deceased', desc: 'Died in play',                      Icon: SkullIcon  },
    { value: 'retired',  label: 'Retired',  desc: 'Lived to retire',                   Icon: SunsetIcon },
    { value: 'shelved',  label: 'Shelved',  desc: 'Created but never played',          Icon: BoxIcon    },
  ];

  // Title shifts with intent: from active it's "Archive", from any off-roster
  // status it's "Change Status" — same modal, accurate framing either way.
  const active = !character.status || character.status === 'active';
  const title  = active ? 'Archive Character' : 'Change Status';

  return (
    <Modal title={title} subtitle={character.name || 'Character'} onClose={onCancel}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
        {options.map(opt => {
          const isCurrent =
            character.status === opt.value ||
            (opt.value === 'inactive' && character.status === 'archived');
          const Glyph = opt.Icon;
          return (
            <div
              key={opt.value}
              onClick={() => !isCurrent && onSelect(opt.value)}
              style={{
                padding: '0.75rem 0.9rem',
                border: '1px solid var(--border)',
                borderRadius: '2px',
                background: 'var(--bg-raised)',
                cursor: isCurrent ? 'default' : 'pointer',
                opacity: isCurrent ? 0.45 : 1,
                display: 'flex',
                alignItems: 'center',
                gap: '0.75rem',
              }}
              onMouseEnter={e => { if (!isCurrent) e.currentTarget.style.borderColor = 'var(--border-bright)'; }}
              onMouseLeave={e => { e.currentTarget.style.borderColor = 'var(--border)'; }}
            >
              <span style={{ color: 'var(--text-dim)', display: 'inline-flex' }}>
                <Glyph size={20} />
              </span>
              <div style={{ flex: 1 }}>
                <div style={{
                  fontFamily: 'var(--font-body)',
                  fontSize: '0.95rem',
                  color: 'var(--text-primary)',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '0.5rem',
                }}>
                  {opt.label}
                  {isCurrent && (
                    <span style={{
                      fontFamily: 'var(--font-mono)',
                      fontSize: '0.6rem',
                      color: 'var(--text-dim)',
                      letterSpacing: '0.1em',
                      textTransform: 'uppercase',
                    }}>
                      current
                    </span>
                  )}
                </div>
                <div style={{
                  fontFamily: 'var(--font-mono)',
                  fontSize: '0.7rem',
                  color: 'var(--text-dim)',
                  marginTop: '0.15rem',
                }}>
                  {opt.desc}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </Modal>
  );
}

// ─── CharacterList ────────────────────────────────────────────────────────────
// Wrap the matched substring in a highlight span. Uses indexOf (not a RegExp)
// so any term — including regex metacharacters — is safe and needs no escaping,
// mirroring the server's substring-only matching. Returns an array of nodes.
function highlightMatch(text, term) {
  if (!text || !term) return text;
  const i = text.toLowerCase().indexOf(term.toLowerCase());
  if (i < 0) return text;
  return [
    text.slice(0, i),
    <mark key="hl" style={{ background: 'var(--accent-glow)', color: 'var(--text-primary)', borderRadius: '2px', padding: '0 0.1rem' }}>
      {text.slice(i, i + term.length)}
    </mark>,
    text.slice(i + term.length),
  ];
}

// ── Roster cache ─────────────────────────────────────────────────────────────
// Lives outside the component so it survives unmount/remount (e.g. navigating
// into a sheet and swiping back). On first load it's null → show spinner.
// On return, the cached data renders instantly while a background refresh runs.
let rosterCache = null;

export default function CharacterList({ onSelect, onNew, user, onUser, onLogout }) {
  const [chars,         setChars]         = useState(rosterCache?.chars     ?? []);
  const [campaigns,     setCampaigns]     = useState(rosterCache?.campaigns ?? []);
  const [loading,       setLoading]       = useState(rosterCache === null);
  const [showNewModal,  setShowNewModal]  = useState(false);
  const [showCampaigns, setShowCampaigns] = useState(false);
  const [showAdmin,     setShowAdmin]     = useState(false);
  const [showAppearance, setShowAppearance] = useState(false);
  const [renamingChar,  setRenamingChar]  = useState(null); // character object being renamed
  const [creating,      setCreating]      = useState(false);
  const [showArchived,  setShowArchived]  = useState(
    () => sessionStorage.getItem('ck-showArchived') === 'true'
  );
  const [showArchivedCampaigns, setShowArchivedCampaigns] = useState(false);
  const [joiningChar,   setJoiningChar]   = useState(null); // character being added to a campaign
  const [sharingChar,   setSharingChar]   = useState(null); // character whose share links are being managed
  const [archivingChar, setArchivingChar] = useState(null);
  const [imgExport,     setImgExport]     = useState(null);

  // ── Search ──────────────────────────────────────────────────────────────
  const [searchOpen,    setSearchOpen]    = useState(false);             // band expanded?
  const [query,         setQuery]         = useState('');
  const [results,       setResults]       = useState([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchSort,    setSearchSort]    = useState('relevance');       // 'relevance' | 'date'
  const searchInputRef = useRef(null);

  const [loadError,     setLoadError]     = useState(null);

  // ── Roster loader — stable callback so the Retry button can re-invoke it ──
  // AbortController + 10s timeout converts a forever-stuck fetch (PWA returning
  // from background, transient 502, session loss) into a real rejection, so the
  // UI can never be stranded in "Loading…" indefinitely. The .catch() branch
  // always calls setLoading(false), guaranteeing the spinner clears on failure.
  const loadRoster = useCallback(() => {
    setLoading(true);
    setLoadError(null);
    const ac = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      ac.abort();
    }, 10000);

    Promise.all([
      api.getCharacters(),
      fetch('/api/campaigns', { credentials: 'include', signal: ac.signal }).then(r => r.json()).catch(() => []),
    ]).then(([c, camps]) => {
      clearTimeout(timer);
      if (!Array.isArray(c)) {
        setLoadError(c?.status === 401
          ? 'Your session has expired. Force-close and reopen the app to log in again.'
          : 'Could not load characters.');
        setLoading(false);
        return;
      }
      const chars = Array.isArray(c) ? c : [];
      const campaigns = Array.isArray(camps) ? camps : [];
      rosterCache = { chars, campaigns };
      setChars(c);
      setCampaigns(Array.isArray(camps) ? camps : []);
      setLoading(false);
    }).catch((err) => {
      clearTimeout(timer);
      if (err?.name === 'AbortError' && !timedOut) return;
      setLoadError(timedOut
        ? 'The server didn\'t respond. Check your connection and try again.'
        : (err?.message || 'Could not load characters.'));
      setLoading(false);
    });

    return () => { clearTimeout(timer); ac.abort(); };
  }, []);

  useEffect(() => loadRoster(), [loadRoster]);

  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === 'visible') loadRoster();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [loadRoster]);

  // Debounced search: each keystroke resets a 200ms timer, so we only hit the
  // server once typing pauses. A term under 2 chars clears results and skips the
  // call entirely (matches the endpoint's own floor). The cleanup cancels the
  // pending timer, so a fast typist never fires a stale request.
  useEffect(() => {
    const term = query.trim();
    if (term.length < 2) { setResults([]); setSearchLoading(false); return; }
    setSearchLoading(true);
    const t = setTimeout(async () => {
      const r = await api.search(term);
      setResults(Array.isArray(r) ? r : []);
      setSearchLoading(false);
    }, 200);
    return () => clearTimeout(t);
  }, [query]);

  const openSearch = () => {
    setSearchOpen(true);
    setTimeout(() => searchInputRef.current?.focus(), 0);  // after the box paints
  };
  // Collapse only when empty — an active query keeps the band open so clicking
  // away doesn't throw away the results.
  const collapseSearch = () => { if (!query.trim()) setSearchOpen(false); };

  const handleModalConfirm = async (sheet, name) => {
    setShowNewModal(false);
    setCreating(true);

    const id     = newId(name);
    const schema = await fetch(`/api/sheets/${sheet.sheetId}/schema`, { credentials: 'include' }).then(r => r.json());
    const blank  = {
      ...schema.emptyCharacter,
      id,
      info: { ...(schema.emptyCharacter.info || {}), name },
      sheetId:   sheet.sheetId,
      sheetName: sheet.name,
    };

    await api.saveCharacter(id, blank);
    setCreating(false);
    onNew(id);
  };

  const handleRenameConfirm = (oldId, newId, newName) => {
    setChars(prev => prev.map(c =>
      c.id === oldId ? { ...c, id: newId, name: newName } : c
    ));
    setRenamingChar(null);
  };

  const [exporting, setExporting] = useState(null); // { char, name }

  const handleExport = async (c) => {
    // Rolls live outside the character envelope (see server.js's roll-log
    // comment), so they need their own fetch alongside the character. A
    // failed rolls fetch shouldn't block the export — worst case the zip
    // just has no roll history.
    const [full, rolls] = await Promise.all([
      api.getCharacter(c.id),
      api.getRolls(c.id).catch(() => []),
    ]);
    if (!full || full.error) { window.alert('Could not load that character to export.'); return; }
    setExporting({ char: full, name: c.name || 'character', rolls: Array.isArray(rolls) ? rolls : [] });
  };
  
  // const handleExport = async (c) => {
  //   const res = await api.exportCharacter(c.id);
  //   if (!res.ok) { window.alert('Export failed. Please try again.'); return; }

  //   const blob = await res.blob();

  //   // The server names the file (it knows whether it sent .json or .zip), so we
  //   // pull the filename from Content-Disposition and only fall back to a slug if
  //   // the header is somehow missing.
  //   const cd = res.headers.get('Content-Disposition') || '';
  //   const m  = /filename="?([^"]+)"?/.exec(cd);
  //   const filename = m ? m[1] : `${slugify(c.name)}.json`;

  //   // Same Blob trick the "View Raw JSON" button uses, but with a real download
  //   // instead of window.open: throwaway <a download>, click, release the URL.
  //   const url = URL.createObjectURL(blob);
  //   const a   = document.createElement('a');
  //   a.href = url;
  //   a.download = filename;
  //   document.body.appendChild(a);
  //   a.click();
  //   a.remove();
  //   URL.revokeObjectURL(url);
  // };

  // const handleExportImage = async (c, mode = 'tabs') => {
  //   const full = await api.getCharacter(c.id);
  //   if (!full || full.error) { window.alert('Could not load that character to export.'); return; }
  //   setImgExport({ char: full, name: c.name || 'character', mode });
  // };

  const handleDelete = async (e, id) => {
    e.stopPropagation();
    if (!window.confirm('Delete this character?')) return;
    await api.deleteCharacter(id);
    setChars(prev => prev.filter(c => c.id !== id));
  };

  const isGM = user?.gm || user?.admin;
  const sortBy = user?.sortBy || 'updatedAt';
  
  const ownedCampaigns = campaigns
    .filter(c => c.ownedBy === user?.username)
    .map(camp => ({
      ...camp,
      characters: sortChars(chars.filter(c => c.campaignId === camp.id), sortBy),
    }));

  const gmCampaigns       = ownedCampaigns.filter(c => c.status !== 'archived');
  const archivedCampaigns = ownedCampaigns.filter(c => c.status === 'archived');

  // BOTH active and archived owned campaigns are rendered somewhere, so their
  // characters stay grouped and never leak into Free Agents.
  const shownCampaignIds = new Set(ownedCampaigns.map(c => c.id));

  const ungrouped  = chars.filter(c => !c.campaignId || !shownCampaignIds.has(c.campaignId));
  const myChars    = sortChars(ungrouped.filter(c => c.owner === user?.username), sortBy);
  const otherChars = sortChars(ungrouped.filter(c => c.owner !== user?.username), sortBy);

  const myActive   = myChars.filter(c =>  isActive(c.status));
  const myInactive = myChars.filter(c => !isActive(c.status));


  async function handleStatus(id, status) {
  await api.setCharacterStatus(id, status);
  setChars(prev => prev.map(c => (c.id === id ? { ...c, status } : c)));
  }

  const handleLeaveCampaign = async (c) => {
    if (!window.confirm(`Remove "${c.name || 'this character'}" from ${c.campaignName || 'its campaign'}?`)) return;
    const res = await api.leaveCampaign(c.id);
    if (res && 'campaignId' in res) {
      // If we'll still see this character afterward (we own it, or we're an admin
      // who sees everything), keep it and let it re-group. Otherwise we only had
      // visibility because it was in our campaign — drop it from the list, matching
      // what a refresh would show.
      const stillVisible = c.owner === user?.username;
      setChars(prev => stillVisible
        ? prev.map(x => (x.id === c.id ? { ...x, campaignId: null, campaignName: null } : x))
        : prev.filter(x => x.id !== c.id));
    }
  };

  const handleJoinDone = (id, campaignId, campaignName) => {
    setChars(prev => prev.map(c => (c.id === id ? { ...c, campaignId, campaignName } : c)));
    setJoiningChar(null);
  };
  // "My Characters" = anything not already shown inside a campaign group.
  // The second clause is the fix: a player owns no campaign groups, so their
  // campaign-tagged character falls back to here instead of vanishing.
  // !!! const ownChars = chars.filter(c => !c.campaignId || !shownCampaignIds.has(c.campaignId))

  const CharCard = ({ c, canManage = true, canRemoveCampaign = false, onStatus }) => {
    // Build the menu per viewer/character. An owner (or admin) gets the full set;
    // a GM/admin viewing a campaign member they don't own gets ONLY the eject
    // action. No items → ActionMenu renders nothing.
    const items = [];
    if (canManage) {
      items.push({ label: 'Rename', onClick: () => setRenamingChar(c) });
      items.push({ label: 'Share',  onClick: () => setSharingChar(c) });
      if (onStatus) {
        if (isActive(c.status)) {
          // One entry point — the modal handles the four off-roster choices.
          items.push({ label: 'Archive…', onClick: () => setArchivingChar(c) });
        } else {
          items.push({ label: 'Change Status…', onClick: () => setArchivingChar(c) });
        }
      }
      items.push(c.campaignId
        ? { label: 'Remove from Campaign', onClick: () => handleLeaveCampaign(c) }
        : { label: 'Add to Campaign',      onClick: () => setJoiningChar(c) });
      // items.push({ label: 'Export Image (test)', onClick: () => handleExportImage(c, 'single') });
      // items.push({ label: 'Export Tabs (test)',  onClick: () => handleExportImage(c, 'tabs') });
      // items.push({ label: 'Export Images (.zip)', onClick: () => handleExportImage(c, 'zip') });
      // items.push({ label: 'Export Sessions (.md)', onClick: () => handleExportSessions(c) });
      // items.push({ label: 'Export JSON', onClick: () => handleExport(c) });
      items.push({ label: 'Export', onClick: () => handleExport(c) });
      items.push({ label: 'Delete', danger: true, onClick: (e) => handleDelete(e, c.id) });
    } else if (canRemoveCampaign && c.campaignId) {
      items.push({ label: 'Remove from Campaign', onClick: () => handleLeaveCampaign(c) });
    }

    return (
      <div className="char-card" key={c.id} onClick={() => onSelect(c.id)} style={{ marginBottom: '0.5rem' }}>
        <div>
          <div className="char-name">{c.name || 'Unnamed Character'}</div>
          <div className="char-meta">
            <span>{c.sheetName || ''}</span>
            {c.owner && c.owner !== user?.username && (
              <span style={{ color: 'var(--accent)', marginLeft: '0.4rem' }}>· {c.owner}</span>
            )}
            {(() => {
              const meta = statusMeta(c.status);
              if (!meta.Icon) return null;
              const Glyph = meta.Icon;
              return (
                <span
                  title={meta.label}
                  aria-label={meta.label}
                  style={{
                    display: 'inline-flex',
                    verticalAlign: 'middle',
                    marginLeft: '0.4rem',
                    color: 'var(--text-dim)',
                  }}
                >
                  <Glyph size={13} />
                </span>
              );
            })()}
          </div>
        </div>

        {/* Right cluster: shared indicator · date · menu — pinned right as a unit,
            even when it wraps below the name on a narrow screen. */}
        <div style={{
          marginLeft: 'auto',
          display: 'flex',
          alignItems: 'center',
          gap: '0.5rem',
        }}>
          {c.hasActiveShare && (
            <span title="Has active share link" aria-label="Shared" style={{ display: 'inline-flex', color: 'var(--accent)' }}>
              <ShareIcon size={14} />
            </span>
          )}
          <div style={{ fontFamily: 'var(--font-mono)', fontSize: '0.65rem', color: 'var(--text-dim)', whiteSpace: 'nowrap' }}>
            {c.updatedAt ? new Date(c.updatedAt).toLocaleDateString() : ''}
          </div>
          <ActionMenu items={items} />
        </div>
      </div>
    );
  };

  return (
    <div style={{ maxWidth: 720, margin: '0 auto', padding: '2rem 1rem' }}>

      {/* Header */}
      <div style={{ marginBottom: '2rem' }}>
        <div style={{ fontFamily: 'var(--font-mono)', fontSize: '0.65rem', color: 'var(--text-dim)', letterSpacing: '0.15em', textTransform: 'uppercase', marginBottom: '0.25rem' }}>
          Character Keeper
        </div>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '1rem' }}>
          <h1 style={{ fontSize: '1.8rem', color: 'var(--text-accent)', letterSpacing: '0.05em', lineHeight: 1.1 }}>Characters</h1>
          <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', flexWrap: 'wrap' }}>
            <button className="btn-primary" onClick={() => setShowNewModal(true)} disabled={creating}>
              {creating ? 'Creating…' : '+ New Character'}
            </button>
            <ActionMenu label={user?.username || 'Menu'} items={[
              user?.admin && { label: iconLabel(GearIcon, 'Admin'),       onClick: () => setShowAdmin(true) },
              isGM &&        { label: iconLabel(SwordsIcon, 'Campaigns'),  onClick: () => setShowCampaigns(true) },
              {                label: iconLabel(PaletteIcon, 'Appearance'), onClick: () => setShowAppearance(true) },
              {                label: iconLabel(SignOutIcon, 'Sign Out'),   onClick: onLogout },
            ]} />
          </div>
        </div>
      </div>

      {/* version line — hugs the divider just below it */}
      <VersionTag style={{ display: 'block', marginBottom: '0.4rem' }} />

      {/* divider */}
      <div style={{ height: '1px', background: 'linear-gradient(90deg, var(--accent), transparent)', marginBottom: '1.5rem' }} />

      {/* ── Search band ── collapses to a bare glyph; the frame grows out of it ── */}
      {(() => {
        const isSearching = query.trim().length >= 2;
        const sorted = searchSort === 'date'
          ? [...results].sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')))
          : results;
        const charCount = new Set(results.map(r => r.id)).size;
        const term = query.trim();

        return (
          <>
            <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: '1.5rem' }}>
              <div style={{
                position: 'relative', display: 'flex', alignItems: 'center',
                width: searchOpen ? '100%' : 38, height: 38,
                background: searchOpen ? 'var(--bg-input)' : 'transparent',
                border: `1px solid ${searchOpen ? 'var(--border-bright)' : 'transparent'}`,
                borderRadius: 'var(--radius)', overflow: 'hidden',
                boxShadow: searchOpen ? '0 0 0 1px var(--accent-glow)' : 'none',
                transition: 'width 220ms cubic-bezier(0.22,0.61,0.36,1), border-color 180ms ease, background-color 180ms ease',
              }}>
                <button
                  type="button"
                  aria-label="Search"
                  onClick={() => (searchOpen ? collapseSearch() : openSearch())}
                  onMouseEnter={e => { if (!searchOpen) e.currentTarget.style.color = 'var(--text-accent)'; }}
                  onMouseLeave={e => { if (!searchOpen) e.currentTarget.style.color = 'var(--text-secondary)'; }}
                  style={{
                    flex: '0 0 38px', width: 38, height: 38, display: 'flex',
                    alignItems: 'center', justifyContent: searchOpen ? 'center' : 'flex-end',
                    paddingRight: searchOpen ? 0 : 2, background: 'none', border: 'none',
                    cursor: searchOpen ? 'default' : 'pointer',
                    color: searchOpen ? 'var(--text-dim)' : 'var(--text-secondary)',
                  }}
                >
                  <SearchIcon size={16} />
                </button>
                <input
                  ref={searchInputRef}
                  type="text"
                  value={query}
                  onChange={e => setQuery(e.target.value)}
                  onBlur={collapseSearch}
                  onKeyDown={e => { if (e.key === 'Escape') { setQuery(''); setSearchOpen(false); e.currentTarget.blur(); } }}
                  placeholder="Search characters and session notes…"
                  autoComplete="off"
                  style={{
                    flex: '1 1 auto', minWidth: 0, background: 'none', border: 'none',
                    outline: 'none', boxShadow: 'none', color: 'var(--text-primary)', fontFamily: 'var(--font-body)',
                    fontSize: '0.95rem', padding: '0 0.2rem',
                    opacity: searchOpen ? 1 : 0, transition: 'opacity 140ms ease 90ms',
                  }}
                />
                {searchOpen && query && (
                  <button
                    type="button"
                    aria-label="Clear search"
                    onClick={() => { setQuery(''); searchInputRef.current?.focus(); }}
                    style={{ flex: '0 0 auto', background: 'none', border: 'none', color: 'var(--text-dim)', cursor: 'pointer', fontSize: '1.05rem', lineHeight: 1, padding: '0 0.7rem 0 0.3rem' }}
                  >
                    ✕
                  </button>
                )}
              </div>
            </div>

            {isSearching && (
              <div style={{ marginBottom: '1.5rem' }}>
                {/* Results bar: count on the left, sort toggle on the right */}
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '1rem', flexWrap: 'wrap', marginBottom: '0.75rem' }}>
                  <div style={{ fontFamily: 'var(--font-mono)', fontSize: '0.62rem', color: 'var(--text-dim)', letterSpacing: '0.1em', textTransform: 'uppercase' }}>
                    {searchLoading
                      ? 'Searching…'
                      : `${results.length} result${results.length === 1 ? '' : 's'} · ${charCount} character${charCount === 1 ? '' : 's'}`}
                  </div>
                  {results.length > 0 && (
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                      <span style={{ fontFamily: 'var(--font-mono)', fontSize: '0.58rem', color: 'var(--text-dim)', letterSpacing: '0.1em', textTransform: 'uppercase' }}>Sort</span>
                      {['relevance', 'date'].map(key => (
                        <button
                          key={key}
                          type="button"
                          onClick={() => setSearchSort(key)}
                          style={{
                            fontFamily: 'var(--font-mono)', fontSize: '0.6rem', letterSpacing: '0.06em', textTransform: 'uppercase',
                            background: searchSort === key ? 'var(--accent-glow)' : 'none',
                            border: `1px solid ${searchSort === key ? 'var(--accent-dim)' : 'var(--border)'}`,
                            borderRadius: '2px', color: searchSort === key ? 'var(--text-primary)' : 'var(--text-dim)',
                            padding: '0.2rem 0.5rem', cursor: 'pointer',
                          }}
                        >
                          {key === 'relevance' ? 'Relevance' : 'Newest'}
                        </button>
                      ))}
                    </div>
                  )}
                </div>

                {!searchLoading && results.length === 0 && (
                  <div style={{ color: 'var(--text-dim)', fontFamily: 'var(--font-body)', fontSize: '1rem', textAlign: 'center', padding: '2.5rem 1rem', border: '1px dashed var(--border)', borderRadius: '2px' }}>
                    No matches for “{term}”. Try a name, a concept, or a phrase from your session notes.
                  </div>
                )}

                {sorted.map((h, idx) => (
                  <div
                    key={`${h.id}-${h.label}-${h.item || ''}-${idx}`}
                    onClick={() => onSelect(h.id)}
                    style={{
                      background: 'var(--bg-surface)', border: '1px solid var(--border)',
                      borderLeft: '2px solid var(--accent-dim)', borderRadius: 'var(--radius)',
                      padding: '0.65rem 0.9rem', marginBottom: '0.5rem', cursor: 'pointer',
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'baseline', gap: '0.6rem' }}>
                      <span style={{ fontFamily: 'var(--font-display)', fontSize: '1rem', color: 'var(--text-accent)' }}>{h.name}</span>
                      <span style={{
                        fontFamily: 'var(--font-mono)', fontSize: '0.58rem', letterSpacing: '0.1em', textTransform: 'uppercase',
                        color: h.tier === 'notes' ? 'var(--accent)' : 'var(--text-dim)',
                        border: `1px solid ${h.tier === 'notes' ? 'var(--accent-dim)' : 'var(--border)'}`,
                        borderRadius: '2px', padding: '0.08rem 0.35rem',
                      }}>
                        {h.label}{h.item ? ` · ${h.item}` : ''}
                      </span>
                      <span style={{ marginLeft: 'auto', fontFamily: 'var(--font-mono)', fontSize: '0.6rem', color: 'var(--text-dim)', whiteSpace: 'nowrap' }}>
                        {h.date ? new Date(h.date).toLocaleDateString() : ''}
                      </span>
                    </div>
                    <div style={{ fontFamily: 'var(--font-body)', fontSize: '0.9rem', color: 'var(--text-secondary)', lineHeight: 1.4, marginTop: '0.25rem' }}>
                      {highlightMatch(h.snippet, term)}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </>
        );
      })()}

      {loadError && !(query.trim().length >= 2) && (
        <div style={{
          color: 'var(--text-dim)', fontFamily: 'var(--font-mono)', fontSize: '0.8rem',
          textAlign: 'center', padding: '2rem', border: '1px dashed var(--border)',
          borderRadius: '2px',
        }}>
          <div style={{ marginBottom: '0.75rem' }}>{loadError}</div>
          <button
            onClick={loadRoster}
            style={{
              fontFamily: 'var(--font-mono)', fontSize: '0.75rem',
              padding: '0.4rem 0.9rem', background: 'transparent',
              color: 'var(--accent)', border: '1px solid var(--accent-dim)',
              borderRadius: '2px', cursor: 'pointer',
            }}
          >
            Retry
          </button>
        </div>
      )}

      {loading && !loadError && !(query.trim().length >= 2) && (
        <div style={{ color: 'var(--text-dim)', fontFamily: 'var(--font-mono)', fontSize: '0.8rem', textAlign: 'center', padding: '2rem' }}>
          Loading...
        </div>
      )}

      {!loading && !(query.trim().length >= 2) && (
        <>
          {myChars.length === 0 && otherChars.length === 0 && gmCampaigns.length === 0 && (
            <div style={{ color: 'var(--text-dim)', fontFamily: 'var(--font-body)', fontSize: '1rem', textAlign: 'center', padding: '3rem 1rem', border: '1px dashed var(--border)', borderRadius: '2px' }}>
              No characters yet. Create one to begin.
            </div>
          )}

          {myActive.length > 0 && (
            <>
              <div style={{ fontFamily: 'var(--font-mono)', fontSize: '0.65rem', color: 'var(--text-dim)', letterSpacing: '0.12em', textTransform: 'uppercase', marginBottom: '0.5rem' }}>
                My Characters
              </div>
              {myActive.map(c => <CharCard key={c.id} c={c} canManage={c.owner === user?.username} onStatus={handleStatus}/>)}
            </>
          )}

          {otherChars.length > 0 && (
            <div style={{ marginTop: myChars.length > 0 ? '1.5rem' : 0 }}>
              <div style={{ fontFamily: 'var(--font-mono)', fontSize: '0.65rem', color: 'var(--text-dim)', letterSpacing: '0.12em', textTransform: 'uppercase', marginBottom: '0.5rem' }}>
                Free Agents
              </div>
              {otherChars.map(c => <CharCard key={c.id} c={c} canManage={c.owner === user?.username} />)}
            </div>
          )}

          {gmCampaigns.map(camp => (
            <div key={camp.id} style={{ marginTop: '1.5rem' }}>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: '0.75rem', marginBottom: '0.5rem' }}>
                <div style={{ fontFamily: 'var(--font-mono)', fontSize: '0.65rem', color: 'var(--text-dim)', letterSpacing: '0.12em', textTransform: 'uppercase' }}>
                  Campaign — {camp.name}
                </div>
                <div style={{ fontFamily: 'var(--font-mono)', fontSize: '0.6rem', color: 'var(--accent)', letterSpacing: '0.1em' }}>
                  {camp.joinCode}
                </div>
              </div>
              <div style={{ height: '1px', background: 'linear-gradient(90deg, var(--border), transparent)', marginBottom: '0.5rem' }} />
              {camp.characters.length === 0
                ? <div style={{ color: 'var(--text-dim)', fontFamily: 'var(--font-mono)', fontSize: '0.75rem', padding: '0.5rem 0' }}>No characters in this campaign yet.</div>
                : camp.characters.map(c => <CharCard key={c.id} c={c} canManage={c.owner === user?.username} canRemoveCampaign />)
              }
            </div>
          ))}

          {myInactive.length > 0 && (
            <div style={{ marginTop: '1.5rem' }}>
              <div
                onClick={() => setShowArchived(v => {
                  const next = !v;
                  sessionStorage.setItem('ck-showArchived', next);
                  return next;
                })}
                style={{ fontFamily: 'var(--font-mono)', fontSize: '0.65rem', color: 'var(--text-dim)', letterSpacing: '0.12em', textTransform: 'uppercase', marginBottom: '0.5rem', cursor: 'pointer', userSelect: 'none' }}
              >
                {showArchived ? '▾' : '▸'} Inactive ({myInactive.length})
              </div>
              {showArchived && (
                <>
                  <div style={{ height: '1px', background: 'linear-gradient(90deg, var(--border), transparent)', marginBottom: '0.5rem' }} />
                  {myInactive.map(c => <CharCard key={c.id} c={c} canManage={c.owner === user?.username} onStatus={handleStatus} />)}
                </>
              )}
            </div>
           )}

          {archivedCampaigns.length > 0 && (
            <div style={{ marginTop: '1.5rem' }}>
              <div
                onClick={() => setShowArchivedCampaigns(v => !v)}
                style={{ fontFamily: 'var(--font-mono)', fontSize: '0.65rem', color: 'var(--text-dim)', letterSpacing: '0.12em', textTransform: 'uppercase', marginBottom: '0.5rem', cursor: 'pointer', userSelect: 'none' }}
              >
                {showArchivedCampaigns ? '▾' : '▸'} Archived Campaigns ({archivedCampaigns.length})
              </div>
              {showArchivedCampaigns && archivedCampaigns.map(camp => (
                <div key={camp.id} style={{ marginTop: '1rem', opacity: 0.7 }}>
                  <div style={{ display: 'flex', alignItems: 'baseline', gap: '0.75rem', marginBottom: '0.5rem' }}>
                    <div style={{ fontFamily: 'var(--font-mono)', fontSize: '0.65rem', color: 'var(--text-dim)', letterSpacing: '0.12em', textTransform: 'uppercase' }}>
                      Campaign — {camp.name}
                    </div>
                    <div style={{ fontFamily: 'var(--font-mono)', fontSize: '0.6rem', color: 'var(--accent)', letterSpacing: '0.1em' }}>
                      {camp.joinCode}
                    </div>
                  </div>
                  <div style={{ height: '1px', background: 'linear-gradient(90deg, var(--border), transparent)', marginBottom: '0.5rem' }} />
                  {camp.characters.length === 0
                    ? <div style={{ color: 'var(--text-dim)', fontFamily: 'var(--font-mono)', fontSize: '0.75rem', padding: '0.5rem 0' }}>No characters in this campaign.</div>
                    : camp.characters.map(c => <CharCard key={c.id} c={c} canManage={c.owner === user?.username} canRemoveCampaign />)
                  }
                </div>
              ))}
            </div>
          )}
        </>
      )}

      {showNewModal && <NewCharacterModal onConfirm={handleModalConfirm} onCancel={() => setShowNewModal(false)} />}
      {showCampaigns && <CampaignsModal onClose={() => setShowCampaigns(false)} onStatusChange={(id, status) => setCampaigns(prev => prev.map(c => (c.id === id ? { ...c, status } : c)))} />}
      {showAdmin && <AdminModal currentUser={user} onClose={() => setShowAdmin(false)} />}
      {showAppearance && <AppearanceModal user={user} onUser={onUser} onClose={() => setShowAppearance(false)} />}
      {renamingChar && <RenameModal character={renamingChar} onConfirm={handleRenameConfirm} onCancel={() => setRenamingChar(null)} />}
      {joiningChar && <AddCampaignModal character={joiningChar} onJoin={handleJoinDone} onCancel={() => setJoiningChar(null)} />}
      {archivingChar && (
        <StatusModal
          character={archivingChar}
          onSelect={async (status) => {
            await handleStatus(archivingChar.id, status);
            setArchivingChar(null);
          }}
          onCancel={() => setArchivingChar(null)}
        />
      )}
      {sharingChar && (
        <ShareModal
          characterId={sharingChar.id}
          onClose={() => setSharingChar(null)}
          onChanged={(hasActive) => setChars(prev => prev.map(x => (x.id === sharingChar.id ? { ...x, hasActiveShare: hasActive } : x)))}
        />
      )}
      {exporting && (
        <>
          <Toast message="Building export…" />
          <ExportStage
            char={exporting.char}
            mode="tabs"
            onDone={async (result) => {
              try {
                const base = slugify(exporting.name);
                downloadBlob(await buildExportZip(base, result.tabs, exporting.char, exporting.rolls), `${base}.zip`);
              } catch (err) {
                window.alert('Export failed: ' + err.message);
              } finally {
                setExporting(null);
              }
            }}
            onError={(err) => { window.alert('Export failed: ' + err.message); setExporting(null); }}
          />
        </>
      )}
      {/* {imgExport && (
        <>
          <Toast message="Generating image…" />
          <ExportStage
            char={imgExport.char}
            mode={imgExport.mode === 'single' ? 'single' : 'tabs'}
            onDone={async (result) => {
              try {
                const base = slugify(imgExport.name);
                if (imgExport.mode === 'single') {
                  downloadBlob(result.blob, `${base}.png`);
                } else if (imgExport.mode === 'zip') {
                  const zipBlob = await buildImageZip(base, result.tabs, imgExport.char.portrait);
                  downloadBlob(zipBlob, `${base}.zip`);
                } else { // 'tabs' — loose files
                  result.tabs.forEach((t, i) => {
                    const suffix = t.label ? slugify(t.label) : String(i + 1);
                    setTimeout(() => downloadBlob(t.blob, `${base}-${suffix}.png`), i * 400);
                  });
                }
              } catch (err) {
                window.alert('Export failed: ' + err.message);
              } finally {
                setImgExport(null);
              }
            }}
            onError={(err) => { window.alert('Image export failed: ' + err.message); setImgExport(null); }}
          />
        </>
      )} */}

    </div>
  );
}
