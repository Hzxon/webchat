// The agent's settings (R-039, D-115): each harness on its laptop, and what its runs and answers
// load from the owner's setup there. Opening them asks the agent, which answers in the owner's
// direct chat with the harnesses it found, what the laptop offers, the choice it keeps and what its
// last run loaded. Save sends a new choice, and the agent's answer to it confirms it. Nothing of it
// reaches the server unsealed.
import { useEffect, useMemo, useState } from 'react';
import { HARNESS_ROW_WORDS, harnessRow, setupWords, takesAsks, type HarnessRow, type HarnessState, type SetupChoice, type UserDTO } from '../../../shared/types';
import { blockedBy, ownAgents, useAgentChat, WAKE } from '../agents';
import { askSetup } from '../chat';
import { useAppState } from '../store';
import { AgentAsks } from './AgentAsks';
import { Dialog } from './Dialog';
import { formatAgo } from './format';
import { Tag, type Tone } from './PullTags';

/** How long the dialog waits for the agent's answer before it says none came. */
const ANSWER_MS = 60_000;

const sorted = (list: string[] = []) => [...list].sort().join();
const flip = (list: string[], item: string) => (list.includes(item) ? list.filter((i) => i !== item) : [...list, item]);
const same = (a: SetupChoice, b: SetupChoice) => a.claudeMd === b.claudeMd && a.noAttribution === b.noAttribution && !a.noPlan === !b.noPlan && sorted(a.skills) === sorted(b.skills) && sorted(a.off) === sorted(b.off) && (a.linked ?? []).join() === (b.linked ?? []).join();

const ROW_TONE: Record<HarnessRow, Tone> = { linked: 'ok', attention: 'warn', found: 'info', missing: 'muted' };

/** What a plugin from before the harness list runs: Claude Code alone, with no toggle, since it ignores `off`. */
const OLD_PLUGIN: HarnessState = { name: 'Claude Code', instructions: '~/.claude/CLAUDE.md', skills: '~/.claude/skills', knobs: ['noAttribution'] };

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
  const chat = useAgentChat(agent);
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
  // An agent that knows linking keeps the list and the off list itself: Link and Unlink send them at once, so an unsaved edit never carries stale ones.
  const links = answer.harnesses?.some((h) => h.linked !== undefined);
  const choice = edit ? { ...edit, ...(links && { linked: answer.choice.linked, off: answer.choice.off }) } : answer.choice;
  const offered = new Set(answer.skills.map((s) => s.name));
  // A chosen skill that left the laptop stays listed, so it can be turned off.
  const skills = [...answer.skills, ...choice.skills.filter((name) => !offered.has(name)).map((name) => ({ name, description: 'Not on the laptop' }))];
  const off = choice.off ?? [];
  const busy = saving && waiting && !late;
  // Link and Unlink are signed setup choices of their own, sent from the answer's choice, not from unsaved edits.
  const relink = (h: HarnessState) => {
    const linked = (answer.choice.linked ?? []).filter((n) => n !== h.name);
    void ask({ ...answer.choice, linked: h.linked ? linked : [...linked, h.name], off: (answer.choice.off ?? []).filter((n) => n !== h.name) });
  };

  return (
    <form
      className="dialog-form"
      onSubmit={(e) => {
        e.preventDefault();
        void ask(choice);
      }}
    >
      <p className="dialog-intro">
        Each coding agent on your agent’s laptop, and what its runs and answers load from your setup there. Your settings, hooks,
        MCP servers and plugins stay off, since a run follows cards your teammates wrote.{' '}
        {takesAsks(agent.protocol) ? 'It asks you in the Coding agents pane before an action its coding agent would ask about.' : 'Update your agent to be asked before such an action; until then it refuses it.'}
      </p>
      <AgentAsks />
      {(answer.harnesses ?? [OLD_PLUGIN]).map((h) => (
        <section key={h.name} className="dialog-form">
          {h.linked !== undefined ? (
            <div className="toggle-row harness-row">
              <span>
                <strong>{[h.name, h.version].filter(Boolean).join(' ')}</strong>
                {h.path && <small>{h.path}</small>}
                <small>{h.attention ?? (h.linked ? h.refusal ?? 'Takes cards' : !h.path && h.refusal)}</small>
              </span>
              <Tag tone={ROW_TONE[harnessRow(h)]}>{HARNESS_ROW_WORDS[harnessRow(h)]}</Tag>
              <button type="button" className="button-secondary" disabled={busy || (!h.linked && !h.path)} onClick={() => relink(h)}>
                {h.linked ? 'Unlink' : 'Link'}
              </button>
            </div>
          ) : (
            <label className="toggle-row">
              {answer.harnesses && <input type="checkbox" checked={!off.includes(h.name)} onChange={() => setEdit({ ...choice, off: flip(off, h.name) })} />}
              <span>
                <strong>{[h.name, h.version].filter(Boolean).join(' ')}</strong>
                <small>{[h.signedIn !== undefined && (h.signedIn ? 'Signed in' : 'Not signed in'), h.refusal ?? (answer.harnesses && 'Takes cards')].filter(Boolean).join('. ')}</small>
              </span>
            </label>
          )}
          <ul className="people-list">
            {h.instructions && (
              <li>
                <label className="person">
                  <input type="checkbox" checked={choice.claudeMd} disabled={!answer.claudeMd && !choice.claudeMd} onChange={() => setEdit({ ...choice, claudeMd: !choice.claudeMd })} />
                  <span>
                    <strong>Follow my {h.instructions.split('/').pop()}</strong>
                    <small>{answer.claudeMd ? h.instructions : 'Not on the laptop'}</small>
                  </span>
                </label>
              </li>
            )}
            {/* A knob this page does not know yet stays as it is. */}
            {h.knobs.includes('noAttribution') && (
              <li>
                <label className="person">
                  <input type="checkbox" checked={choice.noAttribution} onChange={() => setEdit({ ...choice, noAttribution: !choice.noAttribution })} />
                  <span>
                    <strong>No AI attribution in commits and pull requests</strong>
                    <small>No “Co-Authored-By” or “Generated with {h.name}” lines.</small>
                  </span>
                </label>
              </li>
            )}
            {h.knobs.includes('noPlan') && (
              <li>
                <label className="person">
                  <input type="checkbox" checked={!choice.noPlan} onChange={() => setEdit({ ...choice, noPlan: !choice.noPlan })} />
                  <span>
                    <strong>Show me the plan before any code</strong>
                    <small>A card run waits for your go after its check.</small>
                  </span>
                </label>
              </li>
            )}
          </ul>
          {h.skills &&
            (skills.length > 0 ? (
              <ul className="people-list" aria-label={`Skills of ${h.name}`}>
                {skills.map((s) => (
                  <li key={s.name}>
                    <label className="person">
                      <input type="checkbox" checked={choice.skills.includes(s.name)} onChange={() => setEdit({ ...choice, skills: flip(choice.skills, s.name) })} />
                      <span>
                        <strong>{s.name}</strong>
                        <small>{s.description}</small>
                      </span>
                    </label>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="dialog-intro">No skills in {h.skills} on the laptop.</p>
            ))}
        </section>
      ))}
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
