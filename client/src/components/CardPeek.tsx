import { Fragment, useSyncExternalStore, type ReactNode } from 'react';
import { Button } from '@astryxdesign/core/Button';
import { Dialog, DialogHeader } from '@astryxdesign/core/Dialog';
import { Divider } from '@astryxdesign/core/Divider';
import { Heading } from '@astryxdesign/core/Heading';
import { IconButton } from '@astryxdesign/core/IconButton';
import { SegmentedControl, SegmentedControlItem } from '@astryxdesign/core/SegmentedControl';
import { Stack, StackItem } from '@astryxdesign/core/Stack';
import { Text } from '@astryxdesign/core/Text';
import { DownIcon, UpIcon } from './icons';

// The width of the narrow layout in styles.css. Astryx's dialog takes its variant as a prop, not by breakpoint.
const narrow = matchMedia('(max-width: 760px)');
const onNarrow = (changed: () => void) => {
  narrow.addEventListener('change', changed);
  return () => narrow.removeEventListener('change', changed);
};

/**
 * A board card opened over the board, wide enough to read and, at phone width, the whole page.
 * Its arrows step to the card above or below it in its lane or list. Purpose "form" keeps a
 * backdrop click from closing it once a field was used. Every peek has two panels: the card, and
 * beside it, or under it at phone width, the agent's panel, which holds the user's own run of the
 * card or says no agent works on it (the card-run-in-peek decision, proposed in #259). The agent's
 * panel switches the card between its page and its editor, so one control does that everywhere.
 *
 * A card that names its `id` reads as a page: the id and the tools in the header, then its title,
 * its facts as a list of names and values, and its text under a line.
 */
export function CardPeek({
  title,
  id,
  tools,
  facts,
  prev,
  next,
  onOpen,
  onClose,
  run,
  onRun,
  isEditing,
  onEditing,
  editOff,
  children,
}: {
  title: string;
  /** The card's id, such as R-12, which moves the title into the page. */
  id?: string;
  /** The card's own buttons, beside the arrows. */
  tools?: ReactNode;
  /** What the card says about itself, each a name and its value; an empty value is left out. */
  facts?: Array<[string, ReactNode]>;
  prev?: string;
  next?: string;
  onOpen?: (id: string) => void;
  onClose: () => void;
  /** The agent's panel; with none, it says no agent works on the card. */
  run?: ReactNode;
  /** Starts a run where the card could be run now, from the empty agent's panel. */
  onRun?: () => void;
  isEditing: boolean;
  onEditing?: (on: boolean) => void;
  /** Why the card cannot switch to its editor now, which disables the switch. */
  editOff?: string;
  children: ReactNode;
}) {
  const phone = useSyncExternalStore(onNarrow, () => narrow.matches);
  const close = (open: boolean) => {
    if (!open) onClose();
  };
  return (
    <Dialog
      isOpen
      onOpenChange={close}
      purpose="form"
      width={1200}
      maxHeight="90dvh"
      variant={phone ? 'fullscreen' : 'standard'}
    >
      <DialogHeader
        title={id ? <Text type="label" color="secondary">{id}</Text> : title}
        onOpenChange={close}
        endContent={
          <>
            {tools}
            <IconButton
              variant="ghost"
              size="sm"
              label="Previous card"
              tooltip="Previous card"
              icon={<UpIcon />}
              isDisabled={!prev}
              onClick={() => onOpen!(prev!)}
            />
            <IconButton
              variant="ghost"
              size="sm"
              label="Next card"
              tooltip="Next card"
              icon={<DownIcon />}
              isDisabled={!next}
              onClick={() => onOpen!(next!)}
            />
          </>
        }
      />
      {/* Each column scrolls on its own, so the run's newest message and its box stay in view. */}
      <Stack direction="horizontal" className="card-peek">
        <StackItem size="fill" isScrollable>
          {/* The card's tools sit right under the header's line, so the top pads less than the sides. */}
          <Stack gap={4} padding={5} paddingBlockStart={2}>
            {id && <Heading level={2}>{title}</Heading>}
            {facts && (
              <dl className="card-facts">
                {facts
                  .filter(([, value]) => value)
                  .map(([name, value]) => (
                    <Fragment key={name}>
                      <dt>{name}</dt>
                      <dd>{value}</dd>
                    </Fragment>
                  ))}
              </dl>
            )}
            {id && <Divider />}
            {children}
          </Stack>
        </StackItem>
        <Stack className="card-peek-run">
          <header className="run-head">
            <SegmentedControl
              label="Show the card as"
              size="sm"
              value={isEditing ? 'edit' : 'preview'}
              onChange={(v) => onEditing?.(v === 'edit')}
              isDisabled={!!editOff}
              disabledMessage={editOff}
            >
              <SegmentedControlItem value="preview" label="Preview" />
              <SegmentedControlItem value="edit" label="Edit" />
            </SegmentedControl>
          </header>
          {run ?? (
            <Stack gap={3} padding={5} align="start">
              <Text as="p" color="secondary">
                No agent works on this card.
              </Text>
              {onRun && <Button label="Run with your agent" onClick={onRun} />}
            </Stack>
          )}
        </Stack>
      </Stack>
    </Dialog>
  );
}
