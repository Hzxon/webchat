import { useMemo } from 'react';
import type { PullRequestDTO } from '../../../shared/types';
import { agentOf } from '../agents';
import { openConversation, sharePull } from '../chat';
import { chatTitle, useAppState } from '../store';
import { Dialog } from './Dialog';
import { HashIcon, UsersIcon } from './icons';
import { Avatar } from './Avatar';

/** Picks the chat a pull request goes to. The card lands there and the chat opens. */
export function SharePullDialog({ pull, onClose }: { pull: PullRequestDTO; onClose: () => void }) {
  const conversations = useAppState((s) => s.conversations);
  const users = useAppState((s) => s.users);
  const projects = useAppState((s) => s.projects);
  const me = useAppState((s) => s.me);
  const meId = me?.id;
  // A chat with the user's own agent is the Coding agents pane's, where a card would show nowhere (D-103).
  const sorted = useMemo(
    () => Object.values(conversations).filter((c) => !agentOf({ users, me }, c)).sort((a, b) => b.updatedAt - a.updatedAt),
    [conversations, users, me],
  );

  async function pick(conversationId: number) {
    onClose();
    await openConversation(conversationId);
    await sharePull(conversationId, pull);
  }

  return (
    <Dialog title="Share to" onClose={onClose}>
      <p className="dialog-intro">
        {pull.title} ({pull.repo}#{pull.number})
      </p>
      {sorted.length === 0 ? (
        <p className="dialog-note">No chats yet. Start one from the chat list first.</p>
      ) : (
        <ul className="people-list">
          {sorted.map((conversation) => {
            const other = conversation.type === 'direct' ? conversation.members.find((m) => m.userId !== meId) : undefined;
            const user = other && users[other.userId];
            const project = conversation.projectId === null ? undefined : projects[conversation.projectId];
            return (
              <li key={conversation.id}>
                <button className="person" onClick={() => void pick(conversation.id)}>
                  {conversation.type === 'direct' ? (
                    <Avatar name={user?.displayName ?? '?'} seed={other?.userId ?? 0} size={38} online={user?.online ?? false} />
                  ) : (
                    <span className="share-mark">{conversation.type === 'channel' ? <HashIcon /> : <UsersIcon />}</span>
                  )}
                  <span>
                    <strong>{conversation.type === 'channel' ? `#${conversation.title ?? 'channel'}` : chatTitle(conversation)}</strong>
                    <small>{conversation.type === 'channel' ? (project?.name ?? 'Project') : conversation.type === 'group' ? 'Group' : `@${user?.username ?? ''}`}</small>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </Dialog>
  );
}
