// frontend/src/components/shared/WorldSettingsModal.jsx
//
// One consolidated "World settings" modal for all GM-facing, owner-only world
// settings (§4.7b). Before this, world settings were scattered: the Worlds-list
// "…" → Edit opened an inline name/description/backdrop form on the list page,
// while Broken links, Customize categories (§4j), and Access & members (§4.7)
// each lived as a separate rail item + modal inside WorldDetail.
//
// This is a pure VIEW refactor — every section's logic is moved verbatim from its
// old home and every route/api.js wrapper it calls already exists. Nothing about
// the backend, the data model, or owner-gating changes.
//
// The modal is reusable and SELF-FETCHING: given a worldId it loads each section's
// data through the existing api.js wrappers, and calls `onSaved(payload)` so a
// parent (Worlds.jsx list, or WorldDetail) can refresh whatever it cares about —
// `payload.world` after a General/backdrop save, `payload.categories` after a
// rename/hide. Sections that only manage server-side state (Access & members)
// don't need a parent refresh, so they don't call it.
//
// Left nav is a DATA-DRIVEN list (SECTIONS) so future settings — calendar (§8a),
// landing config, world-level visibility defaults — slot in as one more row.
//
// Style matches the existing modal grammar in WorldDetail.jsx (customize / broken
// / members): theme variables only, the same pill/button patterns.

import React, { useState, useEffect, useMemo, useRef } from 'react';
import WorldCalendarEditor from './WorldCalendarEditor';
import { api } from '../../api';
import { parseBody, splitLinkNamespace } from '../fog';
import {
  MapPinIcon, UserIcon, FlagIcon, StarIcon, CalendarIcon, BuildingIcon,
  LocationIcon, FactionsIcon, PlanesIcon,
  FileIcon, EyeOffIcon,
} from './Icons';

// ---- shared style atoms (local, mirroring WorldDetail.jsx) -------------------
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

// Pack icon name → glyph (mirrors WorldDetail's ICONS map / CatIcon). Unknown
// names fall back to a generic file icon so a pack can't break the row.
const ICONS = {
  'map-pin': MapPinIcon, user: UserIcon, flag: FlagIcon, star: StarIcon,
  calendar: CalendarIcon, building: BuildingIcon,
  location: LocationIcon, faction: FactionsIcon, plane: PlanesIcon,
};
function CatIcon({ name, ...props }) {
  const G = ICONS[name] || FileIcon;
  return <G {...props} />;
}

// The sections. A plain list so future settings are one more entry here.
const SECTIONS = [
  { id: 'general',    label: 'General' },
  { id: 'access',     label: 'Access & members' },
  { id: 'campaigns',  label: 'Campaigns' },
  { id: 'categories', label: 'Categories' },
  { id: 'calendar',   label: 'Calendar' },
  { id: 'proposals',  label: 'Proposals' },
  { id: 'links',      label: 'Links & conversion' },
];

// Member tiers, ascending. `coGM` is GM-equivalent for CONTENT: reads hidden
// entries, sees and writes ||fog||, edits directly, approves proposals. It does
// NOT carry structural powers (members, pack, delete, transfer) — those stay with
// the owner so a coGM can never lock them out. See backend/loreAccess.js.
const MEMBER_TIERS = ['read', 'propose', 'coGM'];
const TIER_LABEL = { read: 'Read', propose: 'Read · propose', coGM: 'Co-GM' };
const TIER_HINT = {
  read:    'Sees shared entries. GM-only fog is stripped before it leaves the server.',
  propose: 'As Read, plus may submit edits for your approval. Sees no more than Read.',
  coGM:    'Full content access — including hidden entries and every ||fog|| secret.',
};

export default function WorldSettingsModal({ worldId, initialSection = 'general', onClose, onSaved, onNavigateEntry }) {
  const [section, setSection] = useState(
    SECTIONS.some(s => s.id === initialSection) ? initialSection : 'general',
  );

  // This modal is OWNER-ONLY by construction: WorldDetail renders the settings
  // button behind `isOwner`, and every settings route is owner-gated server-side
  // as well. Sections that hand a permission flag to a child component read it
  // from here rather than inlining `true`, so if a co-GM is ever let into part of
  // this panel there is exactly one line to change.
  const canManage = true;

  // ---- General (name / description / backdrop) — moved from Worlds.jsx --------
  // The world record for this section is fetched from the owner-filtered list
  // (there's no single-world GET), exactly as WorldDetail seeds its `world`.
  const [world,     setWorld]     = useState(null);
  const [draftName, setDraftName] = useState('');
  const [draftDesc, setDraftDesc] = useState('');
  const [busy,      setBusy]      = useState(false);

  // Backdrop draft — same STAGE-then-commit-on-Save model as the old inline form:
  // `bdFile` is a freshly-picked File, `bdUrl` the existing saved backdrop,
  // `bdRemove` flags "clear the existing one on save", `bdPreview` a local blob URL.
  const [bdFile,    setBdFile]    = useState(null);
  const [bdPreview, setBdPreview] = useState(null);
  const [bdUrl,     setBdUrl]     = useState(null);
  const [bdRemove,  setBdRemove]  = useState(false);
  const fileRef = useRef(null);

  useEffect(() => () => { if (bdPreview) URL.revokeObjectURL(bdPreview); }, [bdPreview]);

  // ---- Wave C: the world's system stamp -------------------------------------
  // Which ruleset this world's system-reference tier is written for. The field
  // shapes come from that BUNDLE's schema, so picking a system is what makes the
  // System rail section appear at all. Staged like the backdrop and committed on
  // Save, since it is a separate owner-only endpoint.
  const [systems,     setSystems]     = useState([]);   // installed bundles
  const [systemId,    setSystemId]    = useState(null); // saved value
  const [draftSystem, setDraftSystem] = useState('');   // '' = none
  useEffect(() => {
    let alive = true;
    // getSystems(), not getSheets(): only bundles that DECLARE a compendium can
    // stamp a world. Offering every character sheet meant picking one that yields
    // no types, which 400s on save or leaves an empty System rail.
    Promise.all([api.getSystems(), api.getWorldSystem(worldId)])
      .then(([list, sys]) => {
        if (!alive) return;
        setSystems(Array.isArray(list) ? list : []);
        const id = sys && !sys.error ? (sys.systemId || null) : null;
        setSystemId(id);
        setDraftSystem(id || '');
      })
      .catch(() => {});
    return () => { alive = false; };
  }, [worldId]);

  // Seed the General form from the world record once it loads.
  const seedGeneral = (w) => {
    setWorld(w || null);
    setDraftName(w?.name || '');
    setDraftDesc(w?.description || '');
    setBdFile(null);
    setBdPreview(prev => { if (prev) URL.revokeObjectURL(prev); return null; });
    setBdUrl(w?.backdrop || null);
    setBdRemove(false);
    if (fileRef.current) fileRef.current.value = '';
  };

  useEffect(() => {
    let alive = true;
    api.getWorlds()
      .then(list => { if (alive) seedGeneral(Array.isArray(list) ? list.find(x => x.id === worldId) : null); })
      .catch(() => {});
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [worldId]);

  const pickBackdrop = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setBdFile(file);
    setBdRemove(false);
    setBdPreview(prev => { if (prev) URL.revokeObjectURL(prev); return URL.createObjectURL(file); });
  };
  const clearBackdrop = () => {
    setBdFile(null);
    setBdPreview(prev => { if (prev) URL.revokeObjectURL(prev); return null; });
    if (fileRef.current) fileRef.current.value = '';
    if (bdUrl) setBdRemove(true);
  };
  const shownBackdrop = bdPreview || (bdRemove ? null : bdUrl);

  const saveGeneral = async () => {
    const name = draftName.trim();
    if (!name || busy) return;
    setBusy(true);
    try {
      const saved = await api.updateWorld(worldId, { name, description: draftDesc.trim() });
      if (!saved || !saved.id) return;
      // Commit the staged backdrop change against the known world id.
      let backdrop = saved.backdrop ?? null;
      if (bdFile) {
        const r = await api.uploadWorldBackdrop(saved.id, bdFile);
        if (r && !r.error) backdrop = r.backdrop;
      } else if (bdRemove) {
        const r = await api.deleteWorldBackdrop(saved.id);
        if (r && !r.error) backdrop = null;
      }
      const finalWorld = { ...saved, backdrop };
      seedGeneral(finalWorld);
      onSaved && onSaved({ world: finalWorld });

      // Commit a changed system stamp through its own owner-only route. Done
      // after the world save so a failure here can't lose the name/description
      // edit, and reported separately because it reshapes the whole System rail.
      if ((draftSystem || '') !== (systemId || '')) {
        const r = await api.setWorldSystem(worldId, draftSystem || null);
        if (r && !r.error) {
          setSystemId(r.systemId || null);
          onSaved && onSaved({ system: r });
        } else if (r && r.error) {
          window.alert(r.error);
          setDraftSystem(systemId || '');
        }
      }
    } finally {
      setBusy(false);
    }
  };

  // ---- Access & members (§4.7) — moved from WorldDetail ----------------------
  const [members,     setMembers]     = useState([]);
  const [membersBusy, setMembersBusy] = useState(false);
  const [membersLoaded, setMembersLoaded] = useState(false);

  useEffect(() => {
    if (section !== 'access' || membersLoaded) return;
    let alive = true;
    setMembersBusy(true);
    api.getWorldMembers(worldId).then(list => {
      if (!alive) return;
      setMembers(Array.isArray(list) ? list : []);
      setMembersLoaded(true);
      setMembersBusy(false);
    }).catch(() => { if (alive) setMembersBusy(false); });
    return () => { alive = false; };
  }, [section, membersLoaded, worldId]);

  const changeTier = async (userId, tier) => {
  // Promoting to Co-GM grants fog clearance over the ENTIRE world, retroactively.
  // Unlike read/propose it can't be quietly undone — anything they've already read
  // stays read. Confirm deliberately; demotion needs no prompt.
  if (tier === 'coGM' && !window.confirm(
    `Make ${userId} a Co-GM?\n\nThey will immediately see every hidden entry and every `
    + `GM-only ||fog|| secret in this world, and can edit and approve changes.\n\n`
    + `They cannot manage members, change the pack, or delete the world.`,
  )) return;
  const res = await api.setWorldMemberTier(worldId, userId, tier);
  if (res && res.tier) setMembers(prev => prev.map(m => (m.userId === userId ? { ...m, tier } : m)));
};
  const revokeMember = async (userId) => {
    if (!window.confirm(`Revoke ${userId}'s access? Their characters in this world's campaigns will be removed from those campaigns.`)) return;
    const res = await api.revokeWorldMember(worldId, userId);
    if (res && res.ok) setMembers(prev => prev.filter(m => m.userId !== userId));
  };
  const kickCharacter = async (userId, campaignId, charId) => {
    if (!window.confirm('Remove this character from the campaign? The player keeps their world access.')) return;
    const res = await api.kickCampaignCharacter(worldId, campaignId, charId);
    if (res && res.ok) {
      setMembers(prev => prev.map(m => (
        m.userId === userId ? { ...m, characters: m.characters.filter(ch => ch.id !== charId) } : m
      )));
    }
  };

  // ---- Campaigns (§4.10) — read-only list of campaigns linked to this world --
  // Campaigns whose worldId === this world (the §4.7 link). Owner-only route,
  // self-fetched on first visit. No create/unlink here (that lives in the
  // Campaigns manager on the character list); this is a reference view.
  const [campaigns,      setCampaigns]      = useState([]);
  const [campaignsBusy,  setCampaignsBusy]  = useState(false);
  const [campaignsLoaded, setCampaignsLoaded] = useState(false);

  useEffect(() => {
    if (section !== 'campaigns' || campaignsLoaded) return;
    let alive = true;
    setCampaignsBusy(true);
    api.getWorldCampaigns(worldId).then(res => {
      if (!alive) return;
      setCampaigns(Array.isArray(res?.campaigns) ? res.campaigns : []);
      setCampaignsLoaded(true);
      setCampaignsBusy(false);
    }).catch(() => { if (alive) setCampaignsBusy(false); });
    return () => { alive = false; };
  }, [section, campaignsLoaded, worldId]);

  // ---- Categories (§4j rename + show/hide) — moved from WorldDetail ----------
  const [categories, setCategories] = useState([]);
  const [catDraft,   setCatDraft]   = useState({});
  const [catsLoaded, setCatsLoaded] = useState(false);

  const seedCatDraft = (list) => {
    const draft = {};
    for (const c of list) {
      draft[c.id] = { label: c.label !== c.baseLabel ? c.label : '', hidden: !!c.hidden };
    }
    setCatDraft(draft);
  };

  useEffect(() => {
    if (section !== 'categories' || catsLoaded) return;
    let alive = true;
    api.getWorldCategories(worldId).then(cats => {
      if (!alive) return;
      const list = Array.isArray(cats) ? cats : [];
      setCategories(list);
      seedCatDraft(list);
      setCatsLoaded(true);
    }).catch(() => {});
    return () => { alive = false; };
  }, [section, catsLoaded, worldId]);

  const saveCustomize = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const merged = await api.setWorldCategoryConfig(worldId, catDraft);
      if (Array.isArray(merged)) {
        setCategories(merged);
        seedCatDraft(merged);
        onSaved && onSaved({ categories: merged });
      }
    } finally {
      setBusy(false);
    }
  };

  // ---- Links & conversion (§4h + Wave C) — moved from WorldDetail ------------
  // Self-fetch every entry (the pool [[wiki]] links resolve against), then derive
  // the danglers the same way WorldDetail does — no stored link table.
  const [allEntries, setAllEntries] = useState([]);
  const [linksLoaded, setLinksLoaded] = useState(false);

  const [allSys, setAllSys] = useState([]);

  useEffect(() => {
    if (section !== 'links' || linksLoaded) return;
    let alive = true;
    // ⚠️ RAW TEXT ON PURPOSE. Everywhere else in this app you read the SERIALIZED
    // payload, never the stored file — that is the whole discipline (strip at
    // serialization, verify in the Network payload). This scan INVERTS it, and
    // deliberately: a fogged `||[[sys:Ankheg]]||` is invisible to a player but
    // still needs converting, so leaving it out of the worklist would silently
    // hide work. It is safe here for exactly one reason — this modal is
    // owner-only, so the payload the owner receives already IS raw. If this
    // report is ever shown to a non-owner, it must be re-derived server-side.
    Promise.all([api.getLore(worldId), api.getSysrefEntries(worldId)]).then(([all, sys]) => {
      if (!alive) return;
      setAllEntries(Array.isArray(all) ? all : []);
      setAllSys(Array.isArray(sys) ? sys : []);
      setLinksLoaded(true);
    }).catch(() => {});
    return () => { alive = false; };
  }, [section, linksLoaded, worldId]);

  // Two resolution pools, matching the renderer: bare `[[X]]` addresses lore,
  // `[[sys:X]]` addresses the stamped system tier.
  const resolveLink = useMemo(() => {
    const index = (list) => {
      const map = new Map();
      for (const e of list) {
        const k = (e.name || '').trim().toLowerCase();
        if (k && !map.has(k)) map.set(k, e);
      }
      return map;
    };
    const lore = index(allEntries);
    const sys  = index(allSys);
    return (ns, target) =>
      (ns === 'sys' ? sys : lore).get((target || '').trim().toLowerCase()) || null;
  }, [allEntries, allSys]);

  // The conversion tracker. Every unresolved link in the world, SPLIT by what it
  // was addressing — because the two mean completely different things:
  //   • a broken LORE link is almost always a typo or a rename → fix the text;
  //   • a broken SYSTEM link is a statblock nobody has entered yet under the
  //     world's current system → do the work.
  // The authored links ARE the worklist: nothing to maintain, always accurate,
  // and it catches typos on day one. System refs sort by reference count
  // descending so the most-used mechanics convert first.
  const brokenLinks = useMemo(() => {
    const map = new Map();
    for (const e of [...allEntries, ...allSys]) {
      const fields = e.fields || {};
      for (const key of Object.keys(fields)) {
        const val = fields[key];
        if (typeof val !== 'string' || !val.includes('[[')) continue;
        for (const tok of parseBody(val)) {
          if (tok.type !== 'link') continue;
          const { ns, target } = splitLinkNamespace((tok.name || '').trim());
          const k = `${ns || ''}:${(target || '').trim().toLowerCase()}`;
          if (!target || resolveLink(ns, target)) continue;
          if (!map.has(k)) map.set(k, { key: k, name: target.trim(), ns: ns || null, refs: [] });
          const rec = map.get(k);
          if (!rec.refs.some(r => r.id === e.id)) rec.refs.push(e);
        }
      }
    }
    return Array.from(map.values());
  }, [allEntries, allSys, resolveLink]);

  const brokenLore = useMemo(
    () => brokenLinks.filter(b => b.ns !== 'sys').sort((a, b) => a.name.localeCompare(b.name)),
    [brokenLinks],
  );
  const unconvertedSys = useMemo(
    () => brokenLinks.filter(b => b.ns === 'sys')
      .sort((a, b) => b.refs.length - a.refs.length || a.name.localeCompare(b.name)),
    [brokenLinks],
  );

  // ---- Proposals (§4.9) — the owner's world-wide pending review queue --------
  // Each pending proposal is shown against the CURRENT raw entry, and the GM can
  // EDIT the proposed values before approving (never a blind overwrite — this is
  // the fog-safety guarantee: a proposer's base was fog-stripped, so the GM
  // re-injects any ||fog|| here). Approve applies through the normal update path.
  const [proposals,   setProposals]   = useState([]);
  const [propEntries, setPropEntries] = useState({});   // entryId -> raw entry (owner view)
  const [propDraft,   setPropDraft]   = useState({});    // proposalId -> { name, fields }
  const [propLoaded,  setPropLoaded]  = useState(false);
  const [propBusy,    setPropBusy]    = useState(null);  // proposalId being resolved
  const [propCount,   setPropCount]   = useState(null);  // pending count for the nav badge

  // Lightweight pending-count on mount so the nav badge shows before the section
  // is opened (owner-only route; a non-owner would 403, harmless here).
  useEffect(() => {
    api.getWorldProposals(worldId)
      .then(q => setPropCount(Array.isArray(q?.proposals) ? q.proposals.length : 0))
      .catch(() => {});
  }, [worldId]);

  useEffect(() => {
    if (section !== 'proposals' || propLoaded) return;
    let alive = true;
    Promise.all([api.getWorldProposals(worldId), api.getLore(worldId)]).then(([q, all]) => {
      if (!alive) return;
      const list = Array.isArray(q?.proposals) ? q.proposals : [];
      setProposals(list);
      setPropCount(list.length);
      const byId = {};
      (Array.isArray(all) ? all : []).forEach(e => { byId[e.id] = e; });
      setPropEntries(byId);
      const draft = {};
      list.forEach(p => { draft[p.id] = { name: p.name || '', fields: { ...(p.fields || {}) } }; });
      setPropDraft(draft);
      setPropLoaded(true);
    }).catch(() => {});
    return () => { alive = false; };
  }, [section, propLoaded, worldId]);

  const setPropField = (pid, key, val) =>
    setPropDraft(d => ({ ...d, [pid]: { ...d[pid], fields: { ...d[pid].fields, [key]: val } } }));
  const setPropName = (pid, val) =>
    setPropDraft(d => ({ ...d, [pid]: { ...d[pid], name: val } }));

  const resolveProposal = async (p, action) => {
    setPropBusy(p.id);
    try {
      const res = action === 'approve'
        ? await api.approveProposal(worldId, p.entryId, p.id, propDraft[p.id])
        : await api.rejectProposal(worldId, p.entryId, p.id);
      if (res && res.ok) {
        setProposals(prev => prev.filter(x => x.id !== p.id));
        setPropCount(c => (typeof c === 'number' ? Math.max(0, c - 1) : c));
        if (action === 'approve') onSaved && onSaved({ loreChanged: true });
      } else if (res && res.error) {
        window.alert(res.error);
      }
    } finally {
      setPropBusy(null);
    }
  };

  const proposalsBody = (
    !propLoaded ? (
      <div style={{ color: 'var(--text-dim)', fontSize: '0.85rem' }}>Loading…</div>
    ) : proposals.length === 0 ? (
      <div style={{ color: 'var(--text-dim)', fontSize: '0.9rem' }}>
        No pending proposals. Members with <strong>Read · propose</strong> access can suggest edits;
        they'll appear here for review.
      </div>
    ) : (
      <>
        <div style={{ color: 'var(--text-dim)', fontSize: '0.8rem', marginBottom: '0.75rem', lineHeight: 1.4 }}>
          Review each suggestion against the current text and <strong>edit before approving</strong> if
          needed — a proposer's copy has GM-only <code>||fog||</code> removed, so restore any fog here.
          Approving applies the change (and records history); rejecting closes it.
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
          {proposals.map(p => {
            const cur = propEntries[p.entryId] || {};
            const draft = propDraft[p.id] || { name: p.name, fields: p.fields || {} };
            const fieldKeys = Object.keys(draft.fields || {});
            const busyRow = propBusy === p.id;
            return (
              <div key={p.id} style={{ border: '1px solid var(--border)', borderRadius: '2px', background: 'var(--bg-raised)', padding: '0.75rem' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: '0.5rem', marginBottom: '0.5rem' }}>
                  <div style={{ color: 'var(--text-accent)', fontSize: '0.95rem', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {p.entryName || cur.name || '(entry)'}
                  </div>
                  <div style={{ ...eyebrow, flex: '0 0 auto' }}>
                    {p.proposedBy} · {new Date(p.proposedAt).toLocaleDateString()}
                  </div>
                </div>
                {p.note && (
                  <div style={{ color: 'var(--text-primary)', fontSize: '0.85rem', fontStyle: 'italic', marginBottom: '0.5rem' }}>
                    “{p.note}”
                  </div>
                )}

                <div style={{ marginBottom: '0.5rem' }}>
                  <label style={labelStyle}>Name</label>
                  {cur.name != null && cur.name !== draft.name && (
                    <div style={{ color: 'var(--text-dim)', fontSize: '0.75rem', marginBottom: '0.2rem' }}>Current: {cur.name}</div>
                  )}
                  <input value={draft.name} onChange={e => setPropName(p.id, e.target.value)} style={inputStyle} />
                </div>

                {fieldKeys.map(k => {
                  const curVal = typeof cur.fields?.[k] === 'string' ? cur.fields[k] : '';
                  return (
                    <div key={k} style={{ marginBottom: '0.5rem' }}>
                      <label style={labelStyle}>{k}</label>
                      {curVal !== draft.fields[k] && (
                        <div style={{
                          color: 'var(--text-dim)', fontSize: '0.75rem', whiteSpace: 'pre-wrap',
                          borderLeft: '2px solid var(--border)', paddingLeft: '0.5rem', marginBottom: '0.25rem',
                        }}>
                          <span style={{ ...eyebrow, fontSize: '0.55rem' }}>Current</span>
                          <div>{curVal || <em>(empty)</em>}</div>
                        </div>
                      )}
                      <textarea value={draft.fields[k]} onChange={e => setPropField(p.id, k, e.target.value)}
                        rows={3} style={{ ...inputStyle, resize: 'vertical', lineHeight: 1.4 }} />
                    </div>
                  );
                })}

                <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.5rem' }}>
                  <button className="btn-primary" disabled={busyRow} onClick={() => resolveProposal(p, 'approve')}>
                    {busyRow ? '…' : 'Approve'}
                  </button>
                  <button className="btn-ghost" disabled={busyRow} onClick={() => resolveProposal(p, 'reject')}
                    style={{ color: 'var(--danger)' }}>Reject</button>
                </div>
              </div>
            );
          })}
        </div>
      </>
    )
  );

  // ---- section bodies --------------------------------------------------------
  const generalBody = (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
      <div>
        <label style={labelStyle}>World Name</label>
        <input type="text" value={draftName} onChange={e => setDraftName(e.target.value)}
          placeholder="e.g. The Shattered Realms" style={inputStyle}
          onKeyDown={e => e.key === 'Enter' && saveGeneral()} autoFocus />
      </div>
      <div>
        <label style={labelStyle}>Description</label>
        <textarea value={draftDesc} onChange={e => setDraftDesc(e.target.value)}
          placeholder="A one-line blurb — what is this world?" rows={3}
          style={{ ...inputStyle, resize: 'vertical', fontFamily: 'var(--font-body)' }} />
      </div>

      {/* Wave C: the ruleset this world's system reference is written for. The
          reference TYPES (Edges, Powers, Bestiary…) come from the chosen sheet
          bundle's own schema, so this is what makes the System section appear in
          the rail. Changing it does NOT rewrite existing entries — each keeps its
          own stamp, which is what lets a world outlive a system; unconverted
          references then show up in Broken links as the conversion worklist. */}
      <div>
        <label style={labelStyle}>Game system (optional)</label>
        <select value={draftSystem} onChange={e => setDraftSystem(e.target.value)}
          style={{ ...inputStyle, cursor: 'pointer' }}>
          <option value="">None — no system reference</option>
          {systems.map(sh => (
            <option key={sh.sheetId} value={sh.sheetId}>
              {sh.name}{sh.types ? ` — ${sh.types} categories` : ''}
            </option>
          ))}
          {/* A stamp pointing at a bundle that no longer declares a package (or
              was removed) would otherwise vanish from the list and look like
              "None" — show it explicitly rather than silently mis-reporting. */}
          {systemId && !systems.some(sh => sh.sheetId === systemId) && (
            <option value={systemId}>Current system (bundle unavailable)</option>
          )}
        </select>
        <div style={{ color: 'var(--text-dim)', fontSize: '0.75rem', marginTop: '0.3rem', lineHeight: 1.4 }}>
          Adds a <strong>System</strong> section to the rail for statblocks, edges, powers and gear,
          linkable from any entry as <code>[[sys:Name]]</code>. Existing entries keep the system they
          were written for.
        </div>
      </div>

      {/* Backdrop image (optional). Portrait-style upload; the app mutes it
          automatically everywhere it's shown, so there's nothing to configure. */}
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
        <button className="btn-primary" onClick={saveGeneral} disabled={!draftName.trim() || busy}>
          {busy ? 'Saving…' : 'Save'}
        </button>
        <button className="btn-ghost" onClick={onClose} disabled={busy}>Cancel</button>
      </div>
    </div>
  );

  const accessBody = (
    <div>
      <div style={{
        color: 'var(--text-dim)', fontSize: '0.8rem', marginBottom: '0.9rem', lineHeight: 1.5,
        border: '1px solid var(--border)', borderRadius: '2px', background: 'var(--bg-raised)', padding: '0.6rem 0.75rem',
      }}>
        A player gains access when a character of theirs joins a campaign that's linked to this world
        (set the link in the Campaigns panel). Everyone starts at <strong>Read</strong>; promote from here.
        <br />
        <strong>Members can't open this world yet</strong> — the read-only view for players is a later step.
        This panel just manages who <em>will</em> have access.
      </div>

      {membersBusy && <div style={{ color: 'var(--text-dim)', fontSize: '0.85rem' }}>Loading…</div>}

      {!membersBusy && members.length === 0 && (
        <div style={{ color: 'var(--text-dim)', fontSize: '0.9rem', padding: '0.5rem 0' }}>
          No members yet. When a player joins a campaign linked to this world, they'll appear here.
        </div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
        {members.map(m => (
          <div key={m.userId} style={{
            border: '1px solid var(--border)', borderRadius: '2px', background: 'var(--bg-raised)', padding: '0.7rem 0.8rem',
          }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.5rem', marginBottom: '0.5rem' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', minWidth: 0 }}>
                <span style={{ color: 'var(--text-dim)', flex: '0 0 auto' }}><UserIcon size={16} /></span>
                <span style={{ color: 'var(--text-accent)', fontSize: '0.95rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{m.userId}</span>
              </div>
              <button type="button" onClick={() => revokeMember(m.userId)} style={{
                cursor: 'pointer', fontFamily: 'var(--font-mono)', fontSize: '0.6rem',
                letterSpacing: '0.08em', textTransform: 'uppercase', padding: '0.3rem 0.6rem',
                borderRadius: '999px', whiteSpace: 'nowrap', flex: '0 0 auto',
                color: 'var(--danger)', background: 'transparent', border: '1px solid var(--danger)',
              }}>Revoke</button>
            </div>

            {/* Tier control */}
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.4rem', marginBottom: m.characters.length ? '0.6rem' : 0 }}>
              {MEMBER_TIERS.map(t => {
                <div style={{ fontSize: '0.7rem', color: 'var(--text-dim)', marginTop: '0.15rem', flexBasis: '100%' }}>
                  {TIER_HINT[m.tier] || ''}
                </div>
                const on = m.tier === t;
                return (
                  <button key={t} type="button" onClick={() => changeTier(m.userId, t)} style={{
                    cursor: 'pointer', fontFamily: 'var(--font-mono)', fontSize: '0.6rem',
                    letterSpacing: '0.06em', textTransform: 'uppercase', padding: '0.3rem 0.6rem',
                    borderRadius: '999px', whiteSpace: 'nowrap',
                    color: on ? 'var(--bg-deep)' : 'var(--text-dim)',
                    background: on ? 'var(--accent)' : 'transparent',
                    border: `1px solid ${on ? 'var(--accent)' : 'var(--border)'}`,
                  }}>{TIER_LABEL[t]}</button>
                );
              })}
            </div>

            {/* Characters in this world's campaigns, each kickable */}
            {m.characters.length > 0 && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.3rem' }}>
                <div style={{ ...eyebrow, fontSize: '0.55rem' }}>In this world's campaigns</div>
                {m.characters.map(ch => (
                  <div key={ch.id} style={{
                    display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.5rem',
                    padding: '0.35rem 0.5rem', background: 'var(--bg-input)', border: '1px solid var(--border)', borderRadius: '2px',
                  }}>
                    <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: '0.85rem', color: 'var(--text-primary)' }}>
                      {ch.name}
                      {ch.campaignName && <span style={{ color: 'var(--text-dim)', fontSize: '0.75rem' }}>{`  ·  ${ch.campaignName}`}</span>}
                    </span>
                    <button type="button" onClick={() => kickCharacter(m.userId, ch.campaignId, ch.id)} style={{
                      cursor: 'pointer', fontFamily: 'var(--font-mono)', fontSize: '0.55rem',
                      letterSpacing: '0.06em', textTransform: 'uppercase', padding: '0.25rem 0.5rem',
                      borderRadius: '999px', whiteSpace: 'nowrap', flex: '0 0 auto',
                      color: 'var(--text-dim)', background: 'transparent', border: '1px solid var(--border)',
                    }}>Kick</button>
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );

  const campaignsBody = (
    <div>
      <div style={{ color: 'var(--text-dim)', fontSize: '0.88rem', marginBottom: '0.75rem', lineHeight: 1.5 }}>
        Campaigns linked to this world. Players join with a campaign's code (from the Campaigns
        manager on your character list); joining grants their user <strong>Read</strong> access here.
      </div>
      {campaignsBusy && <div style={{ color: 'var(--text-dim)', fontSize: '0.85rem' }}>Loading…</div>}
      {!campaignsBusy && campaigns.length === 0 && (
        <div style={{ color: 'var(--text-dim)', fontSize: '0.9rem' }}>
          No campaigns are linked to this world yet. Link one from the Campaigns manager
          (set its World when creating or editing a campaign).
        </div>
      )}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
        {campaigns.map(c => (
          <div key={c.id} style={{ border: '1px solid var(--border)', borderRadius: '2px', background: 'var(--bg-raised)', padding: '0.6rem 0.75rem' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.5rem', marginBottom: '0.35rem' }}>
              <span style={{ color: 'var(--text-accent)', fontSize: '0.95rem', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {c.name || '(unnamed)'}
                {c.status === 'archived' && <span style={{ ...eyebrow, marginLeft: '0.5rem' }}>· archived</span>}
              </span>
              {c.joinCode && (
                <span title="Join code" style={{
                  fontFamily: 'var(--font-mono)', fontSize: '0.7rem', letterSpacing: '0.1em',
                  color: 'var(--text-primary)', background: 'var(--bg-input)',
                  border: '1px solid var(--border)', borderRadius: '2px', padding: '0.1rem 0.45rem', flex: '0 0 auto',
                }}>{c.joinCode}</span>
              )}
            </div>
            <div style={{ fontFamily: 'var(--font-mono)', fontSize: '0.72rem', color: 'var(--text-dim)', display: 'flex', flexWrap: 'wrap', gap: '0.75rem' }}>
              <span>GM: {c.ownedBy}</span>
              <span>{c.memberCount} member{c.memberCount === 1 ? '' : 's'}</span>
              <span>{c.characterCount} character{c.characterCount === 1 ? '' : 's'}</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );

  const categoriesBody = (
    <div>
      <div style={{ color: 'var(--text-dim)', fontSize: '0.8rem', marginBottom: '0.75rem', lineHeight: 1.4 }}>
        Rename or hide categories for this world only. Hiding keeps every entry —
        it just drops the category from the rail. The shared pack is never changed.
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
        {categories.map(c => {
          const d = catDraft[c.id] || { label: '', hidden: false };
          return (
            <div key={c.id} style={{
              display: 'flex', alignItems: 'center', gap: '0.6rem', padding: '0.6rem 0.75rem',
              border: '1px solid var(--border)', borderRadius: '2px', background: 'var(--bg-raised)',
            }}>
              <span style={{ color: 'var(--text-dim)', flex: '0 0 auto' }}><CatIcon name={c.icon} size={17} /></span>
              <input value={d.label} placeholder={c.baseLabel}
                onChange={e => setCatDraft(cd => ({ ...cd, [c.id]: { ...d, label: e.target.value } }))}
                style={{ ...inputStyle, flex: '1 1 auto' }} aria-label={`Rename ${c.baseLabel}`} />
              <button type="button"
                onClick={() => setCatDraft(cd => ({ ...cd, [c.id]: { ...d, hidden: !d.hidden } }))}
                style={{
                  cursor: 'pointer', fontFamily: 'var(--font-mono)', fontSize: '0.6rem',
                  letterSpacing: '0.08em', textTransform: 'uppercase', padding: '0.3rem 0.6rem',
                  borderRadius: '999px', whiteSpace: 'nowrap', flex: '0 0 auto',
                  display: 'inline-flex', alignItems: 'center', gap: '0.3rem',
                  color: d.hidden ? 'var(--bg-deep)' : 'var(--positive)',
                  background: d.hidden ? 'var(--neutral)' : 'transparent',
                  border: `1px solid ${d.hidden ? 'var(--neutral)' : 'var(--positive)'}`,
                }}>
                {d.hidden && <EyeOffIcon size={11} />}
                {d.hidden ? 'Hidden' : 'Shown'}
              </button>
            </div>
          );
        })}
      </div>
      <div style={{ display: 'flex', gap: '0.5rem', marginTop: '1rem' }}>
        <button className="btn-primary" onClick={saveCustomize} disabled={busy}>
          {busy ? 'Saving…' : 'Save'}
        </button>
        <button className="btn-ghost" onClick={onClose} disabled={busy}>Cancel</button>
      </div>
    </div>
  );

  // One row renderer for both groups — the existing broken-link card, with the
  // link rendered in whichever form it was authored so the text on screen matches
  // the text to search for.
  const brokenRow = (bl) => (
    <div key={bl.key} style={{ border: '1px solid var(--border)', borderRadius: '2px', background: 'var(--bg-raised)', padding: '0.6rem 0.75rem' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.35rem' }}>
        <span style={{ color: 'var(--text-dim)', textDecoration: 'underline dotted', fontSize: '0.95rem' }}>
          [[{bl.ns ? `${bl.ns}:` : ''}{bl.name}]]
        </span>
        <span style={{ ...eyebrow }}>· {bl.refs.length} ref{bl.refs.length === 1 ? '' : 's'}</span>
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.35rem' }}>
        {bl.refs.map(r => {
          // Clicking a ref jumps to that entry — but only when a navigator
          // is available (WorldDetail passes one; the Worlds list has no
          // open world to navigate, so refs are inert there).
          const canNav = !!onNavigateEntry;
          return canNav ? (
            <button key={r.id} type="button"
              onClick={() => { onNavigateEntry(r); onClose && onClose(); }}
              style={{
                cursor: 'pointer', background: 'var(--bg-input)', border: '1px solid var(--border)',
                borderRadius: '2px', color: 'var(--text-accent)', fontFamily: 'var(--font-body)',
                fontSize: '0.8rem', padding: '0.2rem 0.5rem',
              }}>
              {r.name}
            </button>
          ) : (
            <span key={r.id} style={{
              background: 'var(--bg-input)', border: '1px solid var(--border)',
              borderRadius: '2px', color: 'var(--text-primary)', fontFamily: 'var(--font-body)',
              fontSize: '0.8rem', padding: '0.2rem 0.5rem',
            }}>
              {r.name}
            </span>
          );
        })}
      </div>
    </div>
  );

  const linksBody = (
    !linksLoaded ? (
      <div style={{ color: 'var(--text-dim)', fontSize: '0.85rem' }}>Loading…</div>
    ) : brokenLinks.length === 0 ? (
      <div style={{ color: 'var(--text-dim)', fontSize: '0.9rem' }}>
        No broken links — every <code>[[link]]</code> resolves.
      </div>
    ) : (
      <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
        {/* Unconverted system references — the conversion worklist. Listed FIRST
            and most-used first, because these are work to do rather than a
            mistake to correct. */}
        {unconvertedSys.length > 0 && (
          <div>
            <div style={{ ...eyebrow, marginBottom: '0.4rem' }}>
              Unconverted system references · {unconvertedSys.length}
            </div>
            <div style={{ color: 'var(--text-dim)', fontSize: '0.8rem', marginBottom: '0.75rem', lineHeight: 1.4 }}>
              These <code>[[sys:Name]]</code> links point at mechanics that don't exist yet under
              this world's system. Most-referenced first — add each one to the matching System
              section and every link to it lights up at once. Nothing is broken meanwhile; an
              unresolved link just renders as plain text.
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
              {unconvertedSys.map(brokenRow)}
            </div>
          </div>
        )}

        {brokenLore.length > 0 && (
          <div>
            <div style={{ ...eyebrow, marginBottom: '0.4rem' }}>Broken lore links · {brokenLore.length}</div>
            <div style={{ color: 'var(--text-dim)', fontSize: '0.8rem', marginBottom: '0.75rem', lineHeight: 1.4 }}>
              Each name below is linked from a body but has no matching entry. Create it, fix the
              spelling, or use <code>[[Name|display]]</code> — links resolve by name, so a rename
              breaks old references on purpose.
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
              {brokenLore.map(brokenRow)}
            </div>
          </div>
        )}
      </div>
    )
  );

  // Mounted only while its tab is open, matching the lazy-load pattern the other
  // sections use — the editor fetches the calendar and the entry list on mount.
  const calendarBody = section === 'calendar' ? (
    <WorldCalendarEditor worldId={worldId} canManage={canManage} onSaved={onSaved} />
  ) : null;

  const bodyFor = { general: generalBody, access: accessBody, campaigns: campaignsBody, categories: categoriesBody, calendar: calendarBody, proposals: proposalsBody, links: linksBody };
  const activeSection = SECTIONS.find(s => s.id === section) || SECTIONS[0];
  const headerCount =
    section === 'access' && members.length ? ` · ${members.length}`
    : section === 'campaigns' && campaigns.length ? ` · ${campaigns.length}`
    : section === 'proposals' && proposals.length ? ` · ${proposals.length}`
    : section === 'links' && brokenLinks.length ? ` · ${brokenLinks.length}`
    : '';

  return (
    // §4.10: shared modal shell — the panel never scrolls; only the nav + the
    // active section's content scroll (each with overscroll containment).
    <div onClick={onClose} className="keep-modal-overlay">
      <div onClick={e => e.stopPropagation()} className="keep-modal" style={{ maxWidth: 760 }}>
        {/* Modal header */}
        <div className="keep-modal-header" style={{
          display: 'flex', justifyContent: 'space-between', alignItems: 'center',
          padding: '1rem 1.25rem', borderBottom: '1px solid var(--border)',
        }}>
          <div style={eyebrow}>
            World settings{world?.name ? ` · ${world.name}` : ''}
          </div>
          <button className="btn-ghost" onClick={onClose}>Close</button>
        </div>

        {/* Two columns: left section nav + right content. This row is the modal's
            flexible region; each column scrolls independently. */}
        <div style={{ display: 'flex', minHeight: 0, flex: '1 1 auto' }}>
          {/* Left nav — a vertical list of section labels with an active state. */}
          <div style={{
            flex: '0 0 auto', width: 168, borderRight: '1px solid var(--border)',
            padding: '0.75rem 0.5rem', display: 'flex', flexDirection: 'column', gap: '0.15rem',
            overflowY: 'auto', overscrollBehavior: 'contain',
          }}>
            {SECTIONS.map(s => {
              const on = s.id === section;
              // §4.9: the Proposals row carries a pending-count badge.
              const badge = s.id === 'proposals' && propCount ? propCount : null;
              return (
                <button key={s.id} type="button" onClick={() => setSection(s.id)} style={{
                  display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.4rem',
                  width: '100%', textAlign: 'left', cursor: 'pointer',
                  padding: '0.5rem 0.6rem', borderRadius: '2px',
                  background: on ? 'var(--bg-raised)' : 'transparent',
                  border: 'none', borderLeft: `2px solid ${on ? 'var(--accent)' : 'transparent'}`,
                  color: on ? 'var(--text-accent)' : 'var(--text-primary)',
                  fontFamily: 'var(--font-body)', fontSize: '0.9rem',
                }}>
                  <span>{s.label}</span>
                  {badge && (
                    <span style={{
                      fontFamily: 'var(--font-mono)', fontSize: '0.6rem', color: 'var(--bg-deep)',
                      background: 'var(--accent)', borderRadius: '999px', padding: '0.1rem 0.4rem', lineHeight: 1.4, flex: '0 0 auto',
                    }}>{badge}</span>
                  )}
                </button>
              );
            })}
          </div>

          {/* Right content — the scrolling body for the active section. */}
          <div className="keep-modal-body" style={{ minWidth: 0, padding: '1.25rem' }}>
            <div style={{ ...eyebrow, marginBottom: '1rem' }}>{activeSection.label}{headerCount}</div>
            {bodyFor[section]}
          </div>
        </div>
      </div>
    </div>
  );
}
