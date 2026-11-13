// Pairs a coding agent with this account (R-030, D-093). The page makes a one-time code, which the
// owner pastes into the agent. The page then waits for the agent's keys, which the code proves,
// and the owner names the agent, picks its projects and approves. No invite code or password. It
// also lists the owner's agents, so one can be removed (R-033).
import { useEffect, useMemo, useState } from 'react';
import { newPairingCode } from '../../../shared/e2ee';
import { LIMITS, PAIRING_TTL_MS, type PairingPick, type PublicKeysDTO, type UserDTO } from '../../../shared/types';
import { ownAgents } from '../agents';
import { api, ApiError } from '../api';
import { holdReloadWhile } from '../build';
import { connectAgent, pairingKeys, removeAgent } from '../chat';
import { useAppState } from '../store';
import { Dialog } from './Dialog';
import { presenceText } from './format';
import { CopyRow } from './NotificationDialog';

/** Adds the plugin's marketplace and installs it in one step, from Claude Code 2.1.275 on. */
const INSTALL = '/plugin install webchat --marketplace Hzxon/webchat#plugin';

/** The release's own installer, which checks the agent file against the release's checksum before it installs it (docs/decisions/agent-install.md). */
const installLine = (release: string, pasted: string) => `curl -fsSL https://github.com/Hzxon/webchat/releases/download/v${release}/install.sh | sh -s -- '${pasted}'`;

export function AgentDialog({ onClose }: { onClose: () => void }) {
  const projects = useAppState((s) => s.projects);
  const users = useAppState((s) => s.users);
  const meId = useAppState((s) => s.me?.id);
  const mine = useMemo(() => ownAgents(users, meId), [users, meId]);
  const [code] = useState(newPairingCode);
  const [keys, setKeys] = useState<PublicKeysDTO | null>(null);
  // The harnesses the agent asks to link, which its code opens: shown before the owner approves.
  const [picks, setPicks] = useState<PairingPick[]>([]);
  const [name, setName] = useState('Claude Code');
  const [picked, setPicked] = useState<Set<number>>(() => new Set());
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState('');
  const [note, setNote] = useState('');
  // The server's release names the files the line fetches. Without it, the line is left out.
  const [release, setRelease] = useState('');
  const sorted = useMemo(() => Object.values(projects).sort((a, b) => a.name.localeCompare(b.name)), [projects]);

  useEffect(() => {
    void api.config().then(({ release: found }) => setRelease(found), () => undefined);
  }, []);

  // The code lives only in this page. A reload after a deploy would lose it while the agent waits
  // on it, and the owner leaves the tab for Claude Code, so it would go hidden or idle (D-040).
  useEffect(() => holdReloadWhile(() => true), []);

  // Looks for the agent's half every 2 seconds, for as long as the code works. A failed request, in
  // a deploy or a network blip, shows its error and the look goes on (K-61).
  useEffect(() => {
    const until = Date.now() + PAIRING_TTL_MS;
    let live = true;
    let failed = false;
    let timer: ReturnType<typeof setTimeout>;
    const look = async () => {
      try {
        const found = await pairingKeys(code);
        if (!live) return;
        if (failed) setError('');
        failed = false;
        if (found) {
          setKeys(found.keys);
          setPicks(found.picks);
          return;
        }
      } catch (err) {
        if (!live) return;
        // Keys that did not come with the code are no blip: they stay an error for good (D-093).
        if (!(err instanceof ApiError)) {
          setError((err as Error).message);
          return;
        }
        failed = true;
        setError(`${err.message} Still trying.`);
      }
      if (Date.now() > until) setError('The code lapsed. Close this window and open it again for a new one.');
      else timer = setTimeout(() => void look(), 2000);
    };
    void look();
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [code]);

  function toggle(id: number) {
    setPicked((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function remove(agent: UserDTO) {
    if (!confirm(`Remove ${agent.displayName}? It leaves every project, and its sessions stop taking cards. This cannot be undone.`)) return;
    setBusy(true);
    setError('');
    try {
      await removeAgent(agent);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function approve() {
    setBusy(true);
    setError('');
    try {
      const agent = await connectAgent(code, keys!, name.trim(), [...picked]);
      setDone(`${agent.displayName} is connected. Ask it about your code here, or hand it a roadmap card with the play button.`);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog title="Connect coding agent" onClose={onClose}>
      {done ? (
        <p className="dialog-intro">{done}</p>
      ) : !keys ? (
        <>
          <p className="dialog-intro">
            Your coding agent is Claude Code on your laptop. It answers your questions about your team’s code and
            works on the cards you hand it, and nobody else’s. It needs a Mac or Linux for now.
          </p>
          <ol className="dialog-steps">
            <li>
              In <a href="https://claude.com/claude-code" target="_blank" rel="noreferrer">Claude Code</a>, type this line:
              <CopyRow value={INSTALL} onCopied={setNote} />
              {mine.length > 0 && (
                <>
                  Already have the plugin? Type this instead:
                  <CopyRow value="/plugin configure webchat@webchat" onCopied={setNote} />
                </>
              )}
            </li>
            <li>
              When it asks for a pairing code, paste this one. It works once, within 10 minutes.
              {/* The address rides along so nobody types it (R-031). After `#`, a browser would never send the code. */}
              <CopyRow value={`${location.origin}#${code}`} onCopied={setNote} />
            </li>
            <li>
              Open Claude Code in your team’s repository and type <code>/webchat:connect</code>.
            </li>
          </ol>
          {release && (
            <>
              <p className="dialog-intro">
                No Claude Code window to keep open? In a terminal on your laptop, run this line instead. It installs
                the agent, asks before it installs anything else, and keeps the agent running whenever you are logged
                in. It needs an account that can use sudo, or an administrator on a Mac.
                {/windows/i.test(navigator.userAgent) && ' On Windows, open Ubuntu on WSL2 and run it there.'}
              </p>
              <CopyRow value={installLine(release, `${location.origin}#${code}`)} onCopied={setNote} />
            </>
          )}
          {!error && <p className="dialog-note">{note || 'Waiting for the agent…'}</p>}
          {mine.length > 0 && <p className="dialog-intro">Your agents:</p>}
          <ul className="people-list">
            {mine.map((agent) => (
              <li key={agent.id} className="member">
                <span className="member-name">
                  <strong>{agent.displayName}</strong>
                  <small>{presenceText(agent)}</small>
                </span>
                <span className="member-actions">
                  <button className="member-remove" onClick={() => void remove(agent)} disabled={busy} aria-label={`Remove ${agent.displayName}`}>
                    Remove
                  </button>
                </span>
              </li>
            ))}
          </ul>
        </>
      ) : (
        <form
          className="dialog-form"
          onSubmit={(e) => {
            e.preventDefault();
            void approve();
          }}
        >
          <p className="dialog-intro">The agent sent the code. Name it, and pick the projects it joins: it reads their channels.</p>
          {/* Display only: Unlink in Agent settings takes one back. */}
          {picks.length > 0 && (
            <>
              <p className="dialog-intro">It links these coding agents on its laptop, and runs your questions and cards with them:</p>
              <ul className="people-list">
                {picks.map((p) => (
                  <li key={p.name} className="member">
                    <span className="member-name">
                      <strong>{p.name}</strong>
                      <small>{[p.version, p.signedIn !== undefined && (p.signedIn ? 'signed in' : 'not signed in')].filter(Boolean).join(', ') || 'not installed yet'}</small>
                    </span>
                  </li>
                ))}
              </ul>
            </>
          )}
          <label className="field">
            Name
            <input className="field-input" value={name} onChange={(e) => setName(e.target.value)} maxLength={LIMITS.displayNameLength} />
          </label>
          <ul className="people-list">
            {sorted.map((project) => (
              <li key={project.id}>
                <label className="person">
                  <input type="checkbox" checked={picked.has(project.id)} onChange={() => toggle(project.id)} />
                  <span>
                    <strong>{project.name}</strong>
                  </span>
                </label>
              </li>
            ))}
          </ul>
          {/* An agent in no project reads no board, so it could answer nothing. */}
          <button className="button-primary" disabled={busy || !name.trim() || picked.size === 0}>
            Approve
          </button>
        </form>
      )}
      {error && <p className="form-error">{error}</p>}
    </Dialog>
  );
}
