// Reloads this tab once the server runs a newer build, so a page from before a deploy does not show
// new data formats as errors, such as reactions as messages it cannot decrypt (D-040).
import { BUILD_HEADER } from '../../shared/types';

let current: string | null = null;
let reloading = false;
const holds = new Set<() => boolean>();

/** Called with every API response. The first build seen is the one this page belongs to. */
export function noteBuild(response: Response) {
  const build = response.headers.get(BUILD_HEADER);
  if (!build || reloading) return;
  if (current === null) {
    current = build;
    return;
  }
  if (build === current) return;
  reloading = true;
  reloadWhenIdle();
}

/**
 * Holds off the reload while `check` says a reload would lose something that lives only in this
 * page, such as a draft. Returns the function that ends the hold.
 */
export function holdReloadWhile(check: () => boolean): () => void {
  holds.add(check);
  return () => {
    holds.delete(check);
  };
}

const isTyping = () => {
  const el = document.activeElement;
  return el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement;
};

/**
 * Reloads once nothing would be lost: no draft, no message still sending or not sent, no urgent
 * alert waiting to be dismissed, and nobody typing in a tab they are looking at. Focus alone is not
 * enough: a hidden tab can hold a draft, and a ringing alert has a button in focus.
 */
function reloadWhenIdle() {
  const tryReload = () => {
    if ([...holds].some((check) => check())) return;
    if (document.visibilityState !== 'hidden' && isTyping()) return;
    document.removeEventListener('visibilitychange', tryReload);
    document.removeEventListener('focusout', onFocusOut);
    clearInterval(timer);
    location.reload();
  };
  // focusout fires before the focus moves, so look again on the next turn.
  const onFocusOut = () => setTimeout(tryReload, 0);
  // A hold can end without any focus or visibility change, for example when a send finishes.
  const timer = setInterval(tryReload, 5000);
  document.addEventListener('visibilitychange', tryReload);
  document.addEventListener('focusout', onFocusOut);
  tryReload();
}
