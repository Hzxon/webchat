// An agent's request to link a harness, which `webchat-agent link <name>` sends in the owner's
// direct chat, sealed (docs/decisions/harness-linking.md). The owner approves or declines it here;
// the answer is a signed message the agent checks, so only the owner's page can link anything.
import { useState } from 'react';
import { useAgentChats } from '../agents';
import { answerLink } from '../chat';
import { useAppState } from '../store';

/** How long a request waits for its answer: the agent drops it after the same 10 minutes. */
const FRESH_MS = 10 * 60_000;

type Shown = { key: string; chat: number; note: string } | { key: string; chat: number; to: string; harness: string; agent: string };

export function AgentLinkAsks() {
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
      if (m.senderId === meId || m.ask?.kind !== 'link' || now - m.createdAt > FRESH_MS) return [];
      if (m.ask.step === 'failed') return [{ key: `${m.id}`, chat: chat.id, note: m.text }];
      return m.ask.step === 'request' && m.clientId && !answered.has(m.clientId) ? [{ key: m.clientId, chat: chat.id, to: m.clientId, harness: m.ask.harness, agent: agent?.displayName ?? 'Your agent' }] : [];
    });
  });
  if (!asks.length) return null;

  async function answer(chat: number, to: string, step: 'approve' | 'decline') {
    setBusy(to);
    await answerLink(chat, to, step).finally(() => setBusy(''));
  }

  return (
    <div className="agents-link-asks">
      {asks.map((a) =>
        'note' in a ? (
          <p key={a.key} className="dialog-note">
            {a.note}
          </p>
        ) : (
          <div key={a.key} className="agents-link-ask" role="group" aria-label={`Link ${a.harness}`}>
            <p>
              <strong>{a.agent}</strong> asks to link <strong>{a.harness}</strong> on its laptop. It will run the questions and cards you give it.
            </p>
            <div className="agents-link-buttons">
              <button className="button-primary" disabled={busy === a.to} onClick={() => void answer(a.chat, a.to, 'approve')}>
                Approve
              </button>
              <button className="button-secondary" disabled={busy === a.to} onClick={() => void answer(a.chat, a.to, 'decline')}>
                Decline
              </button>
            </div>
          </div>
        ),
      )}
    </div>
  );
}
