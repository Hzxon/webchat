// In-page alerts: sounds made with Web Audio (no audio files), the tab title, the favicon dot,
// and the app badge of an installed app.

const SOUND_KEY = 'webchat.sound';

function readSoundPref(): boolean {
  try {
    return localStorage.getItem(SOUND_KEY) !== 'off';
  } catch {
    return true;
  }
}

let soundOn = readSoundPref();
let context: AudioContext | null = null;
const soundListeners = new Set<() => void>();

function audio(): AudioContext | null {
  if (!context && typeof AudioContext !== 'undefined') context = new AudioContext();
  return context;
}

function notifySound() {
  for (const listener of soundListeners) listener();
}

// Browsers keep audio locked until the user interacts with the page once.
function unlock() {
  const ctx = audio();
  if (ctx && ctx.state !== 'running') {
    void ctx.resume().then(notifySound);
  }
}
for (const event of ['pointerdown', 'keydown', 'touchstart'] as const) {
  window.addEventListener(event, unlock, { capture: true });
}

function tone(frequency: number, start: number, duration: number, volume: number) {
  const ctx = audio();
  if (!ctx) return;
  const oscillator = ctx.createOscillator();
  const gain = ctx.createGain();
  oscillator.type = 'sine';
  oscillator.frequency.value = frequency;
  const at = ctx.currentTime + start;
  gain.gain.setValueAtTime(0.0001, at);
  gain.gain.exponentialRampToValueAtTime(volume, at + 0.015);
  gain.gain.exponentialRampToValueAtTime(0.0001, at + duration);
  oscillator.connect(gain).connect(ctx.destination);
  oscillator.start(at);
  oscillator.stop(at + duration + 0.05);
}

let ringTimer: ReturnType<typeof setInterval> | undefined;

function ringOnce() {
  // A phone-like double burst, louder and longer than the message sound.
  for (const offset of [0, 0.45]) {
    for (let i = 0; i < 6; i++) {
      tone(i % 2 ? 960 : 760, offset + i * 0.06, 0.07, 0.35);
    }
  }
}

export const sound = {
  enabled: () => soundOn,
  /** False until the user has clicked or typed on the page once. */
  unlocked: () => context?.state === 'running',
  setEnabled(enabled: boolean) {
    soundOn = enabled;
    try {
      localStorage.setItem(SOUND_KEY, enabled ? 'on' : 'off');
    } catch {
      // Private mode: the choice lasts until reload.
    }
    notifySound();
  },
  subscribe(listener: () => void) {
    soundListeners.add(listener);
    return () => soundListeners.delete(listener);
  },
  message() {
    if (!soundOn) return;
    tone(880, 0, 0.12, 0.25);
    tone(1320, 0.1, 0.18, 0.2);
  },
  startRinging() {
    if (ringTimer) return;
    // Urgent messages ring even with message sounds off: missing them is the problem this app solves.
    ringOnce();
    ringTimer = setInterval(ringOnce, 2500);
  },
  stopRinging() {
    clearInterval(ringTimer);
    ringTimer = undefined;
  },
};

const BASE_TITLE = 'WebChat';
let titleTimer: ReturnType<typeof setInterval> | undefined;

/** Puts the unread count in the tab title and favicon. An urgent message makes the title flash. */
export function showUnreadInTab(unread: number, urgentFrom: string | null) {
  const plain = unread > 0 ? `(${unread}) ${BASE_TITLE}` : BASE_TITLE;
  clearInterval(titleTimer);
  titleTimer = undefined;
  document.title = plain;
  if (urgentFrom) {
    let flip = false;
    const flash = () => {
      flip = !flip;
      document.title = flip ? `URGENT: ${urgentFrom}` : plain;
    };
    flash();
    titleTimer = setInterval(flash, 1000);
  }

  const favicon = document.getElementById('favicon') as HTMLLinkElement | null;
  const href = unread > 0 || urgentFrom ? '/favicon-unread.svg' : '/favicon.svg';
  if (favicon && favicon.getAttribute('href') !== href) favicon.setAttribute('href', href);

  if ('setAppBadge' in navigator) {
    const badge = unread > 0 ? navigator.setAppBadge(unread) : navigator.clearAppBadge();
    badge.catch(() => undefined);
  }
}
