// frontend/src/components/shared/WorldDetail.jsx
//
// The three-panel lore wiki for a single world ("Keep", step 3-4). Reached at
// /worlds/:id, GM-gated and owner-only (the server refuses a world you don't own).
//
// Three panels, progressively collapsed rather than a separate mobile layout:
//   1. Category rail  — the world name + its pack's lore categories.
//   2. Entry list     — the selected category's entries, a search box, a + to add.
//   3. Reader/editor  — read view (fog rendered as GM chips) or an Option-A
//                       labeled field form.
//
// On a phone it's one panel at a time (categories → list → entry) with a back
// chevron and a hamburger drawer — the owner runs games from a phone, so the
// drill-down is first-class, not an afterthought.
//
// Everything is theme-variable styled (no hardcoded colors) and everything talks
// to the server through the api.js wrappers. Lore bodies are user-authored, so
// they are ALWAYS rendered as React nodes (react-markdown + remarkKeep), NEVER
// dangerouslySetInnerHTML and never rehype-raw — literal HTML shows as text.

import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { api } from '../../api';
import { remarkKeep } from '../fog';
import { formatDate, diffDays, compareDates, calMonths, calEras, calWeekdays, weekdayOf } from '../calendarMath';
import WorldSettingsModal from './WorldSettingsModal';
import {
  MapPinIcon, UserIcon, FlagIcon, StarIcon, CalendarIcon, BuildingIcon,
  FileIcon, EyeOffIcon, ClockIcon, ChevronLeftIcon, PlusIcon, MenuIcon, HomeIcon,
  SearchIcon, GearIcon,
} from './Icons';

// ---- shared style atoms (local, mirroring Worlds.jsx / CharacterList) --------
const inputStyle = {
  width: '100%', background: 'var(--bg-input)', border: '1px solid var(--border)',
  borderRadius: '2px', padding: '0.4rem 0.6rem', color: 'var(--text-primary)',
  fontFamily: 'var(--font-body)', fontSize: '0.95rem', outline: 'none',
};
const labelStyle = {
  fontFamily: 'var(--font-mono)', fontSize: '0.65rem', color: 'var(--text-dim)',
  display: 'block', marginBottom: '0.25rem', letterSpacing: '0.05em',
};
const eyebrow = {
  fontFamily: 'var(--font-mono)', fontSize: '0.65rem', color: 'var(--text-dim)',
  letterSpacing: '0.15em', textTransform: 'uppercase',
};
// Denser action button (§4.10) — smaller padding/type than the default btn-*,
// but a ~30px min height so it stays a comfortable touch target.
const denseBtn = { padding: '0.25rem 0.6rem', fontSize: '0.78rem', minHeight: 30 };

const humanSize = (n) =>
  n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(0)} KB` : `${(n / 1048576).toFixed(1)} MB`;

// For a global-search hit (§4l), the secondary line under the entry name: the
// entry's subtitle when it has one, else a short snippet of the field text around
// the match so the searcher sees WHY it matched.
//
// The text is used as received, which is safe BY CONSTRUCTION: search runs over
// `allEntries`, i.e. the payload the server already ran through
// serializeEntryForRole. A read/propose viewer's fog was stripped before it left
// the server, so there is no fogged text here to leak; owner/coGM hold raw fog and
// are MEANT to match it — a GM searching their own notes should find hidden text.
//
// This only holds while search is client-side over the serialized payload. Any
// future server-side lore search MUST search the serialized entry, not the file.
// Shared by every search-result kind (lore entry, campaign, session): find `q`
// inside one string and return a trimmed, ellipsis-bounded snippet around the
// hit, with [[wiki|links]] collapsed to their display text (display only — not
// a security control, fog is already gone by the time any of this text is in
// hand). Returns '' when `q` isn't in `v`.
function snippetAround(v, q) {
  if (typeof v !== 'string') return '';
  const idx = v.toLowerCase().indexOf(q);
  if (idx < 0) return '';
  const start = Math.max(0, idx - 24);
  const end   = Math.min(v.length, idx + q.length + 48);
  const mid = v.slice(start, end).replace(/\s+/g, ' ').trim()
    .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '$2')
    .replace(/\[\[([^\]]+)\]\]/g, '$1');
  return (start > 0 ? '…' : '') + mid + (end < v.length ? '…' : '');
}

function matchSnippet(entry, q) {
  const sub = entry.fields?.subtitle;
  if (typeof sub === 'string' && sub.trim()) return sub.trim();
  const fields = entry.fields || {};
  for (const k of Object.keys(fields)) {
    if (k === 'subtitle') continue;                 // already handled above
    const hit = snippetAround(fields[k], q);
    if (hit) return hit;
  }
  return '';
}

// True if href points to a different origin than the app itself. Relative /
// same-origin links are never external. Mirrors SheetRenderer's helper so lore
// obeys the SAME admin "Allow external links" policy as character sheets.
function isExternalHref(href) {
  if (!href) return false;
  try {
    return new URL(href, window.location.origin).origin !== window.location.origin;
  } catch {
    return false;
  }
}

// Pack icon name → glyph. Unknown names fall back to a generic file icon, so a
// pack can't break the rail by declaring an icon we don't ship.
const ICONS = {
  'map-pin': MapPinIcon, user: UserIcon, flag: FlagIcon, star: StarIcon,
  calendar: CalendarIcon, building: BuildingIcon,
};
function CatIcon({ name, ...props }) {
  const G = ICONS[name] || FileIcon;
  return <G {...props} />;
}

// The two-state visibility model. Secrecy is BINARY and lives on the ENTRY;
// capability (read / propose / coGM) lives on the MEMBER. They are independent
// axes and must never be encoded as ranks on one scale — see backend/loreAccess.js.
// There is deliberately no per-entry tiering: fog provides intra-entry secrecy, so
// a GM can share an entry freely and still hide the parts that matter.
const VIS = {
  hidden: { label: 'Hidden', color: 'var(--neutral)'  },
  shared: { label: 'Shared', color: 'var(--positive)' },
};
const VIS_ORDER = ['hidden', 'shared'];

// Prep is a list of SCENES — "The Script" template (GM Note / Cinematic /
// Location / Who's There / Move It Forward / Dialog / Skill Checks / Big Clue),
// one card per scene, in run order. [key, label, hint] — the hint is the
// template's own prompt text, shown as a placeholder so the form teaches the
// method on first use. Rendered identically in the form and the read view.
const SESSION_SCENE_FIELDS_UI = [
  ['gmNote',        'GM Note',                 'Big, juicy fact for the GM only — motives, or world events influencing the scene.'],
  ['cinematic',      'Scene Cinematic',        'What does the establishing shot look, sound, smell, feel like?'],
  ['location',       'Location',               'Where is it? A few short facts — use the senses.'],
  ['whoThere',       "Who's There",            'NPCs? Monsters? A few facts each, and what MOTIVATES them — essential for improv.'],
  ['moveItForward',  'Move It Forward',        'Hazards, the pressure/threat, a doom clock — how it raises the stakes into the next scene.'],
  ['dialog',         'Dialog',                 "Essential lines only — don't overcook it. A couple of short one-liners."],
  ['skillChecks',    'Potential Checks',       'Environmental hazards? Charm/persuade? Perception/notice?'],
  ['bigClue',        'Big Clue to Reveal',     'Knowledge to move the plot along — without revealing everything. No roll required.'],
];
const emptyScene = () => ({
  name: '', gmNote: '', cinematic: '', location: '', whoThere: '',
  moveItForward: '', dialog: '', skillChecks: '', bigClue: '',
});
const emptySessionDraft = () => ({
  _id: null, number: null, title: '', date: '', inWorldDate: null, visibility: 'hidden',
  scenes: [], record: { recap: '', happened: '', clues: '', loot: '' },
  nextTime: '', encounters: [],
});

// Shown under the picker. "Shared" alone doesn't tell a GM that fog still protects
// them, which is the thing that makes sharing safe to do freely.
const VIS_HINT = {
  hidden: 'GMs only. Players cannot see this entry, or that it exists.',
  shared: 'Visible to every member. ||fog|| spans are still stripped for non-GMs.',
};

function VisibilityPill({ value }) {
  const v = VIS[value] || VIS.hidden;
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: '0.3rem',
      fontFamily: 'var(--font-mono)', fontSize: '0.6rem', letterSpacing: '0.08em',
      textTransform: 'uppercase', color: v.color,
      border: `1px solid ${v.color}`, borderRadius: '999px', padding: '0.15rem 0.5rem',
      whiteSpace: 'nowrap',
    }}>
      {value === 'hidden' && <EyeOffIcon size={11} />}
      {v.label}
    </span>
  );
}

// A fogged span: a "GM only" chip WITH the hidden text beside it (the GM must
// read their own hidden lore at the table) — never a solid redaction bar. The
// server-side stripFog() hook (fog.js) removes these entirely before a body ever
// reaches a read-tier player; that enforcement is a later step.
function FogChip({ children }) {
  return (
    <span style={{
      display: 'inline', background: 'var(--accent-glow)',
      border: '1px dashed var(--accent)', borderRadius: '3px',
      padding: '0 0.3rem', margin: '0 0.1rem',
    }}>
      <span style={{
        fontFamily: 'var(--font-mono)', fontSize: '0.55rem', color: 'var(--accent)',
        letterSpacing: '0.08em', textTransform: 'uppercase', marginRight: '0.35rem',
        verticalAlign: 'middle',
      }}>GM only</span>
      <span style={{ color: 'var(--text-accent)' }}>{children}</span>
    </span>
  );
}

// Inline-image layout is encoded in the markdown TITLE slot — `![alt](url "medium
// left")` — which is standard markdown (react-markdown parses it natively) and
// round-trips through JSON as literal, visible text, same ethos as fog/wiki. The
// title carries at most a size token and an align token; anything else is ignored.
const IMG_SIZES  = ['small', 'medium', 'large', 'full'];
const IMG_ALIGNS = ['left', 'center', 'right'];
const IMG_WIDTH  = { small: '25%', medium: '45%', large: '70%', full: '100%' };

function parseImgDirective(title) {
  const t = String(title || '').toLowerCase().split(/\s+/);
  return {
    size:  IMG_SIZES.find(s => t.includes(s)) || 'full',
    align: IMG_ALIGNS.find(a => t.includes(a)) || 'center',
  };
}
// Normalize back to a title string, dropping the defaults (full / center) so the
// stored body stays clean when the image is at its default look.
function buildImgDirective(size, align) {
  const parts = [];
  if (size && size !== 'full')   parts.push(size);
  if (align && align !== 'center') parts.push(align);
  return parts.join(' ');
}

// One inline image. APP-ORIGIN ONLY (relative `/…` src): an off-origin
// `![x](https://tracker/…)` a GM hand-types is NOT loaded — it degrades to its
// alt text so no third party gets a request. When `onEdit` is supplied (the
// active entry's editable reader), a hover/tap control strip lets the GM set the
// size and left/center/right alignment; each change rewrites this exact image's
// markdown (located by its source offsets) and saves. In read-only contexts
// (history preview) there are no controls, but the size/align still apply.
function InlineImage({ src, alt, title, node, onEdit }) {
  const [show, setShow] = useState(false);
  const appOrigin = typeof src === 'string' && src.startsWith('/') && !src.startsWith('//');
  if (!appOrigin) {
    return (
      <span title="Only images uploaded to this entry are shown"
        style={{ color: 'var(--text-dim)', textDecoration: 'underline dotted' }}>
        {alt || 'image'}
      </span>
    );
  }

  const { size, align } = parseImgDirective(title);
  const editable = !!onEdit && node?.position;

  // The wrapper carries the width + float so text flows around a left/right image.
  const wrapStyle = {
    position: 'relative', display: 'inline-block', width: IMG_WIDTH[size], maxWidth: '100%',
    ...(align === 'left'  ? { float: 'left',  margin: '0.2rem 1rem 0.5rem 0' }
      : align === 'right' ? { float: 'right', margin: '0.2rem 0 0.5rem 1rem' }
      : { display: 'block', margin: '0.6rem auto' }),
  };

  const set = (nextSize, nextAlign) =>
    onEdit(node.position, alt || '', src, buildImgDirective(nextSize, nextAlign));

  const pill = (activeOn) => ({
    cursor: 'pointer', fontFamily: 'var(--font-mono)', fontSize: '0.55rem', lineHeight: 1,
    padding: '0.2rem 0.3rem', border: '1px solid var(--border)', borderRadius: '2px',
    background: activeOn ? 'var(--accent)' : 'var(--bg-input)',
    color: activeOn ? 'var(--bg-deep)' : 'var(--text-secondary)',
  });

  return (
    <span style={wrapStyle}
      onMouseEnter={() => editable && setShow(true)}
      onMouseLeave={() => editable && setShow(false)}
      onClick={() => editable && setShow(s => !s)}>
      <img src={src} alt={alt || ''} loading="lazy"
        style={{ display: 'block', width: '100%', height: 'auto', borderRadius: '2px' }} />
      {editable && show && (
        <span onClick={e => e.stopPropagation()} style={{
          position: 'absolute', top: '0.3rem', left: '0.3rem', right: '0.3rem',
          display: 'flex', flexWrap: 'wrap', gap: '0.25rem', alignItems: 'center',
          padding: '0.25rem', borderRadius: '2px',
          background: 'color-mix(in srgb, var(--bg-deep) 82%, transparent)',
        }}>
          {IMG_SIZES.map(s => (
            <button key={s} type="button" title={`Size: ${s}`} style={pill(s === size)}
              onMouseDown={e => e.preventDefault()} onClick={() => set(s, align)}>
              {s === 'full' ? 'Full' : s[0].toUpperCase()}
            </button>
          ))}
          <span style={{ width: '1px', alignSelf: 'stretch', background: 'var(--border)' }} />
          {IMG_ALIGNS.map(a => (
            <button key={a} type="button" title={`Align: ${a}`} style={pill(a === align)}
              onMouseDown={e => e.preventDefault()} onClick={() => set(size, a)}>
              {a === 'left' ? '◧' : a === 'right' ? '◨' : '▬'}
            </button>
          ))}
        </span>
      )}
    </span>
  );
}

// Render a lore body. ONE react-markdown pass handles all three families:
//   • clean markdown (bold/italic/headings/lists/tables) via remark-gfm,
//   • ||fog|| and [[wiki links]] via our remarkKeep plugin (fog.js).
// Everything is emitted as React nodes — NEVER dangerouslySetInnerHTML, and no
// rehype-raw, so any literal HTML an author types is shown as text, not run.
// This is the stored-XSS guard for when collaborators/players can author lore.
//
// `resolve` maps a trimmed/lower-cased name to an entry (or null); `onLink`
// navigates to a resolved entry. Both are optional — history previews pass
// neither, so links there render inert (still visibly styled, just not tappable).
// Markdown block styling lives in the `.lore-md` CSS class (index.css) so it
// stays theme-variable driven and headings can't dwarf the entry title.
// Plain CommonMark collapses a single newline inside a paragraph (you need a
// blank line for a new paragraph, or two trailing spaces for a hard break) —
// surprising for GM prose typed like a normal note, where every line break was
// meant to show. Turn every bare `\n` into a markdown hard break ("  \n") before
// handing text to react-markdown, so what the author typed is what renders. A
// blank line (`\n\n`) still reads as a paragraph break — the extra trailing
// spaces on an otherwise-blank line don't change that, CommonMark still treats
// it as blank. No new dep (the remark-breaks plugin does the same thing, but
// this is a one-line string transform, matching the app's "hand-rolled, no new
// dep" ethos for fog.js/diceParser.js).
function softBreaks(text) {
  return typeof text === 'string' ? text.replace(/\n/g, '  \n') : text;
}

function LoreMarkdown({ text, resolve, onLink, onEditImage, allowExternal }) {
  const components = useMemo(() => ({
    fog: ({ children }) => <FogChip>{children}</FogChip>,
    wikilink: ({ node, children }) => {
      const name = node?.properties?.linkname || '';
      const target = resolve ? resolve(name) : null;
      if (target && onLink) {
        return (
          <span role="link" onClick={() => onLink(target)} style={{
            color: 'var(--text-accent)', textDecoration: 'underline',
            textDecorationColor: 'var(--accent)', cursor: 'pointer',
          }}>{children}</span>
        );
      }
      // broken / unresolvable link — visible so a dangling reference is obvious.
      return (
        <span title={`No entry named "${name}"`} style={{
          color: 'var(--text-dim)', textDecoration: 'underline dotted',
        }}>{children}</span>
      );
    },
    // Ordinary markdown links. OFF-ORIGIN links obey the admin "Allow external
    // links" policy (same as sheets): when it's off, an external link is
    // neutralized to plain text — no navigable href at all. Same-origin/relative
    // links are always fine. External links open in a new tab and can't
    // script-navigate (urlTransform already strips javascript:).
    a: ({ href, children }) => {
      const external = isExternalHref(href);
      if (external && !allowExternal) {
        return <span style={{ color: 'var(--text-primary)' }}>{children}</span>;
      }
      return (
        <a href={href} {...(external ? { target: '_blank', rel: 'noopener noreferrer nofollow' } : {})}
          style={{ color: 'var(--text-accent)' }}>{children}</a>
      );
    },
    // Inline images: app-origin only, with size + left/center/right controls when
    // editable. See InlineImage. (react-markdown's urlTransform already strips
    // javascript: URLs; InlineImage narrows further to same-origin for privacy.)
    img: ({ src, alt, title, node }) => (
      <InlineImage src={src} alt={alt} title={title} node={node} onEdit={onEditImage} />
    ),
  }), [resolve, onLink, onEditImage, allowExternal]);

  return (
    <div className="lore-md">
      <Markdown remarkPlugins={[remarkGfm, remarkKeep]} components={components}>
        {softBreaks(text) || ''}
      </Markdown>
    </div>
  );
}

// If the caret sits inside an open, still-unclosed `[[` on the current line,
// return { open, query } where `open` is the index of the `[[` and `query` is
// what's been typed after it. Returns null once the token is closed (`]]`), the
// display-text pipe is reached, or a newline intervenes — those aren't a name to
// autosuggest. Pure string math, no dep (diceParser.js ethos).
function activeWikiToken(text, caret) {
  const before = text.slice(0, caret);
  const open = before.lastIndexOf('[[');
  if (open === -1) return null;
  const inner = before.slice(open + 2);
  if (inner.includes(']]') || inner.includes('\n') || inner.includes('|')) return null;
  return { open, query: inner };
}

// A textarea that autosuggests existing entry names as you type a `[[wiki` link.
// The dropdown appears once the first character after `[[` is entered; picking a
// name inserts it and the closing `]]`, then drops the caret past the link.
// Keyboard: ↑/↓ move, Enter/Tab accept, Esc dismiss. Suggestions come from the
// world's entry names (resolution is by name, so that's exactly the valid set).
function WikiTextarea({ value, onChange, names, style, rows, onUploadImage, allowExternalLink, allowFog = true }) {
  const ref = useRef(null);
  const imgRef = useRef(null);
  const [uploading, setUploading] = useState(false);
  const [menu, setMenu] = useState(null); // { open, items, index } | null

  const recompute = (val, caret) => {
    const tok = activeWikiToken(val, caret);
    if (!tok || tok.query.length < 1) { setMenu(null); return; }
    const q = tok.query.toLowerCase();
    const items = names
      .filter(n => n.toLowerCase().includes(q))
      .sort((a, b) => {
        const sa = a.toLowerCase().startsWith(q) ? 0 : 1;
        const sb = b.toLowerCase().startsWith(q) ? 0 : 1;
        return sa - sb || a.localeCompare(b);
      })
      .slice(0, 8);
    setMenu(items.length ? { open: tok.open, items, index: 0 } : null);
  };

  const accept = (name) => {
    const el = ref.current;
    if (!el || !menu) return;
    const caret = el.selectionStart;
    const next = value.slice(0, menu.open + 2) + name + ']]' + value.slice(caret);
    onChange(next);
    setMenu(null);
    const pos = menu.open + 2 + name.length + 2;
    requestAnimationFrame(() => {
      if (ref.current) { ref.current.focus(); ref.current.setSelectionRange(pos, pos); }
    });
  };

  const onKeyDown = (e) => {
    if (!menu) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); setMenu(m => ({ ...m, index: (m.index + 1) % m.items.length })); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setMenu(m => ({ ...m, index: (m.index - 1 + m.items.length) % m.items.length })); }
    else if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); accept(menu.items[menu.index]); }
    else if (e.key === 'Escape') { e.preventDefault(); setMenu(null); }
  };

  const NAV = ['ArrowDown', 'ArrowUp', 'Enter', 'Tab', 'Escape'];

  // ---- formatting bar --------------------------------------------------------
  // Buttons that INSERT markdown/fog/wiki syntax into the textarea — never a
  // WYSIWYG/contenteditable surface. The author still sees (and can hand-edit)
  // the literal `**bold**`, `||fog||`, `[[Link]]` text, matching the app's
  // "clear to a non-technical GM" ethos. Each button wraps the current selection
  // (or drops a placeholder) and restores focus with the wrapped text selected.
  const surround = (before, after, placeholder) => {
    const el = ref.current;
    if (!el) return;
    const s = el.selectionStart, e = el.selectionEnd;
    const sel = value.slice(s, e) || placeholder;
    const next = value.slice(0, s) + before + sel + after + value.slice(e);
    onChange(next);
    const a = s + before.length;
    requestAnimationFrame(() => {
      if (ref.current) { ref.current.focus(); ref.current.setSelectionRange(a, a + sel.length); }
    });
  };

  // Prefix the line(s) the selection touches — for headings and list items.
  const prefixLine = (prefix) => {
    const el = ref.current;
    if (!el) return;
    const s = el.selectionStart;
    const lineStart = value.lastIndexOf('\n', s - 1) + 1;
    const next = value.slice(0, lineStart) + prefix + value.slice(lineStart);
    onChange(next);
    const pos = s + prefix.length;
    requestAnimationFrame(() => {
      if (ref.current) { ref.current.focus(); ref.current.setSelectionRange(pos, pos); }
    });
  };

  // Insert text at the caret (or replace the selection), leaving the caret after
  // the inserted text. Used by the image button once an upload resolves.
  const insertAtCaret = (text) => {
    const el = ref.current;
    if (!el) return;
    const s = el.selectionStart, e = el.selectionEnd;
    const next = value.slice(0, s) + text + value.slice(e);
    onChange(next);
    const pos = s + text.length;
    requestAnimationFrame(() => {
      if (ref.current) { ref.current.focus(); ref.current.setSelectionRange(pos, pos); }
    });
  };

  // Upload a picked image, then drop its markdown reference at the caret. The
  // author can then wrap it in ||…|| to fog it (the parser handles fog around an
  // image). onUploadImage returns the stored { name, url } asset (or null).
  const pickImage = async (ev) => {
    const file = ev.target.files?.[0];
    if (imgRef.current) imgRef.current.value = '';   // allow re-picking the same file
    if (!file || !onUploadImage) return;
    setUploading(true);
    try {
      const asset = await onUploadImage(file);
      if (asset && asset.url) {
        const alt = (asset.name || 'image').replace(/[[\]]/g, '');   // keep alt markdown-safe
        insertAtCaret(`![${alt}](${asset.url})`);
      }
    } finally {
      setUploading(false);
    }
  };

  const barBtn = {
    cursor: 'pointer', background: 'var(--bg-input)', border: '1px solid var(--border)',
    borderRadius: '2px', color: 'var(--text-secondary)', fontFamily: 'var(--font-mono)',
    fontSize: '0.7rem', padding: '0.2rem 0.45rem', lineHeight: 1, minWidth: '1.8rem',
  };
  const Btn = ({ onClick, title, children, disabled }) => (
    <button type="button" title={title} disabled={disabled} onMouseDown={e => e.preventDefault()}
      onClick={onClick} style={{ ...barBtn, opacity: disabled ? 0.5 : 1 }}>{children}</button>
  );

  return (
    <div style={{ position: 'relative' }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.25rem', marginBottom: '0.35rem' }}>
        <Btn title="Bold"        onClick={() => surround('**', '**', 'bold')}>B</Btn>
        <Btn title="Italic"      onClick={() => surround('*', '*', 'italic')}>I</Btn>
        <Btn title="Heading"     onClick={() => prefixLine('## ')}>H</Btn>
        <Btn title="List item"   onClick={() => prefixLine('- ')}>•</Btn>
        {allowExternalLink && (
          <Btn title="Link" onClick={() => surround('[', '](https://)', 'text')}>↗</Btn>
        )}
        {allowFog && <Btn title="GM-only fog" onClick={() => surround('||', '||', 'hidden text')}>||</Btn>}
        <Btn title="Wiki link (type to search entries)" onClick={() => surround('[[', ']]', '')}>[[ ]]</Btn>
        {onUploadImage && (
          <>
            <input ref={imgRef} type="file" accept="image/*" onChange={pickImage} style={{ display: 'none' }} />
            <Btn title="Insert image (uploads to this entry)" disabled={uploading}
              onClick={() => imgRef.current && imgRef.current.click()}>
              {uploading ? '…' : 'IMG'}
            </Btn>
          </>
        )}
      </div>
      <textarea ref={ref} rows={rows} value={value} style={style}
        onChange={e => { onChange(e.target.value); recompute(e.target.value, e.target.selectionStart); }}
        onKeyDown={onKeyDown}
        onClick={e => recompute(value, e.target.selectionStart)}
        onKeyUp={e => { if (!NAV.includes(e.key)) recompute(value, e.target.selectionStart); }}
        onBlur={() => setTimeout(() => setMenu(null), 120)} />
      {menu && (
        <div style={{
          position: 'absolute', left: 0, right: 0, top: '100%', zIndex: 5, marginTop: '2px',
          background: 'var(--bg-raised)', border: '1px solid var(--accent)', borderRadius: '2px',
          maxHeight: 220, overflowY: 'auto', boxShadow: '0 6px 18px rgba(0,0,0,0.4)',
        }}>
          <div style={{ ...eyebrow, padding: '0.35rem 0.6rem' }}>Link to…</div>
          {menu.items.map((n, i) => (
            <button key={n} type="button"
              onMouseDown={e => { e.preventDefault(); accept(n); }}
              onMouseEnter={() => setMenu(m => ({ ...m, index: i }))}
              style={{
                display: 'block', width: '100%', textAlign: 'left', cursor: 'pointer',
                padding: '0.4rem 0.6rem', border: 'none',
                background: i === menu.index ? 'var(--bg-input)' : 'transparent',
                color: 'var(--text-primary)', fontFamily: 'var(--font-body)', fontSize: '0.9rem',
              }}>
              {n}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// §4.11 compact in-world date editor: year + month-select + day, with an era
// selector only when the calendar declares more than one era. NOT a real-world
// datepicker — this is fiction, so there's no month grid or locale logic. Degrades
// to a read-only note when the world's pack has no calendar. The value it emits is
// the structured { era, year, month, day } (1-based) the server validates, or null.
function CalendarDateField({ calendar, value, onChange }) {
  if (!calendar) {
    return (
      <div style={{ color: 'var(--text-dim)', fontSize: '0.8rem', fontStyle: 'italic' }}>
        This world's pack has no calendar, so a date can't be set.
      </div>
    );
  }
  const months = calMonths(calendar);
  const eras   = calEras(calendar);
  const has    = !!value;
  const month  = value?.month || 1;
  const maxDay = months[month - 1]?.days || 1;

  // Compose the next value from a partial edit. A blank year clears the whole
  // date (the field is optional); month/day are clamped into the calendar's range.
  const emit = (patch) => {
    const base = value || {
      era:  eras.length ? (calendar.epoch?.era ?? eras[0].id) : null,
      year: calendar.epoch?.year ?? 1, month: 1, day: 1,
    };
    const next = { ...base, ...patch };
    if (next.year === '' || next.year == null || Number.isNaN(Number(next.year))) { onChange(null); return; }
    const mo = Math.min(Math.max(1, parseInt(next.month, 10) || 1), months.length);
    const mx = months[mo - 1]?.days || 1;
    const dy = Math.min(Math.max(1, parseInt(next.day, 10) || 1), mx);
    onChange({ era: eras.length ? next.era : null, year: Math.trunc(Number(next.year)), month: mo, day: dy });
  };

  const selStyle = { ...inputStyle, width: 'auto', flex: '0 0 auto' };
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '0.4rem' }}>
      <input type="number" placeholder="Year" value={has ? value.year : ''}
        onChange={e => emit({ year: e.target.value })} style={{ ...inputStyle, width: 90 }} aria-label="Year" />
      <select value={month} onChange={e => emit({ month: e.target.value })} style={selStyle} aria-label="Month">
        {months.map((m, i) => <option key={i} value={i + 1}>{m.name}</option>)}
      </select>
      <input type="number" min="1" max={maxDay} placeholder="Day" value={has ? value.day : ''}
        onChange={e => emit({ day: e.target.value })} style={{ ...inputStyle, width: 70 }} aria-label="Day" />
      {eras.length > 1 && (
        <select value={value?.era ?? eras[0].id} onChange={e => emit({ era: e.target.value })} style={selStyle} aria-label="Era">
          {eras.map(er => <option key={er.id} value={er.id}>{er.abbr || er.label || er.id}</option>)}
        </select>
      )}
      {has && (
        <button type="button" className="btn-ghost" style={{ padding: '0.2rem 0.5rem', fontSize: '0.75rem' }}
          onClick={() => onChange(null)}>Clear</button>
      )}
    </div>
  );
}

export default function WorldDetail({ user, worldId, onBack }) {
  const [world,      setWorld]      = useState(null);
  const [categories, setCategories] = useState([]);
  const [activeCat,  setActiveCat]  = useState(null);
  const [entries,    setEntries]    = useState([]);
  const [allEntries, setAllEntries] = useState([]);    // every entry, for [[wiki]] resolution
  const [calendar,   setCalendar]   = useState(null);   // §4.11: pack calendar, or null
  // List / Timeline / Calendar for the active category (Timeline: §4.11; Calendar
  // is the month-grid view). `calCursor` is the grid's currently-shown
  // { era, year, month } — null means "not navigated yet, use the default"
  // (the earliest dated entry, or the calendar's epoch if there are none); reset
  // to null on a category switch so a new category doesn't inherit a stale month.
  const [viewMode,   setViewMode]   = useState('list'); // 'list' | 'timeline'
  // World Calendar (rail item, world-level — NOT scoped to one category, and NOT
  // a per-entry thing). Opens a full-width month grid over EVERY dated entry in
  // the world, across every lore category, the same way Home sits above the
  // category list rather than inside it. `calCursor` is the grid's currently
  // shown { era, year, month } — null means "use the default" (the latest dated
  // entry anywhere in the world, or the calendar's epoch if there are none).
  const [calendarOpen, setCalendarOpen] = useState(false);
  const [calCursor,    setCalCursor]    = useState(null);
  const [active,     setActive]     = useState(null);   // selected entry object
  const [mode,       setMode]       = useState('read'); // 'read' | 'edit' | 'create'
  const [search,     setSearch]     = useState('');
  const [loading,    setLoading]    = useState(true);
  const [busy,       setBusy]       = useState(false);

  // Collapse-to-glyph search band (§4m) — same idiom as CharacterList's search:
  // a bare glyph until clicked, then the frame grows to full width and the input
  // fades in. `searchOpen` is the expanded/collapsed flag; the ref lets us focus
  // the input right after it paints.
  const [searchOpen, setSearchOpen] = useState(false);
  const searchInputRef = useRef(null);
  const openSearch = () => {
    setSearchOpen(true);
    setTimeout(() => searchInputRef.current?.focus(), 0);  // after the box paints
  };
  // Collapse only when empty — an active query keeps the band open so clicking
  // away doesn't hide the results the GM is looking at (mirrors CharacterList).
  const collapseSearch = () => { if (!search.trim()) setSearchOpen(false); };

  // Draft for the edit/create form.
  const [draft, setDraft] = useState({ name: '', fields: {}, visibility: 'hidden' });

  // History timeline modal.
  const [historyFor, setHistoryFor] = useState(null); // entry object or null
  const [versions,   setVersions]   = useState([]);
  const [preview,    setPreview]    = useState(null);  // {index, body}

  // Consolidated World Settings modal (§4.7b). One modal now houses General
  // (name/description/backdrop), Access & members (§4.7), Categories (§4j
  // rename/hide), and the Broken-links report (§4h) — each was a separate rail
  // item/modal before. `settingsSection` is which section it opens on; null
  // `settingsFor`-style flag is `settingsOpen`.
  const [settingsOpen,    setSettingsOpen]    = useState(false);
  const [settingsSection, setSettingsSection] = useState('general');
  const openSettings = (sec = 'general') => {
    setSettingsSection(sec);
    setSettingsOpen(true);
    setDrawerOpen(false);
  };

  // World landing page (§4k): a GM-authored "home" (Markdown + images) shown on
  // open, before any lore category. `showHome` means the reader shows the landing
  // rather than an entry; `landingMode` is its own read/edit switch (the landing
  // isn't a lore entry, so it doesn't share the entry `mode`/history machinery).
  // `worldAssets` is the world-level asset store (images the IMG button uploads).
  // --- Campaigns (Wave A) ----------------------------------------------------
  // The rail's campaign list, and the selected campaign's overview. `campaigns`
  // comes from GET /api/worlds/:id/campaigns, which a world MEMBER may now call —
  // a non-owner sees only the campaigns they hold a character in, with the join
  // code stripped server-side. Selecting one is a THIRD top-level rail mode
  // alongside Home and a lore category, so selectHome/selectCategory clear it.
  const [campaigns,       setCampaigns]       = useState([]);
  const [activeCampaign,  setActiveCampaign]  = useState(null);   // campaign id
  const [campaignData,    setCampaignData]    = useState(null);   // the overview payload
  const [campaignBusy,    setCampaignBusy]    = useState(false);
  const [showArchivedCamps, setShowArchivedCamps] = useState(false);
  // Prefetched, per-campaign overview + session log, keyed by campaign id — for
  // world-global search ONLY (so a query can also match campaign prose and
  // session content, not just lore). Both endpoints already role-serialize their
  // payload for whoever's asking (fog stripped, prep/joinCode absent for a
  // player), so search sees exactly what that viewer is allowed to see — no
  // separate permission check needed here. Loaded once campaigns load; small
  // worlds have few campaigns, so this is a handful of extra requests, not a scan.
  const [campaignOverviews, setCampaignOverviews] = useState({});
  const [campaignSessionsAll, setCampaignSessionsAll] = useState({});
  // The overview's edit form. `campDraft` is null in read mode; an object holding
  // the three prose fields while editing. Only the GM ever gets here — the button
  // is gated on the role the SERVER echoed back, not a client guess.
  const [campDraft,       setCampDraft]       = useState(null);
  const [campSaving,      setCampSaving]      = useState(false);

  // --- Sessions (Wave B) ------------------------------------------------------
  // The campaign's play log. `sessions` is already role-serialized by the server
  // (GET .../sessions): a player's copy has no prep, no nextTime, no encounters —
  // this component never re-derives that, only hides GM-only CHROME off
  // `campaignData.role`. `activeSession` is the selected session (or null, meaning
  // the overview shows); `sessionDraft` is non-null only while creating/editing
  // (owner-only — the server 403s a player's write regardless).
  const [sessions,        setSessions]        = useState([]);
  const [sessionsLoading, setSessionsLoading]  = useState(false);
  const [activeSession,   setActiveSession]   = useState(null);
  const [sessionDraft,    setSessionDraft]    = useState(null);
  const [sessionSaving,   setSessionSaving]   = useState(false);
  // Which scene cards are collapsed (by index) — everything starts expanded (a
  // GM reading at the table wants scenes visible; collapsing is for tidying up a
  // long prep list), separate sets for the read view and the edit form since
  // they're different sessions/views. Resets whenever the underlying session
  // changes so a new session doesn't inherit another one's fold state.
  const [viewScenesCollapsed, setViewScenesCollapsed] = useState(new Set());
  const [formScenesCollapsed, setFormScenesCollapsed] = useState(new Set());
  useEffect(() => { setViewScenesCollapsed(new Set()); }, [activeSession?.id]);
  const sessionDraftOpen = !!sessionDraft;
  useEffect(() => { setFormScenesCollapsed(new Set()); }, [sessionDraft?._id, sessionDraftOpen]);
  const toggleSceneCollapse = (setFn, i) => setFn(prev => {
    const next = new Set(prev);
    if (next.has(i)) next.delete(i); else next.add(i);
    return next;
  });

  const [showHome,     setShowHome]     = useState(true);
  const [landingMode,  setLandingMode]  = useState('read'); // 'read' | 'edit'
  const [landingDraft, setLandingDraft] = useState('');
  const [worldAssets,  setWorldAssets]  = useState([]);
  const worldFileRef = useRef(null);

  // Per-entry assets (inline images + downloadable attachments share one store).
  const [assets, setAssets] = useState([]);
  const attachInputRef = useRef(null);

  // Session attachments (Wave B follow-up). The server already role-filters the
  // list — owner gets hidden+shared, a player gets only shared — so this state is
  // just whatever GET returns, no client-side filtering.
  const [sessionAssets, setSessionAssets] = useState([]);
  const sessionAttachInputRef = useRef(null);

  // §4.9 propose tier: a member's OWN suggestions for the active entry (the server
  // returns only their own unless they're the owner). Loaded when a propose member
  // opens an entry, and refreshed after they submit.
  const [myProposals, setMyProposals] = useState([]);

  // Admin "Allow external links" policy (public setting) — governs lore exactly
  // as it governs sheets: when off, off-origin links are neutralized and the
  // format bar's Link button is hidden.
  const [allowExternal, setAllowExternal] = useState(false);
  useEffect(() => {
    api.getSettings().then(s => setAllowExternal(!!s?.allowExternalLinks)).catch(() => {});
  }, []);

  // World-level assets (landing-page images + attachments). Loaded once per world.
  useEffect(() => {
    api.getWorldAssets(worldId).then(r => setWorldAssets(Array.isArray(r?.assets) ? r.assets : [])).catch(() => {});
  }, [worldId]);

  // Phone drill-down: which single pane is showing. Lands on 'categories' (the
  // TOP of the stack) so the user always starts where the rail is, then drills in
  // categories → list → entry — never dropped mid-stack.
  const [isPhone, setIsPhone] = useState(() => window.matchMedia('(max-width: 640px)').matches);
  const [pane, setPane]       = useState('home'); // 'home' | 'categories' | 'list' | 'entry'
  const [drawerOpen, setDrawerOpen] = useState(false);
  const touch = useRef(null); // {x, y} of a touchstart, for swipe-back detection

  useEffect(() => {
    const mq = window.matchMedia('(max-width: 640px)');
    const onChange = (e) => setIsPhone(e.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  // Initial load: the world record + the viewer's ROLE (§4.8) + categories +
  // lore. GET /api/worlds/:id returns `{ ...world, role }` — 'owner' or a member
  // tier. All the read-only chrome below is driven off that role; the SERVER is
  // the gate (it already filtered categories/entries and stripped fog), so the
  // client only decides which management controls to show, never what's visible.
  useEffect(() => {
    let alive = true;
    (async () => {
      const [w, cats, all, cal] = await Promise.all([
        api.getWorld(worldId), api.getWorldCategories(worldId), api.getLore(worldId),
        api.getWorldCalendar(worldId),   // §4.11: resolved pack calendar, or null
      ]);
      if (!alive) return;
      setWorld(w && !w.error ? w : null);
      const list = Array.isArray(cats) ? cats : [];
      setCategories(list);
      setAllEntries(Array.isArray(all) ? all : []);
      setCalendar(cal && !cal.error ? (cal.calendar || null) : null);
      const firstVisible = list.find(c => !c.hidden);
      if (firstVisible) setActiveCat(firstVisible.id);
      setLoading(false);
    })();
    return () => { alive = false; };
  }, [worldId]);

  // Load the active category's entries (the middle-panel list).
  const loadEntries = useCallback(async (catId) => {
    if (!catId) return;
    const list = await api.getLore(worldId, catId);
    setEntries(Array.isArray(list) ? list : []);
  }, [worldId]);

  // Load EVERY entry in the world — the pool [[wiki]] links resolve against,
  // regardless of category. No stored link table; resolution is by name at
  // render time, so this just needs to stay fresh after any mutation.
  const loadAll = useCallback(async () => {
    const list = await api.getLore(worldId);
    setAllEntries(Array.isArray(list) ? list : []);
  }, [worldId]);

  // Load the selected entry's assets (images + attachments). One store per
  // entry, so this refreshes whenever the selected entry changes.
  const loadAssets = useCallback(async (entryId) => {
    if (!entryId) { setAssets([]); return; }
    const res = await api.getLoreAssets(worldId, entryId);
    setAssets(Array.isArray(res?.assets) ? res.assets : []);
  }, [worldId]);

  // §4.9: a propose member's own suggestions for an entry (server returns only theirs).
  const loadMyProposals = useCallback(async (entryId) => {
    if (!entryId) { setMyProposals([]); return; }
    const res = await api.getEntryProposals(worldId, entryId);
    setMyProposals(Array.isArray(res?.proposals) ? res.proposals : []);
  }, [worldId]);

  // Effect only LOADS the list for the active category. It deliberately does NOT
  // clear the selected entry — programmatic navigation (a wiki-link jump into
  // another category) sets activeCat AND active together, and must not race with
  // an effect that nulls active. Manual category picks clear it in selectCategory.
  useEffect(() => { if (activeCat) loadEntries(activeCat); }, [activeCat, loadEntries]);

  // Refresh the asset store whenever the selected entry changes (id, not object).
  useEffect(() => { loadAssets(active?.id); }, [active?.id, loadAssets]);

  // Refresh a propose member's own suggestions when they open an entry. (Reads
  // world?.role directly rather than the derived canPropose, which is defined
  // below — keeps this effect above the capability block without a TDZ.)
  useEffect(() => {
    if (world?.role === 'propose' && active?.id) loadMyProposals(active.id);
    else setMyProposals([]);
  }, [active?.id, world?.role, loadMyProposals]);

  const catDef = categories.find(c => c.id === activeCat) || null;

  // §4.11: calendar-date fields on the active category. The FIRST is the timeline
  // sort key ("start"); a second (e.g. "end") drives range display. A Timeline
  // view is offered only when there's a start date field AND the pack has a calendar.
  const dateFields = (catDef?.fields || []).filter(f => f.type === 'calendar-date');
  const startKey   = dateFields[0]?.key || null;
  const endKey     = dateFields.find(f => f.key !== startKey)?.key || null;
  const canTimeline = !!(startKey && calendar);

  // Tier-derived capabilities. The SERVER is the gate — these only decide which
  // affordances to show; every action is re-checked server-side off req.worldRole.
  //  • canEdit   (owner|coGM)   — all lore CONTENT: create, edit, delete, set
  //                               visibility, upload images, edit the landing page.
  //  • isOwner   (owner)        — STRUCTURAL only: world settings, members, pack,
  //                               world files, delete/transfer. Not canEdit, so a
  //                               coGM can never lock the owner out of their world.
  //  • canPropose(propose)      — "Suggest an edit" (submits a proposal that
  //                               never mutates the entry) + a view of their own.
  // Default to the most restrictive until the role loads, so nothing flashes.
  const role      = world?.role || null;
  // Content powers — mirrors backend isGM(): read hidden entries, create/edit/delete,
  // set visibility, see and write ||fog||, approve proposals.
  const canEdit   = role === 'owner' || role === 'coGM';
  // Structural powers — OWNER ONLY, and deliberately not canEdit. Members, pack,
  // world delete and transfer stay with one person so a coGM can never lock the
  // owner out. Matches requireWorldOwner server-side.
  const isOwner   = role === 'owner';
  const canPropose = role === 'propose';

  // Name → entry index for wiki-link resolution (case-insensitive, trimmed).
  // First entry wins on a name collision (disambiguate later via [[Name|display]]).
  const resolveLink = useMemo(() => {
    const map = new Map();
    for (const e of allEntries) {
      const k = (e.name || '').trim().toLowerCase();
      if (k && !map.has(k)) map.set(k, e);
    }
    return (name) => map.get((name || '').trim().toLowerCase()) || null;
  }, [allEntries]);

  // Names offered by the [[wiki]] autosuggest — exactly the resolvable set.
  const entryNames = useMemo(
    () => Array.from(new Set(allEntries.map(e => (e.name || '').trim()).filter(Boolean))),
    [allEntries],
  );

  // Merged category lookup (id → { label, baseLabel, hidden, icon, … }). Includes
  // HIDDEN categories (§4j) so a search hit inside one still resolves its renamed
  // label and its hidden flag — the GM can still reach anything they authored.
  const catById = useMemo(() => {
    const m = new Map();
    for (const c of categories) m.set(c.id, c);
    return m;
  }, [categories]);

  // World-global search (§4l, extended): scans EVERY lore entry, EVERY campaign's
  // prose, and EVERY session in the world — not just the active category or the
  // currently open campaign. Each source is already role-serialized by its own
  // endpoint (fog stripped, prep/joinCode absent for a non-owner), so a query
  // sees exactly what this viewer is allowed to see with no extra filtering here.
  // Rows are a discriminated union (`kind: 'entry' | 'campaign' | 'session'`),
  // sorted lore-first (by category label, then name) and campaigns/sessions after
  // (by campaign name, then session number); capped at 50 total, with
  // `truncated` driving a "refine your search" note.
  const searchResults = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return { rows: [], truncated: false };

    const entryHits = [];
    for (const e of allEntries) {
      const values = [e.name];
      const fields = e.fields || {};
      for (const k of Object.keys(fields)) {
        if (typeof fields[k] === 'string') values.push(fields[k]);
      }
      if (values.some(v => typeof v === 'string' && v.toLowerCase().includes(q))) entryHits.push(e);
    }
    entryHits.sort((a, b) => {
      const la = (catById.get(a.categoryId)?.label || a.categoryId || '').toLowerCase();
      const lb = (catById.get(b.categoryId)?.label || b.categoryId || '').toLowerCase();
      return la.localeCompare(lb) || (a.name || '').localeCompare(b.name || '');
    });
    const entryRows = entryHits.map(e => ({ kind: 'entry', key: `e:${e.id}`, entry: e, snippet: matchSnippet(e, q) }));

    const campaignRows = [];
    for (const c of campaigns) {
      const ov = campaignOverviews[c.id];
      const values = [c.name, ov?.premise, ov?.situation, ov?.threads].filter(v => typeof v === 'string');
      if (!values.some(v => v.toLowerCase().includes(q))) continue;
      const snippet = [ov?.premise, ov?.situation, ov?.threads].map(v => snippetAround(v, q)).find(Boolean) || '';
      campaignRows.push({ kind: 'campaign', key: `c:${c.id}`, campaignId: c.id, name: c.name, snippet });
    }

    const sessionRows = [];
    for (const c of campaigns) {
      for (const s of campaignSessionsAll[c.id] || []) {
        const proseFields = [
          s.title, s.record?.recap, s.record?.happened, s.record?.clues, s.record?.loot, s.nextTime,
          ...(Array.isArray(s.scenes) ? s.scenes.flatMap(sc => Object.values(sc)) : []),
        ].filter(v => typeof v === 'string');
        if (!proseFields.some(v => v.toLowerCase().includes(q))) continue;
        const snippet = proseFields.map(v => snippetAround(v, q)).find(Boolean) || '';
        sessionRows.push({
          kind: 'session', key: `s:${c.id}:${s.id}`, campaignId: c.id, campaignName: c.name, session: s, snippet,
        });
      }
    }
    campaignRows.sort((a, b) => a.name.localeCompare(b.name));
    sessionRows.sort((a, b) => a.campaignName.localeCompare(b.campaignName) || a.session.number - b.session.number);

    const all = [...entryRows, ...campaignRows, ...sessionRows];
    const CAP = 50;
    return { rows: all.slice(0, CAP), truncated: all.length > CAP };
  }, [search, allEntries, catById, campaigns, campaignOverviews, campaignSessionsAll]);

  const goToCampaignResult = (campaignId) => { selectCampaign(campaignId); };
  const goToSessionResult = (campaignId, session) => {
    selectCampaign(campaignId);
    setActiveSession(session);
    setSessionDraft(null);
    if (isPhone) setPane('entry');
  };

  // (The world-level broken-links report moved into the World Settings modal
  // (§4.7b), which self-derives it the same way — no stored link table.)

  // Show the world's landing "home" in the reader (desktop) / a top-of-stack pane
  // (phone). Home sits above the lore categories, so selecting it clears the
  // active entry but leaves the category list intact behind it.
  const selectHome = () => {
    setActiveCampaign(null);
    setCampDraft(null);
    setCalendarOpen(false);
    setShowHome(true);
    setLandingMode('read');
    setActive(null);
    setMode('read');
    setDrawerOpen(false);
    if (isPhone) setPane('home');
  };

  // The World Calendar — a rail item that's a peer of Home, not a lore category
  // (it has no entries of its own; it aggregates dates OFF every category).
  const selectCalendar = () => {
    setActiveCampaign(null);
    setCampDraft(null);
    setShowHome(false);
    setActiveCat(null);
    setActive(null);
    setMode('read');
    setCalendarOpen(true);
    setSearch('');
    setDrawerOpen(false);
    if (isPhone) setPane('entry');
  };

  const selectCategory = (id) => {
    setActiveCampaign(null);
    setCampDraft(null);
    setCalendarOpen(false);
    setShowHome(false);
    setActiveCat(id);
    setActive(null);
    setMode('read');
    setSearch('');
    setViewMode('list');   // a fresh category starts in list view
    setDrawerOpen(false);
    if (isPhone) setPane('list');
  };

  // Navigate to a specific entry, switching category if it lives elsewhere (a
  // wiki-link may point across categories). On phone this pushes to the entry pane.
  // Load the world's campaign list once. Failure is silent and leaves the section
  // empty rather than breaking the rail — a world with no campaigns is normal.
  useEffect(() => {
    let alive = true;
    api.getWorldCampaigns(worldId)
      .then(res => { if (alive) setCampaigns(Array.isArray(res?.campaigns) ? res.campaigns : []); })
      .catch(() => {});
    return () => { alive = false; };
  }, [worldId]);

  // Once the campaign list is in, prefetch each one's overview + session log so
  // search can reach into them. Each pair of calls is independent per campaign
  // (one failing doesn't drop the others); results land keyed by campaign id.
  useEffect(() => {
    let alive = true;
    if (!campaigns.length) { setCampaignOverviews({}); setCampaignSessionsAll({}); return; }
    Promise.all(campaigns.map(c => Promise.all([
      api.getCampaignOverview(c.id).catch(() => null),
      api.getCampaignSessions(c.id).catch(() => null),
    ]).then(([overview, sessRes]) => ({
      id: c.id,
      overview: overview && !overview.error ? overview : null,
      sessions: Array.isArray(sessRes?.sessions) ? sessRes.sessions : [],
    })))).then(results => {
      if (!alive) return;
      const ov = {}, ss = {};
      for (const r of results) { ov[r.id] = r.overview; ss[r.id] = r.sessions; }
      setCampaignOverviews(ov);
      setCampaignSessionsAll(ss);
    });
    return () => { alive = false; };
  }, [campaigns]);

  // Fetch the overview whenever a campaign is selected. A 404 here is the normal
  // "not yours" answer (the server never 403s on this route), so it clears the
  // panel rather than surfacing an error.
  useEffect(() => {
    if (!activeCampaign) { setCampaignData(null); return; }
    let alive = true;
    setCampaignBusy(true);
    api.getCampaignOverview(activeCampaign)
      .then(res => { if (alive) setCampaignData(res && !res.error ? res : null); })
      .catch(() => { if (alive) setCampaignData(null); })
      .finally(() => { if (alive) setCampaignBusy(false); });
    return () => { alive = false; };
  }, [activeCampaign]);

  // Load the play log whenever a campaign is selected. `sessions` is dropped (not
  // errored) on an empty/absent campaign — a fresh campaign with no sessions yet
  // is normal. `campaignData` (fetched in parallel above) carries the role every
  // render below reads off, so this effect doesn't need to store its own copy.
  useEffect(() => {
    if (!activeCampaign) {
      setSessions([]); setActiveSession(null); setSessionDraft(null);
      return;
    }
    let alive = true;
    setSessionsLoading(true);
    api.getCampaignSessions(activeCampaign)
      .then(res => { if (alive) setSessions(Array.isArray(res?.sessions) ? res.sessions : []); })
      .catch(() => { if (alive) setSessions([]); })
      .finally(() => { if (alive) setSessionsLoading(false); });
    return () => { alive = false; };
  }, [activeCampaign]);

  const startCampaignEdit = () => {
    if (!campaignData) return;
    setCampDraft({
      premise:   campaignData.premise   || '',
      situation: campaignData.situation || '',
      threads:   campaignData.threads   || '',
    });
  };

  // Save the three prose fields. PUT /api/campaigns/:id picks each key explicitly
  // server-side, so this body cannot touch ownedBy/joinCode/worldId even though
  // they live on the same record. On success we re-fetch the OVERVIEW rather than
  // trusting the PUT's echo: the overview is the role-serialized shape (fog, join
  // code, roster) and the raw record is not.
  const saveCampaign = async () => {
    if (!campDraft || !activeCampaign) return;
    setCampSaving(true);
    try {
      const res = await api.updateCampaign(activeCampaign, campDraft);
      if (res && !res.error) {
        const fresh = await api.getCampaignOverview(activeCampaign);
        if (fresh && !fresh.error) setCampaignData(fresh);
        setCampDraft(null);
        // The rail shows campaign NAMES, which this form does not touch — no
        // reason to refetch the list.
      }
    } catch { /* leave the draft open so the GM does not lose their text */ }
    finally { setCampSaving(false); }
  };

  const selectCampaign = (id) => {
    setCampDraft(null);          // switching campaigns discards an unsaved draft
    setActiveSession(null);
    setSessionDraft(null);
    setCalendarOpen(false);
    setShowHome(false);
    setActiveCampaign(id);
    setActiveCat(null);
    setActive(null);
    setMode('read');
    setSearch('');
    setViewMode('list');
    setDrawerOpen(false);
    // The session picker + content are merged into one pane now (renderCampaignPane),
    // so a phone jumps straight to 'entry' — there's no separate list step.
    if (isPhone) setPane('entry');
  };

  // Select a session from the list (or `null` to fall back to the overview).
  const selectSession = (s) => {
    setSessionDraft(null);
    setActiveSession(s);
    if (isPhone) setPane('entry');
  };
  const selectOverview = () => {
    setSessionDraft(null);
    setActiveSession(null);
    if (isPhone) setPane('entry');
  };

  const startNewSession = () => {
    setActiveSession(null);
    // Default the in-world date to the LATEST existing session's — a new session
    // usually picks up right after the last one, and re-typing the same year/era
    // every time is exactly the kind of friction this should remove. `number` is
    // the spine of "latest" here, not the in-world date itself (a flashback
    // session could carry an earlier date than the one before it).
    const latest = sessions.reduce((best, s) => (!best || s.number > best.number) ? s : best, null);
    setSessionDraft({ ...emptySessionDraft(), inWorldDate: latest?.inWorldDate || null });
    if (isPhone) setPane('entry');
  };

  const startEditSession = (s) => {
    setSessionDraft({
      _id: s.id, number: s.number,
      title: s.title || '', date: s.date || '', inWorldDate: s.inWorldDate || null,
      visibility: s.visibility || 'hidden',
      scenes: Array.isArray(s.scenes) ? s.scenes.map(sc => ({ ...emptyScene(), ...sc })) : [],
      record: { recap: '', happened: '', clues: '', loot: '', ...(s.record || {}) },
      nextTime: s.nextTime || '',
      encounters: Array.isArray(s.encounters) ? s.encounters.map(e => ({ ...e })) : [],
    });
    if (isPhone) setPane('entry');
  };

  // Save (create or update) via the ALLOWLIST server route — the body only ever
  // carries the fields sessionFromBody accepts; the envelope (id/number/createdAt)
  // is never sent, matching the campaign-save discipline above. On success we
  // re-fetch the whole log rather than trusting the echo, so ordering-by-number
  // and any server-side clamping (e.g. a rejected bad date) show correctly.
  const saveSession = async () => {
    if (!sessionDraft || !activeCampaign) return;
    setSessionSaving(true);
    try {
      const body = {
        title: sessionDraft.title, date: sessionDraft.date || null,
        inWorldDate: sessionDraft.inWorldDate, visibility: sessionDraft.visibility,
        scenes: sessionDraft.scenes, record: sessionDraft.record,
        nextTime: sessionDraft.nextTime, encounters: sessionDraft.encounters,
      };
      const res = sessionDraft._id
        ? await api.updateSession(activeCampaign, sessionDraft._id, body)
        : await api.createSession(activeCampaign, body);
      if (res && !res.error) {
        const fresh = await api.getCampaignSessions(activeCampaign);
        const list  = Array.isArray(fresh?.sessions) ? fresh.sessions : [];
        setSessions(list);
        setActiveSession(list.find(x => x.id === res.id) || res);
        setSessionDraft(null);
      } else if (res?.error) {
        window.alert(res.error);
      }
    } catch { /* leave the draft open so the GM does not lose their text */ }
    finally { setSessionSaving(false); }
  };

  // Numbers are NOT re-packed after a delete (server comment) — a gap in the log
  // is honest about what happened, so the list simply drops the removed row.
  const deleteSessionRow = async (s) => {
    if (!activeCampaign || !s) return;
    if (!window.confirm(`Delete session #${s.number}? This can't be undone.`)) return;
    const res = await api.deleteSession(activeCampaign, s.id);
    if (res && res.ok) {
      setSessions(list => list.filter(x => x.id !== s.id));
      if (activeSession?.id === s.id) setActiveSession(null);
    }
  };

  // Load the selected session's attachments. Runs for every role — the server
  // decides what's in the list (owner: hidden+shared, player: shared only), so
  // there's nothing to filter here.
  const loadSessionAssets = useCallback(async (sessionId) => {
    if (!activeCampaign || !sessionId) { setSessionAssets([]); return; }
    const res = await api.getSessionAssets(activeCampaign, sessionId);
    setSessionAssets(Array.isArray(res?.assets) ? res.assets : []);
  }, [activeCampaign]);
  useEffect(() => { loadSessionAssets(activeSession?.id); }, [activeSession?.id, loadSessionAssets]);

  const uploadSessionAssetFile = async (file, visibility) => {
    if (!activeCampaign || !activeSession) return;
    const res = await api.uploadSessionAsset(activeCampaign, activeSession.id, file, visibility);
    if (res && res.asset) setSessionAssets(res.assets);
    else if (res && res.error) window.alert(res.error);
  };

  const toggleSessionAssetVisibility = async (a) => {
    if (!activeCampaign || !activeSession) return;
    const next = a.visibility === 'shared' ? 'hidden' : 'shared';
    const res = await api.setSessionAssetVisibility(activeCampaign, activeSession.id, a.key, next);
    if (res && res.assets) setSessionAssets(res.assets);
  };

  const removeSessionAsset = async (key) => {
    if (!activeCampaign || !activeSession) return;
    if (!window.confirm('Remove this file? This cannot be undone.')) return;
    const res = await api.deleteSessionAsset(activeCampaign, activeSession.id, key);
    if (res && Array.isArray(res.assets)) setSessionAssets(res.assets);
  };

  // Navigate to a lore entry from ANYWHERE a [[wiki link]] can appear — the lore
  // reader, a session's prep/record, a campaign's premise/situation/threads, the
  // landing page. `renderReader` picks its view by checking activeCampaign /
  // calendarOpen / showHome BEFORE it ever looks at `active`, so a click from
  // inside one of those modes has to explicitly back out of it, or `active`
  // gets set correctly but nothing ever renders it — the entry never appears.
  const goToEntry = (entry) => {
    if (!entry) return;
    setActiveCampaign(null);
    setCampDraft(null);
    setActiveSession(null);
    setSessionDraft(null);
    setCalendarOpen(false);
    setShowHome(false);
    if (entry.categoryId !== activeCat) setActiveCat(entry.categoryId);
    setActive(entry);
    setMode('read');
    if (isPhone) setPane('entry');
  };

  // Opening from the list is just navigation within the current category.
  const openEntry = goToEntry;

  // Walk one step UP the phone drill-down stack (entry → list → categories). A
  // campaign's session picker + content, and the World Calendar, are each ONE
  // merged pane (no list step), so 'entry' pops straight to 'categories' for
  // either.
  const popStack = () => {
    if (pane === 'entry') {
      if (activeCampaign || calendarOpen) { setPane('categories'); return; }
      setMode('read'); setPane('list');
    }
    else if (pane === 'list') setPane('categories');
    else if (pane === 'categories') { setShowHome(true); setLandingMode('read'); setPane('home'); }
  };

  // Swipe-back polish: a rightward horizontal swipe pops the stack, matching the
  // native iOS/Android back gesture. Guarded — mostly-horizontal, past a
  // threshold — so it doesn't fire on scrolls. Back-chevron + hamburger remain
  // the reliable path if a swipe misfires (CLAUDE.md 4d: swipe is polish).
  const onTouchStart = (e) => {
    const t = e.touches[0];
    touch.current = { x: t.clientX, y: t.clientY };
  };
  const onTouchEnd = (e) => {
    if (!touch.current) return;
    const t = e.changedTouches[0];
    const dx = t.clientX - touch.current.x;
    const dy = t.clientY - touch.current.y;
    touch.current = null;
    if (dx > 70 && Math.abs(dx) > Math.abs(dy) * 1.8) {
      if (drawerOpen) setDrawerOpen(false);
      else popStack();
    }
  };

  const startCreate = () => {
    setShowHome(false);
    setActive(null);
    // Entries start GM-only. Sharing is a deliberate act, and fog means a shared
    // entry can still hold secrets — so defaulting to hidden costs nothing.
    setDraft({ name: '', fields: {}, visibility: 'hidden', note: '' });
    setMode('create');
    if (isPhone) setPane('entry');
  };

  const startEdit = (entry) => {
    setDraft({ name: entry.name || '', fields: { ...(entry.fields || {}) }, visibility: entry.visibility || 'hidden', note: '' });
    setMode('edit');
  };

  // §4.9 propose: a `propose` member suggests an edit. Same form, but Save submits
  // a PROPOSAL (never mutates the entry) that the GM later reviews. Seeds from the
  // entry as the member currently sees it (fog already stripped server-side).
  const startPropose = (entry) => {
    if (!entry) return;
    // No `visibility` here: secrecy is a GM decision and createProposal submits
    // only name/fields/note. Carrying a value would imply the proposer has a say.
    setDraft({ name: entry.name || '', fields: { ...(entry.fields || {}) }, note: '' });
    setMode('propose');
  };

  const save = async () => {
    const name = draft.name.trim();
    if (!name || busy || !catDef) return;
    setBusy(true);
    try {
      if (mode === 'propose') {
        if (!active) return;
        const res = await api.createProposal(worldId, active.id, {
          name, fields: draft.fields, note: (draft.note || '').trim(),
        });
        if (res && res.id) {
          setMode('read');
          await loadMyProposals(active.id);
        }
      } else if (mode === 'create') {
        const res = await api.createLore(worldId, {
          categoryId: catDef.id, name, fields: draft.fields, visibility: draft.visibility,
        });
        if (res && res.id) {
          await Promise.all([loadEntries(activeCat), loadAll()]);
          setActive(res);
          setMode('read');
        }
      } else if (active) {
        const res = await api.updateLore(worldId, active.id, {
          name, fields: draft.fields, visibility: draft.visibility,
        });
        if (res && res.id) {
          await Promise.all([loadEntries(activeCat), loadAll()]);
          setActive(res);
          setMode('read');
        }
      }
    } finally {
      setBusy(false);
    }
  };

  const remove = async (entry) => {
    if (!window.confirm(`Delete "${entry.name}"? This cannot be undone.`)) return;
    const res = await api.deleteLore(worldId, entry.id);
    if (res && res.ok) {
      await Promise.all([loadEntries(activeCat), loadAll()]);
      setActive(null);
      setMode('read');
      if (isPhone) setPane('list');
    }
  };

  // Upload an image via the editor's IMG button. Returns the stored asset so the
  // textarea can drop `![name](url)` at the caret. Requires an existing entry
  // (the server keys assets to the entry id), so the button only appears in edit
  // mode — a brand-new entry has no id to attach to until it's first saved.
  const uploadImage = async (file) => {
    if (!active) return null;
    const res = await api.uploadLoreAsset(worldId, active.id, file);
    if (res && res.asset) { setAssets(a => [...a, res.asset]); return res.asset; }
    if (res && res.error) window.alert(res.error);
    return null;
  };

  // Upload any allowlisted file from the attachments panel.
  const uploadAsset = async (file) => {
    if (!active) return;
    const res = await api.uploadLoreAsset(worldId, active.id, file);
    if (res && res.asset) setAssets(a => [...a, res.asset]);
    else if (res && res.error) window.alert(res.error);
  };

  const removeAsset = async (key) => {
    if (!active) return;
    if (!window.confirm('Remove this file? Anything in the body that embeds it will show a broken image.')) return;
    const res = await api.deleteLoreAsset(worldId, active.id, key);
    if (res && Array.isArray(res.assets)) setAssets(res.assets);
  };

  // Apply a size/align change to ONE inline image, located by its source offsets
  // in the given field's text. Optimistic: splice the body and update local state
  // immediately (so the control feels instant), then persist with a normal PUT
  // (which snapshots history like any edit, so a resize is itself undoable).
  const applyImageDirective = async (fieldKey, position, alt, src, dir) => {
    if (!active || !position) return;
    const text  = active.fields?.[fieldKey] || '';
    const start = position.start.offset, end = position.end.offset;
    if (typeof start !== 'number' || typeof end !== 'number') return;
    const token = `![${alt}](${src}${dir ? ` "${dir}"` : ''})`;
    const nextText   = text.slice(0, start) + token + text.slice(end);
    const nextFields = { ...(active.fields || {}), [fieldKey]: nextText };
    const optimistic = { ...active, fields: nextFields };
    setActive(optimistic);
    setEntries(es => es.map(e => (e.id === active.id ? optimistic : e)));
    setAllEntries(es => es.map(e => (e.id === active.id ? optimistic : e)));

    const res = await api.updateLore(worldId, active.id, {
      name: active.name, fields: nextFields, visibility: active.visibility,
    });
    if (res && res.id) setActive(res);   // reconcile timestamps
  };

  const openHistory = async (entry) => {
    setHistoryFor(entry);
    setPreview(null);
    const res = await api.getLoreHistory(worldId, entry.id);
    setVersions(Array.isArray(res?.versions) ? res.versions : []);
  };

  const restore = async (index) => {
    if (!historyFor) return;
    if (!window.confirm('Restore this version? The current state is saved to history first, so this is undoable.')) return;
    const res = await api.restoreLore(worldId, historyFor.id, index);
    if (res && res.id) {
      await Promise.all([loadEntries(activeCat), loadAll()]);
      setActive(res);
      setHistoryFor(null);
      setMode('read');
    }
  };

  // Apply a category rename/hide saved from the World Settings modal (§4.7b). The
  // modal owns the edit UI + the PUT; here we adopt the merged list it returns and
  // keep the active category valid — if it was just hidden (or vanished), fall
  // back to the first still-visible one so the reader/list don't point at a dead
  // rail. (This was `saveCustomize`'s tail; the edit form moved into the modal.)
  const applyCategoryConfig = (merged) => {
    if (!Array.isArray(merged)) return;
    setCategories(merged);
    const stillVisible = merged.find(c => c.id === activeCat && !c.hidden);
    if (!stillVisible) {
      const firstVisible = merged.find(c => !c.hidden);
      selectCategory(firstVisible ? firstVisible.id : null);
    }
  };

  // ---- landing page handlers -------------------------------------------------
  const startEditLanding = () => { setLandingDraft(world?.landing || ''); setLandingMode('edit'); };

  const saveLanding = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const res = await api.setWorldLanding(worldId, landingDraft);
      if (res && res.id) { setWorld(res); setLandingMode('read'); }
    } finally {
      setBusy(false);
    }
  };

  // Upload an image via the landing editor's IMG button. Unlike a lore entry, the
  // landing has no entry id — assets go to the WORLD store, so this is the
  // world-scoped uploader threaded into the SAME `WikiTextarea` onUploadImage
  // prop the lore form uses. Returns the stored asset so `![name](url)` drops in.
  const uploadWorldImage = async (file) => {
    const res = await api.uploadWorldAsset(worldId, file);
    if (res && res.asset) { setWorldAssets(a => [...a, res.asset]); return res.asset; }
    if (res && res.error) window.alert(res.error);
    return null;
  };

  const uploadWorldFile = async (file) => {
    const res = await api.uploadWorldAsset(worldId, file);
    if (res && res.asset) setWorldAssets(a => [...a, res.asset]);
    else if (res && res.error) window.alert(res.error);
  };

  const removeWorldAsset = async (key) => {
    if (!window.confirm('Remove this file? Anything in the landing that embeds it will show a broken image.')) return;
    const res = await api.deleteWorldAsset(worldId, key);
    if (res && Array.isArray(res.assets)) setWorldAssets(res.assets);
  };

  const filtered = entries.filter(e =>
    !search.trim() || (e.name || '').toLowerCase().includes(search.trim().toLowerCase())
  );

  // A non-empty query flips the entry-list panel (and, on phone, the rail itself)
  // from the active category's entries into world-global results.
  const searching = !!search.trim();

  // ---- panel renderers -------------------------------------------------------

  // Shared global-search result rows — used by the desktop list panel and, on
  // phone, inline under the rail search box. Each row: entry name, the merged
  // category-label chip (§4j renames show here), the subtitle/snippet, and the
  // eye-off marker when the entry OR its category is hidden. Click → goToEntry
  // (which switches category and, on phone, pushes to the entry pane).
  // One row shape shared by all three result kinds: title + a type/category
  // chip on the right of the title, an optional snippet line, an optional
  // trailing glyph (hidden-eye for lore, none for campaign/session), and an
  // `on` (currently-open) highlight. Kind-specific data maps into this in
  // renderResultRows below.
  const resultRow = ({ key, title, chip, snippet, on, hiddenTitle, onClick }) => (
    <button key={key} type="button" onClick={onClick} style={{
      display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.5rem',
      textAlign: 'left', cursor: 'pointer', padding: '0.55rem 0.7rem', width: '100%',
      background: 'var(--bg-raised)',
      border: `1px solid ${on ? 'var(--accent)' : 'var(--border)'}`, borderRadius: '2px',
      color: 'var(--text-primary)', fontFamily: 'var(--font-body)',
    }}>
      <span style={{ minWidth: 0, flex: '1 1 auto' }}>
        <span style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', minWidth: 0 }}>
          <span style={{ color: 'var(--text-accent)', fontSize: '1rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }}>
            {title}
          </span>
          <span style={{
            flex: '0 0 auto', fontFamily: 'var(--font-mono)', fontSize: '0.55rem',
            letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--text-dim)',
            border: '1px solid var(--border)', borderRadius: '999px', padding: '0.05rem 0.4rem',
          }}>{chip}</span>
        </span>
        {snippet && (
          <span style={{ display: 'block', fontSize: '0.8rem', color: 'var(--text-dim)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {snippet}
          </span>
        )}
      </span>
      {hiddenTitle && (
        <span style={{ color: 'var(--text-dim)', flex: '0 0 auto' }} title={hiddenTitle}>
          <EyeOffIcon size={15} />
        </span>
      )}
    </button>
  );

  const renderResultRows = () => (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem', overflowY: 'auto' }}>
      {searchResults.rows.length === 0 && (
        <div style={{ color: 'var(--text-dim)', fontSize: '0.85rem', padding: '1rem 0', textAlign: 'center' }}>
          No matches for “{search.trim()}”.
        </div>
      )}
      {searchResults.rows.map(row => {
        if (row.kind === 'entry') {
          const e   = row.entry;
          const cat = catById.get(e.categoryId);
          return resultRow({
            key: row.key, title: e.name, chip: cat?.label || e.categoryId, snippet: row.snippet,
            on: active && active.id === e.id,
            hiddenTitle: (e.visibility === 'hidden' || !!cat?.hidden)
              ? (cat?.hidden ? 'In a hidden category' : 'Hidden from players') : null,
            onClick: () => { goToEntry(e); setDrawerOpen(false); },
          });
        }
        if (row.kind === 'campaign') {
          return resultRow({
            key: row.key, title: row.name, chip: 'Campaign', snippet: row.snippet,
            on: activeCampaign === row.campaignId && !activeSession,
            onClick: () => { goToCampaignResult(row.campaignId); setDrawerOpen(false); },
          });
        }
        // row.kind === 'session'
        return resultRow({
          key: row.key, title: `${row.campaignName} · #${row.session.number}${row.session.title ? ` ${row.session.title}` : ''}`,
          chip: 'Session', snippet: row.snippet,
          on: activeCampaign === row.campaignId && activeSession?.id === row.session.id,
          onClick: () => { goToSessionResult(row.campaignId, row.session); setDrawerOpen(false); },
        });
      })}
      {searchResults.truncated && (
        <div style={{ color: 'var(--text-dim)', fontSize: '0.75rem', padding: '0.5rem 0', textAlign: 'center' }}>
          Showing the first 50 — refine your search.
        </div>
      )}
    </div>
  );

  const renderRail = () => (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
      <div>
        <div style={eyebrow}>World</div>
        <div style={{ fontFamily: 'var(--font-body)', fontSize: '1.25rem', color: 'var(--text-accent)', letterSpacing: '0.03em', lineHeight: 1.2 }}>
          {world ? world.name : '…'}
        </div>
      </div>
      {/* World-global search (§4l), compacted to the collapse-to-glyph band (§4m)
          so it reads as one search idiom with the character list. It stays at the
          TOP of the rail — world-wide, matching name/subtitle/any field across
          EVERY category. On desktop, results fill the list panel (renderList); on
          phone this is the categories pane, so results show inline just below (the
          `isPhone && searching` branch). Tokens/timings are copied verbatim from
          CharacterList's band so the two feel identical. */}
      {/* Search band + (owner-only) settings gear (§4.10). Both live on the RIGHT
          of this row: the gear is rightmost, the collapse-to-glyph search sits
          immediately to its left, and both glyphs are the same size. Opening the
          search grows the band LEFTWARD to full width, sweeping over the gear
          (which fades via the band's 140ms token) and coming back on collapse.
          The gear opens the same WorldSettingsModal the rail item used to; it's
          chrome only — the settings routes are already owner-gated. */}
      <div style={{ position: 'relative', height: 30 }}>
        {isOwner && (
          <button type="button" aria-label="World settings" title="World settings"
            onClick={() => openSettings('general')}
            tabIndex={searchOpen ? -1 : 0}
            style={{
              position: 'absolute', right: 0, top: 0, width: 30, height: 30, zIndex: 1,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-primary)',
              opacity: searchOpen ? 0 : 1, pointerEvents: searchOpen ? 'none' : 'auto',
              transition: 'opacity 140ms ease',
            }}
            onMouseEnter={e => { e.currentTarget.style.color = 'var(--text-accent)'; }}
            onMouseLeave={e => { e.currentTarget.style.color = 'var(--text-primary)'; }}>
            <GearIcon size={17} style={{ display: 'block', flexShrink: 0, minWidth: 17, minHeight: 17 }} />
          </button>
        )}
        <div style={{
          position: 'absolute', top: 0, zIndex: 2,
          // Anchored to the right: collapsed it sits just left of the gear (right:
          // 52, a clear gap without overlapping); open it slides to right:0 and
          // grows to full width, covering the faded gear.
          right: searchOpen ? 0 : (isOwner ? 24 : 0),
          display: 'flex', alignItems: 'center', justifyContent: 'flex-end',
          width: searchOpen ? '100%' : 30, height: 30,
          background: searchOpen ? 'var(--bg-input)' : 'transparent',
          border: `1px solid ${searchOpen ? 'var(--border-bright)' : 'transparent'}`,
          borderRadius: 'var(--radius)', overflow: 'hidden',
          boxShadow: searchOpen ? '0 0 0 1px var(--accent-glow)' : 'none',
          transition: 'width 220ms cubic-bezier(0.22,0.61,0.36,1), right 220ms cubic-bezier(0.22,0.61,0.36,1), border-color 180ms ease, background-color 180ms ease',
        }}>
          <button type="button" aria-label="Search this world"
            onClick={() => (searchOpen ? collapseSearch() : openSearch())}
            onMouseEnter={e => { if (!searchOpen) e.currentTarget.style.color = 'var(--text-accent)'; }}
            onMouseLeave={e => { if (!searchOpen) e.currentTarget.style.color = 'var(--text-primary)'; }}
            style={{
              flex: '0 0 30px', width: 30, height: 30, display: 'flex',
              alignItems: 'center', justifyContent: 'center',
              background: 'none', border: 'none',
              cursor: searchOpen ? 'default' : 'pointer',
              color: searchOpen ? 'var(--text-dim)' : 'var(--text-primary)',
            }}>
            <SearchIcon size={17} style={{ display: 'block', flexShrink: 0, minWidth: 17, minHeight: 17 }} />
          </button>
          <input ref={searchInputRef} type="text" value={search}
            onChange={e => setSearch(e.target.value)}
            onBlur={collapseSearch}
            onKeyDown={e => { if (e.key === 'Escape') { setSearch(''); setSearchOpen(false); e.currentTarget.blur(); } }}
            placeholder="Search this world…" autoComplete="off"
            style={{
              flex: '1 1 auto', minWidth: 0, background: 'none', border: 'none',
              outline: 'none', boxShadow: 'none', color: 'var(--text-primary)', fontFamily: 'var(--font-body)',
              fontSize: '0.95rem', padding: '0 0.2rem',
              opacity: searchOpen ? 1 : 0, transition: 'opacity 140ms ease 90ms',
            }} />
          {searchOpen && search && (
            <button type="button" aria-label="Clear search"
              onClick={() => { setSearch(''); searchInputRef.current?.focus(); }}
              style={{ flex: '0 0 auto', background: 'none', border: 'none', color: 'var(--text-dim)', cursor: 'pointer', fontSize: '1.05rem', lineHeight: 1, padding: '0 0.7rem 0 0.3rem' }}>
              ✕
            </button>
          )}
        </div>
      </div>

      {isPhone && searching ? (
        <>
          <div style={{ ...eyebrow }}>Results · {searchResults.rows.length}{searchResults.truncated ? '+' : ''}</div>
          {renderResultRows()}
        </>
      ) : (
        <>
          {/* Home — the world's landing page, above the Lore divider. Highlighted
              like a category when it's the active view. */}
          <button type="button" onClick={selectHome} style={{
            display: 'flex', alignItems: 'center', gap: '0.6rem', width: '100%',
            textAlign: 'left', cursor: 'pointer', padding: '0.5rem 0.6rem',
            background: showHome ? 'var(--bg-raised)' : 'transparent',
            border: 'none', borderLeft: `2px solid ${showHome ? 'var(--accent)' : 'transparent'}`,
            color: showHome ? 'var(--text-accent)' : 'var(--text-primary)',
            fontFamily: 'var(--font-body)', fontSize: '0.95rem',
          }}>
            <HomeIcon size={17} /> Home
          </button>
          {/* World Calendar — only shown when the pack actually has a calendar
              (calendar-date fields degrade to a note without one, so there'd be
              nothing to plot). A peer of Home, not a lore category. */}
          {calendar && (
            <button type="button" onClick={selectCalendar} style={{
              display: 'flex', alignItems: 'center', gap: '0.6rem', width: '100%',
              textAlign: 'left', cursor: 'pointer', padding: '0.5rem 0.6rem',
              background: calendarOpen ? 'var(--bg-raised)' : 'transparent',
              border: 'none', borderLeft: `2px solid ${calendarOpen ? 'var(--accent)' : 'transparent'}`,
              color: calendarOpen ? 'var(--text-accent)' : 'var(--text-primary)',
              fontFamily: 'var(--font-body)', fontSize: '0.95rem',
            }}>
              <CalendarIcon size={17} /> Calendar
            </button>
          )}
          <div style={{ height: '1px', background: 'linear-gradient(90deg, var(--accent), transparent)' }} />
          <div style={{ ...eyebrow, marginBottom: '0.15rem' }}>Lore</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.15rem' }}>
            {categories.filter(c => !c.hidden).map(c => {
              const on = !showHome && c.id === activeCat;
              return (
                <button key={c.id} type="button" onClick={() => selectCategory(c.id)} style={{
                  display: 'flex', alignItems: 'center', gap: '0.6rem', width: '100%',
                  textAlign: 'left', cursor: 'pointer', padding: '0.5rem 0.6rem',
                  background: on ? 'var(--bg-raised)' : 'transparent',
                  border: 'none', borderLeft: `2px solid ${on ? 'var(--accent)' : 'transparent'}`,
                  color: on ? 'var(--text-accent)' : 'var(--text-primary)',
                  fontFamily: 'var(--font-body)', fontSize: '0.95rem',
                }}>
                  <CatIcon name={c.icon} size={17} />
                  {c.label}
                </button>
              );
            })}
          </div>
          {/* Campaigns — a PEER of the whole lore tree, not a lore category.
              Campaigns have children (sessions), live in campaigns.json rather
              than the pack, and are cross-user relational, so they can't be a
              category however much the rail makes them look like one. */}
          {campaigns.length > 0 && (
            <>
              <div style={{ height: '1px', background: 'linear-gradient(90deg, var(--accent), transparent)' }} />
              <div style={{ ...eyebrow, marginBottom: '0.15rem' }}>Campaigns</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.15rem' }}>
                {campaigns
                  .filter(c => showArchivedCamps || c.status !== 'archived')
                  .map(c => {
                    const on = c.id === activeCampaign;
                    return (
                      <button key={c.id} type="button" onClick={() => selectCampaign(c.id)} style={{
                        display: 'flex', alignItems: 'center', gap: '0.6rem', width: '100%',
                        textAlign: 'left', cursor: 'pointer', padding: '0.5rem 0.6rem',
                        background: on ? 'var(--bg-raised)' : 'transparent',
                        border: 'none', borderLeft: `2px solid ${on ? 'var(--accent)' : 'transparent'}`,
                        color: on ? 'var(--text-accent)' : 'var(--text-primary)',
                        fontFamily: 'var(--font-body)', fontSize: '0.95rem',
                        opacity: c.status === 'archived' ? 0.6 : 1,
                      }}>
                        <CatIcon name="flag" size={17} />
                        <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {c.name}
                        </span>
                      </button>
                    );
                  })}
                {campaigns.some(c => c.status === 'archived') && (
                  <button type="button" onClick={() => setShowArchivedCamps(v => !v)}
                    style={{
                      background: 'none', border: 'none', cursor: 'pointer', textAlign: 'left',
                      color: 'var(--text-dim)', fontFamily: 'var(--font-mono)', fontSize: '0.65rem',
                      letterSpacing: '0.08em', textTransform: 'uppercase', padding: '0.35rem 0.6rem',
                    }}>
                    {showArchivedCamps ? 'Hide archived' : 'Show archived'}
                  </button>
                )}
              </div>
            </>
          )}

          {/* Room reserved (structurally) for a future "System" section — not
              rendered now, so no empty placeholder implying missing function. */}
          {/* §4.10: the "World settings" rail item moved to a gear button beside
              the search band above (owner-only). Nothing here now. */}
        </>
      )}
    </div>
  );

  // §4.11 Timeline — a VIEW of the active category's entries (NOT a new fetch:
  // `entries` is already the canSee-filtered, fog-stripped §4.8 payload, so a
  // member's timeline inherits their visibility for free). Dated entries sort by
  // compareDates(start); undated ones bucket at the end, never dropped. Each row
  // shows the formatted date (+ range if there's an end), the gap to the previous
  // event via diffDays, name and subtitle; clicking uses the existing goToEntry.
  const renderTimeline = () => {
    const dated = [];
    const undated = [];
    for (const e of entries) {
      const s = e.fields?.[startKey];
      if (s && Number.isInteger(s.year)) dated.push(e); else undated.push(e);
    }
    dated.sort((a, b) => compareDates(calendar, a.fields[startKey], b.fields[startKey]));

    const row = (e, extra) => {
      const on = active && active.id === e.id;
      return (
        <button key={e.id} type="button" onClick={() => openEntry(e)} style={{
          display: 'block', textAlign: 'left', cursor: 'pointer', width: '100%',
          padding: '0.5rem 0.7rem', background: 'var(--bg-raised)',
          border: `1px solid ${on ? 'var(--accent)' : 'var(--border)'}`, borderRadius: '2px',
          color: 'var(--text-primary)', fontFamily: 'var(--font-body)',
        }}>
          {extra}
          <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.5rem' }}>
            <span style={{ color: 'var(--text-accent)', fontSize: '1rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }}>{e.name}</span>
            {e.visibility === 'hidden' && (
              <span style={{ color: 'var(--text-dim)', flex: '0 0 auto' }} title="Hidden from players"><EyeOffIcon size={15} /></span>
            )}
          </span>
          {e.fields?.subtitle && (
            <span style={{ display: 'block', fontSize: '0.8rem', color: 'var(--text-dim)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{e.fields.subtitle}</span>
          )}
        </button>
      );
    };

    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem', overflowY: 'auto' }}>
        {dated.length === 0 && undated.length === 0 && (
          <div style={{ color: 'var(--text-dim)', fontSize: '0.85rem', padding: '1rem 0', textAlign: 'center' }}>No entries yet.</div>
        )}
        {dated.map((e, i) => {
          const s = e.fields[startKey];
          const end = endKey ? e.fields?.[endKey] : null;
          const prev = i > 0 ? dated[i - 1].fields[startKey] : null;
          const gap = prev ? diffDays(calendar, s, prev) : null;
          const dateLine = (
            <span style={{ display: 'block', fontFamily: 'var(--font-mono)', fontSize: '0.65rem', color: 'var(--text-dim)', letterSpacing: '0.05em', marginBottom: '0.15rem' }}>
              {formatDate(calendar, s)}{end && Number.isInteger(end.year) ? ` – ${formatDate(calendar, end)}` : ''}
              {gap != null && gap > 0 ? `  ·  +${gap} day${gap === 1 ? '' : 's'}` : ''}
            </span>
          );
          return row(e, dateLine);
        })}
        {undated.length > 0 && (
          <>
            <div style={{ ...eyebrow, marginTop: dated.length ? '0.4rem' : 0 }}>Undated · {undated.length}</div>
            {undated.map(e => row(e, null))}
          </>
        )}
      </div>
    );
  };

  // The World Calendar — a rail-level pane (like Home), NOT scoped to one
  // category. Aggregates every entry in the WHOLE world that has a
  // calendar-date field, across every category, from the same canSee-filtered
  // `allEntries` payload [[wiki]] resolution already uses — no extra fetch. Each
  // entry's category can declare its own date field under a different key, so
  // this looks the field up per-entry via `catById`, not a single `startKey`.
  const globalDatedEntries = useMemo(() => {
    const out = [];
    for (const e of allEntries) {
      const cat = catById.get(e.categoryId);
      const dateField = (cat?.fields || []).find(f => f.type === 'calendar-date');
      if (!dateField) continue;
      const d = e.fields?.[dateField.key];
      if (d && Number.isInteger(d.year)) out.push({ entry: e, catLabel: cat.label, date: d });
    }
    return out;
  }, [allEntries, catById]);

  // Opens on the LATEST dated entry's month anywhere in the world (the most
  // recent thing that happened), not the calendar's epoch — then `calCursor`
  // takes over once the GM navigates with the ‹ › controls.
  const defaultCalCursor = () => {
    if (!calendar) return null;
    if (globalDatedEntries.length) {
      const latest = globalDatedEntries.slice().sort((a, b) => compareDates(calendar, b.date, a.date))[0];
      return { era: latest.date.era, year: latest.date.year, month: latest.date.month };
    }
    const eras = calEras(calendar);
    return { era: calendar.epoch?.era ?? (eras[0]?.id ?? null), year: calendar.epoch?.year || 1, month: 1 };
  };

  const renderWorldCalendarPane = () => {
    if (!calendar) return null;
    const cursor = calCursor || defaultCalCursor();
    if (!cursor) return null;
    const months   = calMonths(calendar);
    const weekdays = calWeekdays(calendar);
    const eras     = calEras(calendar);
    const monthDef = months[cursor.month - 1];
    const monthDays = monthDef?.days || 0;
    const eraObj = eras.find(er => er.id === cursor.era);

    const gotoMonth = (delta) => {
      let month = cursor.month + delta, year = cursor.year;
      if (month < 1) { month = months.length; year -= 1; }
      else if (month > months.length) { month = 1; year += 1; }
      setCalCursor({ era: cursor.era, year, month });
    };

    // Bucket this month's dated entries by day. Multi-day (start→end) entries
    // are plotted on their START day only — a full date-range fill is future
    // polish, not required to make the month useful.
    const byDay = new Map();
    for (const { entry, catLabel, date: d } of globalDatedEntries) {
      if (d.year !== cursor.year || d.month !== cursor.month) continue;
      if (eras.length && d.era !== cursor.era) continue;
      if (!byDay.has(d.day)) byDay.set(d.day, []);
      byDay.get(d.day).push({ entry, catLabel });
    }

    let leadBlanks = 0;
    if (weekdays.length) {
      const idx = weekdays.indexOf(weekdayOf(calendar, { era: cursor.era, year: cursor.year, month: cursor.month, day: 1 }));
      leadBlanks = idx >= 0 ? idx : 0;
    }
    const cols = weekdays.length || 7;
    const cells = [];
    for (let i = 0; i < leadBlanks; i++) cells.push(null);
    for (let day = 1; day <= monthDays; day++) cells.push(day);

    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
        <div style={eyebrow}>World Calendar</div>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <button type="button" className="btn-ghost" onClick={() => gotoMonth(-1)}
            style={{ padding: '0.3rem 0.7rem' }} aria-label="Previous month">‹</button>
          <div style={{ fontFamily: 'var(--font-body)', fontSize: '1.3rem', color: 'var(--text-accent)', textAlign: 'center' }}>
            {monthDef?.name || `Month ${cursor.month}`} · {cursor.year}
            {eraObj ? ` ${eraObj.abbr || eraObj.label || eraObj.id}` : ''}
          </div>
          <button type="button" className="btn-ghost" onClick={() => gotoMonth(1)}
            style={{ padding: '0.3rem 0.7rem' }} aria-label="Next month">›</button>
        </div>
        {weekdays.length > 0 && (
          <div style={{ display: 'grid', gridTemplateColumns: `repeat(${cols}, 1fr)`, gap: '0.35rem' }}>
            {weekdays.map(w => (
              <div key={w} style={{
                fontFamily: 'var(--font-mono)', fontSize: '0.6rem', color: 'var(--text-dim)',
                textAlign: 'center', textTransform: 'uppercase', letterSpacing: '0.04em',
                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              }}>{w}</div>
            ))}
          </div>
        )}
        <div style={{ display: 'grid', gridTemplateColumns: `repeat(${cols}, 1fr)`, gap: '0.35rem' }}>
          {cells.map((day, i) => day == null ? <div key={`b${i}`} /> : (
            <div key={day} style={{
              minHeight: 84, border: '1px solid var(--border)', borderRadius: '2px',
              padding: '0.3rem', background: 'var(--bg-raised)',
              display: 'flex', flexDirection: 'column', gap: '0.2rem', overflow: 'hidden',
            }}>
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: '0.65rem', color: 'var(--text-dim)' }}>{day}</span>
              {(byDay.get(day) || []).slice(0, 3).map(({ entry, catLabel }) => (
                <button key={entry.id} type="button" onClick={() => goToEntry(entry)}
                  title={`${entry.name} · ${catLabel}`} style={{
                    cursor: 'pointer', textAlign: 'left', background: 'var(--accent-glow)',
                    border: '1px solid var(--accent)', borderRadius: '2px', color: 'var(--text-accent)',
                    fontSize: '0.65rem', padding: '0.1rem 0.3rem', fontFamily: 'var(--font-body)',
                    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                  }}>{entry.name}</button>
              ))}
              {(byDay.get(day) || []).length > 3 && (
                <span style={{ fontSize: '0.6rem', color: 'var(--text-dim)' }}>+{byDay.get(day).length - 3} more</span>
              )}
            </div>
          ))}
        </div>
        {globalDatedEntries.length === 0 && (
          <div style={{ color: 'var(--text-dim)', fontSize: '0.85rem', fontStyle: 'italic' }}>
            No entries have a date yet — a category needs a calendar-date field, and an entry needs it filled in.
          </div>
        )}
      </div>
    );
  };

  // Sessions (Wave B) — this campaign's play log, ordered newest-first for
  // browsing (the spine is still `number`, unchanged by this display choice; the
  // server always returns it sorted ascending). An "Overview" row is pinned above
  // the log so there's always a way back to the campaign summary in the reader —
  // the same role the Home item plays above lore categories.
  // The merged campaign pane (session picker strip + whatever's selected below
  // it) — replaces the old three-panel layout (rail / session list / reader) for
  // campaigns with a two-panel one (rail / this). A laptop-width three-way split
  // left almost no room to write a scene; this gives the content the panel that
  // used to be split between a session list and a reader. All the chips live in
  // one row so Overview and every session stay one click away without a
  // dedicated list view eating width. Session data is already role-serialized by
  // the server — the isCampGM checks here only decide which CHROME to show.
  const renderCampaignPane = () => {
    const isCampGM = campaignData?.role === 'owner';
    const list = [...sessions].sort((a, b) => b.number - a.number);
    const chip = (key, label, on, onClick) => (
      <button key={key} type="button" onClick={onClick} style={{
        cursor: 'pointer', fontFamily: 'var(--font-mono)', fontSize: '0.7rem', letterSpacing: '0.03em',
        padding: '0.35rem 0.65rem', borderRadius: '999px', whiteSpace: 'nowrap', flex: '0 0 auto',
        color: on ? 'var(--bg-deep)' : 'var(--text-primary)',
        background: on ? 'var(--accent)' : 'var(--bg-raised)',
        border: `1px solid ${on ? 'var(--accent)' : 'var(--border)'}`,
      }}>
        {label}
      </button>
    );
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', flexWrap: 'wrap', borderBottom: '1px solid var(--border)', paddingBottom: '0.85rem' }}>
          {chip('overview', 'Overview', !activeSession && !sessionDraft, selectOverview)}
          {sessionsLoading && <span style={{ color: 'var(--text-dim)', fontSize: '0.75rem' }}>Loading…</span>}
          {list.map(s => chip(
            s.id,
            `#${s.number}${isCampGM && s.visibility === 'hidden' ? ' ●' : ''}`,
            activeSession?.id === s.id && !sessionDraft,
            () => selectSession(s),
          ))}
          {isCampGM && (
            <button type="button" onClick={startNewSession} className="btn-primary"
              style={{ padding: '0.3rem 0.5rem', display: 'inline-flex', alignItems: 'center', marginLeft: 'auto', flex: '0 0 auto' }}
              aria-label="New session" title="New session">
              <PlusIcon size={15} />
            </button>
          )}
        </div>
        {sessionDraft ? renderSessionForm() : activeSession ? renderSessionDetail() : renderCampaign()}
      </div>
    );
  };

  // The read view of one session. The payload is already role-serialized by the
  // server: a player's `s` has no scenes/nextTime/encounters/visibility at all,
  // so this branches on `campaignData.role` only to hide GM chrome (the Prep
  // block, the Edit/Delete row) — it never re-derives what content to show.
  const renderSessionDetail = () => {
    const s = activeSession;
    if (!s) return null;
    const isCampGM = campaignData?.role === 'owner';
    const prose = (label, text) => !text ? null : (
      <div>
        <div style={{ ...eyebrow, marginBottom: '0.3rem' }}>{label}</div>
        <LoreMarkdown text={text} resolve={resolveLink} onLink={goToEntry} allowExternal={allowExternal} />
      </div>
    );
    const scenes = Array.isArray(s.scenes) ? s.scenes : [];
    const hasRecord = s.record?.recap || s.record?.happened || s.record?.clues || s.record?.loot;

    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.7rem' }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '1rem' }}>
          <div style={{ minWidth: 0 }}>
            <h2 style={{ fontSize: '1.5rem', color: 'var(--text-accent)', letterSpacing: '0.03em', lineHeight: 1.15 }}>
              Session #{s.number}{s.title ? ` · ${s.title}` : ''}
            </h2>
            <div style={{ display: 'flex', gap: '0.6rem', flexWrap: 'wrap', marginTop: '0.2rem', color: 'var(--text-dim)', fontSize: '0.85rem' }}>
              {s.date && <span>{s.date}</span>}
              {s.inWorldDate && <span>{formatDate(calendar, s.inWorldDate)}</span>}
              {!s.date && !s.inWorldDate && <span style={{ fontStyle: 'italic' }}>No date set</span>}
            </div>
          </div>
          {isCampGM && <VisibilityPill value={s.visibility} />}
        </div>

        {isCampGM && (
          <div>
            <div style={{ ...eyebrow, marginBottom: '0.4rem' }}>Prep · GM only, never sent to players</div>
            {scenes.length === 0 ? (
              <div style={{ color: 'var(--text-dim)', fontSize: '0.8rem', fontStyle: 'italic', border: '1px solid var(--border)', borderRadius: '2px', background: 'var(--bg-raised)', padding: '0.6rem 0.75rem' }}>
                No scenes prepped yet.
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.6rem' }}>
                {scenes.map((sc, i) => {
                  const open = !viewScenesCollapsed.has(i);
                  return (
                    <div key={i} style={{ border: '1px solid var(--border)', borderRadius: '2px', background: 'var(--bg-raised)' }}>
                      <button type="button" onClick={() => toggleSceneCollapse(setViewScenesCollapsed, i)} style={{
                        display: 'flex', alignItems: 'center', gap: '0.4rem', width: '100%', cursor: 'pointer',
                        textAlign: 'left', background: 'none', border: 'none', padding: '0.6rem 0.75rem',
                        color: 'var(--text-accent)', fontSize: '1rem', fontFamily: 'var(--font-body)',
                      }}>
                        <span style={{ display: 'inline-block', transform: open ? 'rotate(90deg)' : 'none', transition: 'transform 120ms ease', color: 'var(--text-dim)', flex: '0 0 auto' }}>▸</span>
                        <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          Scene {i + 1}{sc.name ? ` · ${sc.name}` : ''}
                        </span>
                      </button>
                      {open && (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.45rem', padding: '0 0.75rem 0.65rem' }}>
                          {SESSION_SCENE_FIELDS_UI.map(([k, label]) => sc[k] ? (
                            <div key={k}>
                              <div style={{ fontFamily: 'var(--font-mono)', fontSize: '0.6rem', color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>{label}</div>
                              <LoreMarkdown text={sc[k]} resolve={resolveLink} onLink={goToEntry} allowExternal={allowExternal} />
                            </div>
                          ) : null)}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {hasRecord ? (
          <>
            {prose('Recap', s.record?.recap)}
            {prose('What happened', s.record?.happened)}
            {prose('Clues & information', s.record?.clues)}
            {prose('Loot', s.record?.loot)}
          </>
        ) : (
          <div style={{ color: 'var(--text-dim)', fontSize: '0.85rem', fontStyle: 'italic' }}>
            {isCampGM ? 'No record written yet.' : "The GM hasn't shared a record for this session yet."}
          </div>
        )}

        {isCampGM && s.nextTime && prose('Next time', s.nextTime)}

        {isCampGM && Array.isArray(s.encounters) && s.encounters.length > 0 && (
          <div>
            <div style={{ ...eyebrow, marginBottom: '0.4rem' }}>Encounters</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem' }}>
              {s.encounters.map((e, i) => (
                <div key={i} style={{
                  display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.5rem',
                  border: '1px solid var(--border)', borderRadius: '2px', background: 'var(--bg-raised)', padding: '0.4rem 0.6rem',
                }}>
                  <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {e.name || `Encounter ${i + 1}`}
                  </span>
                  <span style={{
                    fontFamily: 'var(--font-mono)', fontSize: '0.6rem', letterSpacing: '0.06em', textTransform: 'uppercase',
                    padding: '0.15rem 0.5rem', borderRadius: '999px', flex: '0 0 auto',
                    color: e.status === 'run' ? 'var(--positive)' : 'var(--neutral)',
                    border: `1px solid ${e.status === 'run' ? 'var(--positive)' : 'var(--neutral)'}`,
                  }}>
                    {e.status === 'run' ? 'Run' : 'Ready'}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Attachments. The server already filtered `sessionAssets` for this
            role — owner gets hidden+shared, a player gets shared-only — so this
            renders whatever came back with no client-side gating. The GM alone
            gets upload/visibility/remove controls; a player gets a plain,
            read-only download list (and the section is hidden entirely for them
            when empty, rather than showing an empty "Attachments" header). */}
        {(isCampGM || sessionAssets.length > 0) && (
          <div style={{ borderTop: '1px solid var(--border)', paddingTop: '0.6rem' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.4rem' }}>
              <div style={eyebrow}>Attachments · {sessionAssets.length}</div>
              {isCampGM && (
                <>
                  <input ref={sessionAttachInputRef} type="file" style={{ display: 'none' }}
                    onChange={e => {
                      const f = e.target.files?.[0];
                      if (sessionAttachInputRef.current) sessionAttachInputRef.current.value = '';
                      if (f) uploadSessionAssetFile(f, 'hidden');
                    }} />
                  <button className="btn-ghost" style={{ padding: '0.2rem 0.5rem', fontSize: '0.72rem', minHeight: 28 }}
                    onClick={() => sessionAttachInputRef.current && sessionAttachInputRef.current.click()}>+ Add file</button>
                </>
              )}
            </div>
            {sessionAssets.length === 0 && (
              <div style={{ color: 'var(--text-dim)', fontSize: '0.78rem' }}>No files attached.</div>
            )}
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
              {sessionAssets.map(a => (
                <div key={a.key} style={{
                  display: 'flex', alignItems: 'center', gap: '0.5rem', padding: '0.25rem 0.4rem',
                  border: '1px solid var(--border)', borderRadius: '2px', background: 'var(--bg-raised)',
                }}>
                  {a.isImage
                    ? <img src={a.url} alt="" style={{ width: 26, height: 26, objectFit: 'cover', borderRadius: '2px', flex: '0 0 auto' }} />
                    : <span style={{ color: 'var(--text-dim)', flex: '0 0 auto' }}><FileIcon size={15} /></span>}
                  <div style={{ minWidth: 0, flex: '1 1 auto' }}>
                    <a href={a.url} target="_blank" rel="noopener noreferrer" style={{
                      display: 'block', color: 'var(--text-accent)', fontSize: '0.82rem',
                      overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                    }}>{a.name}</a>
                    <div style={{ fontFamily: 'var(--font-mono)', fontSize: '0.55rem', color: 'var(--text-dim)' }}>
                      {(a.ext || '').toUpperCase()} · {humanSize(a.size || 0)}
                    </div>
                  </div>
                  {isCampGM && (
                    <>
                      <button type="button" onClick={() => toggleSessionAssetVisibility(a)} style={{
                        cursor: 'pointer', fontFamily: 'var(--font-mono)', fontSize: '0.58rem', letterSpacing: '0.05em',
                        textTransform: 'uppercase', padding: '0.15rem 0.45rem', borderRadius: '999px', flex: '0 0 auto', whiteSpace: 'nowrap',
                        color: a.visibility === 'shared' ? 'var(--bg-deep)' : VIS[a.visibility === 'shared' ? 'shared' : 'hidden'].color,
                        background: a.visibility === 'shared' ? VIS.shared.color : 'transparent',
                        border: `1px solid ${a.visibility === 'shared' ? VIS.shared.color : VIS.hidden.color}`,
                      }} title="Click to toggle player visibility">
                        {a.visibility === 'shared' ? 'Shared' : 'Hidden'}
                      </button>
                      <button className="btn-ghost" style={{ padding: '0.15rem 0.4rem', fontSize: '0.66rem', color: 'var(--danger)', flex: '0 0 auto', minHeight: 28 }}
                        onClick={() => removeSessionAsset(a.key)}>Remove</button>
                    </>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {isCampGM && (
          <div style={{ display: 'flex', gap: '0.4rem', marginTop: '0.5rem' }}>
            <button className="btn-primary" style={denseBtn} onClick={() => startEditSession(s)}>Edit</button>
            <button className="btn-danger" style={denseBtn} onClick={() => deleteSessionRow(s)}>Delete</button>
          </div>
        )}
      </div>
    );
  };

  // The create/edit form — owner-only (the server 403s a player's write anyway).
  // Prep is a repeatable list of SCENE cards (add/remove/reorder), each with the
  // "Script" template's 8 prompts. Record keeps the old flat shape — the GM
  // writes what happened once, not per-scene. No fog hint on Prep fields: Prep
  // is already a structural GM-only boundary (never serialized to a player at
  // all — see loreAccess.js), so `||fog||` inside it would hide nothing further.
  // The hint stays on Record fields, where fog does real work (a shared recap
  // that still needs to hide who forged the ledger).
  const renderSessionForm = () => {
    const d = sessionDraft;
    if (!d) return null;
    const isNew = !d._id;
    const setRecord = (k, v) => setSessionDraft(dr => ({ ...dr, record: { ...dr.record, [k]: v } }));
    const gmField = (label, hint, value, onChange, rows = 3) => (
      <div>
        <label style={labelStyle}>{label}</label>
        <WikiTextarea rows={rows} value={value} names={entryNames} onChange={onChange}
          allowExternalLink={allowExternal} allowFog={false}
          style={{ ...inputStyle, resize: 'vertical', lineHeight: 1.5 }} placeholder={hint} />
      </div>
    );
    const recordField = (label, value, onChange, rows = 3) => (
      <div>
        <label style={labelStyle}>{label}  ·  ||text|| = GM-only fog</label>
        <WikiTextarea rows={rows} value={value} names={entryNames} onChange={onChange}
          allowExternalLink={allowExternal} style={{ ...inputStyle, resize: 'vertical', lineHeight: 1.5 }} />
      </div>
    );

    const addScene    = () => setSessionDraft(dr => ({ ...dr, scenes: [...dr.scenes, emptyScene()] }));
    const updateScene = (i, patch) => setSessionDraft(dr => ({ ...dr, scenes: dr.scenes.map((sc, idx) => idx === i ? { ...sc, ...patch } : sc) }));
    const removeScene = (i) => setSessionDraft(dr => ({ ...dr, scenes: dr.scenes.filter((_, idx) => idx !== i) }));
    const moveScene   = (i, dir) => setSessionDraft(dr => {
      const j = i + dir;
      if (j < 0 || j >= dr.scenes.length) return dr;
      const next = dr.scenes.slice();
      [next[i], next[j]] = [next[j], next[i]];
      return { ...dr, scenes: next };
    });

    const addEncounter    = () => setSessionDraft(dr => ({ ...dr, encounters: [...dr.encounters, { name: '', notes: '', status: 'ready' }] }));
    const updateEncounter = (i, patch) => setSessionDraft(dr => ({ ...dr, encounters: dr.encounters.map((e, idx) => idx === i ? { ...e, ...patch } : e) }));
    const removeEncounter = (i) => setSessionDraft(dr => ({ ...dr, encounters: dr.encounters.filter((_, idx) => idx !== i) }));

    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
        <div style={eyebrow}>{isNew ? 'New session' : `Edit · Session #${d.number}`}</div>

        <div style={{ display: 'flex', gap: '0.6rem', flexWrap: 'wrap' }}>
          <div style={{ flex: '1 1 200px' }}>
            <label style={labelStyle}>Title</label>
            <input value={d.title} onChange={e => setSessionDraft(dr => ({ ...dr, title: e.target.value }))}
              style={inputStyle} placeholder="e.g. The Counting House" autoFocus />
          </div>
          <div style={{ flex: '1 1 140px' }}>
            <label style={labelStyle}>Real-world date</label>
            <input type="date" value={d.date || ''} onChange={e => setSessionDraft(dr => ({ ...dr, date: e.target.value }))} style={inputStyle} />
          </div>
        </div>

        <div>
          <label style={labelStyle}>In-world date — a separate axis from the date above, never inferred from it</label>
          <CalendarDateField calendar={calendar} value={d.inWorldDate}
            onChange={v => setSessionDraft(dr => ({ ...dr, inWorldDate: v }))} />
        </div>

        <div>
          <label style={labelStyle}>Share with players</label>
          <div style={{ display: 'flex', gap: '0.4rem', marginTop: '0.3rem' }}>
            {VIS_ORDER.map(v => (
              <button key={v} type="button" onClick={() => setSessionDraft(dr => ({ ...dr, visibility: v }))} style={{
                cursor: 'pointer', fontFamily: 'var(--font-mono)', fontSize: '0.65rem', letterSpacing: '0.06em',
                textTransform: 'uppercase', padding: '0.3rem 0.7rem', borderRadius: '999px',
                color: d.visibility === v ? 'var(--bg-deep)' : VIS[v].color,
                background: d.visibility === v ? VIS[v].color : 'transparent',
                border: `1px solid ${VIS[v].color}`,
              }}>
                {VIS[v].label}
              </button>
            ))}
          </div>
          <div style={{ color: 'var(--text-dim)', fontSize: '0.75rem', marginTop: '0.3rem' }}>
            {d.visibility === 'shared' ? 'The Record below becomes visible to players. Prep never is, regardless.' : 'GM only — players do not see this session exists.'}
          </div>
        </div>

        <div style={{ borderTop: '1px solid var(--border)', paddingTop: '0.8rem' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.5rem' }}>
            <div style={eyebrow}>Prep · Scenes — the rails. GM only, never sent to players.</div>
            <button type="button" className="btn-ghost" style={{ padding: '0.25rem 0.6rem', fontSize: '0.78rem' }} onClick={addScene}>+ Add scene</button>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.7rem' }}>
            {d.scenes.map((sc, i) => {
              const open = !formScenesCollapsed.has(i);
              return (
                <div key={i} style={{ border: '1px solid var(--border)', borderRadius: '2px', background: 'var(--bg-raised)', padding: '0.65rem 0.75rem', display: 'flex', flexDirection: 'column', gap: open ? '0.55rem' : 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                    <button type="button" onClick={() => toggleSceneCollapse(setFormScenesCollapsed, i)}
                      style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '0.2rem', color: 'var(--text-dim)', flex: '0 0 auto', display: 'inline-flex' }}
                      aria-label={open ? 'Collapse scene' : 'Expand scene'} title={open ? 'Collapse' : 'Expand'}>
                      <span style={{ display: 'inline-block', transform: open ? 'rotate(90deg)' : 'none', transition: 'transform 120ms ease' }}>▸</span>
                    </button>
                    <span style={{ ...eyebrow, flex: '0 0 auto' }}>Scene {i + 1}</span>
                    <input value={sc.name} onChange={e => updateScene(i, { name: e.target.value })}
                      placeholder="Scene name (e.g. Ellis discovers the truth)" style={{ ...inputStyle, flex: 1 }} />
                    <button type="button" className="btn-ghost" style={{ padding: '0.2rem 0.4rem' }} disabled={i === 0}
                      onClick={() => moveScene(i, -1)} aria-label="Move scene up" title="Move up">↑</button>
                    <button type="button" className="btn-ghost" style={{ padding: '0.2rem 0.4rem' }} disabled={i === d.scenes.length - 1}
                      onClick={() => moveScene(i, 1)} aria-label="Move scene down" title="Move down">↓</button>
                    <button type="button" className="btn-ghost" style={{ padding: '0.2rem 0.4rem', color: 'var(--danger)' }}
                      onClick={() => removeScene(i)} aria-label="Remove scene" title="Remove scene">✕</button>
                  </div>
                  {open && SESSION_SCENE_FIELDS_UI.map(([k, label, hint]) => (
                    <React.Fragment key={k}>{gmField(label, hint, sc[k], v => updateScene(i, { [k]: v }), k === 'dialog' || k === 'skillChecks' ? 2 : 3)}</React.Fragment>
                  ))}
                </div>
              );
            })}
            {d.scenes.length === 0 && (
              <div style={{ color: 'var(--text-dim)', fontSize: '0.8rem', fontStyle: 'italic' }}>No scenes yet — add one to start prepping.</div>
            )}
          </div>
        </div>

        <div style={{ borderTop: '1px solid var(--border)', paddingTop: '0.8rem' }}>
          <div style={{ ...eyebrow, marginBottom: '0.5rem' }}>Record — what actually happened, shareable per the toggle above.</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.6rem' }}>
            {recordField('Recap — read this aloud, two or three sentences', d.record.recap, v => setRecord('recap', v), 3)}
            {recordField('What happened', d.record.happened, v => setRecord('happened', v), 5)}
            {recordField('Clues & information handed out', d.record.clues, v => setRecord('clues', v), 4)}
            {recordField('Loot', d.record.loot, v => setRecord('loot', v), 3)}
          </div>
        </div>

        <div style={{ borderTop: '1px solid var(--border)', paddingTop: '0.8rem' }}>
          {gmField('Next time — prep this session generates for the next one', '', d.nextTime, v => setSessionDraft(dr => ({ ...dr, nextTime: v })), 5)}
        </div>

        <div style={{ borderTop: '1px solid var(--border)', paddingTop: '0.8rem' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.5rem' }}>
            <div style={eyebrow}>Encounters</div>
            <button type="button" className="btn-ghost" style={{ padding: '0.25rem 0.6rem', fontSize: '0.78rem' }} onClick={addEncounter}>+ Add</button>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
            {d.encounters.map((e, i) => (
              <div key={i} style={{ border: '1px solid var(--border)', borderRadius: '2px', background: 'var(--bg-raised)', padding: '0.5rem 0.6rem', display: 'flex', flexDirection: 'column', gap: '0.35rem' }}>
                <div style={{ display: 'flex', gap: '0.4rem' }}>
                  <input value={e.name} onChange={ev => updateEncounter(i, { name: ev.target.value })}
                    placeholder="Encounter name" style={{ ...inputStyle, flex: 1 }} />
                  <button type="button" onClick={() => updateEncounter(i, { status: e.status === 'run' ? 'ready' : 'run' })} style={{
                    cursor: 'pointer', fontFamily: 'var(--font-mono)', fontSize: '0.6rem', letterSpacing: '0.06em',
                    textTransform: 'uppercase', padding: '0.3rem 0.6rem', borderRadius: '999px', whiteSpace: 'nowrap',
                    color: e.status === 'run' ? 'var(--bg-deep)' : 'var(--neutral)',
                    background: e.status === 'run' ? 'var(--positive)' : 'transparent',
                    border: `1px solid ${e.status === 'run' ? 'var(--positive)' : 'var(--neutral)'}`,
                  }}>
                    {e.status === 'run' ? 'Run' : 'Ready'}
                  </button>
                  <button type="button" className="btn-ghost" style={{ padding: '0.25rem 0.5rem', color: 'var(--danger)' }}
                    onClick={() => removeEncounter(i)} aria-label="Remove encounter">✕</button>
                </div>
                <textarea value={e.notes} onChange={ev => updateEncounter(i, { notes: ev.target.value })}
                  placeholder="Notes" rows={2} style={{ ...inputStyle, resize: 'vertical' }} />
              </div>
            ))}
            {d.encounters.length === 0 && (
              <div style={{ color: 'var(--text-dim)', fontSize: '0.8rem', fontStyle: 'italic' }}>No encounters prepped.</div>
            )}
          </div>
        </div>

        <div style={{ display: 'flex', gap: '0.5rem' }}>
          <button className="btn-primary" onClick={saveSession} disabled={sessionSaving}>
            {sessionSaving ? 'Saving…' : 'Save'}
          </button>
          <button className="btn-ghost" onClick={() => setSessionDraft(null)} disabled={sessionSaving}>Cancel</button>
        </div>
      </div>
    );
  };

  const renderList = () => (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.6rem', height: '100%' }}>
      {/* Header: a results/category count on the left, view controls on the right.
          The search box lives in the rail (§4l), so a non-empty query renders
          global results here. §4.11: when the category has a calendar-date field
          and the pack has a calendar, a List/Timeline/Calendar switch appears;
          the + still creates in the active category. */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.5rem' }}>
        <div style={{ ...eyebrow }}>
          {searching
            ? `Results · ${searchResults.rows.length}${searchResults.truncated ? '+' : ''}`
            : `${catDef ? catDef.label : ''} · ${filtered.length}`}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
          {!searching && canTimeline && (
            <div style={{ display: 'flex', gap: '0.2rem' }}>
              {[['list', 'List'], ['timeline', 'Timeline']].map(([v, label]) => (
                <button key={v} type="button" onClick={() => setViewMode(v)}
                  aria-pressed={viewMode === v} title={`Show as ${label.toLowerCase()}`}
                  style={{
                    cursor: 'pointer', fontFamily: 'var(--font-mono)', fontSize: '0.6rem',
                    letterSpacing: '0.08em', textTransform: 'uppercase', padding: '0.3rem 0.6rem',
                    borderRadius: '999px', whiteSpace: 'nowrap',
                    color: viewMode === v ? 'var(--bg-deep)' : 'var(--text-dim)',
                    background: viewMode === v ? 'var(--accent)' : 'transparent',
                    border: `1px solid ${viewMode === v ? 'var(--accent)' : 'var(--border)'}`,
                  }}>
                  {label}
                </button>
              ))}
            </div>
          )}
          {canEdit && (
            <button type="button" onClick={startCreate} className="btn-primary"
              style={{ padding: '0.35rem 0.55rem', display: 'inline-flex', alignItems: 'center' }} aria-label="New entry">
              <PlusIcon size={16} />
            </button>
          )}
        </div>
      </div>
      {searching ? renderResultRows() : (
        // keep-fade replays on the list⇄timeline switch (§4m/§4.10 pattern,
        // gated by prefers-reduced-motion in index.css), keyed on the mode.
        <div className="keep-fade" key={viewMode} style={{ minHeight: 0, display: 'flex', flexDirection: 'column' }}>
        {viewMode === 'timeline' && canTimeline ? renderTimeline() : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem', overflowY: 'auto' }}>
          {filtered.length === 0 && (
            <div style={{ color: 'var(--text-dim)', fontSize: '0.85rem', padding: '1rem 0', textAlign: 'center' }}>
              No entries yet.
            </div>
          )}
          {filtered.map(e => {
            const on = active && active.id === e.id;
            return (
              <button key={e.id} type="button" onClick={() => openEntry(e)} style={{
                display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.5rem',
                textAlign: 'left', cursor: 'pointer', padding: '0.55rem 0.7rem', width: '100%',
                background: 'var(--bg-raised)',
                border: `1px solid ${on ? 'var(--accent)' : 'var(--border)'}`, borderRadius: '2px',
                color: 'var(--text-primary)', fontFamily: 'var(--font-body)',
              }}>
                <span style={{ minWidth: 0 }}>
                  <span style={{ display: 'block', color: 'var(--text-accent)', fontSize: '1rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {e.name}
                  </span>
                  {e.fields?.subtitle && (
                    <span style={{ display: 'block', fontSize: '0.8rem', color: 'var(--text-dim)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {e.fields.subtitle}
                    </span>
                  )}
                </span>
                {e.visibility === 'hidden' && (
                  <span style={{ color: 'var(--text-dim)', flex: '0 0 auto' }} title="Hidden from players">
                    <EyeOffIcon size={15} />
                  </span>
                )}
              </button>
            );
          })}
        </div>
        )}
        </div>
      )}
    </div>
  );

  const renderForm = () => {
    const proposing = mode === 'propose';
    // A write member may not set `hidden` (owner-only); the owner gets all states.
    // Both GM roles may set either state; non-GMs never reach this branch (the
    // proposing path renders a note field instead of the visibility control).
    const visChoices = VIS_ORDER;
    return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
      <div style={eyebrow}>
        {proposing ? `Suggest an edit — ${active?.name || ''}` : mode === 'create' ? `New ${catDef?.label || 'Entry'}` : 'Edit Entry'}
      </div>
      {proposing && (
        <div style={{
          color: 'var(--text-dim)', fontSize: '0.8rem', lineHeight: 1.5,
          border: '1px solid var(--border)', borderRadius: '2px', background: 'var(--bg-raised)', padding: '0.6rem 0.75rem',
        }}>
          Your changes are <strong>submitted for review</strong>, not applied — a GM approves or
          rejects them. The entry stays unchanged until then.
        </div>
      )}
      <div>
        <label style={labelStyle}>Name</label>
        <input value={draft.name} onChange={e => setDraft(d => ({ ...d, name: e.target.value }))}
          style={inputStyle} autoFocus placeholder="e.g. Waterdeep" />
      </div>
      {(catDef?.fields || []).map(f => (
        <div key={f.key}>
          <label style={labelStyle}>
            {f.label}{f.fog ? '  ·  ||text|| = GM-only fog' : ''}
          </label>
          {f.type === 'textarea'
            ? <WikiTextarea rows={8} value={draft.fields[f.key] || ''} names={entryNames}
                onChange={val => setDraft(d => ({ ...d, fields: { ...d.fields, [f.key]: val } }))}
                onUploadImage={active && canEdit ? uploadImage : undefined}
                allowExternalLink={allowExternal}
                style={{ ...inputStyle, resize: 'vertical', lineHeight: 1.5 }} />
            : f.type === 'calendar-date'
            ? <CalendarDateField calendar={calendar} value={draft.fields[f.key] || null}
                onChange={val => setDraft(d => ({ ...d, fields: { ...d.fields, [f.key]: val } }))} />
            : <input value={draft.fields[f.key] || ''}
                onChange={e => setDraft(d => ({ ...d, fields: { ...d.fields, [f.key]: e.target.value } }))}
                style={inputStyle} />}
        </div>
      ))}
      {proposing ? (
        <div>
          <label style={labelStyle}>Note to the GM (optional)</label>
          <textarea value={draft.note || ''} onChange={e => setDraft(d => ({ ...d, note: e.target.value }))}
            rows={2} placeholder="Why this change?" style={{ ...inputStyle, resize: 'vertical' }} />
        </div>
      ) : (
        <div>
          <label style={labelStyle}>Visibility</label>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.4rem' }}>
            {visChoices.map(v => {
              const on = draft.visibility === v;
              return (
                <button key={v} type="button" onClick={() => setDraft(d => ({ ...d, visibility: v }))} style={{
                  cursor: 'pointer', fontFamily: 'var(--font-mono)', fontSize: '0.6rem',
                  letterSpacing: '0.08em', textTransform: 'uppercase', padding: '0.3rem 0.6rem',
                  borderRadius: '999px', whiteSpace: 'nowrap',
                  color: on ? 'var(--bg-deep)' : VIS[v].color,
                  background: on ? VIS[v].color : 'transparent',
                  border: `1px solid ${VIS[v].color}`,
                }}>
                  {VIS[v].label}
                </button>
              );
            })}
          </div>
          <div style={{ fontSize: '0.7rem', color: 'var(--text-dim)', marginTop: '0.4rem' }}>
            {VIS_HINT[draft.visibility] || ''}
          </div>
        </div>
      )}
      <div style={{ display: 'flex', gap: '0.5rem' }}>
        <button className="btn-primary" onClick={save} disabled={!draft.name.trim() || busy}>
          {busy ? (proposing ? 'Submitting…' : 'Saving…') : (proposing ? 'Submit suggestion' : 'Save')}
        </button>
        <button className="btn-ghost" onClick={() => { setMode('read'); if (!active && isPhone) setPane('list'); }} disabled={busy}>
          Cancel
        </button>
      </div>
    </div>
    );
  };

  // The world landing "home": a read view (title + rendered Markdown, with fog
  // chips, [[wiki]] links and app-origin inline images all handled by the SAME
  // LoreMarkdown as lore bodies) plus an Option-A edit form — one fog-enabled
  // WikiTextarea whose IMG button uploads to the WORLD asset store. No history
  // (the landing isn't a lore entry). Owner-only, like everything on this page.
  const renderLanding = () => {
    if (landingMode === 'edit' && canEdit) {
      return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
          <div style={eyebrow}>Edit Home</div>
          <div>
            <label style={labelStyle}>Landing page  ·  ||text|| = GM-only fog</label>
            <WikiTextarea rows={16} value={landingDraft} names={entryNames}
              onChange={setLandingDraft}
              onUploadImage={uploadWorldImage}
              allowExternalLink={allowExternal}
              style={{ ...inputStyle, resize: 'vertical', lineHeight: 1.5 }} />
          </div>
          <div style={{ display: 'flex', gap: '0.5rem' }}>
            <button className="btn-primary" onClick={saveLanding} disabled={busy}>
              {busy ? 'Saving…' : 'Save'}
            </button>
            <button className="btn-ghost" onClick={() => setLandingMode('read')} disabled={busy}>Cancel</button>
          </div>
        </div>
      );
    }
    const body = world?.landing || '';
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.9rem' }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '1rem' }}>
          <h2 style={{ fontSize: '1.6rem', color: 'var(--text-accent)', letterSpacing: '0.03em', lineHeight: 1.15, minWidth: 0 }}>
            {world ? world.name : ''}
          </h2>
          {canEdit && (
            <button className="btn-primary" style={{ flex: '0 0 auto' }} onClick={startEditLanding}>Edit</button>
          )}
        </div>
        {body
          ? <LoreMarkdown text={body} resolve={resolveLink} onLink={goToEntry} allowExternal={allowExternal} />
          : <div style={{ color: 'var(--text-dim)', fontSize: '0.9rem', lineHeight: 1.5 }}>
              {canEdit
                ? <>No landing page yet. Click <strong>Edit</strong> to write one — Markdown, <code>||fog||</code>, <code>[[wiki links]]</code>, and uploaded images all work.</>
                : 'No landing page yet.'}
            </div>}

        {/* World-level assets. The manage panel (upload/remove) is owner-only
            (§4.8); a member sees landing images inline in the body above, not this
            management list. */}
        {isOwner && (
        <div style={{ borderTop: '1px solid var(--border)', paddingTop: '0.75rem' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.5rem' }}>
            <div style={eyebrow}>World files · {worldAssets.length}</div>
            <input ref={worldFileRef} type="file" style={{ display: 'none' }}
              onChange={e => { const f = e.target.files?.[0]; if (worldFileRef.current) worldFileRef.current.value = ''; if (f) uploadWorldFile(f); }} />
            <button className="btn-ghost" style={{ padding: '0.25rem 0.5rem' }}
              onClick={() => worldFileRef.current && worldFileRef.current.click()}>+ Add file</button>
          </div>
          {worldAssets.length === 0 && (
            <div style={{ color: 'var(--text-dim)', fontSize: '0.8rem' }}>No files uploaded.</div>
          )}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem' }}>
            {worldAssets.map(a => (
              <div key={a.key} style={{
                display: 'flex', alignItems: 'center', gap: '0.6rem', padding: '0.4rem 0.55rem',
                border: '1px solid var(--border)', borderRadius: '2px', background: 'var(--bg-raised)',
              }}>
                {a.isImage
                  ? <img src={a.url} alt="" style={{ width: 34, height: 34, objectFit: 'cover', borderRadius: '2px', flex: '0 0 auto' }} />
                  : <span style={{ color: 'var(--text-dim)', flex: '0 0 auto' }}><FileIcon size={18} /></span>}
                <div style={{ minWidth: 0, flex: '1 1 auto' }}>
                  <a href={a.url} target="_blank" rel="noopener noreferrer" style={{
                    display: 'block', color: 'var(--text-accent)', fontSize: '0.9rem',
                    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                  }}>{a.name}</a>
                  <div style={{ fontFamily: 'var(--font-mono)', fontSize: '0.6rem', color: 'var(--text-dim)' }}>
                    {(a.ext || '').toUpperCase()} · {humanSize(a.size || 0)}
                  </div>
                </div>
                <button className="btn-ghost" style={{ padding: '0.2rem 0.45rem', fontSize: '0.7rem', color: 'var(--danger)', flex: '0 0 auto' }}
                  onClick={() => removeWorldAsset(a.key)}>Remove</button>
              </div>
            ))}
          </div>
        </div>
        )}
      </div>
    );
  };

  // The campaign overview. Everything here is either config the GM already set or
  // DERIVED at read (roster, counts) — nothing on this panel is stored twice, the
  // same reason autosave re-reads `shares` from disk.
  //
  // The payload is already role-filtered by the server: a player's copy has no
  // joinCode and no ||fog|| in the prose. This component therefore does NOT branch
  // on permissions for content — it only hides GM-only CHROME (the join code row,
  // the edit affordance), and it decides that from `campaignData.role`, the role
  // the server echoed back, never from a client-side guess.
  const renderCampaign = () => {
    if (campaignBusy && !campaignData) {
      return <div style={{ color: 'var(--text-dim)', fontSize: '0.9rem', padding: '3rem 1rem', textAlign: 'center' }}>Loading…</div>;
    }
    if (!campaignData) {
      return (
        <div style={{ color: 'var(--text-dim)', fontSize: '0.9rem', padding: '3rem 1rem', textAlign: 'center' }}>
          This campaign isn't available to you.
        </div>
      );
    }
    const c       = campaignData;
    const isCampGM = c.role === 'owner';
    const d       = c.derived || {};

    // --- edit mode ---------------------------------------------------------
    // Reuses WikiTextarea so [[ autocompletes against the world's entry names —
    // a premise that links its locations is the whole point of keeping campaigns
    // inside the world. No image upload here: these are short prose fields, and
    // the world asset store is scoped to lore entries and the landing page.
    if (campDraft && isCampGM) {
      const field = (label, key, hint, rows) => (
        <div>
          <label style={labelStyle}>{label}  ·  ||text|| = GM-only fog</label>
          <div style={{ color: 'var(--text-dim)', fontSize: '0.75rem', marginBottom: '0.3rem' }}>{hint}</div>
          <WikiTextarea rows={rows} value={campDraft[key]} names={entryNames}
            onChange={v => setCampDraft(dr => ({ ...dr, [key]: v }))}
            allowExternalLink={allowExternal}
            style={{ ...inputStyle, resize: 'vertical', lineHeight: 1.5 }} />
        </div>
      );
      return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
          <div style={eyebrow}>Edit · {c.name}</div>
          {field('Premise', 'premise',
            'What this campaign is about, in two or three sentences. Rarely changes.', 4)}
          {field('Situation', 'situation',
            'Where the party is and what is imminent — the ninety-second pre-session read.', 6)}
          {field('Threads', 'threads',
            'Open hooks, unresolved questions, promises you made. A list that grows.', 10)}
          <div style={{ display: 'flex', gap: '0.5rem' }}>
            <button className="btn-primary" onClick={saveCampaign} disabled={campSaving}>
              {campSaving ? 'Saving…' : 'Save'}
            </button>
            <button className="btn-ghost" onClick={() => setCampDraft(null)} disabled={campSaving}>Cancel</button>
          </div>
        </div>
      );
    }

    const stat = (label, value) => (
      <div style={{ minWidth: 0 }}>
        <div style={eyebrow}>{label}</div>
        <div style={{ fontFamily: 'var(--font-body)', fontSize: '0.95rem', color: 'var(--text-primary)' }}>{value}</div>
      </div>
    );

    const prose = (label, key, hint) => {
      const text = c[key];
      if (!text) {
        // Empty fields are shown to the GM as a prompt (with the hint that the
        // edit form repeats) and hidden entirely from players — a player should
        // not see three empty headings.
        return isCampGM ? (
          <div>
            <div style={eyebrow}>{label}</div>
            <button type="button" onClick={startCampaignEdit}
              style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', textAlign: 'left',
                color: 'var(--text-dim)', fontSize: '0.85rem', fontStyle: 'italic', fontFamily: 'var(--font-body)' }}>
              {hint}
            </button>
          </div>
        ) : null;
      }
      return (
        <div>
          <div style={eyebrow}>{label}</div>
          <LoreMarkdown text={text} resolve={resolveLink} onLink={goToEntry} allowExternal={allowExternal} />
        </div>
      );
    };

    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '1rem' }}>
          <div style={{ minWidth: 0 }}>
          <div style={eyebrow}>Campaign</div>
          <div style={{ fontFamily: 'var(--font-body)', fontSize: '1.5rem', color: 'var(--text-accent)', lineHeight: 1.2 }}>
            {c.name}
          </div>
          <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', marginTop: '0.3rem', flexWrap: 'wrap' }}>
            {c.sheetName && (
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: '0.65rem', letterSpacing: '0.08em',
                textTransform: 'uppercase', color: 'var(--text-dim)' }}>{c.sheetName}</span>
            )}
            {c.status === 'archived' && (
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: '0.6rem', letterSpacing: '0.08em',
                textTransform: 'uppercase', padding: '0.15rem 0.5rem', borderRadius: '999px',
                color: 'var(--neutral)', border: '1px solid var(--neutral)' }}>Archived</span>
            )}
          </div>
          </div>
          {isCampGM && (
            <button className="btn-ghost" onClick={startCampaignEdit} style={{ flex: '0 0 auto' }}>Edit</button>
          )}
        </div>

        {/* Derived strip. sessionCount/lastPlayed are 0/null until Wave B — shown
            now so the panel does not change shape when sessions land. */}
        <div style={{ display: 'flex', gap: '1.5rem', flexWrap: 'wrap',
          borderTop: '1px solid var(--border)', borderBottom: '1px solid var(--border)', padding: '0.7rem 0' }}>
          {stat('Sessions', d.sessionCount || 0)}
          {stat('Last played', d.lastPlayed || '—')}
          {stat('Characters', d.characterCount || 0)}
        </div>

        {prose('Premise',   'premise',   'What this campaign is about, in two or three sentences.')}
        {prose('Situation', 'situation', 'Where the party is and what is imminent — the ninety-second pre-session read.')}
        {prose('Threads',   'threads',   'Open hooks, unresolved questions, promises you made.')}

        {Array.isArray(d.roster) && d.roster.length > 0 && (
          <div>
            <div style={eyebrow}>Party</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.2rem' }}>
              {d.roster.map((ch, i) => (
                <div key={ch.id || `${ch.name}-${i}`} style={{ fontFamily: 'var(--font-body)', fontSize: '0.95rem' }}>
                  {ch.name}
                  {/* owner usernames only exist in a GM payload — the server strips
                      them for players, so this renders nothing for them. */}
                  {ch.owner && <span style={{ color: 'var(--text-dim)', fontSize: '0.8rem' }}> · {ch.owner}</span>}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Join code: GM-only chrome. It is a bearer credential — anyone holding it
            can attach a character — and the server never sends it to a player. */}
        {isCampGM && c.joinCode && (
          <div>
            <div style={eyebrow}>Join code</div>
            <button type="button"
              onClick={() => { try { navigator.clipboard?.writeText(c.joinCode); } catch { /* no clipboard */ } }}
              title="Copy join code"
              style={{
                fontFamily: 'var(--font-mono)', fontSize: '1rem', letterSpacing: '0.15em',
                background: 'var(--bg-raised)', border: '1px solid var(--border)',
                color: 'var(--text-accent)', padding: '0.4rem 0.8rem', cursor: 'pointer',
              }}>
              {c.joinCode}
            </button>
          </div>
        )}
      </div>
    );
  };

  const renderReader = () => {
    if (activeCampaign) return renderCampaignPane();
    if (calendarOpen) return renderWorldCalendarPane();
    if (showHome) return renderLanding();
    if (mode === 'edit' || mode === 'create' || mode === 'propose') return renderForm();
    if (!active) {
      return (
        <div style={{ color: 'var(--text-dim)', fontSize: '0.9rem', textAlign: 'center', padding: '3rem 1rem' }}>
          Select an entry, or create one.
        </div>
      );
    }
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.7rem' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '1rem' }}>
          <div style={{ minWidth: 0 }}>
            <h2 style={{ fontSize: '1.5rem', color: 'var(--text-accent)', letterSpacing: '0.03em', lineHeight: 1.15 }}>
              {active.name}
            </h2>
            {active.fields?.subtitle && (
              <div style={{ color: 'var(--text-dim)', fontStyle: 'italic', marginTop: '0.15rem' }}>
                {active.fields.subtitle}
              </div>
            )}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', flex: '0 0 auto' }}>
            <VisibilityPill value={active.visibility} />
            {canEdit && (
              <button type="button" onClick={() => openHistory(active)} className="btn-ghost"
                style={{ padding: 0, width: 28, height: 28, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }} title="Version history">
                <ClockIcon size={15} />
              </button>
            )}
          </div>
        </div>

        {/* Category-defined fields, excluding subtitle (shown above). Fogged
            fields go through BodyText (fog chips + [[wiki]] links); plain ones
            render as escaped text. */}
        {(catDef?.fields || []).filter(f => f.key !== 'subtitle').map(f => {
          const val = active.fields?.[f.key];
          if (!val) return null;
          return (
            <div key={f.key}>
              <div style={{ ...eyebrow, marginBottom: '0.3rem' }}>{f.label}</div>
              {f.type === 'textarea'
                ? <LoreMarkdown text={val} resolve={resolveLink} onLink={goToEntry}
                    allowExternal={allowExternal}
                    onEditImage={canEdit ? ((pos, alt, src, dir) => applyImageDirective(f.key, pos, alt, src, dir)) : undefined} />
                : f.type === 'calendar-date'
                ? <div style={{ lineHeight: 1.5, color: 'var(--text-primary)' }}>{formatDate(calendar, val)}</div>
                : <div style={{ whiteSpace: 'pre-wrap', lineHeight: 1.5, color: 'var(--text-primary)' }}>{val}</div>}
            </div>
          );
        })}

        {/* Attachments — the manage/delete panel is owner-only (§4.8). Inline
            images embedded in the body above already render for members; this
            list is management. §4.10: (a) tighter/denser layout; (b) an asset that
            is ALREADY referenced inline (its URL or bare key appears in any field
            text) is hidden here — deriving it from the live field values means
            deleting the inline reference makes the asset reappear automatically,
            with no persisted flag. */}
        {canEdit && (() => {
          const bodyText = Object.values(active.fields || {})
            .filter(v => typeof v === 'string').join('\n');
          const usedInline = (a) =>
            (a.url && bodyText.includes(a.url)) || (a.key && bodyText.includes(a.key));
          const shownAssets = assets.filter(a => !usedInline(a));
          const inlineCount = assets.length - shownAssets.length;
          return (
          <div style={{ borderTop: '1px solid var(--border)', paddingTop: '0.6rem' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.4rem' }}>
              <div style={eyebrow}>Attachments · {shownAssets.length}</div>
              <input ref={attachInputRef} type="file" style={{ display: 'none' }}
                onChange={e => { const f = e.target.files?.[0]; if (attachInputRef.current) attachInputRef.current.value = ''; if (f) uploadAsset(f); }} />
              <button className="btn-ghost" style={{ padding: '0.2rem 0.5rem', fontSize: '0.72rem', minHeight: 28 }}
                onClick={() => attachInputRef.current && attachInputRef.current.click()}>+ Add file</button>
            </div>
            {shownAssets.length === 0 && (
              <div style={{ color: 'var(--text-dim)', fontSize: '0.78rem' }}>
                {assets.length === 0 ? 'No files attached.'
                  : `No unused files — ${inlineCount} shown inline in the text.`}
              </div>
            )}
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
              {shownAssets.map(a => (
                <div key={a.key} style={{
                  display: 'flex', alignItems: 'center', gap: '0.5rem', padding: '0.25rem 0.4rem',
                  border: '1px solid var(--border)', borderRadius: '2px', background: 'var(--bg-raised)',
                }}>
                  {a.isImage
                    ? <img src={a.url} alt="" style={{ width: 26, height: 26, objectFit: 'cover', borderRadius: '2px', flex: '0 0 auto' }} />
                    : <span style={{ color: 'var(--text-dim)', flex: '0 0 auto' }}><FileIcon size={15} /></span>}
                  <div style={{ minWidth: 0, flex: '1 1 auto' }}>
                    <a href={a.url} target="_blank" rel="noopener noreferrer" style={{
                      display: 'block', color: 'var(--text-accent)', fontSize: '0.82rem',
                      overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                    }}>{a.name}</a>
                    <div style={{ fontFamily: 'var(--font-mono)', fontSize: '0.55rem', color: 'var(--text-dim)' }}>
                      {(a.ext || '').toUpperCase()} · {humanSize(a.size || 0)}
                    </div>
                  </div>
                  <button className="btn-ghost" style={{ padding: '0.15rem 0.4rem', fontSize: '0.66rem', color: 'var(--danger)', flex: '0 0 auto', minHeight: 28 }}
                    onClick={() => removeAsset(a.key)}>Remove</button>
                </div>
              ))}
            </div>
          </div>
          );
        })()}

        {/* §4.9 action row: write/owner get direct Edit (owner also Delete);
            a propose member gets "Suggest an edit" instead. §4.10: denser buttons
            (smaller padding/type, but a ~32px touch target kept). */}
        {(canEdit || canPropose) && (
          <div style={{ display: 'flex', gap: '0.4rem', marginTop: '0.5rem' }}>
            {canEdit && <button className="btn-primary" style={denseBtn} onClick={() => startEdit(active)}>Edit</button>}
            {canEdit && <button className="btn-danger" style={denseBtn} onClick={() => remove(active)}>Delete</button>}
            {canPropose && <button className="btn-primary" style={denseBtn} onClick={() => startPropose(active)}>Suggest an edit</button>}
          </div>
        )}

        {/* A propose member's own suggestions for this entry, with status. */}
        {canPropose && myProposals.length > 0 && (
          <div style={{ borderTop: '1px solid var(--border)', paddingTop: '0.75rem' }}>
            <div style={{ ...eyebrow, marginBottom: '0.4rem' }}>Your suggestions · {myProposals.length}</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem' }}>
              {myProposals.slice().reverse().map(p => (
                <div key={p.id} style={{
                  display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.5rem',
                  padding: '0.4rem 0.55rem', border: '1px solid var(--border)', borderRadius: '2px', background: 'var(--bg-raised)',
                }}>
                  <span style={{ fontFamily: 'var(--font-mono)', fontSize: '0.65rem', color: 'var(--text-dim)' }}>
                    {new Date(p.proposedAt).toLocaleDateString()}{p.note ? ` · ${p.note}` : ''}
                  </span>
                  <span style={{
                    fontFamily: 'var(--font-mono)', fontSize: '0.6rem', letterSpacing: '0.06em',
                    textTransform: 'uppercase', padding: '0.15rem 0.5rem', borderRadius: '999px', whiteSpace: 'nowrap',
                    color: p.status === 'approved' ? 'var(--positive)' : p.status === 'rejected' ? 'var(--danger)' : 'var(--neutral)',
                    border: `1px solid ${p.status === 'approved' ? 'var(--positive)' : p.status === 'rejected' ? 'var(--danger)' : 'var(--neutral)'}`,
                  }}>{p.status}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    );
  };

  // ---- history modal ---------------------------------------------------------
  // §4.10: shared modal shell — header fixed, only the body scrolls (no
  // double-scroll on long histories).
  const historyModal = historyFor && (
    <div onClick={() => setHistoryFor(null)} className="keep-modal-overlay">
      <div onClick={e => e.stopPropagation()} className="keep-modal" style={{ maxWidth: 640 }}>
        <div className="keep-modal-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '1rem 1.25rem', borderBottom: '1px solid var(--border)' }}>
          <div style={eyebrow}>History · {historyFor.name}</div>
          <button className="btn-ghost" onClick={() => setHistoryFor(null)}>Close</button>
        </div>
        <div className="keep-modal-body" style={{ padding: '1.25rem' }}>
        {versions.length === 0 && (
          <div style={{ color: 'var(--text-dim)', fontSize: '0.9rem' }}>No prior versions — history is captured from the first edit.</div>
        )}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
          {versions.map((v, i) => (
            <div key={i} style={{ border: '1px solid var(--border)', borderRadius: '2px', background: 'var(--bg-raised)', padding: '0.6rem 0.75rem' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '0.5rem' }}>
                <div style={{ minWidth: 0 }}>
                  <div style={{ color: 'var(--text-accent)', fontSize: '0.95rem' }}>{v.body?.name || '(untitled)'}</div>
                  <div style={{ fontFamily: 'var(--font-mono)', fontSize: '0.6rem', color: 'var(--text-dim)' }}>
                    {new Date(v.savedAt).toLocaleString()} · {v.savedBy} · {v.reason}
                  </div>
                </div>
                <div style={{ display: 'flex', gap: '0.4rem', flex: '0 0 auto' }}>
                  <button className="btn-ghost" style={{ padding: '0.25rem 0.5rem' }}
                    onClick={() => setPreview(preview?.index === i ? null : { index: i, body: v.body })}>
                    {preview?.index === i ? 'Hide' : 'Preview'}
                  </button>
                  <button className="btn-primary" style={{ padding: '0.25rem 0.5rem' }} onClick={() => restore(i)}>Restore</button>
                </div>
              </div>
              {preview?.index === i && (
                <div style={{ marginTop: '0.6rem', borderTop: '1px solid var(--border)', paddingTop: '0.6rem' }}>
                  {v.body?.fields?.subtitle && (
                    <div style={{ color: 'var(--text-dim)', fontStyle: 'italic', marginBottom: '0.3rem' }}>{v.body.fields.subtitle}</div>
                  )}
                  {/* Preview is inert: links render styled but not tappable (no resolve/onLink). */}
                  {v.body?.fields?.body && <LoreMarkdown text={v.body.fields.body} allowExternal={allowExternal} />}
                  <div style={{ marginTop: '0.4rem' }}><VisibilityPill value={v.body?.visibility} /></div>
                </div>
              )}
            </div>
          ))}
        </div>
        </div>
      </div>
    </div>
  );

  // ---- world settings modal (§4.7b) ------------------------------------------
  // One modal for General / Access & members / Categories / Broken links. It
  // self-fetches each section; onSaved lets us adopt a General (name/backdrop) or
  // Categories (rename/hide) change here. onNavigateEntry wires the broken-links
  // refs back to entry navigation (goToEntry), the one thing the reusable modal
  // can't do on its own.
  // Re-fetch the world's resolved calendar (own override → pack template → null)
  // and adopt it into `calendar` — the World Calendar pane, the per-category
  // Timeline toggle, and every calendar-date field all read from this one piece
  // of state, so refreshing it here is enough to make all of them current.
  const refreshCalendar = () => {
    api.getWorldCalendar(worldId)
      .then(cal => setCalendar(cal && !cal.error ? (cal.calendar || null) : null))
      .catch(() => {});
  };

  const settingsModal = settingsOpen && (
    <WorldSettingsModal
      worldId={worldId}
      initialSection={settingsSection}
      onClose={() => {
        setSettingsOpen(false);
        // Belt-and-braces: the Calendar section's own onSaved already keeps
        // `calendar` current live, but re-fetching on close catches anything
        // that changed the resolved calendar without going through onSaved
        // (e.g. a pack swap in General) so the open view is never stale.
        refreshCalendar();
      }}
      onNavigateEntry={goToEntry}
      onSaved={(payload) => {
        if (payload?.world) setWorld(payload.world);
        if (payload?.categories) applyCategoryConfig(payload.categories);
        if (payload?.calendar !== undefined) setCalendar(payload.calendar);
        // §4.9: approving a proposal edited an entry — refresh the lists (and the
        // open entry, if it's the one that changed) so the applied change shows.
        if (payload?.loreChanged) {
          loadAll();
          if (activeCat) loadEntries(activeCat);
          if (active?.id) api.getLoreEntry(worldId, active.id).then(e => { if (e && e.id) setActive(e); }).catch(() => {});
        }
      }}
    />
  );

  // ---- layout ----------------------------------------------------------------
  // When the world has a backdrop image, panels become frosted glass (the
  // `.keep-glass` class owns the semi-opaque themed surface + blur + fallback),
  // so we must NOT set an opaque inline `background` here — an inline style would
  // beat the class and defeat the glass. Without a backdrop, panels stay solid.
  const hasBackdrop = !!world?.backdrop;
  const panelClass  = hasBackdrop ? 'keep-glass' : undefined;
  const panelBox = {
    border: '1px solid var(--border)', borderRadius: '3px', padding: '1rem',
    ...(hasBackdrop ? {} : { background: 'var(--bg-surface)' }),
  };

  // View-switch transition (§4m): a React `key` that changes whenever the READER
  // shows something new (Home / a chosen entry / create form / an empty category),
  // and one for the LIST when the active category (or search) changes. Wrapping the
  // panel *content* in a `.keep-fade` div keyed on these makes React remount it on a
  // switch, replaying the gentle opacity+rise (the animation is gated behind
  // prefers-reduced-motion in index.css). Keys are stable during typing/editing, so
  // the fade only fires on an actual view change — never on every keystroke.
  const readerKey = activeCampaign
    ? (sessionDraft ? (sessionDraft._id ? `sess-edit:${sessionDraft._id}` : 'sess:new')
        : activeSession ? `sess:${activeSession.id}` : `camp:${activeCampaign}`)
    : calendarOpen ? 'calendar'
    : showHome ? 'home'
    : mode === 'create' ? 'create'
    : active ? `e:${active.id}`
    : `c:${activeCat || 'none'}`;
  const listKey = searching ? 'search' : `c:${activeCat || 'none'}`;

  // On Home, in campaign mode, AND on the World Calendar, the middle entry-list
  // panel is dropped so the wide panel gets the width that used to be split
  // three ways — a laptop-width three-column grid left barely enough room to
  // write a scene (or show a useful month grid). The middle panel only comes
  // back while a global search is active (in any mode), so results have
  // somewhere to render.
  const showMiddle  = (activeCampaign || calendarOpen) ? searching : (!showHome || searching);
  const desktopCols = showMiddle
    ? 'minmax(180px, 220px) minmax(240px, 320px) 1fr'
    : 'minmax(180px, 220px) 1fr';

  // The fixed image + themed scrim that sits behind everything (see .keep-backdrop
  // / .keep-backdrop::after in index.css). Rendered once per layout below.
  const backdropLayer = hasBackdrop
    ? <div className="keep-backdrop" style={{ backgroundImage: `url("${world.backdrop}")` }} aria-hidden="true" />
    : null;

  // Close button (§4.10): an X at the top LEFT that navigates back to the worlds
  // list (onBack = navigate('/worlds'), so the browser back button still works).
  // Replaces the old "← Worlds" button that sat at the top right.
  const closeButton = (
    <button className="btn-ghost" onClick={onBack} aria-label="Close world" title="Close world"
      style={{
        padding: 0, width: 36, height: 36, fontSize: '1.05rem', lineHeight: 1,
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flex: '0 0 auto',
      }}>
      ✕
    </button>
  );

  if (loading) {
    return (
      <div style={{ maxWidth: 1100, margin: '0 auto', padding: '2rem 1rem' }}>
        {closeButton}
        <div style={{ ...eyebrow, marginTop: '2rem' }}>Loading…</div>
      </div>
    );
  }

  // Top bar (shared across layouts): close X at the LEFT, then the "Keep" eyebrow.
  const topBar = (
    <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', marginBottom: '1rem' }}>
      {closeButton}
      <div style={eyebrow}>Keep</div>
    </div>
  );

  if (isPhone) {
    // Phone header per pane: a back chevron (walks up one level) except on the
    // top pane, and a hamburger (top-left concept, placed in-header) that opens
    // the category drawer for a quick jump from anywhere — an explicit, VISIBLE
    // affordance, never a hidden edge-drag (which collides with Safari's
    // edge-swipe-back and confused users in the first build).
    // Back-chevron label = the pane one step UP the stack (entry→category name,
    // list→Categories, categories→Home). The top pane (home) has no back button.
    const backLabel = pane === 'entry' ? ((activeCampaign || calendarOpen) ? 'Categories' : (catDef?.label || 'Back'))
      : pane === 'list' ? 'Categories'
      : 'Home';   // pane === 'categories'
    const paneHeader = (
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.75rem' }}>
        {pane !== 'home' && (
          <button className="btn-ghost" onClick={popStack}
            style={{ padding: '0.3rem 0.5rem', display: 'inline-flex', alignItems: 'center', gap: '0.3rem' }}>
            <ChevronLeftIcon size={15} /> {backLabel}
          </button>
        )}
        {/* The categories pane already IS the rail, so no hamburger there. */}
        {pane !== 'categories' && (
          <button className="btn-ghost" onClick={() => setDrawerOpen(true)}
            style={{ padding: '0.3rem 0.5rem', marginLeft: 'auto' }} aria-label="Open categories">
            <MenuIcon size={16} />
          </button>
        )}
      </div>
    );

    return (
      <div style={{ maxWidth: 720, margin: '0 auto', padding: '1rem' }}
        onTouchStart={onTouchStart} onTouchEnd={onTouchEnd}>
        {backdropLayer}
        {topBar}

        {/* Category drawer (slide-over), the roll-log reference interaction. */}
        {drawerOpen && (
          <div onClick={() => setDrawerOpen(false)} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', zIndex: 40 }}>
            <div onClick={e => e.stopPropagation()} style={{
              position: 'absolute', top: 0, left: 0, bottom: 0, width: '80%', maxWidth: 300,
              background: 'var(--bg-surface)', borderRight: '1px solid var(--border)', padding: '1.25rem', overflowY: 'auto',
            }}>
              {renderRail()}
            </div>
          </div>
        )}

        {/* One pane at a time; the content is wrapped in a `.keep-fade` div keyed
            on the pane (and the entry, so entry→entry navigation also replays),
            for the same gentle view-switch transition as desktop. */}
        {pane === 'home' && (
          <div className={panelClass} style={panelBox}>{paneHeader}<div className="keep-fade" key="home">{renderLanding()}</div></div>
        )}
        {pane === 'categories' && (
          <div className={panelClass} style={panelBox}>{paneHeader}<div className="keep-fade" key="categories">{renderRail()}</div></div>
        )}
        {pane === 'list' && (
          <div className={panelClass} style={panelBox}>{paneHeader}<div className="keep-fade" key={listKey}>{renderList()}</div></div>
        )}
        {pane === 'entry' && (
          <div className={panelClass} style={panelBox}>{paneHeader}<div className="keep-fade" key={readerKey}>{renderReader()}</div></div>
        )}
        {historyModal}
        {settingsModal}
      </div>
    );
  }

  // Desktop / tablet — three columns. Rail narrows on tablet via minmax.
  return (
    <div style={{ maxWidth: 1200, margin: '0 auto', padding: '1.5rem 1rem' }}>
      {backdropLayer}
      {topBar}
      <div style={{ display: 'grid', gridTemplateColumns: desktopCols, gap: '1rem', alignItems: 'start' }}>
        <div className={panelClass} style={panelBox}>{renderRail()}</div>
        {showMiddle && (
          <div className={panelClass} style={{ ...panelBox, maxHeight: 'calc(100vh - 120px)' }}>
            <div className="keep-fade" key={listKey} style={{ height: '100%' }}>{renderList()}</div>
          </div>
        )}
        <div className={panelClass} style={panelBox}>
          <div className="keep-fade" key={readerKey}>{renderReader()}</div>
        </div>
      </div>
      {historyModal}
        {settingsModal}
    </div>
  );
}
