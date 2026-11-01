// Fits the chat to the part of the screen that the on-screen keyboard leaves free (D-053).
//
// Safari on iPhone keeps the page at full height when the keyboard opens, and scrolls the page up
// until the focused field shows. The chat fills the screen, so that pushed its header off the top.
// The visual viewport is the part of the page still visible: the layout takes its height from it,
// and the page stays at the top. Sign-in pages scroll as usual, so only the chat layout does this.

/** Fields that open the on-screen keyboard. */
const TYPING_FIELDS = 'textarea, input:not([type="checkbox"]):not([type="radio"])';
/** How long a field may stay lifted when no keyboard opens, such as with a hardware keyboard. */
const LIFT_MS = 400;

/** Keeps the chat layout inside the visible part of the screen until the returned function runs. */
export function fitToVisualViewport(): () => void {
  const viewport = window.visualViewport;
  if (!viewport) return () => undefined;
  const root = document.documentElement;

  // Safari animates its scroll to the focused field, and resetting the scroll midway made the page
  // drop and slide back up. So a field that takes the focus while the keyboard is closed is moved
  // far above the screen first, which leaves Safari nothing to scroll to. It comes back once the
  // layout has shrunk to fit above the keyboard.
  let lifted: HTMLElement | null = null;
  let liftTimer = 0;
  const putBack = () => {
    window.clearTimeout(liftTimer);
    lifted?.style.removeProperty('transform');
    lifted = null;
  };
  const lift = (event: FocusEvent) => {
    const field = event.target;
    const keyboardOpen = viewport.height < root.clientHeight - 100;
    if (!(field instanceof HTMLElement) || !field.matches(TYPING_FIELDS) || keyboardOpen) return;
    if (!window.matchMedia('(hover: none)').matches) return;
    putBack();
    lifted = field;
    field.style.transform = 'translateY(-99999px)';
    liftTimer = window.setTimeout(putBack, LIFT_MS);
  };

  const fit = () => {
    putBack();
    // Pinch zoom also shrinks the visual viewport. A zoomed page keeps its height and can be panned.
    if (viewport.scale > 1.01) {
      root.style.removeProperty('--visible-height');
      return;
    }
    root.style.setProperty('--visible-height', `${viewport.height}px`);
    if (window.scrollX !== 0 || window.scrollY !== 0) window.scrollTo(0, 0);
  };

  fit();
  document.addEventListener('focusin', lift);
  viewport.addEventListener('resize', fit);
  viewport.addEventListener('scroll', fit);
  window.addEventListener('scroll', fit);
  return () => {
    document.removeEventListener('focusin', lift);
    viewport.removeEventListener('resize', fit);
    viewport.removeEventListener('scroll', fit);
    window.removeEventListener('scroll', fit);
    putBack();
    root.style.removeProperty('--visible-height');
  };
}
