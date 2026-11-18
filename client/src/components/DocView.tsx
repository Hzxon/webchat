// A shared doc in a project: its sections as Markdown, who is editing which, and each section's
// history (R-020). Editing a section locks it, so two people never write over each other.
import { useEffect, useMemo, useRef, useState } from 'react';
import { Banner } from '@astryxdesign/core/Banner';
import { Button } from '@astryxdesign/core/Button';
import { CodeBlock } from '@astryxdesign/core/CodeBlock';
import { IconButton } from '@astryxdesign/core/IconButton';
import { List, ListItem } from '@astryxdesign/core/List';
import { Stack } from '@astryxdesign/core/Stack';
import { Text } from '@astryxdesign/core/Text';
import { TextInput } from '@astryxdesign/core/TextInput';
import type { DocSection } from '../../../shared/board';
import { LIMITS } from '../../../shared/types';
import { ApiError } from '../api';
import { holdReloadWhile } from '../build';
import { saveDraft, syncNow } from '../chat';
import {
  beginEditing,
  draftName,
  lineDiff,
  loadSections,
  markSeen,
  newSectionId,
  replaceSection,
  saveSection,
  sectionHistory,
  stopEditing,
  wordCount,
  type Editing,
} from '../docs';
import type { ChatDoc } from '../e2ee/keyring';
import { keyedQueue } from '../queue';
import { actions, senderName, useAppState } from '../store';
import { Dialog } from './Dialog';
import { formatAgo, formatListTime } from './format';
import { BackIcon, FileIcon, HistoryIcon, PencilIcon, PlusIcon, PrinterIcon } from './icons';
import { Markdown } from './Markdown';
import { confirmAction } from './ConfirmHost';

// A section's saves go out one at a time, so an older one never lands after a newer one.
const saveInOrder = keyedQueue();

export function DocView({ doc }: { doc: ChatDoc }) {
  const users = useAppState((s) => s.users);
  const meId = useAppState((s) => s.me?.id);
  const project = useAppState((s) => s.projects[s.conversations[doc.conversationId]?.projectId ?? -1]);
  const [sections, setSections] = useState<DocSection[] | null>(null);
  const [error, setError] = useState('');
  const [editing, setEditingSection] = useState<Editing | null>(null);
  const [historyOf, setHistoryOf] = useState<DocSection | null>(null);

  // Every save grows the version, so the sections load again whenever anyone saves.
  useEffect(() => {
    let live = true;
    loadSections(doc).then(
      (loaded) => live && setSections(loaded),
      (err: Error) => live && setError(err.message),
    );
    markSeen(doc);
    return () => {
      live = false;
    };
  }, [doc.id, doc.version]);

  const nameOf = (id: number) => (id === meId ? 'You' : senderName(users, id));
  const lockOf = (section: string) => doc.locks.find((l) => l.section === section && l.userId !== meId);
  const list = sections ?? [];
  const words = useMemo(() => wordCount(list.map((s) => s.text)), [sections]);

  async function edit(id: string, saved: string, pos: number, isNew = false) {
    setError('');
    try {
      setEditingSection(await beginEditing(doc.id, id, saved, pos, isNew));
    } catch (err) {
      setError((err as Error).message);
    }
  }

  /** A new section after the one at `index`, or at the end. */
  function addAfter(index: number) {
    const before = list[index]?.pos ?? 0;
    const after = list[index + 1]?.pos;
    void edit(newSectionId(), '', after === undefined ? before + 1 : (before + after) / 2, true);
  }

  // A new section shows in its place while it is written, before its first save.
  const shown =
    editing && !list.some((s) => s.id === editing.id)
      ? [...list, { id: editing.id, text: '', pos: editing.pos, failed: false }].sort((a, b) => a.pos - b.pos)
      : list;

  return (
    <section className="chat doc-view">
      <header className="chat-header">
        <IconButton
          className="back-button"
          variant="ghost"
          label="Back to projects"
          onClick={() => actions.setDocOpen(null)}
          icon={<BackIcon />}
        />
        <span className="avatar avatar-square doc-avatar">
          <FileIcon />
        </span>
        <Stack gap={0} className="chat-header-text">
          <Text weight="semibold" maxLines={1}>
            {doc.name}
          </Text>
          <Text type="supporting" color="secondary" maxLines={1}>
            {project?.name} · {nameOf(doc.updatedBy)} edited {formatAgo(doc.updatedAt)} · {words} words
          </Text>
        </Stack>
        <IconButton variant="ghost" label="Export to PDF" tooltip="Export to PDF" onClick={() => print()} icon={<PrinterIcon />} />
      </header>
      <div className="doc-scroll">
        <article className="doc-page">
          <h1 className="doc-title">{doc.name}</h1>
          {error && <Banner status="error" title={error} />}
          {sections === null && !error && <Text as="p" color="secondary">
              Loading…
            </Text>}
          {shown.map((section, index) => {
            if (editing?.id === section.id) {
              return (
                <SectionEditor
                  key={editing.id}
                  doc={doc}
                  editing={editing}
                  onClose={(message) => {
                    setEditingSection(null);
                    setError(message ?? '');
                  }}
                />
              );
            }
            const lock = lockOf(section.id);
            return (
              <div key={section.id} className={`doc-section ${lock ? 'is-locked' : ''}`}>
                <div className="doc-section-tools">
                  {lock && <span className="doc-lock">{nameOf(lock.userId)} is editing</span>}
                  <IconButton
                    variant="ghost"
                    size="sm"
                    label="Edit section"
                    tooltip="Edit"
                    onClick={() => void edit(section.id, section.text, section.pos)}
                    isDisabled={editing !== null || !!lock || section.failed}
                    icon={<PencilIcon width={18} height={18} />}
                  />
                  <IconButton
                    variant="ghost"
                    size="sm"
                    label="Section history"
                    tooltip="History"
                    onClick={() => setHistoryOf(section)}
                    icon={<HistoryIcon width={18} height={18} />}
                  />
                  <IconButton
                    variant="ghost"
                    size="sm"
                    label="Add a section below"
                    tooltip="Add a section below"
                    onClick={() => addAfter(index)}
                    isDisabled={editing !== null}
                    icon={<PlusIcon width={18} height={18} />}
                  />
                </div>
                {section.failed ? (
                  <Text as="p" color="secondary">
                    This section could not be decrypted.
                  </Text>
                ) : section.text.trim() ? (
                  <Markdown text={section.text} />
                ) : (
                  <Text as="p" color="secondary">
                    Empty section
                  </Text>
                )}
              </div>
            );
          })}
          {sections !== null && (
            <Button
              className="doc-add"
              label="Add a section"
              icon={<PlusIcon width={18} height={18} />}
              onClick={() => addAfter(list.length - 1)}
              isDisabled={editing !== null}
            />
          )}
        </article>
      </div>
      {historyOf && <HistoryDialog doc={doc} section={historyOf} nameOf={nameOf} onClose={() => setHistoryOf(null)} />}
    </section>
  );
}

/**
 * Edits one section, for a doc or a board card. Done shows it rendered, so there is no preview. A
 * card with an owner offers Delete only to its owner (the card-owner decision).
 */
export function SectionEditor({
  doc,
  editing,
  onClose,
  canDelete = true,
  toSave,
}: {
  doc: ChatDoc;
  editing: Editing;
  onClose: (message?: string) => void;
  canDelete?: boolean;
  /** What a save writes for the text typed, as a board card keeps the review lines that stand. */
  toSave?: (text: string) => string;
}) {
  const [text, setText] = useState(editing.text);
  const [status, setStatus] = useState('');
  const latest = useRef(text);
  latest.current = text;
  const saved = useRef(editing.saved);
  // A new section reaches the server on its first save, which a cancel takes back. Once cancelled,
  // nothing saves, not even the save on leaving.
  const stored = useRef(!editing.isNew);
  const dropped = useRef(false);
  const mounted = useRef(true);
  const draft = draftName(doc.id, editing.id);

  /** Saves what the editor holds, unless the server has it already. */
  const flush = () =>
    saveInOrder(editing.id, async () => {
      const content = latest.current;
      if (dropped.current || content === saved.current) return;
      setStatus('Saving…');
      await saveSection(doc, editing.id, { text: toSave ? toSave(content) : content, pos: editing.pos });
      stored.current = true;
      saved.current = content;
      if (latest.current === content) {
        setStatus('Saved');
        saveDraft(draft, '');
      }
    });

  function fail(err: unknown) {
    if (err instanceof ApiError && err.code === 'not_locked') {
      void stopEditing(doc.id, editing.id).catch(() => undefined);
      onClose('Someone else is editing this section now. What you wrote stays on this device, and comes back when you edit it again.');
    } else {
      setStatus((err as Error).message);
    }
  }

  // A reload address cannot name the section, so a reload would close the editor (K-63).
  useEffect(() => holdReloadWhile(() => true), []);

  // Each change goes to the device at once, and to the server after a pause in typing.
  useEffect(() => {
    if (text === saved.current) return;
    saveDraft(draft, text);
    const timer = setTimeout(() => flush().catch(fail), 1000);
    return () => clearTimeout(timer);
  }, [text]);

  // Leaving the doc saves the section and frees it. React mounts twice in development, so the
  // timer lets the second mount cancel what the first one's unmount would do.
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      setTimeout(() => {
        if (!mounted.current) void flush().finally(() => stopEditing(doc.id, editing.id)).catch(() => undefined);
      });
    };
  }, []);

  async function done() {
    try {
      await flush();
      await stopEditing(doc.id, editing.id);
      onClose();
      void syncNow();
    } catch (err) {
      fail(err);
    }
  }

  async function remove() {
    if (
      !(await confirmAction({
        title: 'Delete this section from the doc?',
        body: 'Its history stays.',
        confirmLabel: 'Delete section',
      }))
    )
      return;
    try {
      await saveInOrder(editing.id, () =>
        saveSection(doc, editing.id, {
          text: saved.current,
          pos: editing.pos,
          removed: true,
        }),
      );
      saveDraft(draft, '');
      await stopEditing(doc.id, editing.id);
      onClose();
      void syncNow();
    } catch (err) {
      fail(err);
    }
  }

  /** Drops a new section, or puts an old one back as it was when the editor opened: a pause in typing saved over it. */
  async function cancel() {
    dropped.current = true;
    try {
      await saveInOrder(editing.id, async () => {
        if (editing.isNew) {
          if (stored.current)
            await saveSection(doc, editing.id, { text: saved.current, pos: editing.pos, removed: true });
        } else if (saved.current !== editing.saved) {
          await saveSection(doc, editing.id, { text: editing.saved, pos: editing.pos });
        }
      });
      saveDraft(draft, '');
      await stopEditing(doc.id, editing.id);
      onClose();
      void syncNow();
    } catch (err) {
      dropped.current = false;
      fail(err);
    }
  }

  return (
    <div
      className="doc-section doc-editor"
      onKeyDown={(e) => {
        if (e.key === 'Escape') void cancel();
      }}
    >
      <textarea
        className="field-input doc-textarea"
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={Math.max(6, text.split('\n').length + 1)}
        maxLength={LIMITS.docSectionLength}
        placeholder="Write in Markdown: ## Heading, - list, - [ ] task, **bold**, | table |"
        autoFocus
      />
      <div className="doc-editor-actions">
        {!editing.isNew && canDelete && <Button variant="destructive" label="Delete" onClick={() => void remove()} />}
        <Text color="secondary" className="doc-editor-status">
          {status}
        </Text>
        <Button label="Cancel" onClick={() => void cancel()} />
        <Button variant="primary" label="Done" onClick={() => void done()} />
      </div>
    </div>
  );
}

/** Opened by the pencil next to the doc's name in the sidebar. */
export function RenameDialog({ doc, onClose }: { doc: ChatDoc; onClose: () => void }) {
  const [name, setName] = useState(doc.name);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function save() {
    setBusy(true);
    try {
      await replaceSection(doc, 'title', { text: name.trim() });
      onClose();
      void syncNow();
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <Dialog title="Rename doc" onClose={onClose}>
      <Stack
        as="form"
        gap={4}
        onSubmit={(e: React.FormEvent) => {
          e.preventDefault();
          if (name.trim()) void save();
        }}
      >
        <TextInput label="Title" value={name} onChange={(v) => setName(v.slice(0, LIMITS.docTitleLength))} hasAutoFocus />
        {error && <Banner status="error" title={error} />}
        <Button variant="primary" type="submit" isLoading={busy} isDisabled={!name.trim()} label="Save" />
      </Stack>
    </Dialog>
  );
}

type History = Awaited<ReturnType<typeof sectionHistory>>;

/** A section's editing sessions, newest first. Each shows what it changed, and an older one can come back. */
export function HistoryDialog(props: HistoryProps) {
  return (
    <Dialog title="Section history" onClose={props.onClose}>
      <SectionHistory {...props} />
    </Dialog>
  );
}

type HistoryProps = { doc: ChatDoc; section: DocSection; nameOf: (id: number) => string; onClose: () => void };

/** The history alone, for a board card's peek, which shows it in place of the card rather than in a second dialog. */
export function SectionHistory(props: HistoryProps) {
  const { doc, section, nameOf, onClose } = props;
  const [entries, setEntries] = useState<History | null>(null);
  const [picked, setPicked] = useState(0);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    sectionHistory(doc, section.id).then(setEntries, (err: Error) => setError(err.message));
  }, []);

  const entry = entries?.[picked];
  const before = entries?.[picked + 1]?.content?.text ?? '';
  const diff = useMemo(() => entry?.content && lineDiff(before, entry.content.removed ? '' : entry.content.text), [entry, before]);

  async function restore() {
    setBusy(true);
    try {
      await replaceSection(doc, section.id, { text: entry!.content!.text, pos: section.pos });
      onClose();
      void syncNow();
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <>
      {entries === null && !error && (
        <Text as="p" color="secondary">
          Loading…
        </Text>
      )}
      {entries && (
        <List edge="flush" listStyle="decimal">
          {entries.map(({ revision }, i) => (
            <ListItem
              key={revision.id}
              label={nameOf(revision.authorId)}
              endContent={<Text color="secondary">{formatListTime(revision.updatedAt)}</Text>}
              isSelected={i === picked}
              onClick={() => setPicked(i)}
            />
          ))}
        </List>
      )}
      {entry && !entry.content && (
        <Text as="p" color="secondary">
          This version could not be decrypted.
        </Text>
      )}
      {diff && (
        <CodeBlock
          title="What this version changed"
          isDiff
          hasLanguageLabel={false}
          hasCopyButton={false}
          code={diff.map((line) => (line.kind === 'added' ? '+' : line.kind === 'removed' ? '-' : ' ') + line.text).join('\n')}
        />
      )}
      {error && <Banner status="error" title={error} />}
      {picked > 0 && entry?.content && <Button onClick={() => void restore()} isDisabled={busy} label="Restore this version" />}
    </>
  );
}
