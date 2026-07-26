// backend/loreAccess.js
//
// Server-side gate for world lore access. This is the ONE place the access
// decisions live, so the list filter, the single-entry fetch, the proposal routes
// and the asset gate can never drift apart:
//   1. canSee(role, visibility)  — may this viewer see this entry at all?
//   2. seesRawFog(role)          — do they receive GM-only ||fog|| spans?
//   3. serializeEntryForRole()   — the transform that enforces (2) on a payload.
//   4. canEditLore / canProposeEdits / canManageWorld — capability checks.
//
// THE MODEL: three independent axes. Never encode one as a rank on another —
// doing exactly that is what produced the earlier tangle where granting a player
// edit rights silently handed them every GM secret in the world.
//
//   A. CAPABILITY — lives on the member, as `role`:
//        owner  — the world's creator. Content powers of a coGM PLUS the
//                 structural ones: delete the world, add/remove members, change
//                 roles, swap the pack, transfer ownership. Structural powers are
//                 owner-only for RECOVERABILITY, not trust — a coGM who could
//                 remove members could lock the owner out of their own world.
//        coGM   — GM-equivalent for CONTENT: reads anything (incl. hidden),
//                 creates/edits/deletes entries, sets visibility, sees and writes
//                 fog, approves proposals. No structural powers.
//        propose— may submit a suggested edit for a GM to approve. Sees exactly
//                 what `read` sees; the tier is about submitting, not seeing.
//        read   — may view shared entries. The DEFAULT for a new member.
//
//   B. SECRECY — lives on the entry, as `visibility`, and is BINARY:
//        shared — visible to every member.
//        hidden — owner + coGM only. The DEFAULT for a new entry.
//      There is deliberately no per-entry tiering: fog already provides
//      intra-entry secrecy (share the entry, fog the secret line), and tiering
//      entries was what coupled secrecy to edit rights in the first place.
//
//   C. FOG CLEARANCE — derived from role, NOT from entry visibility:
//        owner + coGM see raw fog, anywhere, always. Nobody else ever does.
//
// A consequence worth knowing: because no non-GM tier receives raw fog, a
// proposer's base text is ALWAYS fog-stripped. Approving a proposal by saving the
// proposer's copy wholesale would ERASE the fog — approval must stay a sighted GM
// act that diffs against the raw stored entry. See loreAccess.test.js.
//
// stripFog/parseBody below are byte-for-byte the audited frontend
// `frontend/src/components/fog.js`, ported to CommonJS because that file is an ESM
// module the CommonJS server can't `require`. Keep the two in sync; both are tested.

// --- A. capability -----------------------------------------------------------

const ROLES = ['read', 'propose', 'coGM', 'owner'];

// Ordinal rank for MEMBER comparisons only (e.g. "may this person approve that
// proposal"). It must never be compared against an entry's visibility — that
// cross-axis comparison is the bug this model exists to prevent.
const ROLE_RANK = { read: 1, propose: 2, coGM: 3, owner: 4 };

const DEFAULT_ROLE = 'read';

function rankOf(role) {
  return ROLE_RANK[role] || 0;                 // unknown role → 0 → no access
}

// GM-equivalent for content. The predicate every content decision routes through.
function isGM(role) {
  return role === 'owner' || role === 'coGM';
}

// May create / edit / delete lore entries and set their visibility.
function canEditLore(role) {
  return isGM(role);
}

// May submit a proposed edit (GMs edit directly, so they trivially qualify).
function canProposeEdits(role) {
  return rankOf(role) >= ROLE_RANK.propose;
}

// Structural powers: owner ONLY. Deliberately not isGM().
function canManageWorld(role) {
  return role === 'owner';
}

// --- B. secrecy --------------------------------------------------------------

const VISIBILITY_STATES = ['shared', 'hidden'];

const DEFAULT_VISIBILITY = 'hidden';           // new entries start GM-only

// May a viewer of `role` see an entry of `visibility`?
// GMs see everything. Everyone else sees `shared` only. Unknown/garbage values
// fail closed — an unrecognised visibility is treated as hidden, and an
// unrecognised role gets rank 0 — so a malformed record is hidden, never leaked.
function canSee(role, visibility) {
  if (isGM(role)) return true;
  if (!rankOf(role)) return false;             // non-member / unknown role
  return visibility === 'shared';
}

// --- C. fog clearance --------------------------------------------------------

// Who receives RAW ||fog||: GMs, and nobody else — independent of entry
// visibility. Note this is isGM(), NOT a rank threshold: fog clearance is a
// secrecy decision and must not ride on any edit capability.
function seesRawFog(role) {
  return isGM(role);
}

// --- migration from the old four-state model ---------------------------------
//
// Both migrations FAIL CLOSED. The old vocabulary overloaded one scale for
// capability and secrecy, so a naive mapping would widen access on live data.

// Old member tiers were read|propose|write. `write` implied fog clearance, so
// promoting it to coGM would silently hand out every GM secret — downgrade to
// `propose` instead and let the owner re-grant coGM by hand. Log what changes.
function migrateRole(oldRole) {
  if (oldRole === 'owner' || oldRole === 'coGM') return oldRole;
  if (oldRole === 'propose' || oldRole === 'write') return 'propose';
  return DEFAULT_ROLE;
}

// Old entry visibility was hidden|read|propose|write, where propose/write meant
// MORE secret than read. Only `read` becomes `shared`; everything more restricted
// stays hidden for the owner to re-share deliberately.
function migrateVisibility(oldVisibility) {
  if (oldVisibility === 'shared') return 'shared';
  if (oldVisibility === 'read') return 'shared';
  return 'hidden';
}

// --- fog stripping (CommonJS port of the audited fog.js) ---------------------

// Tokenize a body string into typed spans (text | fog | link). Unmatched openers
// stay literal so nothing an author typed silently vanishes. IDENTICAL to
// fog.js parseBody — keep in sync.
function parseBody(input) {
  const text = typeof input === 'string' ? input : '';
  const tokens = [];
  let i = 0;
  let buf = '';

  const flush = () => { if (buf) { tokens.push({ type: 'text', text: buf }); buf = ''; } };

  while (i < text.length) {
    const fog  = text.indexOf('||', i);
    const link = text.indexOf('[[', i);

    let next = -1;
    if (fog !== -1 && (link === -1 || fog < link)) next = fog;
    else if (link !== -1) next = link;

    if (next === -1) { buf += text.slice(i); break; }

    buf += text.slice(i, next);

    if (next === fog) {
      const close = text.indexOf('||', next + 2);
      if (close === -1) { buf += text.slice(next); break; }
      flush();
      tokens.push({ type: 'fog', text: text.slice(next + 2, close) });
      i = close + 2;
    } else {
      const close = text.indexOf(']]', next + 2);
      if (close === -1) { buf += text.slice(next); break; }
      const inner = text.slice(next + 2, close);
      const pipe  = inner.indexOf('|');
      const name    = (pipe === -1 ? inner : inner.slice(0, pipe)).trim();
      const display = (pipe === -1 ? inner : inner.slice(pipe + 1)).trim();
      if (!name) { buf += text.slice(next, close + 2); i = close + 2; continue; }
      flush();
      tokens.push({ type: 'link', name, display: display || name });
      i = close + 2;
    }
  }

  flush();
  if (tokens.length === 0) tokens.push({ type: 'text', text: '' });
  return tokens;
}

// Re-emit a link token exactly as it was authored. A display alias that matches
// the name collapses to the short form, so a round-trip through stripFog is
// byte-identical for the common case.
function renderLink(t) {
  return (t.display && t.display !== t.name)
    ? `[[${t.name}|${t.display}]]`
    : `[[${t.name}]]`;
}

// The text a non-owner receives: fogged spans dropped WHOLE (so length can't leak
// the hidden text), links PRESERVED as authored. A link the GM chose NOT to fog is
// meant to be followed — whether its target is reachable is decided by canSee on
// the TARGET entry, not here, so an unreachable link simply fails to resolve on the
// client. A link inside fog (`||[[Secret]]||`) never becomes a link token at all:
// parseBody sees the `||` opener first and swallows the whole span, so it is dropped
// with the rest of the fog. IDENTICAL to fog.js stripFog — keep in sync.
function stripFog(input) {
  return parseBody(input)
    .filter(t => t.type !== 'fog')
    .map(t => (t.type === 'link' ? renderLink(t) : t.text))
    .join('');
}

// Serialize a lore entry for a given role. Roles that see raw fog (owner + write)
// get it untouched; read/propose get each fog-capable field (schema `fog: true`)
// run through stripFog, so no ||GM-only|| span ever leaves the server for them.
// `categories` is the world's pack schema (its fields carry the fog flag).
//
// Fails CLOSED on an unknown category: if the entry's categoryId isn't in the pack
// — orphaned by a category rename/removal, or a fallback pack whose ids don't match
// a custom one — we cannot know WHICH fields are fog-capable, so EVERY string field
// is stripped rather than none. The previous version derived an empty fogKeys set in
// that case and returned raw fog, which is why this lives here now: it is the third
// security decision in this module, and keeping it beside canSee/seesRawFog is what
// lets the tests exercise the real function instead of a mirror of it.
//
// The caller must have already checked canSee — this only transforms an allowed entry.
function serializeEntryForRole(entry, role, categories) {
  if (seesRawFog(role)) return entry;
  const cat = (categories || []).find(c => c && c.id === entry.categoryId);
  const fogKeys = cat
    ? new Set((cat.fields || []).filter(f => f && f.fog).map(f => f.key))
    : null;                                   // null = unknown category = strip everything
  const fields = { ...(entry.fields || {}) };
  for (const k of Object.keys(fields)) {
    if (typeof fields[k] !== 'string') continue;
    if (fogKeys === null || fogKeys.has(k)) fields[k] = stripFog(fields[k]);
  }
  return { ...entry, fields };
}

// ===========================================================================
// Campaigns (Wave A)
//
// A campaign has its OWN two-value role axis, deliberately NOT the world's:
//   owner  — the GM who created it (campaign.ownedBy).
//   player — a user who owns a character in it. Membership is DERIVED from that
//            character's campaignId, never stored as a ledger; see
//            resolveCampaignRole in server.js.
// Anything else is null → the route 404s. World membership does NOT imply
// campaign membership: a world member with no character in campaign X is a
// stranger to X, and mixing the two axes is the coupling this codebase keeps
// paying to avoid.
// ===========================================================================

const CAMPAIGN_ROLES = ['player', 'owner'];

// Mirrors the world/campaign status pair already shipped for worlds.
const CAMPAIGN_STATUSES = ['active', 'archived'];
const DEFAULT_CAMPAIGN_STATUS = 'active';

// The GM-authored prose fields. All three are markdown, all three may carry
// ||fog||, all three are optional. House rules are NOT here — homebrew is
// mechanical and belongs in the stamped system tier (CLAUDE.md §1).
const CAMPAIGN_TEXT_FIELDS = ['premise', 'situation', 'threads'];

// Only the owning GM sees raw fog in campaign prose. There is no coGM tier on a
// campaign: co-GM is a WORLD role, and a campaign may be standalone (worldId
// null) with no world to hold that grant.
function seesRawCampaignFog(role) {
  return role === 'owner';
}

// Serialize a campaign for a given role. `derived` is the computed block from the
// route (character count, roster, session stats) — never persisted, because a
// stored copy drifts.
//
// A player's payload differs in three ways, each of which is a leak if missed:
//   1. joinCode is REMOVED. It is a bearer credential — anyone holding it can
//      attach a character to this campaign. Same discipline as shareSafeChar.
//   2. premise/situation/threads are fog-STRIPPED, so a GM can hide the twist in
//      a premise the players otherwise read.
//   3. The roster carries character names only, never owner usernames.
//
// Fails CLOSED: an unrecognised role returns null and the caller must 404.
function serializeCampaignForRole(campaign, role, derived) {
  if (!campaign || !CAMPAIGN_ROLES.includes(role)) return null;
  const owner = role === 'owner';
  const raw   = seesRawCampaignFog(role);
  const d     = derived || {};

  const out = {
    id:        campaign.id,
    name:      campaign.name,
    status:    CAMPAIGN_STATUSES.includes(campaign.status)
                 ? campaign.status : DEFAULT_CAMPAIGN_STATUS,
    sheetId:   campaign.sheetId   || null,
    sheetName: campaign.sheetName || null,
    worldId:   campaign.worldId   || null,
    ownedBy:   campaign.ownedBy   || null,
    createdAt: campaign.createdAt || null,
    role,
  };

  // (1) the credential
  if (owner) out.joinCode = campaign.joinCode || null;

  // (2) the prose
  for (const k of CAMPAIGN_TEXT_FIELDS) {
    const v = typeof campaign[k] === 'string' ? campaign[k] : '';
    out[k] = raw ? v : stripFog(v);
  }

  // (3) the derived block. sessionCount/lastPlayed are fixed until Wave B lands —
  // present now so the overview UI does not change shape when sessions arrive.
  out.derived = {
    characterCount: Number.isInteger(d.characterCount) ? d.characterCount : 0,
    sessionCount:   Number.isInteger(d.sessionCount)   ? d.sessionCount   : 0,
    lastPlayed:     d.lastPlayed || null,
    roster: (Array.isArray(d.roster) ? d.roster : []).map(c => (
      owner ? { id: c.id, name: c.name, owner: c.owner }
            : { name: c.name }
    )),
  };

  return out;
}


// ===========================================================================
// Sessions (Wave B)
//
// A session carries TWO field groups separated by a HARD STRUCTURAL BOUNDARY:
//
//   prep   — the rails the GM intends to lay. Written BEFORE play.
//            GM-ONLY, UNCONDITIONALLY.
//   record — what actually happened. Written AFTER play. Shareable.
//
// This is deliberately NOT one document with per-field visibility flags. Prep
// keys never enter a non-GM payload AT ALL, because the player shape is BUILT
// FROM SCRATCH as an allowlist rather than deleted out of a copy. A mis-set flag,
// a prep field someone adds later and forgets to mark, or a hand-corrupted record
// therefore cannot leak the GM's plans — the same construction as shareSafeChar.
//
// Keep BOTH forever. Players hop the rails; unused prep is reusable (the counting
// house is still there next session), and the gap between intent and outcome is
// the most interesting thing in a campaign log read back a year later. The record
// NEVER overwrites the prep.
//
// ORDERING IS ALWAYS BY `number`, NEVER by date. Flashbacks and time skips mean
// in-world dates are not monotonic, so sorting a log by date would file session 12
// between 4 and 5.
// ===========================================================================

// Prep is a list of SCENES (the "Script" template — GM Note, Cinematic,
// Location, Who's There, Move It Forward, Dialog, Skill Checks, Big Clue), not a
// single who/what/when/where/why block. A session preps as many scenes as the GM
// wants for the night; `name` is the scene's own short title, everything else is
// free text. Order in the array IS the intended run order.
const SESSION_SCENE_FIELDS = [
  'name', 'gmNote', 'cinematic', 'location', 'whoThere', 'moveItForward', 'dialog', 'skillChecks', 'bigClue',
];

// The record. `recap` is framed as read-aloud — two or three sentences you would
// actually say at the table — which is what keeps it player-appropriate. `clues`
// is deliberately separate from the recap: players forget what they were told.
const SESSION_RECORD_FIELDS = ['recap', 'happened', 'clues', 'loot'];

// Sessions reuse the LORE vocabulary rather than inventing a third one. This
// gates the RECORD only: prep is GM-only whatever this says, so the two decisions
// stay independent axes. Default `hidden`, so a half-written recap is never live.
const SESSION_VISIBILITY = ['shared', 'hidden'];
const DEFAULT_SESSION_VISIBILITY = 'hidden';

// Only the owning GM sees raw fog in a session, mirroring campaign prose. Fog
// still applies INSIDE the record: a shared recap can mention the ledger without
// naming who forged it.
function seesRawSessionFog(role) {
  return role === 'owner';
}

function sessionVisibility(session) {
  const v = session && session.visibility;
  return SESSION_VISIBILITY.includes(v) ? v : DEFAULT_SESSION_VISIBILITY;
}

// May this role see this session's RECORD at all? GM always; a player only once
// the GM has shared it. Fails closed on an unknown role.
function canSeeSession(session, role) {
  if (role === 'owner') return true;
  if (role !== 'player') return false;
  return sessionVisibility(session) === 'shared';
}

// Serialize ONE session for a role, or null if this role may not see it (the
// caller omits it from the list entirely — a player must not learn that a session
// they cannot read exists, the same reasoning as the 404 on campaign role).
//
// BOTH branches are allowlists. The owner branch is explicit too, so an unknown
// key hand-added to the sidecar cannot ride along into any payload.
function serializeSessionForRole(session, role) {
  if (!session || !CAMPAIGN_ROLES.includes(role)) return null;
  if (!canSeeSession(session, role)) return null;

  const raw    = seesRawSessionFog(role);
  const text   = v => (typeof v === 'string' ? v : '');
  const prose  = v => (raw ? text(v) : stripFog(text(v)));
  const group  = (src, keys) => {
    const out = {};
    for (const k of keys) out[k] = prose((src || {})[k]);
    return out;
  };

  // Shared by both roles. `number` is the spine; `inWorldDate` is GM-set only,
  // never inferred and never back-filled, so it passes through as stored.
  const base = {
    id:          session.id,
    number:      Number.isInteger(session.number) ? session.number : 0,
    title:       text(session.title),
    date:        session.date || null,
    inWorldDate: session.inWorldDate || null,
  };

  if (role !== 'owner') {
    // THE PLAYER SHAPE. Note what is absent by construction: scenes, nextTime,
    // cast, loreRefs, encounters, visibility. Do not "simplify" this into a
    // spread-and-delete — the whole guarantee is that scenes are never present.
    return { ...base, record: group(session.record, SESSION_RECORD_FIELDS) };
  }

  // Scenes are GM-only prep, reached only in this owner branch — there is no fog
  // to strip here (fog protects content players might otherwise see; nothing in
  // Prep ever reaches a player, so the raw text passes straight through, same
  // reasoning as `cast`/`loreRefs`/`encounters` below).
  const scenes = (Array.isArray(session.scenes) ? session.scenes : []).map(sc => {
    const out = {};
    for (const k of SESSION_SCENE_FIELDS) out[k] = text((sc || {})[k]);
    return out;
  });

  return {
    ...base,
    visibility: sessionVisibility(session),
    scenes,
    record:     group(session.record, SESSION_RECORD_FIELDS),
    nextTime:   prose(session.nextTime),
    cast:       Array.isArray(session.cast)     ? session.cast.slice()     : [],
    loreRefs:   Array.isArray(session.loreRefs) ? session.loreRefs.slice() : [],
    encounters: (Array.isArray(session.encounters) ? session.encounters : []).map(e => ({
      name:   text(e && e.name),
      notes:  prose(e && e.notes),
      status: (e && e.status) === 'run' ? 'run' : 'ready',
    })),
    createdAt: session.createdAt || null,
    updatedAt: session.updatedAt || null,
  };
}

// The whole log for a role: everything this role may see, ALWAYS ordered by
// number. Sessions a player may not see are dropped, not blanked.
function serializeSessionsForRole(sessions, role) {
  return (Array.isArray(sessions) ? sessions : [])
    .map(s => serializeSessionForRole(s, role))
    .filter(Boolean)
    .sort((a, b) => a.number - b.number);
}

// The overview's derived block, computed from what THIS role may see. A player
// counting every session — including ones the GM has not shared — would leak how
// much unpublished material exists, so the count is role-scoped too.
function sessionStatsForRole(sessions, role) {
  const visible = (Array.isArray(sessions) ? sessions : []).filter(s => canSeeSession(s, role));
  let lastPlayed = null;
  for (const s of visible) {
    if (typeof s.date === 'string' && s.date && (!lastPlayed || s.date > lastPlayed)) lastPlayed = s.date;
  }
  return { sessionCount: visible.length, lastPlayed };
}

module.exports = {
  // capability
  ROLES, ROLE_RANK, DEFAULT_ROLE, rankOf, isGM,
  canEditLore, canProposeEdits, canManageWorld,
  // secrecy
  VISIBILITY_STATES, DEFAULT_VISIBILITY, canSee,
  // fog
  seesRawFog, parseBody, stripFog, renderLink, serializeEntryForRole,
  // migration
  migrateRole, migrateVisibility,
  // campaigns (Wave A)
  CAMPAIGN_ROLES, CAMPAIGN_STATUSES, DEFAULT_CAMPAIGN_STATUS, CAMPAIGN_TEXT_FIELDS,
  seesRawCampaignFog, serializeCampaignForRole,
  // sessions (Wave B)
  SESSION_SCENE_FIELDS, SESSION_RECORD_FIELDS, SESSION_VISIBILITY,
  DEFAULT_SESSION_VISIBILITY, seesRawSessionFog, sessionVisibility,
  canSeeSession, serializeSessionForRole, serializeSessionsForRole,
  sessionStatsForRole,
};
