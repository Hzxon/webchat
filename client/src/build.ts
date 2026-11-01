// Reloads this tab once the server runs a newer build, so a page from before a deploy does not show
// new data formats as errors, such as reactions as messages it cannot decrypt (D-040).
import { BUILD_HEADER } from '../../shared/types';

let current: string | null = null;
let reloading = false;
const holds = new Set<() => boolean>();
/** Where the reload lands. The chat module points it at what is open, so the user keeps their place. */
let target: () => string = () => '/';
/** A reload waits until nobody has pressed a key, clicked, touched or scrolled for this long. */
const QUIET_MS = 30_000;

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

/** Sets where a reload lands, such as the chat that is open. Returns the function that resets it. */
export function setReloadTarget(where: () => string): () => void {
  target = where;
  return () => {
    target = () => '/';
  };
}

const ACTIVITY = ['keydown', 'pointerdown', 'wheel', 'touchstart'] as const;

/**
 * Reloads once nothing would be lost: no draft, no message still sending or not sent, no urgent
 * alert waiting to be dismissed, and a tab that is hidden or that nobody has used for a while. It
 * never fires on a click, which the reload would swallow, and it lands where the user was.
 */
function reloadWhenIdle() {
  let lastActive = Date.now();
  const onActivity = () => {
    lastActive = Date.now();
  };
  const tryReload = () => {
    if ([...holds].some((check) => check())) return;
    if (document.visibilityState !== 'hidden' && Date.now() - lastActive < QUIET_MS) return;
    document.removeEventListener('visibilitychange', tryReload);
    for (const type of ACTIVITY) window.removeEventListener(type, onActivity, true);
    clearInterval(timer);
    location.replace(target());
  };
  for (const type of ACTIVITY) window.addEventListener(type, onActivity, { capture: true, passive: true });
  // A hold can end, and the tab go quiet, without any event, for example when a send finishes.
  const timer = setInterval(tryReload, 5000);
  document.addEventListener('visibilitychange', tryReload);
  tryReload();
}
