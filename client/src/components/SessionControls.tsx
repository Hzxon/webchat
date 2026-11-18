// A session's controls (R-072): one picker for the harness and its model, the permission mode in the
// user's own setup, and the summary that hands the session to another harness (D-156). The model
// and mode go with the next reply; picking another harness asks the one that ran it for a summary,
// which the user reads and may edit before the other harness starts from it.
import { Button } from '@astryxdesign/core/Button';
import { Selector } from '@astryxdesign/core/Selector';
import { Stack } from '@astryxdesign/core/Stack';
import { Text } from '@astryxdesign/core/Text';
import { TextArea } from '@astryxdesign/core/TextArea';
import { useState } from 'react';
import { LIMITS, type PermissionMode, type UserDTO } from '../../../shared/types';
import type { Thread } from '../agents';
import { tellAgent } from '../chat';
import type { ChatMessage } from '../e2ee/keyring';
import { useHarnessPick } from './HarnessPicker';

const MODE_WORDS: Record<PermissionMode, string> = { default: 'Ask before edits', acceptEdits: 'Accept edits', plan: 'Plan only' };

type Choice = { model?: string; mode?: PermissionMode };

export function Controls({
  thread,
  agent,
  choice,
  onChoice,
  isDisabled,
}: {
  thread: Thread;
  agent: UserDTO;
  choice: Choice;
  onChoice: (choice: Choice) => void;
  isDisabled: boolean;
}) {
  const { list } = useHarnessPick(agent, true);
  if (!list?.length) return null;
  // Each harness alone, which keeps its default model, then with each model it offers.
  const options = list.flatMap((h) => [
    { value: `${h.name}|`, label: h.name, description: h.reason, disabled: !!h.reason },
    ...(h.models ?? []).map((m) => ({ value: `${h.name}|${m}`, label: `${h.name} · ${m}`, disabled: !!h.reason })),
  ]);
  const pick = (value: string) => {
    const [name, model] = value.split('|') as [string, string];
    if (name === thread.harness) return onChoice({ ...choice, model: model || undefined });
    // Another harness: the one that ran it writes the summary first (D-156).
    void tellAgent(thread.conversationId, thread.root, 'reply', `Hand over to ${name}`, { handover: { harness: name } });
  };
  return (
    <Stack direction="horizontal" gap={2} vAlign="center">
      <Selector
        label="Coding agent and model"
        isLabelHidden
        size="sm"
        isDisabled={isDisabled}
        value={`${thread.harness ?? ''}|${choice.model ?? ''}`}
        onChange={pick}
        options={options}
      />
      {/* A restricted run keeps the mode WebChat sets (D-115). */}
      {thread.about?.own && (
        <Selector
          label="Permission mode"
          isLabelHidden
          size="sm"
          isDisabled={isDisabled}
          value={choice.mode ?? 'default'}
          onChange={(mode) => onChoice({ ...choice, mode: mode as PermissionMode })}
          options={(Object.keys(MODE_WORDS) as PermissionMode[]).map((m) => ({ value: m, label: MODE_WORDS[m] }))}
        />
      )}
    </Stack>
  );
}

/** The summary for a hand over, as plain text the user may edit, and the button that hands it over (D-156). */
export function Summary({ thread, message }: { thread: Thread; message: ChatMessage }) {
  const harness = message.prompt?.kind === 'summary' ? message.prompt.harness : '';
  // Once handed over, the summary as the user sent it, edits and all.
  const sent = thread.messages.find((m) => m.id > message.id && m.prompt?.kind === 'reply' && m.prompt.handover?.summary !== undefined);
  const [text, setText] = useState(sent?.prompt?.kind === 'reply' ? (sent.prompt.handover?.summary ?? message.text) : message.text);
  // Only the newest summary hands over, and only once.
  const open = thread.messages.at(-1) === message && thread.state !== 'working';
  return (
    <Stack gap={2}>
      <Text weight="semibold">A summary for {harness}, which starts from it and the files alone</Text>
      <TextArea
        label="Summary"
        isLabelHidden
        rows={6}
        value={text}
        isDisabled={!open}
        onChange={(v) => setText(v.slice(0, LIMITS.messageLength))}
      />
      {open && (
        <Button
          variant="primary"
          label={`Hand over to ${harness}`}
          isDisabled={!text.trim()}
          onClick={() =>
            void tellAgent(thread.conversationId, thread.root, 'reply', `Hand over to ${harness}`, {
              handover: { harness, summary: text },
            })
          }
        />
      )}
    </Stack>
  );
}
