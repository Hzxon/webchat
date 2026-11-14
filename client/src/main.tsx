import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Theme } from '@astryxdesign/core/theme';
import { App } from './App';
import { webchatTheme } from './astryxTheme';
import { registerServiceWorker } from './push';
import './layers.css';
import '@astryxdesign/core/reset.css';
import '@astryxdesign/core/astryx.css';

void registerServiceWorker();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Theme theme={webchatTheme}>
      <App />
    </Theme>
  </StrictMode>,
);
