// A session's controls (R-072): one picker for the harness and its model, the shield that picks
// where it runs and its permission mode in the user's own setup, and the summary that hands the
// session to another harness or setup (D-156, docs/decisions/new-setup-switch.md). The model and
// mode go with the next reply; picking another harness or setup asks the session for a summary,
// which the user reads and may edit before the new session starts from it.
import { Button } from '@astryxdesign/core/Button';
import { Stack } from '@astryxdesign/core/Stack';
import { Text } from '@astryxdesign/core/Text';
import { TextArea } from '@astryxdesign/core/TextArea';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { LIMITS, type PermissionMode, type UserDTO } from '../../../shared/types';
import type { Thread } from '../agents';
import { tellAgent } from '../chat';
import type { ChatMessage } from '../e2ee/keyring';
import { ModelButton, useHarnessPick } from './HarnessPicker';

type Choice = { model?: string; mode?: PermissionMode };

/**
 * The ask box's model button for a session: its harness and model, and in the user's own setup its
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
      locked={isDisabled}
      onPick={({ harness, model }) => {
        if (harness === thread.harness) return onChoice({ ...choice, model });
        void tellAgent(thread.conversationId, thread.root, 'reply', `Hand over to ${harness}`, { handover: { harness } });
      }}
    />
  );
}

/** A session's shield: where it runs, and switching it to the other setup by a hand over (docs/decisions/new-setup-switch.md). */
export function ThreadSetup({ thread, agent, choice, onChoice, isDisabled }: { thread: Thread; agent: UserDTO; choice: Choice; onChoice: (choice: Choice) => void; isDisabled: boolean }) {
  const { own: owns } = useHarnessPick(agent, true);
  // What the session says it runs with, else what its prompt asked for.
  const first = thread.messages[0]?.prompt;
  const own = thread.about?.own ?? (first?.kind === 'prompt' && !!first.own);
  // The mode the session runs with: the newest one sent, which the agent keeps for the turns after.
  const sent = thread.messages.findLast((m) => (m.prompt?.kind === 'prompt' || m.prompt?.kind === 'reply') && m.prompt.mode)?.prompt;
  const mode = choice.mode ?? (sent && 'mode' in sent ? sent.mode : undefined) ?? 'default';
  return (
    <SetupButton
      own={own}
      canOwn={!!thread.harness && owns.includes(thread.harness)}
      harness={thread.harness}
      mode={mode}
      isDisabled={isDisabled}
      onMode={(m) => onChoice({ ...choice, mode: m })}
      onOwn={(to) =>
        void tellAgent(thread.conversationId, thread.root, 'reply', to ? 'Switch to your own setup' : 'Switch to restricted by WebChat', {
          handover: { harness: thread.harness!, own: to },
        })
      }
    />
  );
}

export const MODE_WORDS: Record<PermissionMode, [string, string]> = {
  auto: ['Auto', 'It acts without asking, and its own check stops a risky action.'],
  default: ['Asks before it acts', 'It asks you before an edit or a command.'],
  acceptEdits: ['Accepts edits', 'It edits files without asking, and asks before a command.'],
  plan: ['Plan first', 'It reads and plans, and changes nothing until you say go.'],
};

const OWN_TITLE = 'Runs in your folder with your own settings, hooks, plugins, MCP servers and permission rules, and no sandbox of WebChat’s.';
const RESTRICTED_TITLE = 'Runs in WebChat’s sandbox and never reads your settings or secrets.';

/**
 * The shield under the ask box: it opens where a session runs, restricted by WebChat or in the
 * user's own setup, and the permission mode there. A restricted session keeps the mode WebChat
 * sets (D-115).
 */
export function SetupButton({
  own,
  canOwn,
  harness,
  mode,
  isDisabled,
  onOwn,
  onMode,
}: {
  own: boolean;
  canOwn: boolean;
  harness?: string;
  mode: PermissionMode;
  isDisabled?: boolean;
  onOwn: (own: boolean) => void;
  onMode: (mode: PermissionMode) => void;
}) {
  const [open, setOpen] = useState(false);
  const pick = (act: () => void) => {
    setOpen(false);
    act();
  };
  return (
    <>
      <button
        type="button"
        className={`agents-mode${own ? ' is-own' : ''}`}
        aria-expanded={open}
        disabled={isDisabled}
        title={own ? OWN_TITLE : RESTRICTED_TITLE}
        onClick={() => setOpen(!open)}
      >
        <ShieldIcon own={own} />
        {own ? 'Your own setup' : 'Restricted by WebChat'}
        {own && <span className="model-button-mode">{MODE_WORDS[mode][0]}</span>}
      </button>
      {open && (
        <Popover className="setup-menu" label="Where it runs and permissions" onClose={() => setOpen(false)}>
          <div role="radiogroup" aria-label="Runs in">
            <span className="model-picker-head">Runs in</span>
            <button type="button" role="radio" aria-checked={!own} title={RESTRICTED_TITLE} onClick={() => pick(() => own && onOwn(false))}>
              Restricted by WebChat
            </button>
            <button
              type="button"
              role="radio"
              aria-checked={own}
              disabled={!canOwn}
              title={canOwn ? OWN_TITLE : `Turn on your own setup for ${harness ?? 'a coding agent'} in Agent settings to run a chat there.`}
              onClick={() => pick(() => !own && onOwn(true))}
            >
              Your own setup
            </button>
          </div>
          <div role="radiogroup" aria-label="Permissions">
            <span className="model-picker-head">Permissions</span>
            {own ? (
              (Object.keys(MODE_WORDS) as PermissionMode[]).map((m) => (
                <button
                  key={m}
                  type="button"
                  role="radio"
                  aria-checked={m === mode}
                  title={MODE_WORDS[m][1]}
                  onClick={() => pick(() => onMode(m))}
                >
                  {MODE_WORDS[m][0]}
                </button>
              ))
            ) : (
              <p>WebChat sets them in a restricted session.</p>
            )}
          </div>
        </Popover>
      )}
    </>
  );
}

/** A small panel that closes on a click outside it or on Escape. */
export function Popover({
  className,
  role = 'dialog',
  label,
  onClose,
  children,
}: {
  className: string;
  role?: 'dialog' | 'menu';
  label: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const away = (e: PointerEvent) => {
      const target = e.target as Element;
      // The button that opened it toggles it itself.
      if (!box.current?.contains(target) && !target.closest('[aria-expanded]')) onClose();
    };
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('pointerdown', away);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('pointerdown', away);
      document.removeEventListener('keydown', esc);
    };
  }, []);
  return (
    <div ref={box} className={`agents-popover ${className}`} role={role} aria-label={label}>
      {children}
    </div>
  );
}


export const ShieldIcon = ({ own }: { own: boolean }) => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M12 3l7 3v5c0 4.5-3 8-7 10-4-2-7-5.5-7-10V6z" />
    {own ? (
      <>
        <line x1="12" y1="8" x2="12" y2="12.5" />
        <circle cx="12" cy="15.5" r=".6" fill="currentColor" />
      </>
    ) : (
      <polyline points="9 12 11 14 15 10" />
    )}
  </svg>
);

/** The summary for a hand over, as plain text the user may edit, and the button that hands it over (D-156). */
export function Summary({ thread, message }: { thread: Thread; message: ChatMessage }) {
  const harness = message.prompt?.kind === 'summary' ? message.prompt.harness : '';
  // The setup it switches to, if it does (docs/decisions/new-setup-switch.md).
  const own = message.prompt?.kind === 'summary' ? message.prompt.own : undefined;
  const to = own === undefined ? harness : `${harness} ${own ? 'in your own setup' : 'restricted by WebChat'}`;
  // Once handed over, the summary as the user sent it, edits and all.
  const sent = thread.messages.find((m) => m.id > message.id && m.prompt?.kind === 'reply' && m.prompt.handover?.summary !== undefined)?.prompt;
  const [text, setText] = useState((sent?.kind === 'reply' && sent.handover?.summary) || message.text);
  // Only the newest summary hands over, and only once.
  const open = thread.messages.at(-1) === message && thread.state !== 'working';
  return (
    <Stack gap={2}>
      <Text weight="semibold">A summary for {to}, which starts from it and the files alone</Text>
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
          label={`Hand over to ${to}`}
          isDisabled={!text.trim()}
          onClick={() =>
            void tellAgent(thread.conversationId, thread.root, 'reply', `Hand over to ${to}`, {
              handover: { harness, summary: text, ...(own !== undefined && { own }) },
            })
          }
        />
      )}
    </Stack>
  );
}
