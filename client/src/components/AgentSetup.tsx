// The agent's settings (R-039, D-115): what its runs and answers load from the owner's Claude Code
// setup on its laptop. Opening them asks the agent, which answers in the owner's direct chat with
// what the laptop offers, the choice it keeps and what its last run loaded. Save sends a new choice,
// and the agent's answer to it confirms it. Nothing of it reaches the server unsealed.
import { useEffect, useMemo, useState } from 'react';
import { setupWords, type SetupChoice, type UserDTO } from '../../../shared/types';
import { blockedBy, ownAgents, useAgentChats, WAKE } from '../agents';
import { askSetup } from '../chat';
import { useAppState } from '../store';
import { Dialog } from './Dialog';
import { formatAgo } from './format';

/** How long the dialog waits for the agent's answer before it says none came. */
const ANSWER_MS = 60_000;

const same = (a: SetupChoice, b: SetupChoice) => a.claudeMd === b.claudeMd && a.noAttribution === b.noAttribution && [...a.skills].sort().join() === [...b.skills].sort().join();

export function AgentSetup({ onClose }: { onClose: () => void }) {
  const users = useAppState((s) => s.users);
  const meId = useAppState((s) => s.me?.id);
  const agents = useMemo(() => ownAgents(users, meId), [users, meId]);
  const [picked, setPicked] = useState(agents[0]?.id);
  const agent = agents.find((a) => a.id === picked) ?? agents[0];
  return (
    <Dialog title="Agent settings" onClose={onClose}>
      {agents.length > 1 && (
        <select className="field-input" value={agent?.id} onChange={(e) => setPicked(Number(e.target.value))} aria-label="Agent">
          {agents.map((a) => (
            <option key={a.id} value={a.id}>
              {a.displayName}
            </option>
          ))}
        </select>
      )}
      {agent && <SetupForm key={agent.id} agent={agent} />}
    </Dialog>
  );
}

function SetupForm({ agent }: { agent: UserDTO }) {
  const chat = useAgentChats().find((c) => c.members.some((m) => m.userId === agent.id));
  const messages = useAppState((s) => (chat ? s.messages[chat.id] : undefined));
  // This dialog's asks, by client id. Only their answers count: another device may change the choice.
  const [asks, setAsks] = useState<string[]>([]);
  const answer = messages?.findLast((m) => m.senderId === agent.id && asks.includes(m.setupState?.to ?? ''))?.setupState ?? undefined;
  const waiting = asks.length > 0 && answer?.to !== asks.at(-1);
  // Whether the last ask was a save, and the owner's changes since the last answer.
  const [saving, setSaving] = useState(false);
  const [edit, setEdit] = useState<SetupChoice>();
  const [late, setLate] = useState(false);
  // An older plugin ignores `setup`, and a sleeping one hears nothing (D-103, D-113).
  const blocked = blockedBy(agent, true);

  async function ask(choice?: SetupChoice) {
    setSaving(!!choice);
    const id = await askSetup(agent.id, choice);
    setAsks((ids) => [...ids, id]);
  }
  useEffect(() => {
    if (!blocked && !asks.length) void ask();
  }, [blocked]);
  useEffect(() => {
    setLate(false);
    if (!waiting) return;
    const timer = setTimeout(() => setLate(true), ANSWER_MS);
    return () => clearTimeout(timer);
  }, [asks.length, waiting]);

  if (blocked) return <p className="dialog-intro">{blocked}</p>;
  if (!answer) return <p className="dialog-intro">{late ? `Your agent did not answer. ${WAKE}` : 'Asking your agent what it can load…'}</p>;
  const choice = edit ?? answer.choice;
  const offered = new Set(answer.skills.map((s) => s.name));
  // A chosen skill that left the laptop stays listed, so it can be turned off.
  const skills = [...answer.skills, ...choice.skills.filter((name) => !offered.has(name)).map((name) => ({ name, description: 'Not on the laptop' }))];
  const toggle = (name: string) => setEdit({ ...choice, skills: choice.skills.includes(name) ? choice.skills.filter((s) => s !== name) : [...choice.skills, name] });
  const busy = saving && waiting && !late;

  return (
    <form
      className="dialog-form"
      onSubmit={(e) => {
        e.preventDefault();
        void ask(choice);
      }}
    >
      <p className="dialog-intro">
        What your agent’s runs and answers load from Claude Code on its laptop. Your settings, hooks, MCP servers and plugins stay
        off, since a run follows cards your teammates wrote.
      </p>
      <ul className="people-list">
        <li>
          <label className="person">
            <input type="checkbox" checked={choice.claudeMd} disabled={!answer.claudeMd && !choice.claudeMd} onChange={() => setEdit({ ...choice, claudeMd: !choice.claudeMd })} />
            <span>
              <strong>Follow my CLAUDE.md</strong>
              <small>{answer.claudeMd ? '~/.claude/CLAUDE.md' : 'Not on the laptop'}</small>
            </span>
          </label>
        </li>
        <li>
          <label className="person">
            <input type="checkbox" checked={choice.noAttribution} onChange={() => setEdit({ ...choice, noAttribution: !choice.noAttribution })} />
            <span>
              <strong>No AI attribution in commits and pull requests</strong>
              <small>No “Co-Authored-By” or “Generated with Claude Code” lines.</small>
            </span>
          </label>
        </li>
      </ul>
      {skills.length > 0 ? (
        <ul className="people-list" aria-label="Skills">
          {skills.map((s) => (
            <li key={s.name}>
              <label className="person">
                <input type="checkbox" checked={choice.skills.includes(s.name)} onChange={() => toggle(s.name)} />
                <span>
                  <strong>{s.name}</strong>
                  <small>{s.description}</small>
                </span>
              </label>
            </li>
          ))}
        </ul>
      ) : (
        <p className="dialog-intro">No skills in ~/.claude/skills on the laptop.</p>
      )}
      {answer.applied && (
        <p className="dialog-intro">
          Its last run, {formatAgo(answer.applied.at)}, loaded {setupWords(answer.applied)}.
        </p>
      )}
      <button className="button-primary" disabled={busy || same(choice, answer.choice)}>
        {busy ? 'Saving…' : 'Save'}
      </button>
      {saving && !waiting && same(choice, answer.choice) && <p className="dialog-note">Saved. The next run and answer load {setupWords(answer.choice)}.</p>}
      {late && <p className="form-error">Your agent did not answer. {WAKE}</p>}
    </form>
  );
}
