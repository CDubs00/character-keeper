import React, { useEffect, useLayoutEffect, useState, useRef } from 'react';
import { createPortal } from 'react-dom';
import { api } from '../api';

const DIE_VALUES = ['d4', 'd6', 'd8', 'd10', 'd12'];

// Whether clickable links to OTHER origins are allowed in sheet content.
// Default: blocked (external <a> rendered as plain text). The SheetRenderer
// component mirrors the stored app setting onto this variable each render, so
// renderNodeFull (a module-level helper) reads the current policy without
// threading it through the whole recursion.
let allowExternalLinks = false;

// Mirrors the readOnly prop the same way (share views) so item-level widgets
// like the info popover can respect it without threading it through every call.
let sheetReadOnly = false;
let sheetExportMode = false;

// True if href points to a different origin than the app itself.
// Relative / same-origin links are never treated as external.
function isExternalHref(href) {
  if (!href) return false;
  try {
    return new URL(href, window.location.origin).origin !== window.location.origin;
  } catch {
    return false;
  }
}

function resolvePath(obj, path) {
  return path.split('.').reduce((cur, key) => (cur != null ? cur[key] : undefined), obj);
}

function setPath(obj, path, value) {
  const keys = path.split('.');
  if (keys.length === 1) return { ...obj, [keys[0]]: value };
  return {
    ...obj,
    [keys[0]]: setPath(obj[keys[0]] ?? {}, keys.slice(1).join('.'), value),
  };
}

// ── Looks up the empty item template from schema.json ─────────────────────────
// Convention: array path "skills" → schema key "emptySkill"
//             array path "hindrances" → schema key "emptyHindrance"
// Falls back to {} if not found — renderer stays functional, item just has no fields
function getEmptyItem(arrayPath, schema) {
  if (!schema) return {};
  // Strip trailing 's', capitalize, prefix with 'empty'
  // handles: skills→emptySkill, weapons→emptyWeapon, powers→emptyPower,
  //          hindrances→emptyHindrance, edges→emptyEdge, advances→emptyAdvance,
  //          abilities→emptyAbility, gear→emptyGearLine (special case)
  const singular = arrayPath.replace(/ances$/, 'ance')  // hindrances→hindrance, advances→advance
                             .replace(/edges$/, 'edge')   // edges→edge
                             .replace(/ies$/, 'y')         // abilities→ability, entries→entry
                             .replace(/s$/, '');           // skills→skill, weapons→weapon, etc.
  const key = `empty${singular.charAt(0).toUpperCase()}${singular.slice(1)}`;
  if (!schema[key]) return {};
  // Resolve dynamic tokens: a template value of "@today" becomes today's date
  // (YYYY-MM-DD, matches <input type="date">). Lets bundles pre-stamp new
  // entries — e.g. emptySession: { "date": "@today", ... }
  const item = {};
  for (const [k, v] of Object.entries(schema[key])) {
    item[k] = v === '@today' ? new Date().toISOString().slice(0, 10) : v;
  }
  return item;
}

function DieSelector({ value, onChange }) {
  const dieVal = typeof value === 'object' ? value?.die : (value ?? 'd4');
  const bonus  = typeof value === 'object' ? (value?.bonus ?? 0) : 0;

  return (
    <div className="die-selector">
      {DIE_VALUES.map((d) => (
        <button
          key={d}
          className={`die-btn${dieVal === d ? ' selected' : ''}`}
          onClick={() => onChange({ die: d, bonus: d === 'd12' ? bonus : 0 })}
          title={d}
          type="button"
        >
          {d.replace('d', '')}
        </button>
      ))}
      {dieVal === 'd12' && (
        <input
          className="die-bonus"
          type="number"
          min={0}
          max={99}
          value={bonus}
          onChange={(e) => onChange({ die: 'd12', bonus: Math.max(0, Math.min(99, parseInt(e.target.value) || 0)) })}
          title="d12 bonus"
        />
      )}
    </div>
  );
}

function Tracker({ value, max, onChange }) {
  const n = parseInt(max) || 3;
  const v = parseInt(value) || 0;
  return (
    <div className="tracker">
      {Array.from({ length: n }, (_, idx) => {
        const i = idx + 1;
        return (
          <div
            key={i}
            className={`tracker-bubble${v >= i ? ' filled' : ''}`}
            onClick={() => onChange(v === i ? i - 1 : i)}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => e.key === 'Enter' && onChange(v === i ? i - 1 : i)}
          />
        );
      })}
    </div>
  );
}

function Toggle({ value, onChange }) {
  return (
    <div
      className={`conviction-bubble${value ? ' filled' : ''}`}
      onClick={() => onChange(!value)}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => e.key === 'Enter' && onChange(!value)}
    />
  );
}

// Controlled <input> that scales its font down until the value fits its box,
// then back up as the value shrinks. Used for the fixed-size combat boxes
// (AC trio, HP, Speed, Passive, …) so an over-long entry such as a Speed of
// "30ft/45ft" never clips or overflows. Re-fits on value change and on box
// resize (responsive / container-query reflow). data-max-font / data-min-font
// tune the bounds; defaults 18 / 10.
function AutofitInput({ maxFont = 18, minFont = 10, ...rest }) {
  const ref = useRef(null);
  const fit = () => {
    const el = ref.current;
    if (!el || !el.clientWidth) return;
    el.style.fontSize = `${maxFont}px`;
    let fs = maxFont;
    while (fs > minFont && el.scrollWidth > el.clientWidth + 1) {
      fs -= 1;
      el.style.fontSize = `${fs}px`;
    }
  };
  // Runs after every render, so it re-fits whenever the bound value changes.
  useLayoutEffect(fit);
  // Re-fit when the box itself changes width (layout / container queries).
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return React.createElement('input', { ...rest, ref });
}

const XP_MILESTONES = new Set([5, 10, 15, 20, 25, 30]);

// Collapsible section. Opt-in: an author puts data-collapsible="Title" on an
// element (and optionally data-collapsed to start closed). The renderer hands
// the element's children here as the body; this component owns the open state,
// so it persists across the renderer's re-walks. Author classes are preserved.
function Collapsible({ title, defaultOpen = true, className, children, exportMode = false, ...rest }) {
  const [open, setOpen] = useState(defaultOpen);
  const isOpen = exportMode ? true : open;            // export renders fully open
  const cls = ['cf-collapsible', className].filter(Boolean).join(' ');
  return React.createElement('div', { ...rest, className: cls, 'data-open': isOpen ? 'true' : 'false' },
    React.createElement('button', {
      type: 'button',
      className: 'cf-collapsible-header',
      'aria-expanded': isOpen ? 'true' : 'false',
      onClick: () => setOpen((o) => !o),
      disabled: exportMode,
    },
      React.createElement('span', { className: 'cf-collapsible-title' }, title),
      exportMode ? null : React.createElement('span', { className: 'cf-collapsible-caret' }, '▾'),
    ),
    isOpen && React.createElement('div', { className: 'cf-collapsible-body' }, ...children),
  );
}

// ── Tabs ──────────────────────────────────────────────────────────────────────
// Opt-in: a container with data-tabs whose element children carry
// data-tab="Label". The renderer collects the labels, renders a tab bar, and
// shows one panel at a time. All panels stay mounted (display:none when
// inactive) so collapsible/open state inside them survives tab switches.
function Tabs({ labels, panels, panelClasses = [], className, exportMode = false, skipExport = [], ...rest }) {
  const [active, setActive] = useState(0);
  const cls = ['cf-tabs', className].filter(Boolean).join(' ');

  // Export: no interactive bar — every panel shown, stacked, each under its tab
  // label, so one capture gets the whole character. Each panel is tagged
  // .cf-tab-export so the capture loop can also grab them one at a time (PDF).
  if (exportMode) {
    return React.createElement('div', { ...rest, className: cls + ' cf-tabs-export' },
      panels.map((kids, i) => skipExport[i] ? null : React.createElement('div', {
        key: `p${i}`,
        role: 'tabpanel',
        className: ['cf-tab-panel', 'cf-tab-export', panelClasses[i]].filter(Boolean).join(' '),
      },
        React.createElement('h2', { className: 'cf-export-tab-title' }, labels[i]),
        ...kids,
      ))
    );
  }

  return React.createElement('div', { ...rest, className: cls },
    React.createElement('div', { className: 'cf-tab-bar', role: 'tablist' },
      labels.map((label, i) => React.createElement('button', {
        key: i,
        type: 'button',
        role: 'tab',
        'aria-selected': i === active ? 'true' : 'false',
        className: `cf-tab-btn${i === active ? ' active' : ''}`,
        onClick: () => setActive(i),
      }, label))
    ),
    panels.map((kids, i) => React.createElement('div', {
      key: `p${i}`,
      role: 'tabpanel',
      className: ['cf-tab-panel', panelClasses[i]].filter(Boolean).join(' '),
      style: i === active ? undefined : { display: 'none' },
    }, ...kids))
  );
}

// ── Minimal markdown → React elements ────────────────────────────────────────
// Read-only formatting for description display (info popover + export). Supports
// the "basic" set only: **bold** / __bold__, *italic* / _italic_, bullet lists
// (-, *, +), numbered lists (1.), and line breaks (single newline → <br>, blank
// line → new paragraph). The editable textarea still holds the raw markdown the
// player typed — this only affects how it's DISPLAYED.
//
// It emits React elements, never an HTML string, so there is no
// dangerouslySetInnerHTML and therefore no XSS surface: anything it doesn't
// recognize falls through as plain text. No new dependencies.

// Inline pass: one line of text → array of strings + <strong>/<em> spans.
// Bold is matched before italic so `**x**` isn't chewed up by the single-* rule.
function renderInlineMd(text, keyPrefix) {
  const out = [];
  let rest = String(text);
  let k = 0;
  const re = /(\*\*|__)(.+?)\1|(\*|_)(.+?)\3/;   // bold first, then italic
  while (rest) {
    const m = re.exec(rest);
    if (!m) { out.push(rest); break; }
    if (m.index > 0) out.push(rest.slice(0, m.index));
    if (m[2] !== undefined) out.push(React.createElement('strong', { key: `${keyPrefix}-b${k++}` }, m[2]));
    else                    out.push(React.createElement('em',     { key: `${keyPrefix}-i${k++}` }, m[4]));
    rest = rest.slice(m.index + m[0].length);
  }
  return out;
}

// Block pass: group consecutive list lines into <ul>/<ol>, runs of plain lines
// into <p> (joined by <br>), blank lines separate paragraphs. Returns an array
// of block elements, or null when the source is empty.
function renderMarkdown(src) {
  const text = String(src ?? '');
  if (!text.trim()) return null;
  const lines = text.replace(/\r\n?/g, '\n').split('\n');

  const blocks = [];
  let para = [];        // buffered plain lines for the current paragraph
  let list = null;      // { ordered, items: [string] } while collecting a list
  let bk = 0;

  const flushPara = () => {
    if (!para.length) return;
    const kids = [];
    para.forEach((ln, i) => {
      if (i > 0) kids.push(React.createElement('br', { key: `br${bk}-${i}` }));
      kids.push(...renderInlineMd(ln, `p${bk}-${i}`));
    });
    blocks.push(React.createElement('p', { key: `blk${bk++}`, className: 'cf-md-p' }, ...kids));
    para = [];
  };
  const flushList = () => {
    if (!list) return;
    const items = list.items.map((it, i) =>
      React.createElement('li', { key: `li${bk}-${i}` }, ...renderInlineMd(it, `l${bk}-${i}`)));
    blocks.push(React.createElement(list.ordered ? 'ol' : 'ul',
      { key: `blk${bk++}`, className: 'cf-md-list' }, ...items));
    list = null;
  };

  for (const raw of lines) {
    const line   = raw.trimEnd();
    const bullet = /^\s*[-*+]\s+(.*)$/.exec(line);
    const number = /^\s*\d+\.\s+(.*)$/.exec(line);
    if (bullet || number) {
      flushPara();
      const ordered = !!number;
      if (!list || list.ordered !== ordered) { flushList(); list = { ordered, items: [] }; }
      list.items.push(bullet ? bullet[1] : number[1]);
    } else if (line.trim() === '') {
      flushPara(); flushList();
    } else {
      flushList();
      para.push(line);
    }
  }
  flushPara(); flushList();
  return blocks;
}

// ── Info popover (the ⓘ) ─────────────────────────────────────────────────────
// One component serves three content sources:
//   refText — read-only "Rules" text shipped in schema.json's reference map
//   text    — the player's own description field on the item (editable inline)
// Opens on hover (desktop) with a grace delay, pins on click/tap (mobile).
// Portaled to document.body: .sheet-root uses container-type, whose layout
// containment would otherwise capture position:fixed and break placement.
function InfoButton({ title, refText, text, editable, onChange }) {
  const [open,   setOpen]   = useState(false);
  const [pinned, setPinned] = useState(false);
  const [editing, setEditing] = useState(false);
  const [pos,    setPos]    = useState(null);
  const btnRef  = useRef(null);
  const popRef  = useRef(null);
  const closeT  = useRef(null);

  const hasContent = !!(refText || (text && String(text).trim()));

  // Outside click / Escape closes
  useEffect(() => {
    if (!open) return;
    const onDown = (e) => {
      if (popRef.current?.contains(e.target)) return;
      if (btnRef.current?.contains(e.target)) return;
      setOpen(false); setPinned(false);
    };
    const onKey = (e) => { if (e.key === 'Escape') { setOpen(false); setPinned(false); } };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  // Nothing to show and no way to add it → render nothing (read-only views)
  if (!editable && !hasContent) return null;

  const openPop = () => {
    clearTimeout(closeT.current);
    setEditing(!(text && String(text).trim()));
    const r = btnRef.current?.getBoundingClientRect();
    if (!r) return;
    const width = Math.min(320, window.innerWidth - 16);
    const left  = Math.max(8, Math.min(r.left + r.width / 2 - width / 2, window.innerWidth - width - 8));
    const spaceBelow = window.innerHeight - r.bottom - 14;
    const openBelow  = spaceBelow >= 140 || spaceBelow >= r.top - 14;
    const maxH = Math.max(80, Math.min(300, openBelow ? spaceBelow : r.top - 14));
    setPos(openBelow
      ? { top: r.bottom + 6, left, width, maxH }
      : { bottom: window.innerHeight - r.top + 6, left, width, maxH });
    setOpen(true);
  };

  const enter = () => { clearTimeout(closeT.current); if (!open) openPop(); };
  const leave = () => {
    if (pinned) return;
    closeT.current = setTimeout(() => setOpen(false), 250);
  };
  const onClick = () => {
    if (open && pinned) { setOpen(false); setPinned(false); }
    else { openPop(); setPinned(true); }
  };

  return React.createElement('span', { className: 'cf-info-wrap', onMouseEnter: enter, onMouseLeave: leave },
    React.createElement('button', {
      ref: btnRef,
      type: 'button',
      className: `cf-info-btn${hasContent ? ' has-content' : ''}`,
      'aria-label': 'Details',
      onClick,
    }, 'ⓘ'),
    open && pos ? createPortal(
      React.createElement('div', {
        ref: popRef,
        className: 'cf-info-pop',
        style: { top: pos.top, bottom: pos.bottom, left: pos.left, width: pos.width, maxHeight: pos.maxH },
        onMouseEnter: () => clearTimeout(closeT.current),
        onMouseLeave: leave,
      },
        title ? React.createElement('div', { className: 'cf-info-title' }, title) : null,
        refText ? React.createElement('div', { className: 'cf-info-ref' },
          React.createElement('div', { className: 'cf-info-ref-label' }, 'Rules'),
          refText,
        ) : null,
        editable
          ? (() => {
              const hasText = !!(text && String(text).trim());
              const showEdit = editing || !hasText;     // blank field → straight to typing
              return React.createElement(React.Fragment, null,
                // Mode bar: only meaningful once there's text worth previewing.
                hasText ? React.createElement('div', { className: 'cf-info-modebar' },
                  React.createElement('button', {
                    type: 'button',
                    className: `cf-info-mode${!showEdit ? ' active' : ''}`,
                    onClick: () => setEditing(false),
                  }, 'Preview'),
                  React.createElement('button', {
                    type: 'button',
                    className: `cf-info-mode${showEdit ? ' active' : ''}`,
                    onClick: () => { setEditing(true); setPinned(true); },
                  }, 'Edit'),
                ) : null,
                showEdit
                  ? React.createElement('textarea', {
                      className: 'cf-info-edit',
                      rows: 4,
                      placeholder: 'Add details…  **bold**  *italic*  - list',
                      value: text || '',
                      onChange: (e) => onChange && onChange(e.target.value),
                      onFocus: () => setPinned(true),
                      autoFocus: editing,
                    })
                  // Click the preview to jump back into editing.
                  : React.createElement('div', {
                      className: 'cf-info-text cf-info-text-edit',
                      title: 'Click to edit',
                      onClick: () => { setEditing(true); setPinned(true); },
                    }, renderMarkdown(text)),
              );
            })()
          : (text && String(text).trim()
              ? React.createElement('div', { className: 'cf-info-text' }, renderMarkdown(text))
              : null),
      ),
      document.body,
    ) : null,
  );
}

// ── Add-item dialog ───────────────────────────────────────────────────────────
// Driven by schema.json: addForms.<listName> is an array of field definitions
// ({ bind, label, type, options?, required? }). Confirm merges the entered
// values over the list's empty-item template and appends (or prepends).
function AddDialog({ title, fields, base, onConfirm, onCancel }) {
  const [vals, setVals] = useState(() => ({ ...base }));
  const set = (k, v) => setVals((s) => ({ ...s, [k]: v }));
  const canAdd = fields
    .filter((f) => f.required)
    .every((f) => String(vals[f.bind] ?? '').trim() !== '');

  const renderField = (f) => {
    const v = vals[f.bind];
    if (f.type === 'textarea') return React.createElement('textarea', { rows: 3, value: v || '', onChange: (e) => set(f.bind, e.target.value) });
    if (f.type === 'select')   return React.createElement('select', { value: v ?? (f.options?.[0] || ''), onChange: (e) => set(f.bind, e.target.value) },
      (f.options || []).map((o) => React.createElement('option', { key: o, value: o }, o)));
    if (f.type === 'die')      return React.createElement(DieSelector, { value: v ?? { die: 'd4', bonus: 0 }, onChange: (val) => set(f.bind, val) });
    if (f.type === 'number')   return React.createElement('input', { type: 'number', value: v ?? '', onChange: (e) => set(f.bind, parseFloat(e.target.value) || 0) });
    return React.createElement('input', { type: 'text', value: v || '', onChange: (e) => set(f.bind, e.target.value), autoFocus: f === fields[0] });
  };

  return createPortal(
    React.createElement('div', { className: 'cf-dialog-overlay', onMouseDown: onCancel },
      React.createElement('div', { className: 'cf-dialog', onMouseDown: (e) => e.stopPropagation() },
        React.createElement('div', { className: 'cf-dialog-title' }, title),
        fields.map((f) => React.createElement('div', { key: f.bind, className: 'cf-dialog-field' },
          React.createElement('label', null, f.label),
          renderField(f),
        )),
        React.createElement('div', { className: 'cf-dialog-actions' },
          React.createElement('button', { type: 'button', className: 'cf-dialog-cancel', onClick: onCancel }, 'Cancel'),
          React.createElement('button', { type: 'button', className: 'cf-dialog-confirm', disabled: !canAdd, onClick: () => onConfirm(vals) }, 'Add'),
        ),
      ),
    ),
    document.body,
  );
}

// data-action="add" host. If the schema defines addForms.<target>, the button
// opens the dialog; otherwise it appends an empty item directly (the existing
// behavior — swade-core and risus-core keep working unchanged).
// data-insert="prepend" puts new items at the top (e.g. newest session first).
function AddItemButton({ label, target, prepend, formTitle, char, updateRef, schemaRef, hostProps }) {
  const [show, setShow] = useState(false);
  const schema = schemaRef.current;
  const form = schema?.addForms?.[target];

  const doAdd = (item) => {
    const current = resolvePath(char, target) ?? [];
    updateRef.current(setPath(char, target, prepend ? [item, ...current] : [...current, item]));
  };

  const onClick = () => {
    if (form && form.length) setShow(true);
    else doAdd(getEmptyItem(target, schema));
  };

  return React.createElement(React.Fragment, null,
    React.createElement('button', { ...hostProps, onClick, type: 'button' }, label),
    show ? React.createElement(AddDialog, {
      title: formTitle || label.replace(/^\+\s*/, ''),
      fields: form,
      base: getEmptyItem(target, schema),
      onCancel: () => setShow(false),
      onConfirm: (vals) => { doAdd({ ...getEmptyItem(target, schema), ...vals }); setShow(false); },
    }) : null,
  );
}

function XPTracker({ value, max, onChange }) {
  const n = parseInt(max) || 30;
  const v = parseInt(value) || 0;
  const elements = [];
  for (let i = 1; i <= n; i++) {
    elements.push(
      <div
        key={i}
        className={`xp-bubble${v >= i ? ' filled' : ''}`}
        onClick={() => onChange(v === i ? i - 1 : i)}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => e.key === 'Enter' && onChange(v === i ? i - 1 : i)}
      />
    );
    if (XP_MILESTONES.has(i)) {
      elements.push(<span key={`m${i}`} className="xp-milestone">{i}</span>);
    }
  }
  return <div className="xp-track">{elements}</div>;
}

const RANK_COLORS = { N: '#3a7a3a', S: '#2a6a8a', V: '#7a4a9a', H: '#8a3a2a', L: '#8a7a1a' };

function RankBadge({ value }) {
  return (
    <span className="rank-badge" style={{ fontFamily: 'var(--font-header, var(--font-display))', fontSize: '10px', fontWeight: 700, color: RANK_COLORS[value] || '#555', minWidth: '14px', flexShrink: 0 }}>
      {value ?? ''}
    </span>
  );
}

function Portrait({ charId, portraitUrl, onUpload, readOnly }) {
  const inputRef = useRef();

  const handleUpload = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const fd = new FormData();
    fd.append('portrait', file);
    const res = await fetch(`/api/characters/${charId}/portrait`, {
      method: 'POST',
      body: fd,
      credentials: 'include',
    });
    if (res.ok) {
      const data = await res.json();
      if (data.portrait && onUpload) onUpload(data.portrait);
    }
  };

  // Read-only mode (share view): just show the image or a neutral placeholder, no click handler
  if (readOnly) {
    return (
      <div className="portrait-area" style={{ cursor: 'default' }}>
        {portraitUrl
          ? <img src={`${portraitUrl}?t=${Date.now()}`} alt="Character portrait" />
          : <span className="portrait-placeholder">No portrait</span>
        }
      </div>
    );
  }

  return (
    <div className="portrait-area" onClick={() => inputRef.current?.click()} title="Click to upload portrait">
      {portraitUrl
        ? <img src={`${portraitUrl}?t=${Date.now()}`} alt="Character portrait" />
        : <span className="portrait-placeholder">Click to upload portrait</span>
      }
      <input ref={inputRef} type="file" accept="image/*" style={{ display: 'none' }} onChange={handleUpload} />
    </div>
  );
}

function getAttrs(node) {
  const out = {};
  for (const attr of node.attributes) out[attr.name] = attr.value;
  return out;
}

// Wrap <table> elements in a horizontal-scroll container so wide tables don't
// blow out the layout on narrow screens. Non-tables are returned untouched.
function wrapIfTable(tag, element, key) {
  if (tag !== 'table') return element;
  return React.createElement('div', { key, className: 'cf-table-scroll' }, element);
}

const ENGINE_ATTRS = new Set([
  'data-bind','data-type','data-list','data-item','data-action','data-target','data-max','data-attr-source',
  'data-tabs','data-tab','data-ref','data-ref-key','data-insert','data-collapsible-bind','data-form-title','data-title',
  'data-max-font','data-min-font',
]);

// ── Parse a CSS string into a React style object ─────────────────────────────
// e.g. "flex:1; font-size:11px" → { flex: '1', fontSize: '11px' }
function parseCssString(css) {
  const style = {};
  css.split(';').forEach((decl) => {
    const [prop, ...rest] = decl.split(':');
    if (!prop || !rest.length) return;
    const key = prop.trim().replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    style[key] = rest.join(':').trim();
  });
  return style;
}

function buildProps(attrs, key, stripList = [], extra = {}) {
  const props = { key };
  const stripSet = new Set(stripList);
  for (const [name, value] of Object.entries(attrs)) {
    if (stripSet.has(name)) continue;
    if (name.startsWith('data-')) {
      if (!ENGINE_ATTRS.has(name)) props[name] = value;
      continue;
    }
    if (name === 'style')    { props.style = parseCssString(value); continue; }
    if (name === 'class')    { props.className = value; continue; }
    if (name === 'for')      { props.htmlFor   = value; continue; }
    if (name === 'tabindex') { props.tabIndex  = value; continue; }
    props[name] = value;
  }
  return { ...props, ...extra };
}

// ── Recursive walker ──────────────────────────────────────────────────────────
function renderNodeFull(node, char, updateRef, schemaRef, charId, readOnly, key = 0) {
  if (node.nodeType === 3) {
    const text = node.textContent;
    return text.trim() ? text : null;
  }
  if (node.nodeType !== 1) return null;

  const tag = node.tagName.toLowerCase();
  if (['script', 'link', 'style', 'head', 'iframe'].includes(tag)) return null;

  const attrs      = getAttrs(node);
  const bindPath   = attrs['data-bind'];
  const dataType   = attrs['data-type'];
  const dataList   = attrs['data-list'];
  const dataAction = attrs['data-action'];
  const dataTarget = attrs['data-target'];
  const dataMax    = attrs['data-max'];

// ── tabs (opt-in: data-tabs container, children with data-tab="Label") ─────
  if (attrs['data-tabs'] !== undefined) {
    const tabKids = Array.from(node.childNodes).filter(
      (n) => n.nodeType === 1 && n.hasAttribute('data-tab')
    );
    const labels = tabKids.map((n) => n.getAttribute('data-tab') || '');
    const panels = tabKids.map((n) =>
      Array.from(n.childNodes)
        .map((child, i) => renderNodeFull(child, char, updateRef, schemaRef, charId, readOnly, i))
        .filter(Boolean)
    );
    const panelClasses = tabKids.map((n) => n.getAttribute('class') || '');
    // Tabs flagged data-export-skip render normally live but are omitted from
    // the export render. Bundle-driven — the renderer doesn't know which tab.
    const skipExport = tabKids.map((n) => n.hasAttribute('data-export-skip'));
    const hostProps = buildProps(attrs, key, []);
    return React.createElement(Tabs, { ...hostProps, labels, panels, panelClasses, exportMode: sheetExportMode, skipExport });
  }

  // ── collapsible (opt-in: data-collapsible="Title", data-collapsed=start closed) ──
  if (attrs['data-collapsible'] !== undefined) {
    const title       = attrs['data-collapsible'] || '';
    const defaultOpen = attrs['data-collapsed'] === undefined;
    const kids = Array.from(node.childNodes)
      .map((child, i) => renderNodeFull(child, char, updateRef, schemaRef, charId, readOnly, i))
      .filter(Boolean);
    const hostProps = buildProps(attrs, key,
      ['data-collapsible','data-collapsed','data-bind','data-type','data-list','data-item','data-action','data-target','data-max']);
    return React.createElement(Collapsible, { ...hostProps, title, defaultOpen, exportMode: sheetExportMode }, ...kids);
  }

  // ── static reference content (data-ref="Key") ──────────────────────────────
  // Renders the element normally and appends a ⓘ that opens the read-only
  // reference text from schema.json's `reference` map. No-op if the key is
  // absent, so bundles can tag elements before the text exists.
  if (attrs['data-ref'] !== undefined) {
    const refKey  = attrs['data-ref'];
    const refText = schemaRef.current?.reference?.[refKey];
    const kids = Array.from(node.childNodes)
      .map((child, i) => renderNodeFull(child, char, updateRef, schemaRef, charId, readOnly, i))
      .filter(Boolean);
    const props = buildProps(attrs, key, []);
    const info = refText
      ? React.createElement(InfoButton, {
          key: '__info',
          title: attrs['data-title'] || refKey,
          refText,
          text: '',
          editable: false,
        })
      : null;
    return React.createElement(tag, props, ...kids, info);
  }

  // ── external link policy (default: neutralize off-origin <a> to plain text) ──
  if (tag === 'a') {
    const kids = Array.from(node.childNodes)
      .map((child, i) => renderNodeFull(child, char, updateRef, schemaRef, charId, readOnly, i))
      .filter(Boolean);
    const external = isExternalHref(attrs.href);
    if (external && !allowExternalLinks) {
      const spanProps = buildProps(attrs, key,
        ['href','target','rel','data-bind','data-type','data-list','data-item','data-action','data-target','data-max']);
      return React.createElement('span', spanProps, ...kids);
    }
    const linkProps = buildProps(attrs, key,
      ['data-bind','data-type','data-list','data-item','data-action','data-target','data-max'],
      external ? { target: '_blank', rel: 'noopener noreferrer' } : {});
    return React.createElement('a', linkProps, ...kids);
  }

  // ── data-list ──────────────────────────────────────────────────────────────
  if (dataList) {
    const items = resolvePath(char, dataList) ?? [];
    const templateNode = Array.from(node.childNodes).find(
      (n) => n.nodeType === 1 && n.hasAttribute('data-item')
    );
    if (!templateNode) return null;

    const itemElements = items.map((item, i) => {
      const itemUpdate = (patch) => {
        if (patch === null || patch?.__remove) {
          updateRef.current(setPath(char, dataList, items.filter((_, idx) => idx !== i)));
        } else {
          const next = [...items];
          next[i] = { ...next[i], ...patch };
          updateRef.current(setPath(char, dataList, next));
        }
      };
      return renderListItem(templateNode, item, itemUpdate, schemaRef, charId, i);
    }).filter(Boolean);

    const containerProps = buildProps(attrs, key, ['data-list','data-item','data-action','data-target','data-bind','data-type','data-max']);
    return wrapIfTable(tag, React.createElement(tag, containerProps, ...itemElements), key);
  }

  // ── data-action="add" ──────────────────────────────────────────────────────
  // Opens the schema-defined add form when addForms.<target> exists, otherwise
  // appends an empty item (original behavior). data-insert="prepend" inserts
  // new items at the top of the list.
  if (dataAction === 'add' && dataTarget) {
    if (sheetReadOnly) return null;
    const { key: _hostKey, ...hostProps } = buildProps(attrs, key, ['data-action','data-target','data-insert','data-form-title']);
    return React.createElement(AddItemButton, {
      key,
      label: node.textContent,
      target: dataTarget,
      prepend: attrs['data-insert'] === 'prepend',
      formTitle: attrs['data-form-title'],
      char, updateRef, schemaRef,
      hostProps,
    });
  }

  // ── portrait ───────────────────────────────────────────────────────────────
  if (dataType === 'portrait') {
    const portraitUrl = char.portrait || null;
    const onUpload = (url) => updateRef.current(setPath(char, 'portrait', url));
    return React.createElement(Portrait, { key, charId, portraitUrl, onUpload, readOnly });
  }

  // readonly-name — displays the character name, not editable here
  if (dataType === 'readonly-name') {
    const value = resolvePath(char, bindPath) || '';
    return React.createElement('span', {
      key,
      style: {
        fontFamily: 'var(--font-header, var(--font-display))',
        fontSize: '18px',
        fontWeight: '700',
        color: 'var(--ink, var(--text-primary))',
        letterSpacing: '0.04em',
        display: 'block',
        padding: '2px 0',
        borderBottom: '1px solid var(--parch-shadow, var(--border))',
        minHeight: '26px',
      }
    }, value || ' '); // nbsp so the line doesn't collapse when empty
  }

  // ── autofit input (data-type="autofit") ────────────────────────────────────
  // A normal controlled data-bind input whose font shrinks to fit its box.
  // Reuses the standard value/onChange wiring and respects read-only.
  if (dataType === 'autofit' && bindPath) {
    const value    = resolvePath(char, bindPath) ?? '';
    const onChange = (e) => {
      const val = e.target.type === 'number' ? (parseFloat(e.target.value) || 0) : e.target.value;
      updateRef.current(setPath(char, bindPath, val));
    };
    const inputProps = buildProps(attrs, key, ['data-bind', 'data-type'], { value, onChange, disabled: sheetReadOnly });
    return React.createElement(AutofitInput, {
      ...inputProps,
      maxFont: parseFloat(attrs['data-max-font']) || 18,
      minFont: parseFloat(attrs['data-min-font']) || 10,
    });
  }

  // ── data-type widgets ──────────────────────────────────────────────────────
  if (dataType && bindPath) {
    const value    = resolvePath(char, bindPath);
    const onChange = sheetReadOnly ? () => {} : (val) => updateRef.current(setPath(char, bindPath, val));

    if (dataType === 'die')        return React.createElement(DieSelector, { key, value: value ?? { die: 'd4', bonus: 0 }, onChange });
    if (dataType === 'tracker')    return React.createElement(Tracker,     { key, value: value ?? 0, max: dataMax ?? 3, onChange });
    if (dataType === 'toggle')     return React.createElement(Toggle,      { key, value: !!value, onChange });
    if (dataType === 'xp-tracker') return React.createElement(XPTracker,   { key, value: value ?? 0, max: dataMax ?? 30, onChange });
  }

  // ── data-bind → controlled input ──────────────────────────────────────────
  if (bindPath && !dataType) {
    const value    = resolvePath(char, bindPath) ?? '';
    const onChange = (e) => {
      const val = e.target.type === 'number' ? (parseFloat(e.target.value) || 0) : e.target.value;
      updateRef.current(setPath(char, bindPath, val));
    };
    if (sheetExportMode && tag === 'textarea') {
      return React.createElement('div', { key, className: 'cf-export-text' }, renderMarkdown(value) ?? '');
    }
    if (['input', 'select', 'textarea'].includes(tag)) {
      const inputProps = buildProps(attrs, key, ['data-bind','data-type'], { value, onChange, disabled: sheetReadOnly });
      if (tag === 'select') {
        const options = Array.from(node.childNodes)
          .filter((n) => n.nodeType === 1 && n.tagName?.toLowerCase() === 'option')
          .map((n, oi) => React.createElement('option', { key: oi, value: n.getAttribute('value') ?? n.textContent }, n.textContent));
        return React.createElement('select', inputProps, ...options);
      }
      return React.createElement(tag, inputProps);
    }
  }

  // ── recurse ────────────────────────────────────────────────────────────────
  const children = Array.from(node.childNodes)
    .map((child, i) => renderNodeFull(child, char, updateRef, schemaRef, charId, readOnly, i))
    .filter(Boolean);

  const props = buildProps(attrs, key, ['data-bind','data-type','data-list','data-item','data-action','data-target','data-max']);
  if (['br','hr'].includes(tag)) return React.createElement(tag, props);
  return wrapIfTable(tag, React.createElement(tag, props, ...children), key);
}

function renderListItem(templateNode, item, itemUpdate, schemaRef, charId, key) {
  const tag   = templateNode.tagName.toLowerCase();
  const attrs = getAttrs(templateNode);
  const collapseAfter = attrs['data-collapse-after'] !== undefined
    ? parseInt(attrs['data-collapse-after'], 10)
    : undefined;
  const children = Array.from(templateNode.childNodes)
    .map((child, i) => renderItemChildFull(child, item, itemUpdate, schemaRef, charId, i, key, collapseAfter))
    .filter(Boolean);
  const props = buildProps(attrs, key, ['data-item','data-list','data-bind','data-type','data-action','data-target','data-max','data-collapse-after']);
  return React.createElement(tag, props, ...children);
}

function renderItemChildFull(node, item, itemUpdate, schemaRef, charId, key, itemIndex, collapseAfter) {
  if (node.nodeType === 3) {
    const text = node.textContent;
    return text.trim() ? text : null;
  }
  if (node.nodeType !== 1) return null;

  const tag  = node.tagName.toLowerCase();
  if (['script','style','link','iframe'].includes(tag)) return null;

  const attrs      = getAttrs(node);
  const bindPath   = attrs['data-bind'];
  const dataType   = attrs['data-type'];
  const dataAction = attrs['data-action'];
  const dataMax    = attrs['data-max'];

  // ── collapsible inside a list item ─────────────────────────────────────────
  // data-collapsible="Session" data-collapsible-bind="date" → "Session — <date>"
  if (attrs['data-collapsible'] !== undefined) {
    const baseTitle = attrs['data-collapsible'] || '';
    const bindKey   = attrs['data-collapsible-bind'];
    const bindVal   = bindKey ? (item[bindKey] || '') : '';
    const title     = bindVal ? (baseTitle ? `${baseTitle} — ${bindVal}` : bindVal) : baseTitle;
    let defaultOpen;
    if (attrs['data-collapsed'] !== undefined) {
      defaultOpen = false;
    } else if (collapseAfter !== undefined) {
      defaultOpen = itemIndex <= collapseAfter;
    } else {
      defaultOpen = true;
    }
    const kids = Array.from(node.childNodes)
      .map((child, i) => renderItemChildFull(child, item, itemUpdate, schemaRef, charId, i, itemIndex, collapseAfter))
      .filter(Boolean);
    const hostProps = buildProps(attrs, key,
      ['data-collapsible','data-collapsed','data-bind','data-type','data-list','data-item','data-action','data-target','data-max']);
    return React.createElement(Collapsible, { ...hostProps, title, defaultOpen, exportMode: sheetExportMode}, ...kids);
  }

  // ── per-item info popover (data-action="info") ─────────────────────────────
  // data-bind names the item field holding the player's text (default:
  // "description"). data-ref-key names the item field whose VALUE keys into
  // schema.json's `reference` map — e.g. data-ref-key="name" on a skill row
  // pulls the bundle's rules text for "Athletics" into the same popover.
  if (dataAction === 'info') {
    const field    = bindPath || 'description';
    const refKeyF  = attrs['data-ref-key'];
    const refMap   = schemaRef.current?.reference;
    const refText  = refKeyF ? refMap?.[item[refKeyF]] : undefined;
    const title    = attrs['data-title'] || (refKeyF ? item[refKeyF] : item.name) || '';
    return React.createElement(InfoButton, {
      key,
      title,
      refText,
      text: item[field] ?? '',
      editable: !sheetReadOnly,
      onChange: (v) => itemUpdate({ [field]: v }),
    });
  }

  if (dataAction === 'remove') {
    if (sheetReadOnly) return null;
    const props = buildProps(attrs, key, ['data-action'], {
      onClick: () => itemUpdate(null),
      type: 'button',
    });
    return React.createElement('button', props, node.textContent);
  }

  if (dataType && bindPath) {
    const value    = item[bindPath];
    const onChange = sheetReadOnly ? () => {} : (val) => itemUpdate({ [bindPath]: val });

    if (dataType === 'die')        return React.createElement(DieSelector, { key, value: value ?? { die: 'd4', bonus: 0 }, onChange });
    if (dataType === 'tracker')    return React.createElement(Tracker,     { key, value: value ?? 0, max: dataMax ?? 3, onChange });
    if (dataType === 'rank-badge') return React.createElement(RankBadge,   { key, value });
    if (dataType === 'attr-badge') return React.createElement('span',      { key, className: 'attr-badge' }, value ?? '');
  }

  if (bindPath && !dataType) {
    const value    = item[bindPath] ?? '';
    const onChange = (e) => {
      const val = e.target.type === 'number' ? (parseFloat(e.target.value) || 0) : e.target.value;
      itemUpdate({ [bindPath]: val });
    };
    if (sheetExportMode && tag === 'textarea') {
      return React.createElement('div', { key, className: 'cf-export-text' }, renderMarkdown(value) ?? '');
    }
    if (['input','select','textarea'].includes(tag)) {
      const inputProps = buildProps(attrs, key, ['data-bind','data-type'], { value, onChange, disabled: sheetReadOnly });
      if (tag === 'select') {
        const options = Array.from(node.childNodes)
          .filter((n) => n.nodeType === 1 && n.tagName?.toLowerCase() === 'option')
          .map((n, oi) => React.createElement('option', { key: oi, value: n.getAttribute('value') ?? n.textContent }, n.textContent));
        return React.createElement('select', inputProps, ...options);
      }
      return React.createElement(tag, inputProps);
    }
  }

  const children = Array.from(node.childNodes)
    .map((child, i) => renderItemChildFull(child, item, itemUpdate, schemaRef, charId, i))
    .filter(Boolean);

  const props = buildProps(attrs, key, ['data-bind','data-type','data-list','data-item','data-action','data-target','data-max']);
  if (['br','hr'].includes(tag)) return React.createElement(tag, props);
  return wrapIfTable(tag, React.createElement(tag, props, ...children), key);
}

// ════════════════════════════════════════════════════════════════════════════
// SheetRenderer — exported component
// ════════════════════════════════════════════════════════════════════════════
export default function SheetRenderer({ char, update, charId, readOnly = false, exportMode = false }) {
  const [htmlString, setHtmlString] = useState(null);
  const [error,      setError]      = useState(null);
  const [allowLinks, setAllowLinks] = useState(false);
  const styleRef  = useRef(null);
  const updateRef = useRef(update);
  const schemaRef = useRef(null);  // holds parsed schema.json — no re-render on change

  useEffect(() => { updateRef.current = update; }, [update]);

  // Read the app-wide external-link policy (public endpoint, works on share pages).
  useEffect(() => {
    api.getSettings().then(s => setAllowLinks(!!s?.allowExternalLinks)).catch(() => {});
  }, []);

  // Mirror onto the module variable before renderNodeFull runs this render.
  allowExternalLinks = allowLinks;
  sheetReadOnly   = readOnly || exportMode;   // export is inherently read-only
  sheetExportMode = exportMode;

  const sheetId = char?.sheetId;

  // ── Fetch sheet.html, theme.css, schema.json once per sheetId ─────────────
  useEffect(() => {
    if (!sheetId) return;
    setHtmlString(null);
    setError(null);

    Promise.all([
      fetch(`/api/sheets/${sheetId}/sheet.html`, { credentials: 'include' }).then((r) => {
        if (!r.ok) throw new Error(`sheet.html not found (${r.status})`);
        return r.text();
      }),
      fetch(`/api/sheets/${sheetId}/theme.css`, { credentials: 'include' }).then((r) => {
        if (!r.ok) throw new Error(`theme.css not found (${r.status})`);
        return r.text();
      }),
      fetch(`/api/sheets/${sheetId}/schema`, { credentials: 'include' }).then((r) => {
        if (!r.ok) throw new Error(`schema not found (${r.status})`);
        return r.json();
      }),
    ])
      .then(([html, css, schema]) => {
        // Resolve the bundle asset base so authors can write %ASSETS%/logo.png
        // (or url('%ASSETS%/bg.jpg') in theme.css) instead of the full path.
        // Absolute /api/sheets/<id>/assets/... paths still work too.
        const assetBase = `/api/sheets/${sheetId}/assets`;

        // Inject CSS
        if (styleRef.current) styleRef.current.remove();
        const style = document.createElement('style');
        style.setAttribute('data-sheet-theme', sheetId);
        style.textContent = css.split('%ASSETS%').join(assetBase);
        document.head.appendChild(style);
        styleRef.current = style;

        schemaRef.current = schema;
        setHtmlString(html.split('%ASSETS%').join(assetBase));
      })
      .catch((e) => setError(e.message));

    return () => {
      if (styleRef.current) { styleRef.current.remove(); styleRef.current = null; }
    };
  }, [sheetId]);

  if (error) {
    return <div className="sheet-error"><h2>Sheet Error</h2><p>{error}</p></div>;
  }
  if (!htmlString || !char) {
    return <div className="sheet-loading">Loading sheet…</div>;
  }

  // ── Parse and walk on every render ────────────────────────────────────────
  const parser = new DOMParser();
  const doc    = parser.parseFromString(htmlString, 'text/html');
  const nodes  = Array.from(doc.body.childNodes)
    .map((node, i) => renderNodeFull(node, char, updateRef, schemaRef, charId, readOnly, i))
    .filter(Boolean);

  // return <div className="sheet-root">{nodes}</div>;
  return <div className="sheet-root" style={{ containerType: 'inline-size', containerName: 'sheet' }}>{nodes}</div>;
}