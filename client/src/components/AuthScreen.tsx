import { useState, type FormEvent } from 'react';
import '@astryxdesign/core/astryx.css';
import { Banner } from '@astryxdesign/core/Banner';
import { Button } from '@astryxdesign/core/Button';
import { Card } from '@astryxdesign/core/Card';
import { Center } from '@astryxdesign/core/Center';
import { Heading } from '@astryxdesign/core/Heading';
import { Stack } from '@astryxdesign/core/Stack';
import { Tab, TabList } from '@astryxdesign/core/TabList';
import { Text } from '@astryxdesign/core/Text';
import { TextInput } from '@astryxdesign/core/TextInput';
import { Theme } from '@astryxdesign/core/theme';
import { register, signIn } from '../e2ee/account';
import { webchatTheme } from '../astryxTheme';

export function AuthScreen({ onSignedIn }: { onSignedIn: () => void }) {
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [username, setUsername] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [inviteCode, setInviteCode] = useState(() => new URLSearchParams(location.search).get('invite') ?? '');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError('');
    // TextInput sets no native required or minLength, so the page checks before a request that
    // would count as a failed sign-in. The server never sees the password, so only the page can.
    const fields = mode === 'login' ? [username, password] : [username, displayName, password, inviteCode];
    if (fields.some((value) => !value.trim())) {
      setError('Fill in every field.');
      return;
    }
    if (mode === 'register' && password.length < 8) {
      setError('Use a password of at least 8 characters.');
      return;
    }
    setBusy(true);
    try {
      if (mode === 'login') await signIn(username, password);
      else await register({ username, displayName, password, inviteCode });
      onSignedIn();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Theme theme={webchatTheme}>
      <Center height="100%">
        <Stack as="main" gap={5} padding={4} width="min(400px, 100%)">
          <Card>
            <Stack gap={5}>
              <Stack direction="horizontal" gap={3} align="center">
                <img src="/favicon.svg" alt="" width="48" height="48" />
                <Stack gap={0.5}>
                  <Heading level={1}>WebChat</Heading>
                  <Text color="secondary">Messages from friends, the moment they are sent.</Text>
                </Stack>
              </Stack>

              <TabList value={mode} onChange={(value) => setMode(value as 'login' | 'register')} layout="fill" hasDivider>
                <Tab value="login" label="Sign in" />
                <Tab value="register" label="Create account" />
              </TabList>

              <Stack as="form" gap={4} onSubmit={submit}>
                <TextInput
                  label="Username"
                  value={username}
                  onChange={setUsername}
                  autoComplete="username"
                  autoCapitalize="none"
                />
                {mode === 'register' && (
                  <TextInput label="Your name" value={displayName} onChange={setDisplayName} />
                )}
                <TextInput
                  type="password"
                  label="Password"
                  value={password}
                  onChange={setPassword}
                  autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
                  description={
                    mode === 'register'
                      ? 'Your password also locks your encrypted messages. If you forget it, your message history cannot be recovered.'
                      : undefined
                  }
                />
                {mode === 'register' && (
                  <TextInput
                    label="Invite code"
                    value={inviteCode}
                    onChange={setInviteCode}
                    autoCapitalize="none"
                    description="Ask the person who runs this server."
                  />
                )}
                {error && <Banner status="error" title={error} />}
                <Button
                  type="submit"
                  variant="primary"
                  width="100%"
                  isLoading={busy}
                  label={busy ? 'Securing your keys…' : mode === 'login' ? 'Sign in' : 'Create account'}
                />
              </Stack>
            </Stack>
          </Card>
        </Stack>
      </Center>
    </Theme>
  );
}
