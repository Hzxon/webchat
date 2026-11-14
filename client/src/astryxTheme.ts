import { defineTheme } from '@astryxdesign/core/theme';

// Astryx tokens point at the D-083 variables in styles.css, so the palette still changes in one
// place and follows the page into dark mode.
export const webchatTheme = defineTheme({
  name: 'webchat',
  tokens: {
    '--color-accent': 'var(--accent)',
    '--color-on-accent': 'var(--on-accent)',
    '--focus-outline-color': 'var(--accent)',
    '--color-background-body': 'var(--bg)',
    '--color-background-surface': 'var(--panel)',
    '--color-background-card': 'var(--panel)',
    '--color-text-primary': 'var(--text)',
    '--color-text-secondary': 'var(--muted)',
    '--color-border': 'var(--line)',
    '--color-error': 'var(--danger)',
    '--radius-inner': 'var(--radius)',
    '--radius-element': 'var(--radius)',
    '--radius-container': 'var(--radius)',
  },
  // Astryx's reset is left out (layers.css), so the browser's h1 margin would push the tagline down.
  components: { heading: { base: { margin: '0' } } },
});
