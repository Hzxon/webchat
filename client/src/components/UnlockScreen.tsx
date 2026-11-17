import { useState, type FormEvent } from 'react';
import { Banner } from '@astryxdesign/core/Banner';
import { Button } from '@astryxdesign/core/Button';
import { Card } from '@astryxdesign/core/Card';
import { Center } from '@astryxdesign/core/Center';
import { Heading } from '@astryxdesign/core/Heading';
import { Stack } from '@astryxdesign/core/Stack';
import { Text } from '@astryxdesign/core/Text';
import { TextInput } from '@astryxdesign/core/TextInput';
import type { UserDTO } from '../../../shared/types';
import { unlock } from '../e2ee/account';
import { LockIcon } from './icons';

/** Shown when the session is valid but this device does not hold the account's keys yet. */
export function UnlockScreen({
  me,
  onUnlocked,
  onSignOut,
}: {
  me: UserDTO;
  onUnlocked: () => void;
  onSignOut: () => void;
}) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError('');
    // TextInput sets no native required, so the page checks before a request.
    if (!password) {
      setError('Enter your password.');
      return;
    }
    setBusy(true);
    try {
      await unlock(me, password);
      onUnlocked();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Center height="100%">
      <Stack as="main" gap={5} padding={4} width="min(400px, 100%)">
        <Card>
          <Stack gap={5}>
            <Stack direction="horizontal" gap={3} align="center">
              <span className="unlock-icon">
                <LockIcon width={26} height={26} />
              </span>
              <Stack gap={0.5}>
                <Heading level={1}>Unlock your messages</Heading>
                <Text color="secondary">
                  Signed in as {me.displayName}. Enter your password to unlock end-to-end encrypted messages on this
                  device.
                </Text>
              </Stack>
            </Stack>
            <Stack as="form" gap={4} onSubmit={submit}>
              <input type="text" autoComplete="username" value={me.username} readOnly hidden />
              <TextInput
                type="password"
                label="Password"
                value={password}
                onChange={setPassword}
                autoComplete="current-password"
                hasAutoFocus
              />
              {error && <Banner status="error" title={error} />}
              <Button
                type="submit"
                variant="primary"
                width="100%"
                isLoading={busy}
                label={busy ? 'Unlocking…' : 'Unlock'}
              />
              <Button width="100%" label="Sign out" onClick={onSignOut} isDisabled={busy} />
            </Stack>
          </Stack>
        </Card>
      </Stack>
    </Center>
  );
}
