// Tracks whether the user is looking at this tab right now: visible, focused, and active in the
// last two minutes. The server uses it to decide between an in-app alert and a push notification,
// so a user who walked away from the desk still gets the push on their phone.

const IDLE_AFTER_MS = 2 * 60_000;

let lastInputAt = Date.now();
let attentive = compute();
const listeners = new Set<(attentive: boolean) => void>();

function compute(): boolean {
  return document.visibilityState === 'visible' && document.hasFocus() && Date.now() - lastInputAt < IDLE_AFTER_MS;
}

function update() {
  const next = compute();
  if (next === attentive) return;
  attentive = next;
  for (const listener of listeners) listener(attentive);
}

function onInput() {
  lastInputAt = Date.now();
  update();
}

for (const event of ['pointerdown', 'pointermove', 'keydown', 'wheel', 'touchstart'] as const) {
  window.addEventListener(event, onInput, { passive: true, capture: true });
}
window.addEventListener('focus', onInput);
window.addEventListener('blur', update);
document.addEventListener('visibilitychange', () => (document.visibilityState === 'visible' ? onInput() : update()));
setInterval(update, 10_000);

export const attention = {
  isAttentive: () => attentive,
  subscribe(listener: (attentive: boolean) => void) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
};
