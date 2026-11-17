import type { BarkDTO } from '../../shared/types';
import type { PushState } from './push';

/** The sidebar's notification warning, or null when this browser needs none. */
export function notificationWarning(
  push: Pick<PushState, 'permission' | 'oldIos' | 'needsInstall'>,
  bark: BarkDTO | null,
): string | null {
  if (push.permission === 'granted') return null;
  if (push.permission === 'denied')
    return 'Notifications are blocked for this site. Allow them in the browser’s site settings.';
  // No Web Push here, so permission never changes: a phone that registered in Bark gets the alerts (D-054).
  if (push.oldIos && bark?.link?.devices.length) return null;
  if (push.oldIos)
    return 'Notifications on iPhone need iOS 16.4. Tap to get alerts through the Bark app instead.';
  if (push.needsInstall) return 'On iPhone, add this site to your Home Screen to get notifications.';
  return 'Turn on notifications so urgent messages reach you when this tab is closed.';
}

/** The warning to show, unless this device closed that same one; a different warning shows again. */
export const shownWarning = (warning: string | null, dismissed: string | null) =>
  warning === dismissed ? null : warning;
