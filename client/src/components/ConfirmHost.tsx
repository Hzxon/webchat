import { useState } from 'react';
import { AlertDialog } from '@astryxdesign/core/AlertDialog';

type Ask = {
  title: string;
  body: string;
  confirmLabel: string;
  destructive?: boolean;
};

let show: ((ask: Ask, done: (yes: boolean) => void) => void) | null = null;

/** Replaces window.confirm: resolves true on the confirm button, false on Cancel or Escape. */
export function confirmAction(ask: Ask): Promise<boolean> {
  return new Promise((done) => show!(ask, done));
}

/** Mounted once, inside the theme. Native modal dialogs stack, so it opens over any other dialog. */
export function ConfirmHost() {
  const [open, setOpen] = useState<{
    ask: Ask;
    done: (yes: boolean) => void;
  } | null>(null);
  show = (ask, done) => setOpen({ ask, done });
  const close = (yes: boolean) => {
    open?.done(yes);
    setOpen(null);
  };
  return (
    <AlertDialog
      isOpen={!!open}
      onOpenChange={(o) => !o && close(false)}
      title={open?.ask.title ?? ''}
      description={open?.ask.body ?? ''}
      actionLabel={open?.ask.confirmLabel ?? ''}
      actionVariant={open?.ask.destructive === false ? 'primary' : 'destructive'}
      onAction={() => close(true)}
    />
  );
}
