import type { ReactNode } from 'react';
import { Dialog as AstryxDialog, DialogHeader } from '@astryxdesign/core/Dialog';
import { Stack } from '@astryxdesign/core/Stack';

/** A modal with a title and a close button. Astryx's dialog traps focus, closes on Escape, and
 * with purpose "form" ignores a backdrop click once a field was used, so no typing is lost. */
export function Dialog({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const close = (open: boolean) => {
    if (!open) onClose();
  };
  return (
    <AstryxDialog isOpen onOpenChange={close} purpose="form" width={440} maxHeight="min(680px, 85dvh)">
      <DialogHeader title={title} onOpenChange={close} />
      <Stack gap={4} padding={5}>
        {children}
      </Stack>
    </AstryxDialog>
  );
}
