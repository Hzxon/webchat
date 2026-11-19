// A harness session's steps, as the agent sent them (R-072): a run of thinking, reads and searches
// folds to one line, and a command, an edit, a tool call and the agent's words stay open. Every
// field is the harness's own text, shown as plain text, never Markdown: a command can hide in it.
import { CodeBlock } from '@astryxdesign/core/CodeBlock';
import { Collapsible } from '@astryxdesign/core/Collapsible';
import { Stack } from '@astryxdesign/core/Stack';
import { Text } from '@astryxdesign/core/Text';
import type { SessionEventDTO } from '../../../shared/types';

const FOLDS: ReadonlySet<SessionEventDTO['kind']> = new Set(['thinking', 'read', 'search']);

/** Lines of plain text, each its own paragraph, so a line break shows without Markdown. */
const Lines = ({ text }: { text: string }) => (
  <Stack gap={1}>
    {text.split('\n').map((line, i) => (
      <Text key={i} as="p" color="secondary">
        {line || ' '}
      </Text>
    ))}
  </Stack>
);

/** A folded run in words, such as "Thought, read 3 files and searched twice". */
export function foldLine(events: SessionEventDTO[]) {
  const count = (kind: SessionEventDTO['kind']) => events.filter((e) => e.kind === kind).length;
  const times = (n: number, one: string, many: string) => (n === 1 ? one : many.replace('#', String(n)));
  const parts = [
    count('thinking') && 'Thought',
    count('read') && times(count('read'), 'read a file', 'read # files'),
    count('search') && times(count('search'), 'searched once', 'searched # times'),
  ].filter((p): p is string => !!p);
  const line = parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}` : parts[0]!;
  return line.charAt(0).toUpperCase() + line.slice(1);
}

function Step({ event }: { event: SessionEventDTO }) {
  if (event.kind === 'thinking' || event.kind === 'text') return <Lines text={event.detail ?? event.title} />;
  if (event.kind === 'read' || event.kind === 'search')
    return (
      <Text as="p" color="secondary">
        {event.kind === 'read' ? 'Read' : 'Searched for'} {event.title}
      </Text>
    );
  // A command with its output, an edit with its change, or another tool with its arguments.
  return (
    <CodeBlock
      code={
        event.kind === 'command'
          ? `$ ${event.title}${event.detail ? `\n${event.detail}` : ''}`
          : (event.detail ?? event.title)
      }
      title={event.kind === 'edit' ? event.title : undefined}
      language="plaintext"
      isDiff={event.kind === 'edit' && event.detail?.startsWith('- ')}
      isWrapped
      maxHeight={240}
      size="sm"
      width="100%"
    />
  );
}

export function SessionSteps({ events }: { events: SessionEventDTO[] }) {
  // Consecutive folded kinds go together; anything else stands alone.
  const groups: SessionEventDTO[][] = [];
  for (const event of events) {
    const last = groups.at(-1);
    if (last && FOLDS.has(event.kind) && FOLDS.has(last[0]!.kind)) last.push(event);
    else groups.push([event]);
  }
  return (
    <Stack gap={2}>
      {groups.map((group, i) =>
        FOLDS.has(group[0]!.kind) ? (
          <Collapsible
            key={i}
            defaultIsOpen={false}
            chevronPosition="start"
            trigger={<Text color="secondary">{foldLine(group)}</Text>}
          >
            <Stack gap={2}>
              {group.map((event, j) => (
                <Step key={j} event={event} />
              ))}
            </Stack>
          </Collapsible>
        ) : (
          <Step key={i} event={group[0]!} />
        ),
      )}
    </Stack>
  );
}
