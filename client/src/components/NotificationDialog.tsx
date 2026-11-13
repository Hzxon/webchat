import { useEffect, useState, useSyncExternalStore } from 'react';
import type { BarkDTO } from '../../../shared/types';
import { sound } from '../alerts';
import { api } from '../api';
import { refreshPushState } from '../chat';
import { disablePushHere, enableNotifications } from '../push';
import { actions, useAppState } from '../store';
import { Dialog } from './Dialog';
import { VolumeIcon } from './icons';

const BARK_APP_STORE = 'https://apps.apple.com/app/id1403753865';

/** A value to type into another app, with a button that copies it. The text selects whole on a tap. */
export function CopyRow({ value, onCopied }: { value: string; onCopied: (note: string) => void }) {
  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      onCopied('Copied.');
    } catch {
      onCopied('Tap the text, then copy it.');
    }
  }
  return (
    <div className="copy-row">
      <code>{value}</code>
      <button type="button" className="button-secondary" onClick={() => void copy()}>
        Copy
      </button>
    </div>
  );
}

export function NotificationDialog({ onClose }: { onClose: () => void }) {
  const push = useAppState((s) => s.push);
  const soundOn = useSyncExternalStore(sound.subscribe, sound.enabled);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  // Undefined while loading; null when the server could not say, which hides the section.
  const [bark, setBark] = useState<BarkDTO | null | undefined>(undefined);

  // The sidebar's banner reads the store, so every answer goes there too (K-1).
  const gotBark = (state: BarkDTO) => {
    setBark(state);
    actions.setBark(state);
  };

  useEffect(() => {
    let current = true;
    api
      .bark()
      .then((state) => current && gotBark(state))
      .catch(() => current && setBark(null));
    return () => {
      current = false;
    };
  }, []);

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

  const barkAct = (work: () => Promise<BarkDTO>) => act(async () => gotBark(await work()));

  const permissionText = {
    granted: 'Allowed',
    denied: 'Blocked',
    default: 'Not asked yet',
    unsupported: 'Not supported in this browser',
  }[push?.permission ?? 'default'];

  const phones = bark?.link?.devices.length ?? 0;
  const canTest = Boolean(push?.subscribed) || phones > 0;

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
          and open WebChat from there. Before iOS 16.4, use Bark below instead.
        </p>
      )}
      {push?.permission === 'denied' && (
        <p className="callout">
          This browser blocked notifications for this site. Click the icon left of the address bar, set Notifications
          to Allow, then reload the page.
        </p>
      )}

      <div className="dialog-actions">
        {/* Without Web Push the permission still lets the open tab notify, so only a browser with no
            Notification at all, such as iOS before 16.4, loses the button. */}
        {push?.permission !== 'denied' && push?.permission !== 'unsupported' && !push?.subscribed && (
          <button className="button-primary" disabled={busy} onClick={() => void act(enableNotifications)}>
            Turn on notifications
          </button>
        )}
        {canTest && (
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
        )}
        {push?.subscribed && (
          <button className="button-secondary" disabled={busy} onClick={() => void act(disablePushHere)}>
            Turn off on this device
          </button>
        )}
      </div>
      {note && <p className="dialog-note">{note}</p>}

      {bark !== null && (
        <section className="bark">
          <h3>iPhone without push: the Bark app</h3>
          {bark === undefined ? (
            <p className="dialog-intro">Checking…</p>
          ) : !bark.configured ? (
            <p className="dialog-intro">This server has no key for Bark yet. The README says how to add one.</p>
          ) : !bark.link ? (
            <>
              <p className="dialog-intro">
                An iPhone before iOS 16.4 cannot get Web Push. Install the free Bark app and link it here: alerts then
                reach it through Apple with the chat and sender names, never the message text.
              </p>
              <div className="dialog-actions">
                <button className="button-secondary" disabled={busy} onClick={() => void barkAct(api.linkBark)}>
                  Link Bark
                </button>
              </div>
            </>
          ) : (
            <>
              <ol className="steps">
                <li>
                  Install{' '}
                  <a href={BARK_APP_STORE} target="_blank" rel="noreferrer">
                    Bark
                  </a>{' '}
                  from the App Store.
                </li>
                <li>
                  In Bark, open the server list and add this server URL:
                  <CopyRow value={bark.link.serverUrl} onCopied={setNote} />
                </li>
                <li>
                  Optional: turn on encryption below, then in Bark open Push Encryption, choose AES256 and GCM, and
                  type the key. Apple then sees nothing of the alert.
                </li>
              </ol>
              <dl className="settings">
                <div>
                  <dt>Phones linked</dt>
                  <dd className={phones > 0 ? 'ok' : 'warn'}>{phones > 0 ? phones : 'None yet'}</dd>
                </div>
                <div>
                  <dt>Encryption</dt>
                  <dd className={bark.link.cipherKey ? 'ok' : ''}>{bark.link.cipherKey ? 'On' : 'Off'}</dd>
                </div>
              </dl>
              {bark.link.cipherKey && <CopyRow value={bark.link.cipherKey} onCopied={setNote} />}
              <div className="dialog-actions">
                {phones === 0 && (
                  <button className="button-secondary" disabled={busy} onClick={() => void barkAct(api.bark)}>
                    Check again
                  </button>
                )}
                <button
                  className="button-secondary"
                  disabled={busy}
                  onClick={() => void barkAct(() => api.setBarkEncryption(!bark.link?.cipherKey))}
                >
                  {bark.link.cipherKey ? 'Turn encryption off' : 'Turn encryption on'}
                </button>
                <button className="button-secondary" disabled={busy} onClick={() => void barkAct(api.unlinkBark)}>
                  Unlink Bark
                </button>
              </div>
            </>
          )}
        </section>
      )}

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
