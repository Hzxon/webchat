// Fits the chat to the part of the screen that the on-screen keyboard leaves free (D-053).
//
// Safari on iPhone keeps the page at full height when the keyboard opens, and scrolls the page up
// until the focused field shows. The chat fills the screen, so that pushed its header off the top.
// The visual viewport is the part of the page still visible: the layout takes its height from it,
// and the page stays at the top. Sign-in pages scroll as usual, so only the chat layout does this.

/** Keeps the chat layout inside the visible part of the screen until the returned function runs. */
export function fitToVisualViewport(): () => void {
  const viewport = window.visualViewport;
  if (!viewport) return () => undefined;
  const root = document.documentElement;

  const fit = () => {
    // Pinch zoom also shrinks the visual viewport. A zoomed page keeps its height and can be panned.
    if (viewport.scale > 1.01) {
      root.style.removeProperty('--visible-height');
      return;
    }
    root.style.setProperty('--visible-height', `${viewport.height}px`);
    if (window.scrollX !== 0 || window.scrollY !== 0) window.scrollTo(0, 0);
  };

  fit();
  viewport.addEventListener('resize', fit);
  viewport.addEventListener('scroll', fit);
  window.addEventListener('scroll', fit);
  return () => {
    viewport.removeEventListener('resize', fit);
    viewport.removeEventListener('scroll', fit);
    window.removeEventListener('scroll', fit);
    root.style.removeProperty('--visible-height');
  };
}
