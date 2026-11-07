// What the sidebar warns about while alerts cannot reach the user yet. Pure, so a test can run it
// without a browser.
import type { BarkDTO } from '../../shared/types';
import type { PushState } from './push';

/** At least one phone registered through the user's Bark link, so Bark alerts reach them (D-054). */
export function barkReaches(bark: BarkDTO | null | undefined): boolean {
  return (bark?.link?.devices.length ?? 0) > 0;
}

/**
 * Alerts can reach the user: the browser allows notifications or, on iOS before 16.4, where that
 * can never happen, a phone registered with Bark. A link with no phone yet still reaches nobody (K-1).
 */
export function alertsReady(push: PushState | null, bark: BarkDTO | null | undefined): boolean {
  return push?.permission === 'granted' || (Boolean(push?.oldIos) && barkReaches(bark));
}

/** The notification warning for the sidebar, or null when there is none to show. */
export function pushWarning(push: PushState | null, bark: BarkDTO | null | undefined): string | null {
  if (!push || alertsReady(push, bark)) return null;
  if (push.permission === 'denied') return 'Notifications are blocked for this site. Allow them in the browser’s site settings.';
  if (push.oldIos) return 'Notifications on iPhone need iOS 16.4. Tap to get alerts through the Bark app instead.';
  if (push.needsInstall) return 'On iPhone, add this site to your Home Screen to get notifications.';
  return 'Turn on notifications so urgent messages reach you when this tab is closed.';
}
