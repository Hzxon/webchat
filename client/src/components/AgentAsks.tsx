// An agent's request, which `webchat-agent link <name>` or `connect` sends in the owner's direct
// chat, sealed (docs/decisions/harness-linking.md, docs/decisions/connect-approval.md). The owner
// approves or declines it here; the answer is a signed message the agent checks, so only the
// owner's page can link a harness or connect a folder.
import { useState } from 'react';
import type { AskDTO } from '../../../shared/types';
import { useAgentChats } from '../agents';
import { answerAsk } from '../chat';
import { useAppState } from '../store';

/** How long a request waits for its answer: the agent drops it after the same 10 minutes. */
const FRESH_MS = 10 * 60_000;

type Shown = { key: string; chat: number; note: string } | { key: string; chat: number; to: string; request: Extract<AskDTO, { step: 'request' }>; agent: string };

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
      return m.ask.step === 'request' && m.clientId && !answered.has(m.clientId) ? [{ key: m.clientId, chat: chat.id, to: m.clientId, request: m.ask, agent: agent?.displayName ?? 'Your agent' }] : [];
    });
  });
  if (!asks.length) return null;

  async function answer(chat: number, to: string, request: Extract<AskDTO, { step: 'request' }>, step: 'approve' | 'decline') {
    setBusy(to);
    await answerAsk(chat, to, request, step).finally(() => setBusy(''));
  }

  return (
    <div className="agents-link-asks">
      {asks.map((a) =>
        'note' in a ? (
          <p key={a.key} className="dialog-note">
            {a.note}
          </p>
        ) : (
          <div key={a.key} className="agents-link-ask" role="group" aria-label={a.request.kind === 'link' ? `Link ${a.request.harness}` : `Connect ${a.request.repo}`}>
            {a.request.kind === 'link' ? (
              <p>
                <strong>{a.agent}</strong> asks to link <strong>{a.request.harness}</strong> on its laptop. It will run the questions and cards you give it.
              </p>
            ) : (
              <p>
                <strong>{a.agent}</strong> asks to connect <strong>{a.request.repo}</strong> in <code>{a.request.folder}</code> on its laptop. It will work in that folder, and a program there can change it.
              </p>
            )}
            <div className="agents-link-buttons">
              <button className="button-primary" disabled={busy === a.to} onClick={() => void answer(a.chat, a.to, a.request, 'approve')}>
                Approve
              </button>
              <button className="button-secondary" disabled={busy === a.to} onClick={() => void answer(a.chat, a.to, a.request, 'decline')}>
                Decline
              </button>
            </div>
          </div>
        ),
      )}
    </div>
  );
}
