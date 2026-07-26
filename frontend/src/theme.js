// App-chrome themes. Each preset overrides a handful of variables on :root;
// anything a preset does NOT list falls back to the index.css defaults, so
// contrast stays safe across themes. Per-bundle sheet themes (theme.css) are
// unaffected — this only restyles the app shell.
//
// Themes may override FONT variables too (--font-display / --font-body /
// --font-mono), not just colors. The faces themselves are declared once in
// index.css via @font-face; a theme just points a font variable at one. A face
// the active theme doesn't reference is never downloaded, so parking several
// display fonts here is free until one is selected.

export const THEMES = {
  tavern: {
    label: 'Tavern',
    vars: {
      '--bg-deep': '#0e0d0b', '--bg-surface': '#161410', '--bg-raised': '#1e1b16', '--bg-input': '#252119',
      '--border': '#3a3428', '--border-bright': '#5a5040',
      '--accent': '#c8922a', '--accent-dim': '#8a6018', '--accent-glow': 'rgba(200,146,42,0.15)',
      '--text-accent': '#d4a84a',
    },
  },
  arcane: {
    label: 'Arcane',
    vars: {
      '--bg-deep': '#0b0b12', '--bg-surface': '#131320', '--bg-raised': '#1b1b2c', '--bg-input': '#222236',
      '--border': '#2f2f45', '--border-bright': '#4a4a68',
      '--accent': '#8a6ad0', '--accent-dim': '#5a44a0', '--accent-glow': 'rgba(138,106,208,0.18)',
      '--text-accent': '#b49ce8',
    },
  },
  verdant: {
    label: 'Verdant',
    vars: {
      '--bg-deep': '#0a0e0b', '--bg-surface': '#121712', '--bg-raised': '#1a201a', '--bg-input': '#202820',
      '--border': '#2c382c', '--border-bright': '#46584a',
      '--accent': '#5a9a55', '--accent-dim': '#3c6a3a', '--accent-glow': 'rgba(90,154,85,0.18)',
      '--text-accent': '#86c47e',
    },
  },
  ember: {
    label: 'Ember',
    vars: {
      '--bg-deep': '#120a08', '--bg-surface': '#1c1210', '--bg-raised': '#261815', '--bg-input': '#301e1a',
      '--border': '#43302a', '--border-bright': '#6a4a40',
      '--accent': '#d06038', '--accent-dim': '#9a4020', '--accent-glow': 'rgba(208,96,56,0.18)',
      '--text-accent': '#e8906a',
    },
  },
  frost: {
    label: 'Frost',
    vars: {
      '--bg-deep': '#080c10', '--bg-surface': '#10161c', '--bg-raised': '#172029', '--bg-input': '#1d2832',
      '--border': '#2a3742', '--border-bright': '#445463',
      '--accent': '#4a90c0', '--accent-dim': '#2c6090', '--accent-glow': 'rgba(74,144,192,0.18)',
      '--text-accent': '#86bce0',
    },
  },
  grey: {
    label: 'In The Grey',
    vars: {
      '--bg-deep': '#0d0d0e', '--bg-surface': '#151517', '--bg-raised': '#1d1d20', '--bg-input': '#252529',
      '--border': '#383840', '--border-bright': '#565660',
      '--accent': '#9a9aa4', '--accent-dim': '#62626c', '--accent-glow': 'rgba(154,154,164,0.16)',
      '--text-accent': '#c4c4cc',
    },
  },
  parchment: {
    label: 'Parchment',
    vars: {
      '--bg-deep':      '#1a2028', '--bg-surface':  '#232A33', '--bg-raised': '#2d3d4e', '--bg-input': '#232A33',
      '--border':       '#c4a87a', '--border-bright':'#c97b2b',
      '--accent':       '#c97b2b', '--accent-dim': '#8a5218', '--accent-glow':  'rgba(201,123,43,0.18)',
      '--text-accent':  '#a35e18',
    },
  },

  rose: {
    label: 'Rose',
    vars: {
      '--bg-deep': '#120a0d', '--bg-surface': '#1c1015', '--bg-raised': '#27161d', '--bg-input': '#311c24',
      '--border': '#4a2a36', '--border-bright': '#7a4458',
      '--accent': '#c8607a', '--accent-dim': '#8a3a50', '--accent-glow': 'rgba(200,96,122,0.18)',
      '--text-accent': '#e8909e',
    },
  },

  // Neon-noir: near-black blue-violet base, cyan structure, hot-magenta accent.
  // Glow is pushed high so surfaces bloom. Status tokens go synthetic so even
  // the lore pills read cyberpunk instead of falling back to the earthy defaults.
  // Type carries the theme too: Cyberpunks (a decorative display face) on all
  // headings, Share Tech Mono for body copy so paragraphs read like a terminal
  // readout. --font-mono already IS Share Tech Mono, so no override needed there.
  cyberpunk: {
    label: 'Cyberpunk',
    vars: {
      '--bg-deep': '#07060d', '--bg-surface': '#0f0d1a', '--bg-raised': '#171325', '--bg-input': '#1e1830',
      '--border': '#2a2450', '--border-bright': '#00e5ff',
      '--accent': '#ff2d95', '--accent-dim': '#b01466', '--accent-glow': 'rgba(0,229,255,0.28)',
      '--text-accent': '#5cf0ff',
      '--text-primary': '#e6e2ff', '--text-secondary': '#899adc',
      '--positive': '#2ee6a0', '--neutral': '#6d6a9a', '--danger': '#ff3b5c',
      '--font-display': "'Cyberpunks', 'Orbitron', 'Cinzel', serif",
      '--font-body':    "'Share Tech Mono', monospace",
    },
  },

  // Dust-bowl frontier: base is lifted and desaturated toward faded sun-baked
  // tan-grey (reads BLEACHED where Tavern reads rich), accent is barn-red /
  // dried clay — nowhere near Tavern's gold. Matte (glow near-zero — Western is
  // baked, not lit). Status tokens sit in the same dust palette. Rye is the
  // display face: an Old-West letterpress look that stays legible at the small
  // heading sizes the display slot also covers (Smokum is too heavy for that —
  // see the note in the response about reserving it for a hero title).
  western: {
    label: 'Western',
    vars: {
      '--bg-deep': '#171009', '--bg-surface': '#221a11', '--bg-raised': '#2e241a', '--bg-input': '#372c20',
      '--border': '#544234', '--border-bright': '#7a6450',
      '--accent': '#b0492e', '--accent-dim': '#7c301c', '--accent-glow': 'rgba(176,73,46,0.09)',
      '--text-accent': '#d07a52',
      '--text-primary': '#ece2cf', '--text-secondary': '#b6a488', '--text-dim': '#8a7860',
      '--positive': '#8a9556', '--neutral': '#6e5c44', '--danger': '#c04030',
      '--font-display': "'Rye', 'Cinzel', serif",
    },
  },

};

// The union of every custom property ANY theme sets. We clear all of these
// before applying a preset (below) so switching FROM a rich theme (cyberpunk /
// western set fonts + extra status tokens) TO a lean one (tavern sets only a
// few colors) doesn't leave the previous theme's extras stuck as inline styles
// on <html>. Computed once at module load.
const ALL_THEME_VARS = [...new Set(
  Object.values(THEMES).flatMap((t) => Object.keys(t.vars)),
)];

// Write a preset's variables onto :root. Inline custom-property values on the
// root element win over the stylesheet :root block.
//
// Reset-then-apply: first strip every var any theme could have set (so unlisted
// vars fall back to the index.css defaults), then write this preset's overrides.
// Falls back to 'tavern' for an unknown key.
export function applyTheme(key) {
  const preset = THEMES[key] || THEMES.tavern;   // lowercase key — 'Tavern' was a no-op
  const root = document.documentElement;
  for (const name of ALL_THEME_VARS) root.style.removeProperty(name);
  for (const [name, value] of Object.entries(preset.vars)) {
    root.style.setProperty(name, value);
  }
}
