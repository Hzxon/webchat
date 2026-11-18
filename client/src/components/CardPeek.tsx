import { useSyncExternalStore, type ReactNode } from 'react';
import { Dialog, DialogHeader } from '@astryxdesign/core/Dialog';
import { IconButton } from '@astryxdesign/core/IconButton';
import { Stack, StackItem } from '@astryxdesign/core/Stack';
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
 */
export function CardPeek({
  title,
  prev,
  next,
  onOpen,
  onClose,
  run,
  children,
}: {
  title: string;
  prev?: string;
  next?: string;
  onOpen: (id: string) => void;
  onClose: () => void;
  run?: ReactNode;
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
        title={title}
        onOpenChange={close}
        endContent={
          <>
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
        <StackItem size="fill" isScrollable>
          {/* The card's tools sit right under the header's line, so the top pads less than the sides. */}
          <Stack gap={4} padding={5} paddingBlockStart={2}>
            {children}
          </Stack>
        </StackItem>
        {run && <Stack className="card-peek-run">{run}</Stack>}
      </Stack>
    </Dialog>
  );
}
