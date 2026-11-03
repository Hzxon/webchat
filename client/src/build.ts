// Reloads this tab once the server runs a newer build, so a page from before a deploy does not show
// new data formats as errors, such as reactions as messages it cannot decrypt (D-040).
import { BUILD_HEADER } from '../../shared/types';

let current: string | null = null;
/** Set while a new build's page is checked, and for good once the page differs. */
let checking = false;
const holds = new Set<() => boolean>();
/** Where the reload lands. The chat module points it at what is open, so the user keeps their place. */
let target: () => string = () => '/';
/** A reload waits until nobody has pressed a key, clicked, touched or scrolled for this long. */
const QUIET_MS = 30_000;

/** Called with every API response. The first build seen is the one this page belongs to. */
export function noteBuild(response: Response) {
  const build = response.headers.get(BUILD_HEADER);
  if (!build || build === current || checking) return;
  if (current === null) {
    current = build;
    return;
  }
  // A deploy of the server or the docs alone hands out the same page, and a reload would only
  // lose the user's place (K-36). A page that fails to load is checked again on the next answer.
  checking = true;
  pageChanged()
    .then((changed) => {
      if (changed) {
        reloadWhenIdle();
        return;
      }
      current = build;
      checking = false;
      // The service worker can change without the page, and the reload no longer fetches it.
      return navigator.serviceWorker?.getRegistration().then((registration) => registration?.update());
    })
    .catch(() => {
      checking = false;
    });
}

/** Vite names every bundle file after its contents, under /assets/. */
const bundleFiles = (html: string) => new Set(html.match(/\/assets\/[\w.-]+/g));

/**
 * Whether the page the server hands out now loads a bundle file that this page did not. A page
 * without bundle files counts as changed, so a new build layout reloads rather than never does.
 */
async function pageChanged(): Promise<boolean> {
  const res = await fetch('/', { cache: 'no-store' });
  if (!res.ok) throw new Error(`The page answered ${res.status}.`);
  const here = bundleFiles(document.head.innerHTML);
  const fresh = bundleFiles(await res.text());
  return fresh.size === 0 || [...fresh].some((file) => !here.has(file));
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
