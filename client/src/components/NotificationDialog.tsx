import { useState, useSyncExternalStore } from 'react';
import { sound } from '../alerts';
import { api } from '../api';
import { refreshPushState } from '../chat';
import { disablePushHere, enableNotifications } from '../push';
import { useAppState } from '../store';
import { Dialog } from './Dialog';
import { VolumeIcon } from './icons';

export function NotificationDialog({ onClose }: { onClose: () => void }) {
  const push = useAppState((s) => s.push);
  const soundOn = useSyncExternalStore(sound.subscribe, sound.enabled);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');

  async function act(work: () => Promise<unknown>) {
    setBusy(true);
    setNote('');
    try {
      await work();
    } catch (err) {
      setNote((err as Error).message);
    } finally {
      await refreshPushState();
      setBusy(false);
    }
  }

  const permissionText = {
    granted: 'Allowed',
    denied: 'Blocked',
    default: 'Not asked yet',
    unsupported: 'Not supported in this browser',
  }[push?.permission ?? 'default'];

  return (
    <Dialog title="Notifications" onClose={onClose}>
      <p className="dialog-intro">
        New messages show up instantly while this tab is open. With push turned on, they also reach this device when the
        tab or browser window is closed.
      </p>

      <dl className="settings">
        <div>
          <dt>Browser permission</dt>
          <dd className={push?.permission === 'granted' ? 'ok' : 'warn'}>{permissionText}</dd>
        </div>
        <div>
          <dt>Push on this device</dt>
          <dd className={push?.subscribed ? 'ok' : 'warn'}>
            {push?.subscribed ? 'On' : push?.pushSupported ? 'Off' : 'Not available'}
          </dd>
        </div>
      </dl>

      {push?.needsInstall && (
        <p className="callout">
          On iPhone and iPad, push works only from the Home Screen app. In Safari, tap Share, then “Add to Home Screen”,
          and open WebChat from there.
        </p>
      )}
      {push?.permission === 'denied' && (
        <p className="callout">
          This browser blocked notifications for this site. Click the icon left of the address bar, set Notifications
          to Allow, then reload the page.
        </p>
      )}

      <div className="dialog-actions">
        {push?.permission !== 'denied' && !push?.subscribed && (
          <button className="button-primary" disabled={busy} onClick={() => void act(enableNotifications)}>
            Turn on notifications
          </button>
        )}
        {push?.subscribed && (
          <>
            <button
              className="button-primary"
              disabled={busy}
              onClick={() =>
                void act(async () => {
                  const { sent, failed } = await api.testPush();
                  setNote(
                    sent > 0
                      ? `Test sent to ${sent} device${sent === 1 ? '' : 's'}${failed ? ` (${failed} failed)` : ''}.`
                      : 'No device accepted the test. Try turning push off and on again.',
                  );
                })
              }
            >
              Send a test notification
            </button>
            <button className="button-secondary" disabled={busy} onClick={() => void act(disablePushHere)}>
              Turn off on this device
            </button>
          </>
        )}
      </div>
      {note && <p className="dialog-note">{note}</p>}

      <label className="toggle-row">
        <VolumeIcon />
        <span>
          <strong>Message sounds</strong>
          <small>Urgent messages always ring, even with this off.</small>
        </span>
        <input type="checkbox" checked={soundOn} onChange={(e) => sound.setEnabled(e.target.checked)} />
      </label>
    </Dialog>
  );
}
