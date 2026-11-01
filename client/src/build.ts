// Reloads this tab once the server runs a newer build, so a page from before a deploy does not show
// new data formats as errors, such as reactions as messages it cannot decrypt (D-040).
import { BUILD_HEADER } from '../../shared/types';

let current: string | null = null;
let reloading = false;

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

const isTyping = () => {
  const el = document.activeElement;
  return el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement;
};

/** Reloads now unless someone is typing here, and then as soon as they stop or leave the tab. */
function reloadWhenIdle() {
  if (document.visibilityState === 'hidden' || !isTyping()) {
    location.reload();
    return;
  }
  const onIdle = () => {
    if (document.visibilityState !== 'hidden' && isTyping()) return;
    document.removeEventListener('visibilitychange', onIdle);
    document.removeEventListener('focusout', onFocusOut);
    location.reload();
  };
  // focusout fires before the focus moves, so look again on the next turn.
  const onFocusOut = () => setTimeout(onIdle, 0);
  document.addEventListener('visibilitychange', onIdle);
  document.addEventListener('focusout', onFocusOut);
}
