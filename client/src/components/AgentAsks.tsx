// An agent's request, which `webchat-agent link <name>` or `connect` sends in the owner's direct
// chat, sealed (docs/decisions/harness-linking.md, docs/decisions/connect-approval.md). The owner
// approves or declines it here; the answer is a signed message the agent checks, so only the
// owner's page can link a harness or connect a folder.
import { useEffect, useState } from 'react';
import { Banner } from '@astryxdesign/core/Banner';
import { Button } from '@astryxdesign/core/Button';
import { Stack } from '@astryxdesign/core/Stack';
import { Text } from '@astryxdesign/core/Text';
import { HARNESS_WARNING, type AskDTO } from '../../../shared/types';
import { useAgentChats } from '../agents';
import { answerAsk } from '../chat';
import { useAppState } from '../store';

/** How long a request waits for its answer: the agent drops it after the same 10 minutes. */
const FRESH_MS = 10 * 60_000;

type Shown =
  | { key: string; chat: number; note: string }
  | { key: string; chat: number; to: string; request: Extract<AskDTO, { step: 'request' }>; agent: string };

export function AgentAsks() {
  const chats = useAgentChats();
  const meId = useAppState((s) => s.me?.id);
  const users = useAppState((s) => s.users);
  const messages = useAppState((s) => s.messages);
  const [busy, setBusy] = useState('');
  const now = Date.now();
  const asks = chats.flatMap((chat): Shown[] => {
    const list = messages[chat.id] ?? [];
    const answered = new Set(list.flatMap((m) => (m.senderId === meId && m.ask && 'to' in m.ask ? [m.ask.to] : [])));
    const agent = users[chat.members.find((member) => member.userId !== meId)?.userId ?? 0];
    return list.flatMap((m): Shown[] => {
      if (m.senderId === meId || !m.ask || now - m.createdAt > FRESH_MS) return [];
      if (m.ask.step === 'failed') return [{ key: `${m.id}`, chat: chat.id, note: m.text }];
      return m.ask.step === 'request' && m.clientId && !answered.has(m.clientId)
        ? [
            {
              key: m.clientId,
              chat: chat.id,
              to: m.clientId,
              request: m.ask,
              agent: agent?.displayName ?? 'Your agent',
            },
          ]
        : [];
    });
  });
  if (!asks.length) return null;

  async function answer(
    chat: number,
    to: string,
    request: Extract<AskDTO, { step: 'request' }>,
    step: 'approve' | 'decline',
  ) {
    setBusy(to);
    await answerAsk(chat, to, request, step).finally(() => setBusy(''));
  }

  return (
    <Stack gap={2}>
      {asks.map((a) =>
        'note' in a ? (
          <Text key={a.key} as="p" weight="semibold">
            {a.note}
          </Text>
        ) : (
          <Banner
            key={a.key}
            status={a.request.kind === 'link' && HARNESS_WARNING[a.request.harness] ? 'warning' : 'info'}
            title={
              a.request.kind === 'link' ? (
                <>
                  <strong>{a.agent}</strong> asks to link <strong>{a.request.harness}</strong> on its laptop.
                </>
              ) : (
                <>
                  <strong>{a.agent}</strong> asks to connect <strong>{a.request.repo}</strong> in{' '}
                  <code>{a.request.folder}</code> on its laptop.
                </>
              )
            }
            description={
              a.request.kind === 'link' ? (
                <>
                  It will run the questions and cards you give it.
                  {HARNESS_WARNING[a.request.harness] && <strong> {HARNESS_WARNING[a.request.harness]}</strong>}
                </>
              ) : (
                'It will work in that folder, and a program there can change it.'
              )
            }
            endContent={
              <Stack direction="horizontal" gap={2}>
                <Button
                  variant="primary"
                  size="sm"
                  label="Approve"
                  aria-label={
                    a.request.kind === 'link'
                      ? `Approve linking ${a.request.harness}`
                      : `Approve connecting ${a.request.repo}`
                  }
                  isDisabled={busy === a.to}
                  onClick={() => void answer(a.chat, a.to, a.request, 'approve')}
                />
                <Button
                  size="sm"
                  label="Decline"
                  isDisabled={busy === a.to}
                  onClick={() => void answer(a.chat, a.to, a.request, 'decline')}
                />
              </Stack>
            }
          />
        ),
      )}
    </Stack>
  );
}

const DECISIONS = [
  ['once', 'Allow it', 'Just this once. It asks again next time.'],
  ['run', 'Allow it for this run', 'It does not ask about this again until the run ends.'],
  ['deny', 'Deny it', 'It goes on without it, or stops if it cannot.'],
] as const;

/**
 * The agent's question before an action, docked above the box (docs/decisions/harness-approvals.md):
 * what it asks to do, as plain text since a command can hide in Markdown, and the three answers a
 * permit takes, numbered, which 1, 2 or 3 picks too. Skip folds it for now: it stays in Waiting for
 * you. Once the answer is sent it folds to one line.
 */
export function QuestionCard({
  text,
  days,
  answered,
  isDisabled,
  onAnswer,
}: {
  text: string;
  days: number;
  answered: boolean;
  isDisabled?: boolean;
  onAnswer: (decision: 'once' | 'run' | 'deny') => void;
}) {
  const [picked, setPicked] = useState<'once' | 'run' | 'deny'>();
  const [skipped, setSkipped] = useState(false);
  useEffect(() => {
    if (answered || skipped || isDisabled) return;
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target.closest('textarea, input') || e.metaKey || e.ctrlKey || e.altKey) return;
      const decision = DECISIONS[Number(e.key) - 1];
      if (decision) setPicked(decision[0]);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [answered, skipped, isDisabled]);
  if (skipped) return null;
  if (answered)
    return (
      <div className="qcard is-done">
        <div className="qhead">
          <b>Answered</b>
          <span>{DECISIONS.find((d) => d[0] === picked)?.[1] ?? 'Your answer is sent'}</span>
          <span className="qgap" />
          <span>Your agent is back at work</span>
        </div>
      </div>
    );
  return (
    <div className="qcard" role="group" aria-label="Your agent asks">
      <div className="qhead">
        <b>Question</b>
        <span>Your agent waits for your answer</span>
        <span className="qgap" />
        <span>Ends in {days} {days === 1 ? 'day' : 'days'}</span>
      </div>
      <p className="qtext">{text}</p>
      <div className="qopts" role="radiogroup" aria-label="Your answer">
        {DECISIONS.map(([decision, label, help], i) => (
          <button
            key={decision}
            type="button"
            className="qopt"
            role="radio"
            aria-checked={picked === decision}
            disabled={isDisabled}
            onClick={() => setPicked(decision)}
          >
            <span className="qnum">{i + 1}</span>
            <span>
              <strong>{label}</strong>
              <small>{help}</small>
            </span>
          </button>
        ))}
      </div>
      <div className="qfoot">
        <span className="qhint">Press 1, 2 or 3 to choose</span>
        <span className="qgap" />
        <Button variant="ghost" label="Skip" onClick={() => setSkipped(true)} />
        <Button
          variant="primary"
          label="Submit"
          isDisabled={!picked || isDisabled}
          onClick={() => onAnswer(picked!)}
        />
      </div>
    </div>
  );
}
