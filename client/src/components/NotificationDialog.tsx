import { useEffect, useState, useSyncExternalStore, type ReactNode } from 'react';
import { Banner } from '@astryxdesign/core/Banner';
import { Button } from '@astryxdesign/core/Button';
import { CodeBlock } from '@astryxdesign/core/CodeBlock';
import { Divider } from '@astryxdesign/core/Divider';
import { Heading } from '@astryxdesign/core/Heading';
import { Link } from '@astryxdesign/core/Link';
import { List, ListItem } from '@astryxdesign/core/List';
import { MetadataList, MetadataListItem } from '@astryxdesign/core/MetadataList';
import { Stack } from '@astryxdesign/core/Stack';
import { StatusDot } from '@astryxdesign/core/StatusDot';
import { Switch } from '@astryxdesign/core/Switch';
import { Text } from '@astryxdesign/core/Text';
import type { BarkDTO } from '../../../shared/types';
import { sound } from '../alerts';
import { api } from '../api';
import { refreshPushState } from '../chat';
import { disablePushHere, enableNotifications } from '../push';
import { actions, useAppState } from '../store';
import { Dialog } from './Dialog';

const BARK_APP_STORE = 'https://apps.apple.com/app/id1403753865';

/** A value to type into another app, with a button that copies it. */
export function CopyRow({ value, onCopied }: { value: string; onCopied: (note: string) => void }) {
  return (
    <CodeBlock
      code={value}
      onCopy={() => onCopied('Copied.')}
      onCopyError={() => onCopied('Select the text, then copy it.')}
    />
  );
}

/** A setting's state, with a dot that says whether it is fine. */
function State({ ok, children }: { ok?: boolean; children: ReactNode }) {
  return (
    <Stack direction="horizontal" gap={2} vAlign="center">
      {ok !== undefined && <StatusDot variant={ok ? 'success' : 'warning'} label={ok ? 'Fine' : 'Needs attention'} />}
      <Text>{children}</Text>
    </Stack>
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
      <Text as="p" color="secondary">
        New messages show up instantly while this tab is open. With push turned on, they also reach this device when the
        tab or browser window is closed.
      </Text>

      <MetadataList>
        <MetadataListItem label="Browser permission">
          <State ok={push?.permission === 'granted'}>{permissionText}</State>
        </MetadataListItem>
        <MetadataListItem label="Push on this device">
          <State ok={!!push?.subscribed}>
            {push?.subscribed ? 'On' : push?.pushSupported ? 'Off' : 'Not available'}
          </State>
        </MetadataListItem>
      </MetadataList>

      {push?.needsInstall && (
        <Banner
          status="warning"
          title="On iPhone and iPad, push works only from the Home Screen app."
          description="In Safari, tap Share, then “Add to Home Screen”, and open WebChat from there. Before iOS 16.4, use Bark below instead."
        />
      )}
      {push?.permission === 'denied' && (
        <Banner
          status="warning"
          title="This browser blocked notifications for this site."
          description="Click the icon left of the address bar, set Notifications to Allow, then reload the page."
        />
      )}

      <Stack direction="horizontal" gap={2} wrap="wrap">
        {/* Without Web Push the permission still lets the open tab notify, so only a browser with no
            Notification at all, such as iOS before 16.4, loses the button. */}
        {push?.permission !== 'denied' && push?.permission !== 'unsupported' && !push?.subscribed && (
          <Button
            variant="primary"
            isDisabled={busy}
            onClick={() => void act(enableNotifications)}
            label="Turn on notifications"
          />
        )}
        {canTest && (
          <Button
            variant="primary"
            isDisabled={busy}
            label="Send a test notification"
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
          />
        )}
        {push?.subscribed && (
          <Button isDisabled={busy} onClick={() => void act(disablePushHere)} label="Turn off on this device" />
        )}
      </Stack>
      {note && (
        <Text as="p" weight="semibold">
          {note}
        </Text>
      )}

      {/* Bark matters only where Web Push cannot work: iOS before 16.4. */}
      {push?.oldIos && bark !== null && (
        <Stack as="section" gap={3}>
          <Divider />
          <Heading level={3}>iPhone without push: the Bark app</Heading>
          {bark === undefined ? (
            <Text as="p" color="secondary">
              Checking…
            </Text>
          ) : !bark.configured ? (
            <Text as="p" color="secondary">
              Alerts through the Bark app are not set up on this server. Ask the person who runs it.
            </Text>
          ) : !bark.link ? (
            <>
              <Text as="p" color="secondary">
                An iPhone before iOS 16.4 cannot get Web Push. Install the free Bark app and link it here: alerts then
                reach it through Apple with the chat and sender names, never the message text.
              </Text>
              <Stack direction="horizontal" gap={2}>
                <Button isDisabled={busy} onClick={() => void barkAct(api.linkBark)} label="Link Bark" />
              </Stack>
            </>
          ) : (
            <>
              <List listStyle="decimal" edge="flush">
                <ListItem
                  label={
                    <Text>
                      Install{' '}
                      <Link href={BARK_APP_STORE} target="_blank">
                        Bark
                      </Link>{' '}
                      from the App Store.
                    </Text>
                  }
                />
                <ListItem
                  label="In Bark, open the server list and add this server URL:"
                  description={<CopyRow value={bark.link.serverUrl} onCopied={setNote} />}
                />
                <ListItem
                  label={
                    <Text>
                      Optional: turn on encryption below, then in Bark open Push Encryption, choose AES256 and GCM, and
                      type the key. Apple then sees nothing of the alert.
                    </Text>
                  }
                />
              </List>
              <MetadataList>
                <MetadataListItem label="Phones linked">
                  <State ok={phones > 0}>{phones > 0 ? phones : 'None yet'}</State>
                </MetadataListItem>
                <MetadataListItem label="Encryption">
                  <State ok={bark.link.cipherKey ? true : undefined}>{bark.link.cipherKey ? 'On' : 'Off'}</State>
                </MetadataListItem>
              </MetadataList>
              {bark.link.cipherKey && <CopyRow value={bark.link.cipherKey} onCopied={setNote} />}
              <Stack direction="horizontal" gap={2} wrap="wrap">
                {phones === 0 && (
                  <Button isDisabled={busy} onClick={() => void barkAct(api.bark)} label="Check again" />
                )}
                <Button
                  isDisabled={busy}
                  onClick={() => void barkAct(() => api.setBarkEncryption(!bark.link?.cipherKey))}
                  label={bark.link.cipherKey ? 'Turn encryption off' : 'Turn encryption on'}
                />
                <Button isDisabled={busy} onClick={() => void barkAct(api.unlinkBark)} label="Unlink Bark" />
              </Stack>
            </>
          )}
        </Stack>
      )}

      <Divider />
      <Switch
        label="Message sounds"
        description="Urgent messages always ring, even with this off."
        value={soundOn}
        onChange={(checked) => sound.setEnabled(checked)}
      />
    </Dialog>
  );
}
