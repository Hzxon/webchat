import type { ReactNode } from 'react';
import { Dialog as AstryxDialog, DialogHeader } from '@astryxdesign/core/Dialog';
import { Divider } from '@astryxdesign/core/Divider';
import { Stack } from '@astryxdesign/core/Stack';

/** A modal with a title and a close button. Astryx's dialog traps focus, closes on Escape, and
 * with purpose "form" ignores a backdrop click once a field was used, so no typing is lost. */
/** A footer holds the dialog's actions under a line, aligned to the end. */
export function Dialog({ title, onClose, children, footer }: { title: string; onClose: () => void; children: ReactNode; footer?: ReactNode }) {
  const close = (open: boolean) => {
    if (!open) onClose();
  };
  return (
    <AstryxDialog isOpen onOpenChange={close} purpose="form" width={440} maxHeight="min(680px, 85dvh)">
      <DialogHeader title={title} onOpenChange={close} />
      <Stack gap={4} padding={5}>
        {children}
      </Stack>
      {footer && (
        <>
          <Divider />
          <Stack direction="horizontal" gap={2} hAlign="end" vAlign="center" paddingInline={5} paddingBlock={3}>
            {footer}
          </Stack>
        </>
      )}
    </AstryxDialog>
  );
}
