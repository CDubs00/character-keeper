// fog.js — the body-markup parser for lore entries (hand-rolled, pure JS, no dep,
// same spirit as diceParser.js).
//
// ONE parser tokenizes a body string into a flat stream of typed spans:
//   { type: 'text', text }                 — plain, render as escaped text
//   { type: 'fog',  text }                  — was inside ||…||, GM-only
//   { type: 'link', name, display }         — was inside [[…]] or [[name|display]]
//
// Both syntaxes are literal, visible in the textarea, and round-trip through JSON
// exactly — the "clear to a non-technical GM" ethos of the rest of the app.
//
//   The vault is guarded ||by a sleeping red dragon||. Ask [[Durnan]] about it.
//   Domains: [[Life Domain]], [[Light Domain|Light]].
//
// The core NEVER renders a body as HTML — callers walk these tokens and inject
// only chip/link spans around escaped text (stored-XSS guard for when players
// and collaborators can write lore).

// Tokenize a body string. Unmatched openers (`||` with no close, `[[` with no
// `]]`) are treated as literal text, so an author mid-typing never sees content
// vanish.
export function parseBody(input) {
  const text = typeof input === 'string' ? input : '';
  const tokens = [];
  let i = 0;
  let buf = '';                     // accumulates plain text between markers

  const flush = () => { if (buf) { tokens.push({ type: 'text', text: buf }); buf = ''; } };

  while (i < text.length) {
    const fog  = text.indexOf('||', i);
    const link = text.indexOf('[[', i);

    // Whichever marker comes first (and exists) wins this iteration.
    let next = -1;
    if (fog !== -1 && (link === -1 || fog < link)) next = fog;
    else if (link !== -1) next = link;

    if (next === -1) { buf += text.slice(i); break; }   // no more markers

    // Copy the plain run before the marker into the buffer.
    buf += text.slice(i, next);

    if (next === fog) {
      const close = text.indexOf('||', next + 2);
      if (close === -1) { buf += text.slice(next); break; }   // unmatched → literal
      flush();
      tokens.push({ type: 'fog', text: text.slice(next + 2, close) });
      i = close + 2;
    } else {
      const close = text.indexOf(']]', next + 2);
      if (close === -1) { buf += text.slice(next); break; }   // unmatched → literal
      const inner = text.slice(next + 2, close);
      const pipe  = inner.indexOf('|');
      const name    = (pipe === -1 ? inner : inner.slice(0, pipe)).trim();
      const display = (pipe === -1 ? inner : inner.slice(pipe + 1)).trim();
      if (!name) { buf += text.slice(next, close + 2); i = close + 2; continue; } // empty [[]] → literal
      flush();
      tokens.push({ type: 'link', name, display: display || name });
      i = close + 2;
    }
  }

  flush();
  if (tokens.length === 0) tokens.push({ type: 'text', text: '' });
  return tokens;
}

// Back-compat alias — some callers historically imported parseFog.
export const parseFog = parseBody;

// remarkKeep — a remark (markdown) plugin that teaches react-markdown our two
// custom, non-markdown syntaxes: ||fog|| and [[wiki links]].
//
// Why a plugin and not post-processing the rendered HTML: the whole app renders
// lore as *React nodes*, never `dangerouslySetInnerHTML`. react-markdown already
// turns clean markdown (bold, lists, headings, tables via remark-gfm) into React
// nodes safely; this plugin runs during that same pass and converts our fog/link
// runs into custom nodes the caller maps to real components. So one pipeline
// handles all three families — markdown + fog + wiki — with zero raw-HTML.
//
// How it works: after markdown is parsed into its tree, we walk it depth-first
// and rewrite each parent's inline children with a small state machine.
//   • `[[wiki]]` always lives inside a single text node → tokenized in place.
//   • `||fog||` is a PAIRED delimiter that may span siblings — crucially so it
//     can wrap an inline image: `||![alt](url)||` parses to three siblings
//     (text "||", image, text "||"), and the machine collects everything between
//     the opening and closing `||` (image included) into one fog node. So fog
//     wraps text, emphasis, AND images uniformly.
// Code spans are separate `inlineCode` nodes with no child text, so `||notfog||`
// inside backticks is never touched (stays literal — verified).
//
// Fog/link runs become nodes carrying `data.hName` (the element react-markdown
// emits: <fog>/<wikilink>) plus `hProperties` for a link's target name. The
// caller supplies `components={{ fog, wikilink }}` to render them. No new
// dependency and no `unist-util-visit` — a tiny hand-rolled recursion, same
// "pure JS, no dep" ethos as diceParser.js / parseBody itself.
export function remarkKeep() {
  return (tree) => process(tree);
}

// Depth-first: transform descendants first (so `||*emph*||` sees the emphasis
// node as a single sibling to wrap), then this node's own children.
function process(node) {
  if (!node || !Array.isArray(node.children)) return;
  for (const child of node.children) process(child);
  node.children = transform(node.children);
}

function makeFog(children) {
  return {
    type: 'keepFog',
    data: { hName: 'fog' },
    children: children.length ? children : [{ type: 'text', value: '' }],
  };
}

// Split a string on the `||` delimiter, preserving the delimiter as a marker so
// the state machine can open/close fog regions. Single `|` (used by
// `[[name|display]]`) is untouched — only the doubled pipe delimits fog.
function splitPipes(str) {
  const parts = [];
  let i = 0;
  for (;;) {
    const idx = str.indexOf('||', i);
    if (idx === -1) { parts.push({ pipe: false, value: str.slice(i) }); break; }
    parts.push({ pipe: false, value: str.slice(i, idx) });
    parts.push({ pipe: true });
    i = idx + 2;
  }
  return parts;
}

// Tokenize a pipe-free text run into text + wiki-link nodes (parseBody sees no
// `||` here, so it only ever yields text/link tokens).
function linkNodes(str) {
  const out = [];
  for (const tok of parseBody(str)) {
    if (tok.type === 'link') {
      out.push({
        type: 'keepLink',
        data: { hName: 'wikilink', hProperties: { linkname: tok.name } },
        children: [{ type: 'text', value: tok.display }],
      });
    } else {
      out.push({ type: 'text', value: tok.text });
    }
  }
  return out;
}

function transform(children) {
  const out = [];
  let fog = null; // an array of collected nodes while a fog region is open
  const push = (n) => { (fog !== null ? fog : out).push(n); };

  for (const child of children) {
    const isText = child.type === 'text' && typeof child.value === 'string';
    if (isText && child.value.includes('||')) {
      for (const part of splitPipes(child.value)) {
        if (part.pipe) {
          if (fog === null) fog = [];                 // opening ||
          else { out.push(makeFog(fog)); fog = null; } // closing ||
        } else if (part.value) {
          for (const n of linkNodes(part.value)) push(n);
        }
      }
    } else if (isText && child.value.includes('[[')) {
      for (const n of linkNodes(child.value)) push(n);
    } else {
      push(child);
    }
  }

  // Unmatched opener: no closing ||, so the region was never fog — emit the
  // literal `||` and its contents so nothing an author typed silently vanishes.
  if (fog !== null) {
    out.push({ type: 'text', value: '||' });
    for (const n of fog) out.push(n);
  }
  return out;
}

// Re-emit a link token exactly as it was authored. A display alias that matches
// the name collapses to the short form, so a round-trip through stripFog is
// byte-identical for the common case.
export function renderLink(t) {
  return (t.display && t.display !== t.name)
    ? `[[${t.name}|${t.display}]]`
    : `[[${t.name}]]`;
}

// The text a read/propose-tier PLAYER receives: fogged spans removed entirely
// (dropped whole so length can't leak the hidden text), links PRESERVED as authored
// — a link the GM chose not to fog is meant to be followed, and its target is gated
// separately by canSee when the player navigates. A link INSIDE fog is dropped with
// the fog, because parseBody sees the `||` opener first and swallows the whole span.
//
// The live enforcement copy is backend/loreAccess.js stripFog, which the server
// applies in serializeEntryForRole before any non-owner response. This copy is the
// audited reference the two are kept in sync against; both have unit tests.
export function stripFog(input) {
  return parseBody(input)
    .filter(t => t.type !== 'fog')
    .map(t => (t.type === 'link' ? renderLink(t) : t.text))
    .join('');
}
