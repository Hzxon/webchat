// A session's controls (R-072): one picker for the harness, its model, its effort and the permission
// mode in the user's own setup, and the summary that hands the session to another harness (D-156).
// The model, effort and mode go with the next reply; picking another harness asks the one that ran it for a summary,
// which the user reads and may edit before the other harness starts from it.
import { Button } from '@astryxdesign/core/Button';
import { Stack } from '@astryxdesign/core/Stack';
import { Text } from '@astryxdesign/core/Text';
import { TextArea } from '@astryxdesign/core/TextArea';
import { useState } from 'react';
import { LIMITS, type PermissionMode, type UserDTO } from '../../../shared/types';
import type { Thread } from '../agents';
import { tellAgent } from '../chat';
import type { ChatMessage } from '../e2ee/keyring';
import { effortsOf, ModelButton, useHarnessPick } from './HarnessPicker';

export type Choice = { model?: string; effort?: string; mode?: PermissionMode };

/**
 * The ask box's model button for a session: its harness, model and effort, and in the user's own setup its
 * permission mode. Picking another harness asks the one that ran it for a summary first (D-156).
 */
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
  if (!list?.length || !thread.harness) return null;
  return (
    <ModelButton
      up
      list={list}
      value={{ harness: thread.harness, model: choice.model ?? thread.about?.model }}
      // A restricted run keeps the mode WebChat sets (D-115).
      own={!!thread.about?.own}
      effort={choice.effort}
      mode={choice.mode ?? 'default'}
      locked={isDisabled}
      onEffort={(effort) => onChoice({ ...choice, effort })}
      onMode={(mode) => onChoice({ ...choice, mode })}
      onPick={({ harness, model }) => {
        // Another model may not take the effort picked.
        if (harness === thread.harness) return onChoice({ ...choice, model, ...(!effortsOf(list, { harness, model }).includes(choice.effort ?? '') && { effort: undefined }) });
        void tellAgent(thread.conversationId, thread.root, 'reply', `Hand over to ${harness}`, { handover: { harness } });
      }}
    />
  );
}

/** The summary for a hand over, as plain text the user may edit, and the button that hands it over (D-156). */
export function Summary({ thread, message }: { thread: Thread; message: ChatMessage }) {
  const harness = message.prompt?.kind === 'summary' ? message.prompt.harness : '';
  // Once handed over, the summary as the user sent it, edits and all.
  const sent = thread.messages.find((m) => m.id > message.id && m.prompt?.kind === 'reply' && m.prompt.handover?.summary !== undefined)?.prompt;
  const [text, setText] = useState((sent?.kind === 'reply' && sent.handover?.summary) || message.text);
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
