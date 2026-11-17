import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Theme } from '@astryxdesign/core/theme';
import { App } from './App';
import { webchatTheme } from './astryxTheme';
import { registerServiceWorker } from './push';
import './layers.css';
import '@astryxdesign/core/reset.css';
import '@astryxdesign/core/astryx.css';

// Astryx's tooltips and menus open, close and light-dismiss through the Popover API, which Safari
// gained in 17. The build supports iOS 15.4 (D-052), so older Safari loads a polyfill first.
if (!('showPopover' in HTMLElement.prototype)) await import('@oddbird/popover-polyfill');

void registerServiceWorker();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Theme theme={webchatTheme}>
      <App />
    </Theme>
  </StrictMode>,
);
