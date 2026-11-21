import { Fragment, useSyncExternalStore, type ReactNode } from 'react';
import { Dialog, DialogHeader } from '@astryxdesign/core/Dialog';
import { Divider } from '@astryxdesign/core/Divider';
import { Heading } from '@astryxdesign/core/Heading';
import { IconButton } from '@astryxdesign/core/IconButton';
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
 * backdrop click from closing it once a field was used. A card's run of the user's own sits beside
 * the card, or under it at phone width (the card-run-in-peek decision, proposed in #259).
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
  runFirst,
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
  onOpen: (id: string) => void;
  onClose: () => void;
  run?: ReactNode;
  /** The run before the card, as the new card form shows the session that drafts it (R-071). */
  runFirst?: boolean;
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
      width={run ? 1200 : 900}
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
              onClick={() => onOpen(prev!)}
            />
            <IconButton
              variant="ghost"
              size="sm"
              label="Next card"
              tooltip="Next card"
              icon={<DownIcon />}
              isDisabled={!next}
              onClick={() => onOpen(next!)}
            />
          </>
        }
      />
      {/* Each column scrolls on its own, so the run's newest message and its box stay in view. */}
      <Stack direction="horizontal" className="card-peek">
        {run && runFirst && <Stack className="card-peek-run is-first">{run}</Stack>}
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
        {run && !runFirst && <Stack className="card-peek-run">{run}</Stack>}
      </Stack>
    </Dialog>
  );
}
