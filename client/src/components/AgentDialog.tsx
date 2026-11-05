// Pairs a coding agent with this account (R-030, D-093). The page makes a one-time code, which the
// owner pastes into the agent. The page then waits for the agent's keys, which the code proves,
// and the owner names the agent, picks its projects and approves. No invite code or password. It
// also lists the owner's agents, so one can be removed (R-033).
import { useEffect, useMemo, useState } from 'react';
import { newPairingCode } from '../../../shared/e2ee';
import { LIMITS, PAIRING_TTL_MS, type PublicKeysDTO, type UserDTO } from '../../../shared/types';
import { ownAgents } from '../agents';
import { connectAgent, pairingKeys, removeAgent } from '../chat';
import { useAppState } from '../store';
import { Dialog } from './Dialog';
import { presenceText } from './format';
import { CopyRow } from './NotificationDialog';

/** Adds the plugin's marketplace and installs it in one step, from Claude Code 2.1.275 on. */
const INSTALL = '/plugin install webchat --marketplace Hzxon/webchat#plugin';

export function AgentDialog({ projectId, onClose }: { projectId: number; onClose: () => void }) {
  const projects = useAppState((s) => s.projects);
  const users = useAppState((s) => s.users);
  const meId = useAppState((s) => s.me?.id);
  const mine = useMemo(() => ownAgents(users, meId), [users, meId]);
  const [code] = useState(newPairingCode);
  const [keys, setKeys] = useState<PublicKeysDTO | null>(null);
  const [name, setName] = useState('Claude Code');
  const [picked, setPicked] = useState<Set<number>>(() => new Set([projectId]));
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState('');
  const [note, setNote] = useState('');
  const sorted = useMemo(() => Object.values(projects).sort((a, b) => a.name.localeCompare(b.name)), [projects]);

  // Looks for the agent's half every 2 seconds, for as long as the code works.
  useEffect(() => {
    const until = Date.now() + PAIRING_TTL_MS;
    let live = true;
    let timer: ReturnType<typeof setTimeout>;
    const look = async () => {
      try {
        const found = await pairingKeys(code);
        if (!live) return;
        if (found) setKeys(found);
        else if (Date.now() > until) setError('The code lapsed. Close this window and open it again for a new one.');
        else timer = setTimeout(() => void look(), 2000);
      } catch (err) {
        if (live) setError((err as Error).message);
      }
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
      setDone(`${agent.displayName} is connected. Ask it about your code under Coding agents, at the top of your chats, or hand it a roadmap card with the play button.`);
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
            Your coding agent is Claude Code on your laptop, with the WebChat plugin. It answers your questions about
            your team’s code and works on the cards you hand it, and nobody else’s. It needs a Mac or Linux for now.
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
          <button className="button-primary" disabled={busy || !name.trim()}>
            Approve
          </button>
        </form>
      )}
      {error && <p className="form-error">{error}</p>}
    </Dialog>
  );
}
