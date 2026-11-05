// Pairs a coding agent with this account (R-030, D-093). The page makes a one-time code, which the
// owner pastes into the agent. The page then waits for the agent's keys, which the code proves,
// and the owner names the agent, picks its projects and approves. No invite code or password.
import { useEffect, useMemo, useState } from 'react';
import { newPairingCode } from '../../../shared/e2ee';
import { LIMITS, PAIRING_TTL_MS, type PublicKeysDTO } from '../../../shared/types';
import { connectAgent, pairingKeys } from '../chat';
import { useAppState } from '../store';
import { Dialog } from './Dialog';
import { CopyRow } from './NotificationDialog';

export function AgentDialog({ projectId, onClose }: { projectId: number; onClose: () => void }) {
  const projects = useAppState((s) => s.projects);
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

  async function approve() {
    setBusy(true);
    setError('');
    try {
      const agent = await connectAgent(code, keys!, name.trim(), [...picked]);
      setDone(`${agent.displayName} is connected. Hand it a card with the play button on a roadmap card.`);
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
            Paste this code into the WebChat plugin in Claude Code, or into <code>npm run agent -- pair</code>. It works
            once, within 10 minutes. The agent becomes yours, and runs only the cards you hand to it.
          </p>
          <CopyRow value={code} onCopied={setNote} />
          {!error && <p className="dialog-note">{note || 'Waiting for the agent…'}</p>}
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
