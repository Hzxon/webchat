import { useSyncExternalStore, type ReactNode } from 'react';
import { Dialog, DialogHeader } from '@astryxdesign/core/Dialog';
import { IconButton } from '@astryxdesign/core/IconButton';
import { Stack } from '@astryxdesign/core/Stack';
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
 * backdrop click from closing it once a field was used.
 */
export function CardPeek({
  title,
  prev,
  next,
  onOpen,
  onClose,
  children,
}: {
  title: string;
  prev?: string;
  next?: string;
  onOpen: (id: string) => void;
  onClose: () => void;
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
      width={900}
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
      {/* The card's tools sit right under the header's line, so the top pads less than the sides. */}
      <Stack gap={4} padding={5} paddingBlockStart={2}>
        {children}
      </Stack>
    </Dialog>
  );
}
