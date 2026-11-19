// What a session runs with, beside its timeline (R-072): the agent's plan, the files it changed, the
// harness with its plugins, skills, hooks and MCP servers, and how much context the newest turn sent.
// All of it is the harness's own text, shown as plain text.
import { List, ListItem } from '@astryxdesign/core/List';
import { Stack } from '@astryxdesign/core/Stack';
import { Text } from '@astryxdesign/core/Text';
import type { Thread } from '../agents';

const PLAN_MARKS: Record<string, string> = { '[x]': 'Done', '[~]': 'Doing', '[ ]': 'To do' };

/** A count in words, or nothing when the harness did not say. */
const counted = (n: number | undefined, one: string) => (n === undefined ? undefined : `${n} ${one}${n === 1 ? '' : 's'}`);

export function SessionDetails({ thread }: { thread: Thread }) {
  const events = (thread.steps ?? []).flatMap((s) => s.events);
  const plan = events.findLast((e) => e.kind === 'plan')?.detail?.split('\n').filter(Boolean) ?? [];
  const changed = [...new Set(events.filter((e) => e.kind === 'edit').map((e) => e.title))];
  const about = thread.about ?? {};
  const counts = [counted(about.plugins, 'plugin'), counted(about.skills, 'skill'), counted(about.hooks, 'hook'), counted(about.mcp?.length, 'MCP server')].filter(Boolean);
  return (
    <Stack gap={4} padding={4}>
      {plan.length > 0 && (
        <List edge="flush" header="Plan">
          {plan.map((line, i) => (
            <ListItem key={i} label={line.slice(4)} description={PLAN_MARKS[line.slice(0, 3)]} />
          ))}
        </List>
      )}
      {changed.length > 0 && (
        <List edge="flush" header="Changed files">
          {changed.map((file) => (
            <ListItem key={file} label={file} />
          ))}
        </List>
      )}
      <Stack gap={1}>
        <Text weight="semibold">{[thread.harness, about.model].filter(Boolean).join(' · ') || 'Coding agent'}</Text>
        {about.own !== undefined && <Text color="secondary">{about.own ? 'Your own setup' : 'Restricted by WebChat'}</Text>}
        {counts.length > 0 && <Text color="secondary">{counts.join(', ')}</Text>}
        {about.mcp && about.mcp.length > 0 && <Text color="secondary">MCP: {about.mcp.join(', ')}</Text>}
        {about.context !== undefined && (
          <Text color="secondary">Context: {Math.round(about.context / 1000)}k tokens in the newest turn</Text>
        )}
      </Stack>
    </Stack>
  );
}
