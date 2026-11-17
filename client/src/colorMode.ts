export type ColorChoice = 'system' | 'light' | 'dark';

const KEY = 'webchat.theme';
const systemDark = matchMedia('(prefers-color-scheme: dark)');
const listeners = new Set<() => void>();

function remembered(): ColorChoice {
  try {
    const value = localStorage.getItem(KEY);
    return value === 'light' || value === 'dark' ? value : 'system';
  } catch {
    return 'system';
  }
}

let choice = remembered();

export const colorChoice = () => choice;

/** The mode the page paints. styles.css keys its dark palette on `data-theme`, which Astryx's root Theme sets too. */
export const colorMode = (): 'light' | 'dark' =>
  choice === 'system' ? (systemDark.matches ? 'dark' : 'light') : choice;

export function subscribeColorMode(listener: () => void) {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

function apply() {
  // Set here as well as by Astryx, whose Theme sets it only in an effect after the first paint.
  document.documentElement.dataset.theme = colorMode();
  for (const listener of listeners) listener();
}

export function setColorChoice(next: ColorChoice) {
  choice = next;
  try {
    if (next === 'system') localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, next);
  } catch {
    // A private window follows the choice until it closes.
  }
  apply();
}

systemDark.addEventListener('change', apply);
apply();
