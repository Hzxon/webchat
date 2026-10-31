import { useState, type FormEvent } from 'react';
import type { UserDTO } from '../../../shared/types';
import { unlock } from '../e2ee/account';
import { LockIcon } from './icons';

/** Shown when the session is valid but this device does not hold the account's keys yet. */
export function UnlockScreen({ me, onUnlocked, onSignOut }: { me: UserDTO; onUnlocked: () => void; onSignOut: () => void }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError('');
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
    <main className="auth">
      <div className="auth-card">
        <div className="auth-brand">
          <span className="unlock-icon">
            <LockIcon width={26} height={26} />
          </span>
          <div>
            <h1>Unlock your messages</h1>
            <p>
              Signed in as {me.displayName}. Enter your password to unlock end-to-end encrypted messages on this device.
            </p>
          </div>
        </div>
        <form onSubmit={submit} className="auth-form">
          <input type="text" autoComplete="username" value={me.username} readOnly hidden />
          <label>
            Password
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              autoFocus
              required
            />
          </label>
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
          <button className="button-primary" disabled={busy}>
            {busy ? 'Unlocking…' : 'Unlock'}
          </button>
          <button type="button" className="button-secondary" onClick={onSignOut} disabled={busy}>
            Sign out
          </button>
        </form>
      </div>
    </main>
  );
}
