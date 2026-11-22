// The agent's settings (R-039, D-115): each harness on its laptop in a list beside the one picked,
// and what its runs and answers load from the owner's setup there. On a phone the list is a row of
// chips above it. Opening them asks the agent, which answers in the owner's
// direct chat with the harnesses it found, what the laptop offers, the choice it keeps and what its
// last run loaded. Save sends a new choice, and the agent's answer to it confirms it. Nothing of it
// reaches the server unsealed.
import { useEffect, useMemo, useState } from 'react';
import { Banner } from '@astryxdesign/core/Banner';
import { Button } from '@astryxdesign/core/Button';
import { Dialog as AstryxDialog, DialogHeader } from '@astryxdesign/core/Dialog';
import { List } from '@astryxdesign/core/List';
import { Selector } from '@astryxdesign/core/Selector';
import { Switch } from '@astryxdesign/core/Switch';
import { Text } from '@astryxdesign/core/Text';
import {
  HARNESS_ROW_WORDS,
  HARNESS_WARNING,
  harnessRow,
  setupWords,
  takesAsks,
  takesOwn,
  type HarnessRow,
  type HarnessState,
  type SetupChoice,
  type UserDTO,
} from '../../../shared/types';
import { blockedBy, ownAgents, useAgentChat, WAKE } from '../agents';
import { askSetup } from '../chat';
import { useAppState } from '../store';
import { AgentAsks } from './AgentAsks';
import { usePhone } from './AgentDialog';
import { HarnessLogo } from './HarnessPicker';
import { formatAgo } from './format';
import { PickItem } from './PickItem';

/** How long the dialog waits for the agent's answer before it says none came. */
const ANSWER_MS = 60_000;

const sorted = (list: string[] = []) => [...list].sort().join();
const flip = (list: string[], item: string) => (list.includes(item) ? list.filter((i) => i !== item) : [...list, item]);
const same = (a: SetupChoice, b: SetupChoice) =>
  a.claudeMd === b.claudeMd &&
  a.noAttribution === b.noAttribution &&
  !a.noPlan === !b.noPlan &&
  sorted(a.skills) === sorted(b.skills) &&
  sorted(a.off) === sorted(b.off) &&
  sorted(a.own) === sorted(b.own) &&
  (a.linked ?? []).join() === (b.linked ?? []).join();

/** What the owner reads before turning on their own setup (D-157). */
const OWN_WARNING =
  'A question you type in the Coding agents pane runs in your folder with your own settings, hooks, plugins, MCP servers and permission rules, and no sandbox of WebChat’s. The board’s cards in its brief can steer it, and it can change your working tree. Card runs and Check again stay restricted.';

/** What a plugin from before the harness list runs: Claude Code alone, with no toggle, since it ignores `off`. */
const OLD_PLUGIN: HarnessState = {
  name: 'Claude Code',
  instructions: '~/.claude/CLAUDE.md',
  skills: '~/.claude/skills',
  knobs: ['noAttribution'],
};

export function AgentSetup({ onClose }: { onClose: () => void }) {
  const users = useAppState((s) => s.users);
  const meId = useAppState((s) => s.me?.id);
  const agents = useMemo(() => ownAgents(users, meId), [users, meId]);
  const [picked, setPicked] = useState(agents[0]?.id);
  const agent = agents.find((a) => a.id === picked) ?? agents[0];
  const phone = usePhone();
  const close = (open: boolean) => !open && onClose();
  return (
    <AstryxDialog
      isOpen
      onOpenChange={close}
      purpose="form"
      width={900}
      maxHeight="min(680px, 90dvh)"
      variant={phone ? 'fullscreen' : 'standard'}
      padding={0}
    >
      <div className="agents-dialog-head">
        <DialogHeader title="Agent settings" onOpenChange={close} />
      </div>
      {agents.length > 1 && (
        <div className="setup-agent">
          <Selector
            label="Agent"
            isLabelHidden
            value={String(agent?.id)}
            onChange={(v) => setPicked(Number(v))}
            options={agents.map((a) => ({ value: String(a.id), label: a.displayName }))}
          />
        </div>
      )}
      {agent && <SetupForm key={agent.id} agent={agent} />}
    </AstryxDialog>
  );
}

function SetupForm({ agent }: { agent: UserDTO }) {
  const chat = useAgentChat(agent);
  const messages = useAppState((s) => (chat ? s.messages[chat.id] : undefined));
  // This dialog's asks, by client id. Only their answers count: another device may change the choice.
  const [asks, setAsks] = useState<string[]>([]);
  const answer =
    messages?.findLast((m) => m.senderId === agent.id && asks.includes(m.setupState?.to ?? ''))?.setupState ??
    undefined;
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

  // The harness picked in the list.
  const [sel, setSel] = useState('');
  if (blocked)
    return (
      <div className="setup-wait">
        <Text as="p" color="secondary">
          {blocked}
        </Text>
      </div>
    );
  if (!answer)
    return (
      <div className="setup-wait">
        <Text as="p" color="secondary">
          {late ? `Your agent did not answer. ${WAKE}` : 'Asking your agent what it can load…'}
        </Text>
      </div>
    );
  // An agent that knows linking keeps the list and the off list itself: Link and Unlink send them at once, so an unsaved edit never carries stale ones.
  const links = answer.harnesses?.some((h) => h.linked !== undefined);
  const choice = edit
    ? { ...edit, ...(links && { linked: answer.choice.linked, off: answer.choice.off }) }
    : answer.choice;
  const offered = new Set(answer.skills.map((s) => s.name));
  // A chosen skill that left the laptop stays listed, so it can be turned off.
  const skills = [
    ...answer.skills,
    ...choice.skills.filter((name) => !offered.has(name)).map((name) => ({ name, description: 'Not on the laptop' })),
  ];
  const off = choice.off ?? [];
  const busy = saving && waiting && !late;
  // Link and Unlink are signed setup choices of their own, sent from the answer's choice, not from unsaved edits.
  const relink = (h: HarnessState) => {
    const linked = (answer.choice.linked ?? []).filter((n) => n !== h.name);
    void ask({
      ...answer.choice,
      linked: h.linked ? linked : [...linked, h.name],
      off: (answer.choice.off ?? []).filter((n) => n !== h.name),
    });
  };

  const harnesses = answer.harnesses ?? [OLD_PLUGIN];
  const h = harnesses.find((x) => x.name === sel) ?? harnesses[0]!;
  // A plugin from before linking keeps its on and off switch; one from before the list has neither.
  const row: HarnessRow = h.linked === undefined ? 'linked' : harnessRow(h);
  const help = row === 'linked' ? undefined : helpFor(h, row);
  const loads = row === 'linked' || row === 'attention';
  const knob = (label: string, text: string, value: boolean, onChange: () => void, isDisabled?: boolean) => (
    <div className="setup-knob" key={label}>
      <span className="setup-knob-text">
        <strong>{label}</strong>
        <Help text={text} />
      </span>
      <Switch label={label} isLabelHidden value={value} isDisabled={isDisabled} onChange={onChange} />
    </div>
  );

  return (
    <form
      className="setup"
      onSubmit={(e) => {
        e.preventDefault();
        void ask(choice);
      }}
    >
      <div className="setup-body">
        <nav className="setup-nav" aria-label="Harnesses">
          {harnesses.map((x) => {
            const r = x.linked === undefined ? 'linked' : harnessRow(x);
            return (
              <button
                key={x.name}
                type="button"
                className={`setup-nav-row is-${r}`}
                aria-current={x === h || undefined}
                title={`${x.name}: ${HARNESS_ROW_WORDS[r]}`}
                onClick={() => setSel(x.name)}
              >
                <span className="setup-logo">
                  <HarnessLogo name={x.name} size={16} />
                </span>
                <span className="setup-nav-text">
                  <strong>{x.name}</strong>
                  {/* Only a linked harness that cannot run says why; the rest show by their fade alone. */}
                  {r === 'attention' && <span>{x.signedIn === false ? 'Not signed in' : 'Needs attention'}</span>}
                </span>
              </button>
            );
          })}
        </nav>
        <div className="setup-main">
          <AgentAsks />
          <div className="setup-title">
            <span className="setup-title-text">
              <strong>
                {h.name} {h.version && <span>{h.version}</span>}
              </strong>
              <span className="setup-where">
                <span>{h.path ? agent.displayName : `Not on ${agent.displayName}`}</span>
                {h.signedIn !== undefined && (
                  <span className={h.signedIn ? undefined : 'is-warn'}>{h.signedIn ? 'Signed in' : 'Not signed in'}</span>
                )}
              </span>
            </span>
            {/* Unlink takes effect at once, as its own signed choice, apart from Apply. */}
            {h.linked && (
              <Button size="sm" variant="destructive" label="Unlink" aria-label={`Unlink ${h.name}`} isDisabled={busy} onClick={() => relink(h)} />
            )}
          </div>
          {help && (
            <section className="setup-help-box" aria-label={help.problem}>
              <strong>{help.problem}</strong>
              {h.path && <code>{h.path}</code>}
              {row === 'found' && HARNESS_WARNING[h.name] && (
                <Banner status="warning" title="Before you link it" description={HARNESS_WARNING[h.name]} />
              )}
              <span className="setup-help-h">How to connect it</span>
              <ol>
                {help.steps.map(([text, cmd], i) => (
                  <li key={i}>
                    <span className="setup-step-n" aria-hidden="true">
                      {i + 1}
                    </span>
                    <span className="setup-step-text">
                      <span>{text}</span>
                      {cmd && <code>{cmd}</code>}
                    </span>
                  </li>
                ))}
              </ol>
              {row === 'found' && (
                <span>
                  <Button variant="primary" label={`Link ${h.name}`} isDisabled={busy} onClick={() => relink(h)} />
                </span>
              )}
            </section>
          )}
          {loads && (
            <section className="setup-section">
              <span className="setup-help-h">What its runs and answers load</span>
              <div className="setup-knobs">
                {h.linked === undefined &&
                  answer.harnesses &&
                  knob('Use it', h.refusal ?? 'Takes cards', !off.includes(h.name), () => setEdit({ ...choice, off: flip(off, h.name) }))}
                {h.instructions &&
                  knob(
                    `Follow my ${h.instructions.split('/').pop()}`,
                    answer.claudeMd ? h.instructions : 'Not on the laptop',
                    choice.claudeMd,
                    () => setEdit({ ...choice, claudeMd: !choice.claudeMd }),
                    !answer.claudeMd && !choice.claudeMd,
                  )}
                {/* A knob this page does not know yet stays as it is. */}
                {h.knobs.includes('noAttribution') &&
                  knob('No AI attribution', `No “Co-Authored-By” or “Generated with ${h.name}” lines.`, choice.noAttribution, () =>
                    setEdit({ ...choice, noAttribution: !choice.noAttribution }),
                  )}
                {h.knobs.includes('own') &&
                  takesOwn(agent.protocol) &&
                  knob('Use my own setup in sessions I start', OWN_WARNING, !!choice.own?.includes(h.name), () =>
                    setEdit({ ...choice, own: flip(choice.own ?? [], h.name) }),
                  )}
                {h.knobs.includes('noPlan') &&
                  knob('Show me the plan before any code', 'A card run waits for your go after its check.', !choice.noPlan, () =>
                    setEdit({ ...choice, noPlan: !choice.noPlan }),
                  )}
              </div>
            </section>
          )}
          {h.skills && loads && (
            <section className="setup-section">
              <span className="setup-help-h">
                Skills of {h.name}
                <span>
                  {choice.skills.length} of {skills.length} on
                </span>
              </span>
              {skills.length > 0 ? (
                <List edge="flush">
                  {skills.map((s) => (
                    <PickItem
                      key={s.name}
                      label={s.name}
                      description={<Help text={s.description} />}
                      checked={choice.skills.includes(s.name)}
                      onChange={() => setEdit({ ...choice, skills: flip(choice.skills, s.name) })}
                    />
                  ))}
                </List>
              ) : (
                <Text as="p" color="secondary">
                  No skills in {h.skills} on the laptop.
                </Text>
              )}
            </section>
          )}
          <Text as="p" color="secondary">
            Your settings, hooks, MCP servers and plugins stay off in card runs, since a run follows cards your teammates
            wrote.{' '}
            {takesAsks(agent.protocol)
              ? 'It asks you in Coding agents before an action its harness would ask about.'
              : 'Update your agent to be asked before such an action; until then it refuses it.'}
          </Text>
          {late && <Banner status="error" title={`Your agent did not answer. ${WAKE}`} />}
        </div>
      </div>
      <footer className="setup-foot">
        <Text color="secondary">
          {saving && !waiting && same(choice, answer.choice)
            ? `Saved. The next run and answer load ${setupWords(answer.choice)}.`
            : !same(choice, answer.choice)
              ? 'Unsaved changes.'
              : answer.applied
                ? `Its last run, ${formatAgo(answer.applied.at)}, loaded ${setupWords(answer.applied)}.`
                : ''}
        </Text>
        <Button variant="primary" type="submit" isLoading={busy} isDisabled={same(choice, answer.choice)} label="Apply" />
      </footer>
    </form>
  );
}

type Steps = Array<[string, string?]>;

/** What a harness that takes no runs yet needs, and the steps to connect it. */
function helpFor(h: HarnessState, row: Exclude<HarnessRow, 'linked'>): { problem: string; steps: Steps } {
  if (row === 'found')
    return {
      problem: `${h.name} is on your laptop, but not linked`,
      steps: [
        [`Read what ${h.name} can reach${HARNESS_WARNING[h.name] ? ', above' : ''}.`],
        [`Make sure ${h.name} works on the laptop. Run it once in a terminal and sign in if it asks.`, h.path],
        [`Press Link ${h.name}. Your agent links it and confirms here.`],
        ['Choose what its runs load. The switches show here once it is linked.'],
      ],
    };
  if (row === 'attention')
    return {
      problem: h.attention ?? `${h.name} is linked, but needs attention`,
      steps: [['On the laptop, fix what it says above.'], ['Open these settings again. It shows as linked once it can run.']],
    };
  return {
    problem: `${h.name} is not on your laptop`,
    steps: [[`Install ${h.name} on the laptop.`], ['Restart your agent. It looks for harnesses each time it starts.'], ['Come back here and press Link.']],
  };
}

/** Help that fits on one line shows under its option; longer help waits behind a ? that opens on click. */
function Help({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  if (text.length <= 80) return <Text color="secondary">{text}</Text>;
  return (
    <span className="setup-help">
      <button
        type="button"
        className="setup-help-mark"
        aria-label="What this does"
        aria-expanded={open}
        // The row toggles its box on a click; the ? only opens its help.
        onClick={(e) => {
          e.stopPropagation();
          setOpen(!open);
        }}
      >
        ?
      </button>
      {open && <Text color="secondary">{text}</Text>}
    </span>
  );
}
