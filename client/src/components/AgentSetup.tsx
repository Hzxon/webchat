// The agent's settings (R-039, D-115): each harness on its laptop, and what its runs and answers
// load from the owner's setup there. Opening them asks the agent, which answers in the owner's
// direct chat with the harnesses it found, what the laptop offers, the choice it keeps and what its
// last run loaded. Save sends a new choice, and the agent's answer to it confirms it. Nothing of it
// reaches the server unsealed.
import { useEffect, useMemo, useState } from 'react';
import { Banner } from '@astryxdesign/core/Banner';
import { Button } from '@astryxdesign/core/Button';
import { List, ListItem } from '@astryxdesign/core/List';
import { Selector } from '@astryxdesign/core/Selector';
import { Stack } from '@astryxdesign/core/Stack';
import { Switch } from '@astryxdesign/core/Switch';
import { Text } from '@astryxdesign/core/Text';
import {
  HARNESS_ROW_WORDS,
  HARNESS_WARNING,
  harnessRow,
  setupWords,
  takesAsks,
  type HarnessRow,
  type HarnessState,
  type SetupChoice,
  type UserDTO,
} from '../../../shared/types';
import { blockedBy, ownAgents, useAgentChat, WAKE } from '../agents';
import { askSetup } from '../chat';
import { useAppState } from '../store';
import { AgentAsks } from './AgentAsks';
import { Dialog } from './Dialog';
import { formatAgo } from './format';
import { PickItem } from './PickItem';
import { Tag, type Tone } from './PullTags';

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
  (a.linked ?? []).join() === (b.linked ?? []).join();

const ROW_TONE: Record<HarnessRow, Tone> = { linked: 'ok', attention: 'warn', found: 'info', missing: 'muted' };

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
  return (
    <Dialog title="Agent settings" onClose={onClose}>
      {agents.length > 1 && (
        <Selector
          label="Agent"
          isLabelHidden
          value={String(agent?.id)}
          onChange={(v) => setPicked(Number(v))}
          options={agents.map((a) => ({ value: String(a.id), label: a.displayName }))}
        />
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

  if (blocked)
    return (
      <Text as="p" color="secondary">
        {blocked}
      </Text>
    );
  if (!answer)
    return (
      <Text as="p" color="secondary">
        {late ? `Your agent did not answer. ${WAKE}` : 'Asking your agent what it can load…'}
      </Text>
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

  return (
    <Stack
      as="form"
      gap={4}
      onSubmit={(e: React.FormEvent) => {
        e.preventDefault();
        void ask(choice);
      }}
    >
      <Text as="p" color="secondary">
        Each coding agent on your agent’s laptop, and what its runs and answers load from your setup there. Your
        settings, hooks, MCP servers and plugins stay off, since a run follows cards your teammates wrote.{' '}
        {takesAsks(agent.protocol)
          ? 'It asks you in the Coding agents pane before an action its coding agent would ask about.'
          : 'Update your agent to be asked before such an action; until then it refuses it.'}
      </Text>
      <AgentAsks />
      {(answer.harnesses ?? [OLD_PLUGIN]).map((h) => (
        <Stack key={h.name} as="section" gap={2}>
          {h.linked !== undefined ? (
            <ListItem
              label={[h.name, h.version].filter(Boolean).join(' ')}
              description={
                <Stack gap={0.5}>
                  {h.path && <Text color="secondary">{h.path}</Text>}
                  <Text color="secondary">
                    {h.attention ??
                      (h.linked ? (h.refusal ?? 'Takes cards') : h.path ? HARNESS_WARNING[h.name] : h.refusal)}
                  </Text>
                </Stack>
              }
              endContent={
                <Stack direction="horizontal" gap={2} vAlign="center">
                  <Tag tone={ROW_TONE[harnessRow(h)]}>{HARNESS_ROW_WORDS[harnessRow(h)]}</Tag>
                  <Button
                    size="sm"
                    isDisabled={busy || (!h.linked && !h.path)}
                    onClick={() => relink(h)}
                    label={h.linked ? 'Unlink' : 'Link'}
                  />
                </Stack>
              }
            />
          ) : answer.harnesses ? (
            <Switch
              label={[h.name, h.version].filter(Boolean).join(' ')}
              description={[
                h.signedIn !== undefined && (h.signedIn ? 'Signed in' : 'Not signed in'),
                h.refusal ?? 'Takes cards',
              ]
                .filter(Boolean)
                .join('. ')}
              value={!off.includes(h.name)}
              onChange={() => setEdit({ ...choice, off: flip(off, h.name) })}
            />
          ) : (
            <ListItem
              label={[h.name, h.version].filter(Boolean).join(' ')}
              description={[h.signedIn !== undefined && (h.signedIn ? 'Signed in' : 'Not signed in'), h.refusal]
                .filter(Boolean)
                .join('. ')}
            />
          )}
          <List edge="flush">
            {h.instructions && (
              <PickItem
                label={`Follow my ${h.instructions.split('/').pop()}`}
                description={answer.claudeMd ? h.instructions : 'Not on the laptop'}
                checked={choice.claudeMd}
                isDisabled={!answer.claudeMd && !choice.claudeMd}
                onChange={() => setEdit({ ...choice, claudeMd: !choice.claudeMd })}
              />
            )}
            {/* A knob this page does not know yet stays as it is. */}
            {h.knobs.includes('noAttribution') && (
              <PickItem
                label="No AI attribution in commits and pull requests"
                description={`No “Co-Authored-By” or “Generated with ${h.name}” lines.`}
                checked={choice.noAttribution}
                onChange={() => setEdit({ ...choice, noAttribution: !choice.noAttribution })}
              />
            )}
            {h.knobs.includes('noPlan') && (
              <PickItem
                label="Show me the plan before any code"
                description="A card run waits for your go after its check."
                checked={!choice.noPlan}
                onChange={() => setEdit({ ...choice, noPlan: !choice.noPlan })}
              />
            )}
          </List>
          {h.skills &&
            (skills.length > 0 ? (
              <List edge="flush" header={`Skills of ${h.name}`}>
                {skills.map((s) => (
                  <PickItem
                    key={s.name}
                    label={s.name}
                    description={s.description}
                    checked={choice.skills.includes(s.name)}
                    onChange={() => setEdit({ ...choice, skills: flip(choice.skills, s.name) })}
                  />
                ))}
              </List>
            ) : (
              <Text as="p" color="secondary">
                No skills in {h.skills} on the laptop.
              </Text>
            ))}
        </Stack>
      ))}
      {answer.applied && (
        <Text as="p" color="secondary">
          Its last run, {formatAgo(answer.applied.at)}, loaded {setupWords(answer.applied)}.
        </Text>
      )}
      <Button variant="primary" type="submit" isLoading={busy} isDisabled={same(choice, answer.choice)} label="Save" />
      {saving && !waiting && same(choice, answer.choice) && (
        <Text as="p" weight="semibold">
          Saved. The next run and answer load {setupWords(answer.choice)}.
        </Text>
      )}
      {late && <Banner status="error" title={`Your agent did not answer. ${WAKE}`} />}
    </Stack>
  );
}
