import { useState, type FormEvent } from 'react';
import { register, signIn } from '../e2ee/account';

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
    <main className="auth">
      <div className="auth-card">
        <div className="auth-brand">
          <img src="/favicon.svg" alt="" width="48" height="48" />
          <div>
            <h1>WebChat</h1>
            <p>Messages from friends, the moment they are sent.</p>
          </div>
        </div>

        <div className="segmented" role="tablist">
          <button role="tab" aria-selected={mode === 'login'} onClick={() => setMode('login')} type="button">
            Sign in
          </button>
          <button role="tab" aria-selected={mode === 'register'} onClick={() => setMode('register')} type="button">
            Create account
          </button>
        </div>

        <form onSubmit={submit} className="auth-form">
          <label>
            Username
            <input
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoComplete="username"
              autoCapitalize="none"
              required
              minLength={3}
              maxLength={24}
            />
          </label>
          {mode === 'register' && (
            <label>
              Your name
              <input value={displayName} onChange={(e) => setDisplayName(e.target.value)} required maxLength={40} />
            </label>
          )}
          <label>
            Password
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
              required
              minLength={mode === 'register' ? 8 : 1}
            />
            {mode === 'register' && (
              <small>
                Your password also locks your encrypted messages. If you forget it, your message history cannot be
                recovered.
              </small>
            )}
          </label>
          {mode === 'register' && (
            <label>
              Invite code
              <input value={inviteCode} onChange={(e) => setInviteCode(e.target.value)} required autoCapitalize="none" />
              <small>Ask the person who runs this server.</small>
            </label>
          )}
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
          <button className="button-primary" disabled={busy}>
            {busy ? 'Securing your keys…' : mode === 'login' ? 'Sign in' : 'Create account'}
          </button>
        </form>
      </div>
    </main>
  );
}
