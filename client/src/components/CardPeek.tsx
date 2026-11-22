import { Fragment, useState, type ReactNode } from 'react';
import { Button } from '@astryxdesign/core/Button';
import { Dialog, DialogHeader } from '@astryxdesign/core/Dialog';
import { IconButton } from '@astryxdesign/core/IconButton';
import { SegmentedControl, SegmentedControlItem } from '@astryxdesign/core/SegmentedControl';
import { Text } from '@astryxdesign/core/Text';
import { BoardMenu, DotsIcon, useNarrow } from './BoardParts';
import { CloseIcon } from './icons';

/** One of the card's own buttons in the peek's header, such as History or Delete. */
export type PeekTool = { label: string; icon: ReactNode; onClick: () => void; isDisabled?: boolean };

/**
 * A board card opened over the board, with two panes: the card on the left, and on the right the
 * agent's panel, which holds the user's own run of the card or says no agent works on it (the
 * card-run-in-peek decision, proposed in #259). At phone width the peek fills the screen, the run
 * goes under the card, the agent's question stays pinned at the foot, and the card's tools sit
 * behind ⋯ in a sheet. Purpose "form" keeps a backdrop click from closing it once a field was used.
 *
 * A card that names its `id` reads as a page: the id and the tools in the header, then its title,
 * its facts as a list of names and values, and its text under a line.
 */
export function CardPeek({
  title,
  id,
  tools = [],
  facts,
  onClose,
  run,
  onRun,
  runLabel = 'Run with your agent',
  isEditing,
  onEditing,
  editOff,
  children,
}: {
  title: string;
  /** The card's id, such as R-12, which moves the title into the page. */
  id?: string;
  /** The card's own buttons, before Close. */
  tools?: PeekTool[];
  /** What the card says about itself, each a name and its value; an empty value is left out. */
  facts?: Array<[string, ReactNode]>;
  onClose: () => void;
  /** The agent's panel; with none, it says no agent works on the card. */
  run?: ReactNode;
  /** The button in the empty agent's panel, such as starting a run. */
  onRun?: () => void;
  runLabel?: string;
  isEditing: boolean;
  onEditing?: (on: boolean) => void;
  /** Why the card cannot switch to its editor now, which disables the switch. */
  editOff?: string;
  children: ReactNode;
}) {
  const phone = useNarrow();
  const [more, setMore] = useState(false);
  const close = (open: boolean) => {
    if (!open) onClose();
  };
  const closeButton = (
    <IconButton variant="ghost" size="sm" label="Close" tooltip="Close" icon={<CloseIcon width={18} height={18} />} onClick={onClose} />
  );
  const moreButton = tools.length > 0 && (
    <IconButton variant="ghost" size="sm" label="More" tooltip="More" icon={<DotsIcon />} onClick={() => setMore(true)} />
  );
  const toolButtons = tools.map((tool) => (
    <IconButton
      key={tool.label}
      variant="ghost"
      size="sm"
      label={tool.label}
      tooltip={tool.label}
      icon={tool.icon}
      isDisabled={tool.isDisabled}
      onClick={tool.onClick}
    />
  ));
  return (
    <Dialog isOpen onOpenChange={close} purpose="form" width={1120} maxHeight="90dvh" padding={0} variant={phone ? 'fullscreen' : 'standard'}>
      <DialogHeader
        title={<Text type="label" color="secondary">{id ?? title}</Text>}
        startContent={phone ? closeButton : undefined}
        endContent={
          phone ? (
            moreButton
          ) : (
            <>
              {toolButtons}
              {tools.length > 0 && <span className="peek-sep" aria-hidden="true" />}
              {closeButton}
            </>
          )
        }
      />
      {more && (
        <BoardMenu
          label="Card"
          entries={tools.filter((t) => !t.isDisabled).map((t) => ({ label: t.label, onSelect: t.onClick }))}
          onClose={() => setMore(false)}
        />
      )}
      {/* Each pane scrolls on its own, so the run's newest step and its question stay in view; on a phone the whole peek scrolls. */}
      <div className="peek-body">
        <article className="peek-card">
          <div className="peek-switch">
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
          </div>
          {id && !isEditing && <h2 className="peek-title">{title}</h2>}
          {facts && !isEditing && (
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
          {id && !isEditing && <hr className="peek-line" />}
          {children}
        </article>
        <aside className="peek-run" aria-label="The agent’s run">
          {run ?? (
            <div className="peek-no-run">
              <p>No agent works on this card.</p>
              {onRun && <Button variant="primary" size="sm" label={runLabel} onClick={onRun} />}
            </div>
          )}
        </aside>
      </div>
    </Dialog>
  );
}
