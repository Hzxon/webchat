import { StrictMode, useSyncExternalStore } from 'react';
import { createRoot } from 'react-dom/client';
import { Theme } from '@astryxdesign/core/theme';
import { App } from './App';
import { ConfirmHost } from './components/ConfirmHost';
import { webchatTheme } from './astryxTheme';
import { colorMode, subscribeColorMode } from './colorMode';
import { registerServiceWorker } from './push';
import './layers.css';
import '@astryxdesign/core/reset.css';
import '@astryxdesign/core/astryx.css';

void registerServiceWorker();

function Root() {
  // Always light or dark, never Astryx's 'system', which would remove the data-theme styles.css keys on.
  const mode = useSyncExternalStore(subscribeColorMode, colorMode);
  return (
    <Theme theme={webchatTheme} mode={mode}>
      <App />
      <ConfirmHost />
    </Theme>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
