import { defineTheme } from '@astryxdesign/core/theme';

// Astryx tokens point at the D-083 variables in styles.css, so the palette still changes in one
// place and follows the page into dark mode.
export const webchatTheme = defineTheme({
  name: 'webchat',
  tokens: {
    '--color-accent': 'var(--accent)',
    '--color-on-accent': 'var(--on-accent)',
    '--color-accent-muted': 'var(--accent-soft)',
    '--color-text-accent': 'var(--accent)',
    '--focus-outline-color': 'var(--accent)',
    '--color-background-body': 'var(--bg)',
    '--color-background-surface': 'var(--panel)',
    '--color-background-card': 'var(--panel)',
    '--color-text-primary': 'var(--text)',
    '--color-text-secondary': 'var(--muted)',
    '--color-border': 'var(--line)',
    '--color-error': 'var(--danger)',
    '--color-info': 'var(--accent)',
    '--color-on-info': 'var(--on-accent)',
    '--color-success': 'var(--ok)',
    '--color-warning': 'var(--warn)',
    '--radius-inner': 'var(--radius)',
    '--radius-element': 'var(--radius)',
    '--radius-container': 'var(--radius)',
  },
});
