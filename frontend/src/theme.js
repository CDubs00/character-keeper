// App-chrome themes. Each preset overrides a handful of color variables on
// :root; everything not listed (text-primary, red, green, fonts, radius…) keeps
// the index.css defaults, so contrast stays safe across themes. Per-bundle sheet
// themes (theme.css) are unaffected — this only restyles the app shell.

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
  
};

// Write a preset's variables onto :root. Inline custom-property values on the
// root element win over the stylesheet :root block. Falls back to 'tavern'.
export function applyTheme(key) {
  const preset = THEMES[key] || THEMES.Tavern;
  const root = document.documentElement;
  for (const [name, value] of Object.entries(preset.vars)) {
    root.style.setProperty(name, value);
  }
}
