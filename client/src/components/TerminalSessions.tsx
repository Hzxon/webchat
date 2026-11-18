// The sessions the user's terminal started in a connected folder, which they go on with here (R-072).
// The agent lists them only for a harness that runs in the user's own setup, where it can resume
// one in that folder. Titles are the harness's own text, shown as plain text.
import { Button } from '@astryxdesign/core/Button';
import { List, ListItem } from '@astryxdesign/core/List';
import { Text } from '@astryxdesign/core/Text';
import { useState } from 'react';
import type { ProjectDTO, UserDTO } from '../../../shared/types';
import { useAgentChat } from '../agents';
import { askAgent, askSessions } from '../chat';
import { actions, useAppState } from '../store';
import { formatAgo } from './format';

export function TerminalSessions({ agent, project, repo }: { agent: UserDTO; project: ProjectDTO; repo: string }) {
  const chat = useAgentChat(agent);
  const [asked, setAsked] = useState<string>();
  // Only the answer to this pane's ask, for the repository it named.
  const answer = useAppState((s) =>
    asked && chat ? s.messages[chat.id]?.findLast((m) => m.senderId === agent.id && m.sessionList?.to === asked)?.sessionList : undefined,
  );
  if (!asked) return <Button variant="ghost" size="sm" label="Sessions from your terminal" onClick={() => void askSessions(agent.id, repo).then(setAsked)} />;
  if (!answer) return <Text color="secondary">Asking your agent for its sessions in {repo}…</Text>;
  if (!answer.harness) return <Text color="secondary">Turn on your own setup for a coding agent in my settings to go on with a terminal’s session here.</Text>;
  if (!answer.sessions.length) return <Text color="secondary">No sessions of {answer.harness} in {repo} on your laptop.</Text>;
  return (
    <List edge="flush" header={`${answer.harness} sessions in ${repo}`}>
      {answer.sessions.map((s) => (
        <ListItem
          key={s.id}
          label={s.title}
          description={formatAgo(s.at)}
          onClick={async () =>
            actions.setAgentsOpen(true, await askAgent(agent.id, project.id, repo, 'Go on with this session from my terminal.', answer.harness, true, undefined, s.id))
          }
        />
      ))}
    </List>
  );
}
