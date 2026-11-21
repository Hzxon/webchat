import { useEffect, type ReactNode } from 'react';
import { Theme } from '@astryxdesign/core/theme';
import { webchatTheme } from '../../../client/src/astryxTheme';

/**
 * WebChat's look around the board's parts: the warm neutrals and the one orange accent, in light or
 * dark. Every part must sit inside one, or it renders with Astryx's own colors and corners.
 */
export function BoardTheme({ mode = 'light', children }: { mode?: 'light' | 'dark'; children: ReactNode }) {
  // The app's stylesheet keys its dark palette on the page's data-theme, as client/src/colorMode.ts sets it.
  useEffect(() => {
    document.documentElement.dataset.theme = mode;
  }, [mode]);
  return (
    <Theme theme={webchatTheme} mode={mode}>
      {children}
    </Theme>
  );
}
