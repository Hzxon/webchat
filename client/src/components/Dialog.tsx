import { useEffect, useRef, type ReactNode } from 'react';
import { CloseIcon } from './icons';

/** Native <dialog> as a modal: focus trapping, Escape to close, and the backdrop come from the browser. */
export function Dialog({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog || dialog.open) return;
    dialog.showModal();
    // A field marked autoFocus gets no focus: React calls focus() on it when it mounts, while the
    // dialog is still closed and nothing in it can take focus. showModal() then focuses the first
    // focusable element, the close button. So the first field in the body takes the focus instead.
    dialog.querySelector<HTMLElement>('.dialog-body input, .dialog-body textarea, .dialog-body select')?.focus();
  }, []);

  return (
    <dialog
      ref={ref}
      className="dialog"
      onClose={onClose}
      onClick={(e) => {
        if (e.target === ref.current) onClose();
      }}
    >
      <div className="dialog-body">
        <header className="dialog-header">
          <h2>{title}</h2>
          <button className="icon-button" onClick={onClose} aria-label="Close">
            <CloseIcon />
          </button>
        </header>
        {children}
      </div>
    </dialog>
  );
}
