// frontend/src/components/shared/WorldCalendarEditor.jsx
//
// The Calendar tab of the world settings modal (§4.11, revised). A calendar is
// LORE, not rules — Harptos is Forgotten Realms and works under any system — so
// the WORLD owns it and a pack merely offers a template.
//
// Kept as its own component rather than another `const xBody` inside
// WorldSettingsModal.jsx: this is several hundred lines of form and that file is
// already long. The modal only gains an import, a SECTIONS entry and a bodyFor key.
//
// TWO THINGS THAT LOOK LIKE BUGS BUT ARE NOT:
//
// 1. The hide toggle saves IMMEDIATELY and separately from the calendar draft.
//    Hiding is a display switch, not an edit — a GM toggling visibility should not
//    have to also commit half-finished month edits, and vice versa.
//
// 2. Warnings never block Save; only errors do. A week that doesn't divide the
//    year evenly is the NORMAL case (Earth: 365 % 7 = 1), so blocking it would
//    make most real calendars unsavable. The rules live in calendarMath.
//    calendarIssues so this component and the server agree exactly.

import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { api } from '../../api';
import {
  formatDate, validateDate, calendarIssues, weekdayOf, yearNameOf,
  yearLength, cycleYearLength, calMonths, calEras, calWeekdays,
  calYearCycle, calEpochYear,
} from '../calendarMath';

const clone = v => JSON.parse(JSON.stringify(v));

const inputStyle = {
  width: '100%', background: 'var(--bg-input)', border: '1px solid var(--border)',
  borderRadius: '2px', padding: '0.4rem 0.6rem', color: 'var(--text-primary)',
  fontFamily: 'var(--font-body)', fontSize: '0.95rem', outline: 'none',
};
const eyebrow = {
  fontFamily: 'var(--font-mono)', fontSize: '0.65rem', color: 'var(--text-dim)',
  letterSpacing: '0.15em', textTransform: 'uppercase',
};
const rowStyle = {
  display: 'flex', alignItems: 'center', gap: '0.4rem',
  border: '1px solid var(--border)', borderRadius: '2px',
  padding: '0.4rem 0.5rem', marginBottom: '0.3rem',
};
const chipStyle = {
  display: 'inline-flex', alignItems: 'center', gap: '0.35rem',
  border: '1px solid var(--border)', borderRadius: '2px',
  padding: '0.25rem 0.5rem', fontSize: '0.85rem', color: 'var(--text-primary)',
};
const panelStyle = {
  border: '1px solid var(--border)', borderRadius: '2px', padding: '0.6rem 0.75rem',
};
const iconBtn = {
  background: 'none', border: 'none', cursor: 'pointer', padding: '0.1rem 0.25rem',
  color: 'var(--text-dim)', fontSize: '0.95rem', lineHeight: 1, fontFamily: 'var(--font-body)',
};
const sectionGap = { marginBottom: 22 };

// A date-shaped value: any object carrying whole-number year/month/day. Detected
// structurally rather than by looking up each category's field types, so an entry
// keeps being counted even if its category was renamed or hidden.
function isDateValue(v) {
  return v && typeof v === 'object' && !Array.isArray(v)
    && Number.isInteger(v.year) && Number.isInteger(v.month) && Number.isInteger(v.day);
}

export default function WorldCalendarEditor({ worldId, canManage, onSaved }) {
  const [loading, setLoading]   = useState(true);
  const [err, setErr]           = useState('');
  const [resolved, setResolved] = useState(null);   // { calendar, hidden, source }
  const [draft, setDraft]       = useState(null);
  const [dirty, setDirty]       = useState(false);
  const [busy, setBusy]         = useState(false);
  const [entries, setEntries]   = useState(null);   // lazy, for the affected count

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.getWorldCalendar(worldId);
      setResolved(res);
      setDraft(clone(res.calendar));
      setDirty(false);
      setErr('');
    } catch {
      setErr('Could not load this world’s calendar. Close the panel and try again.');
    } finally {
      setLoading(false);
    }
  }, [worldId]);

  useEffect(() => { load(); }, [load]);

  // Entries are fetched once, only to count dates that would fall out of range.
  // Same source the broken-links scanner uses.
  useEffect(() => {
    if (entries !== null) return;
    let alive = true;
    api.getLore(worldId)
      .then(all => { if (alive) setEntries(Array.isArray(all) ? all : []); })
      .catch(() => { if (alive) setEntries([]); });
    return () => { alive = false; };
  }, [worldId, entries]);

  const edit = useCallback(mut => {
    setDraft(d => { const next = clone(d); mut(next); return next; });
    setDirty(true);
  }, []);

  const issues = useMemo(() => draft ? calendarIssues(draft) : { errors: [], warnings: [] }, [draft]);

  // Dates that the DRAFT would no longer accept. Non-destructive: nothing is
  // rewritten, the values simply stop validating until the shape covers them again.
  const affected = useMemo(() => {
    if (!draft || !entries || issues.errors.length) return 0;
    let n = 0;
    for (const e of entries) {
      for (const v of Object.values((e && e.fields) || {})) {
        if (isDateValue(v) && !validateDate(draft, v).ok) n++;
      }
    }
    return n;
  }, [draft, entries, issues.errors.length]);

  const preview = useMemo(() => {
    if (!draft || issues.errors.length) return null;
    const ms = calMonths(draft);
    if (!ms.length) return null;
    const mid = Math.min(2, ms.length - 1);
    const v = {
      era: (calEras(draft)[0] || {}).id || null,
      year: calEpochYear(draft) + 491,
      month: mid + 1,
      day: Math.min(15, ms[mid].days),
    };
    return {
      main: formatDate(draft, v),
      weekday: weekdayOf(draft, v),
      yearName: yearNameOf(draft, v.year),
    };
  }, [draft, issues.errors.length]);

  const save = async () => {
    if (busy || issues.errors.length) return;
    setBusy(true);
    try {
      const res = await api.setWorldCalendar(worldId, { calendar: draft });
      setResolved(res);
      setDraft(clone(res.calendar));
      setDirty(false);
      setErr('');
      onSaved && onSaved({ calendar: res.calendar });
    } catch (e) {
      setErr((e && e.message) || 'Could not save the calendar.');
    } finally {
      setBusy(false);
    }
  };

  const patch = async body => {
    if (busy) return;
    setBusy(true);
    try {
      const res = await api.setWorldCalendar(worldId, body);
      setResolved(res);
      setDraft(clone(res.calendar));
      setDirty(false);
      setErr('');
      onSaved && onSaved({ calendar: res.calendar });
    } catch (e) {
      setErr((e && e.message) || 'Could not update the calendar.');
    } finally {
      setBusy(false);
    }
  };

  if (loading) return <div style={{ color: 'var(--text-dim)', fontSize: 14 }}>Loading calendar…</div>;
  if (!draft)  return <div style={{ color: 'var(--text-dim)', fontSize: 14 }}>{err || 'No calendar.'}</div>;

  const months   = calMonths(draft);
  const weekdays = calWeekdays(draft);
  const eras     = calEras(draft);
  const cycle    = calYearCycle(draft);
  const weekLen  = weekdays.length;
  const counted  = cycleYearLength(draft);
  const hidden   = !!(resolved && resolved.hidden);
  const source   = (resolved && resolved.source) || 'builtin';

  const SOURCE_LABEL = {
    own: 'This world’s own calendar',
    pack: 'The pack’s calendar',
    builtin: 'The built-in calendar',
  };

  return (
    <div>
      {/* Visibility. Saves on its own — see the note at the top of this file. */}
      <div style={{ ...rowStyle, marginBottom: '1rem', justifyContent: 'space-between' }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 14, color: 'var(--text-primary)' }}>Show dates in this world</div>
          <div style={{ fontSize: 12, color: 'var(--text-dim)', marginTop: 2 }}>
            {hidden
              ? 'Dates already set stay visible, but cannot be edited, and the timeline is off.'
              : 'Date fields and the events timeline are available.'}
          </div>
        </div>
        {canManage && (
          <button
            className="btn-ghost"
            disabled={busy}
            onClick={() => patch({ hidden: !hidden })}
            style={{ flex: '0 0 auto', fontSize: 13 }}
          >
            {hidden ? 'Turn on' : 'Turn off'}
          </button>
        )}
      </div>

      {/* Which calendar this world is on. */}
      <div style={{ ...sectionGap, ...panelStyle }}>
        <div style={{ fontSize: 14, color: 'var(--text-primary)' }}>{SOURCE_LABEL[source]}</div>
        <div style={{ fontSize: 12, color: 'var(--text-dim)', marginTop: 2 }}>
          {source === 'own'
            ? 'Edited here. Reset to go back to a template.'
            : 'A template. Editing anything below makes this world its own copy.'}
        </div>
        {canManage && (
          <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
            {source !== 'pack' && (
              <button className="btn-ghost" disabled={busy} style={{ fontSize: 12 }}
                onClick={() => patch({ calendar: null, source: 'pack' })}>
                Use the pack’s calendar
              </button>
            )}
            {source !== 'builtin' && (
              <button className="btn-ghost" disabled={busy} style={{ fontSize: 12 }}
                onClick={() => patch({ calendar: null, source: 'builtin' })}>
                Use the built-in calendar
              </button>
            )}
          </div>
        )}
      </div>

      {preview && (
        <div style={{ ...sectionGap, ...panelStyle }}>
          <div style={eyebrow}>Preview</div>
          <div style={{ fontSize: 16, color: 'var(--text-primary)', marginTop: 4 }}>{preview.main}</div>
          {(preview.weekday || preview.yearName) && (
            <div style={{ fontSize: 12, color: 'var(--text-dim)', marginTop: 2 }}>
              {[preview.weekday, preview.yearName].filter(Boolean).join(' · ')}
            </div>
          )}
        </div>
      )}

      <div style={sectionGap}>
        <div style={{ ...eyebrow, marginBottom: 5 }}>Calendar name</div>
        <input style={inputStyle} value={draft.name || ''} disabled={!canManage}
          onChange={e => edit(d => { d.name = e.target.value; })} />
      </div>

      {/* Months — the spine. Every number here is derived, never written down. */}
      <div style={sectionGap}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
          <span style={eyebrow}>Months · {months.length}</span>
          <span style={{ fontSize: 12, color: 'var(--text-dim)' }}>
            Year is {yearLength(draft)} days
          </span>
        </div>

        {months.map((m, i) => (
          <div key={i} style={m.intercalary
            ? { ...rowStyle, borderColor: 'var(--keep-accent, var(--border))' }
            : rowStyle}>
            <input
              style={{ ...inputStyle, flex: 1, minWidth: 0, padding: '5px 8px' }}
              value={m.name || ''} disabled={!canManage}
              onChange={e => edit(d => { d.months[i].name = e.target.value; })}
            />
            <input
              type="number" min="1" style={{ ...inputStyle, width: 64, padding: '5px 6px' }}
              value={m.days} disabled={!canManage}
              onChange={e => edit(d => {
                const n = parseInt(e.target.value, 10);
                d.months[i].days = Number.isNaN(n) ? '' : n;
              })}
            />
            <span style={{ fontSize: 11, color: 'var(--text-dim)', width: 52, textAlign: 'right' }}>
              {m.intercalary || !weekLen || !Number.isInteger(m.days) ? '—'
                : `${Math.floor(m.days / weekLen)}w${m.days % weekLen ? ` + ${m.days % weekLen}` : ''}`}
            </span>
            {canManage && (
              <>
                <button
                  style={{ ...iconBtn, fontSize: 10, letterSpacing: '.04em',
                    color: m.intercalary ? 'var(--text-primary)' : 'var(--text-dim)' }}
                  title={m.intercalary
                    ? 'A festival: these days sit outside the week'
                    : 'Mark as a festival, outside the week'}
                  onClick={() => edit(d => {
                    if (d.months[i].intercalary) delete d.months[i].intercalary;
                    else d.months[i].intercalary = true;
                  })}
                >{m.intercalary ? 'FESTIVAL' : 'MONTH'}</button>
                <button style={iconBtn} title="Move up" disabled={i === 0}
                  onClick={() => edit(d => { const [x] = d.months.splice(i, 1); d.months.splice(i - 1, 0, x); })}>↑</button>
                <button style={iconBtn} title="Move down" disabled={i === months.length - 1}
                  onClick={() => edit(d => { const [x] = d.months.splice(i, 1); d.months.splice(i + 1, 0, x); })}>↓</button>
                <button style={iconBtn} title="Remove month"
                  onClick={() => edit(d => { d.months.splice(i, 1); })}>×</button>
              </>
            )}
          </div>
        ))}

        {canManage && (
          <div style={{ display: 'flex', gap: 8, marginTop: 8, alignItems: 'center' }}>
            <button className="btn-ghost" style={{ fontSize: 12 }}
              onClick={() => edit(d => { d.months.push({ name: 'New month', days: weekLen || 30 }); })}>
              Add month
            </button>
            {weekLen > 0 && (
              <button className="btn-ghost" style={{ fontSize: 12 }}
                onClick={() => edit(d => { d.months.push({ name: 'New month', days: weekLen * 4 }); })}>
                Add month of 4 weeks
              </button>
            )}
          </div>
        )}
        <div style={{ fontSize: 12, color: 'var(--text-dim)', marginTop: 8, lineHeight: 1.5 }}>
          Festival days sit outside the week, so they can absorb whatever is left
          over and keep every year starting on the same weekday.
        </div>
      </div>

      {/* Weekdays — the list length IS the week length. */}
      <div style={sectionGap}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
          <span style={eyebrow}>Days of the week · {weekLen}</span>
          <span style={{ fontSize: 12, color: 'var(--text-dim)' }}>
            {weekLen ? `${counted} days ride the week` : 'No weekdays'}
          </span>
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
          {weekdays.map((d, i) => (
            <span key={i} style={chipStyle}>
              <input
                style={{ ...inputStyle, width: `${Math.max(6, (d || '').length + 1)}ch`,
                  padding: 0, border: 'none', background: 'none' }}
                value={d} disabled={!canManage}
                onChange={e => edit(x => { x.weekdays[i] = e.target.value; })}
              />
              {canManage && (
                <button style={iconBtn} title="Remove day"
                  onClick={() => edit(x => { x.weekdays.splice(i, 1); })}>×</button>
              )}
            </span>
          ))}
          {canManage && (
            <button className="btn-ghost" style={{ ...chipStyle, cursor: 'pointer' }}
              onClick={() => edit(d => {
                if (!Array.isArray(d.weekdays)) d.weekdays = [];
                d.weekdays.push(`Day ${d.weekdays.length + 1}`);
              })}>Add day</button>
          )}
        </div>
        <div style={{ fontSize: 12, color: 'var(--text-dim)', marginTop: 8 }}>
          Leave this empty for a calendar with no weekdays.
        </div>
      </div>

      {/* Eras and epoch. */}
      <div style={sectionGap}>
        <div style={{ ...eyebrow, marginBottom: 6 }}>Eras and starting point</div>
        {eras.map((era, i) => (
          <div key={i} style={rowStyle}>
            <input style={{ ...inputStyle, flex: 1, minWidth: 0, padding: '5px 8px' }}
              value={era.label || ''} disabled={!canManage} placeholder="Name"
              onChange={e => edit(d => { d.eras[i].label = e.target.value; })} />
            <input style={{ ...inputStyle, width: 70, padding: '5px 6px' }}
              value={era.abbr || ''} disabled={!canManage} placeholder="Short"
              onChange={e => edit(d => { d.eras[i].abbr = e.target.value; })} />
            {canManage && (
              <button style={iconBtn} title="Remove era"
                onClick={() => edit(d => { d.eras.splice(i, 1); })}>×</button>
            )}
          </div>
        ))}
        {canManage && (
          <button className="btn-ghost" style={{ fontSize: 12, marginTop: 4 }}
            onClick={() => edit(d => {
              if (!Array.isArray(d.eras)) d.eras = [];
              const n = d.eras.length + 1;
              d.eras.push({ id: `era-${n}`, label: `Era ${n}`, abbr: `E${n}` });
            })}>Add era</button>
        )}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 13, color: 'var(--text-dim)' }}>Day one is year</span>
          <input type="number" style={{ ...inputStyle, width: 90, padding: '5px 8px' }}
            value={(draft.epoch && draft.epoch.year) != null ? draft.epoch.year : 1}
            disabled={!canManage}
            onChange={e => edit(d => {
              const n = parseInt(e.target.value, 10);
              d.epoch = d.epoch || {};
              d.epoch.year = Number.isNaN(n) ? 1 : n;
            })} />
          {eras.length > 0 && (
            <>
              <span style={{ fontSize: 13, color: 'var(--text-dim)' }}>of</span>
              <select style={{ ...inputStyle, width: 'auto', padding: '5px 8px' }}
                value={(draft.epoch && draft.epoch.era) || eras[0].id}
                disabled={!canManage}
                onChange={e => edit(d => { d.epoch = d.epoch || {}; d.epoch.era = e.target.value; })}>
                {eras.map((era, i) => <option key={i} value={era.id}>{era.label || era.id}</option>)}
              </select>
            </>
          )}
        </div>
      </div>

      {/* Year names — a repeating cycle, zodiac style. */}
      <div style={sectionGap}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
          <span style={eyebrow}>Year names · {cycle.length}</span>
          {cycle.length > 0 && (
            <span style={{ fontSize: 12, color: 'var(--text-dim)' }}>
              Repeats every {cycle.length} {cycle.length === 1 ? 'year' : 'years'}
            </span>
          )}
        </div>
        {cycle.length === 0 ? (
          <div style={{ fontSize: 13, color: 'var(--text-dim)' }}>
            No year names.{' '}
            {canManage && (
              <button className="btn-ghost" style={{ fontSize: 12 }}
                onClick={() => edit(d => { d.yearNames = { cycle: ['First year'], anchorYear: calEpochYear(d) }; })}>
                Add a cycle
              </button>
            )}
          </div>
        ) : (
          <>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8, flexWrap: 'wrap' }}>
              <span style={{ fontSize: 13, color: 'var(--text-dim)' }}>Year</span>
              <input type="number" style={{ ...inputStyle, width: 90, padding: '5px 8px' }}
                value={draft.yearNames.anchorYear != null ? draft.yearNames.anchorYear : calEpochYear(draft)}
                disabled={!canManage}
                onChange={e => edit(d => {
                  const n = parseInt(e.target.value, 10);
                  d.yearNames.anchorYear = Number.isNaN(n) ? calEpochYear(d) : n;
                })} />
              <span style={{ fontSize: 13, color: 'var(--text-dim)' }}>
                is {cycle[0] || '—'}
              </span>
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
              {cycle.map((n, i) => (
                <span key={i} style={chipStyle}>
                  <input
                    style={{ ...inputStyle, width: `${Math.max(6, (n || '').length + 1)}ch`,
                      padding: 0, border: 'none', background: 'none' }}
                    value={n} disabled={!canManage}
                    onChange={e => edit(d => { d.yearNames.cycle[i] = e.target.value; })}
                  />
                  {canManage && (
                    <button style={iconBtn} title="Remove year name"
                      onClick={() => edit(d => {
                        d.yearNames.cycle.splice(i, 1);
                        if (!d.yearNames.cycle.length) d.yearNames = null;
                      })}>×</button>
                  )}
                </span>
              ))}
              {canManage && (
                <button className="btn-ghost" style={{ ...chipStyle, cursor: 'pointer' }}
                  onClick={() => edit(d => { d.yearNames.cycle.push(`Year ${d.yearNames.cycle.length + 1}`); })}>
                  Add name
                </button>
              )}
            </div>
          </>
        )}
      </div>

      {/* Errors block the save. Warnings never do. */}
      {issues.errors.length > 0 && (
        <div style={{ ...sectionGap, ...panelStyle, borderColor: 'var(--danger)' }}>
          <div style={{ ...eyebrow, color: 'var(--danger)' }}>Fix before saving</div>
          <ul style={{ margin: '6px 0 0', paddingLeft: 18, fontSize: 13, color: 'var(--text-primary)' }}>
            {issues.errors.map((e, i) => <li key={i} style={{ marginBottom: 2 }}>{e.message}</li>)}
          </ul>
        </div>
      )}

      {issues.warnings.length > 0 && issues.errors.length === 0 && (
        <div style={{ ...sectionGap, ...panelStyle }}>
          <div style={eyebrow}>Worth knowing</div>
          <ul style={{ margin: '6px 0 0', paddingLeft: 18, fontSize: 13, color: 'var(--text-dim)' }}>
            {issues.warnings.map((w, i) => <li key={i} style={{ marginBottom: 2 }}>{w.message}</li>)}
          </ul>
        </div>
      )}

      {affected > 0 && (
        <div style={{ ...sectionGap, ...panelStyle }}>
          <div style={eyebrow}>Dates that no longer fit</div>
          <div style={{ fontSize: 13, color: 'var(--text-dim)', marginTop: 4, lineHeight: 1.5 }}>
            {affected} {affected === 1 ? 'date falls' : 'dates fall'} outside this shape — a
            month or day number that no longer exists. Saving keeps them exactly as
            they are; they will read correctly again if you restore the months they
            depend on.
          </div>
        </div>
      )}

      {err && (
        <div style={{ ...sectionGap, fontSize: 13, color: 'var(--danger)' }}>{err}</div>
      )}

      {canManage && (
        <div style={{ display: 'flex', gap: 8, alignItems: 'center',
          borderTop: '1px solid var(--border)', paddingTop: 14 }}>
          <button className="btn-primary" disabled={busy || !dirty || issues.errors.length > 0}
            onClick={save}>
            {busy ? 'Saving…' : 'Save calendar'}
          </button>
          <button className="btn-ghost" disabled={busy || !dirty}
            onClick={() => { setDraft(clone(resolved.calendar)); setDirty(false); setErr(''); }}>
            Cancel
          </button>
          <span style={{ flex: 1 }} />
          {source === 'own' && (
            <button className="btn-ghost" disabled={busy}
              style={{ fontSize: 12, color: 'var(--danger)' }}
              onClick={() => patch({ calendar: null })}>
              Reset to template
            </button>
          )}
        </div>
      )}
    </div>
  );
}
