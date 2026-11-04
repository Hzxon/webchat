// A shared doc in a project: its sections as Markdown, who is editing which, and each section's
// history (R-020). Editing a section locks it, so two people never write over each other.
import { useEffect, useMemo, useRef, useState } from 'react';
import { LIMITS } from '../../../shared/types';
import { ApiError } from '../api';
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
  type DocSection,
  type Editing,
} from '../docs';
import type { ChatDoc } from '../e2ee/keyring';
import { keyedQueue } from '../queue';
import { actions, senderName, useAppState } from '../store';
import { Dialog } from './Dialog';
import { formatAgo, formatListTime } from './format';
import { BackIcon, FileIcon, HistoryIcon, PencilIcon, PlusIcon, PrinterIcon } from './icons';
import { Markdown } from './Markdown';

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
        <button className="icon-button back-button" onClick={() => actions.setDocOpen(null)} aria-label="Back to projects">
          <BackIcon />
        </button>
        <span className="avatar avatar-square doc-avatar">
          <FileIcon />
        </span>
        <div className="chat-header-text">
          <strong>{doc.name}</strong>
          <span>
            {project?.name} · {nameOf(doc.updatedBy)} edited {formatAgo(doc.updatedAt)} · {words} words
          </span>
        </div>
        <div className="header-end">
          <button className="icon-button" onClick={() => print()} title="Export to PDF" aria-label="Export to PDF">
            <PrinterIcon />
          </button>
        </div>
      </header>
      <div className="doc-scroll">
        <article className="doc-page">
          <h1 className="doc-title">{doc.name}</h1>
          {error && <p className="form-error">{error}</p>}
          {sections === null && !error && <p className="doc-note">Loading…</p>}
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
                  <button
                    className="icon-button icon-button-small"
                    onClick={() => void edit(section.id, section.text, section.pos)}
                    disabled={editing !== null || !!lock || section.failed}
                    title="Edit"
                    aria-label="Edit section"
                  >
                    <PencilIcon width={18} height={18} />
                  </button>
                  <button className="icon-button icon-button-small" onClick={() => setHistoryOf(section)} title="History" aria-label="Section history">
                    <HistoryIcon width={18} height={18} />
                  </button>
                  <button
                    className="icon-button icon-button-small"
                    onClick={() => addAfter(index)}
                    disabled={editing !== null}
                    title="Add a section below"
                    aria-label="Add a section below"
                  >
                    <PlusIcon width={18} height={18} />
                  </button>
                </div>
                {section.failed ? (
                  <p className="doc-note">This section could not be decrypted.</p>
                ) : section.text.trim() ? (
                  <Markdown text={section.text} />
                ) : (
                  <p className="doc-note">Empty section</p>
                )}
              </div>
            );
          })}
          {sections !== null && (
            <button className="button-secondary doc-add" onClick={() => addAfter(list.length - 1)} disabled={editing !== null}>
              <PlusIcon width={18} height={18} /> Add a section
            </button>
          )}
        </article>
      </div>
      {historyOf && <HistoryDialog doc={doc} section={historyOf} nameOf={nameOf} onClose={() => setHistoryOf(null)} />}
    </section>
  );
}

/** Edits one section, for a doc or a board card. Done shows it rendered, so there is no preview. */
export function SectionEditor({ doc, editing, onClose }: { doc: ChatDoc; editing: Editing; onClose: (message?: string) => void }) {
  const [text, setText] = useState(editing.text);
  const [status, setStatus] = useState('');
  const latest = useRef(text);
  latest.current = text;
  const saved = useRef(editing.saved);
  const mounted = useRef(true);
  const draft = draftName(doc.id, editing.id);

  /** Saves what the editor holds, unless the server has it already. */
  const flush = () =>
    saveInOrder(editing.id, async () => {
      const content = latest.current;
      if (content === saved.current) return;
      setStatus('Saving…');
      await saveSection(doc, editing.id, { text: content, pos: editing.pos });
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
    if (!confirm('Delete this section from the doc? Its history stays.')) return;
    try {
      await saveInOrder(editing.id, () => saveSection(doc, editing.id, { text: saved.current, pos: editing.pos, removed: true }));
      saveDraft(draft, '');
      await stopEditing(doc.id, editing.id);
      onClose();
      void syncNow();
    } catch (err) {
      fail(err);
    }
  }

  return (
    <div className="doc-section doc-editor">
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
        <span className="doc-note">{status}</span>
        {!editing.isNew && (
          <button className="button-danger" onClick={() => void remove()}>
            Delete
          </button>
        )}
        <button className="button-primary" onClick={() => void done()}>
          Done
        </button>
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
      <form
        className="dialog-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (name.trim()) void save();
        }}
      >
        <label className="field">
          Title
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={LIMITS.docTitleLength} />
        </label>
        {error && <p className="form-error">{error}</p>}
        <button className="button-primary" type="submit" disabled={busy || !name.trim()}>
          Save
        </button>
      </form>
    </Dialog>
  );
}

type History = Awaited<ReturnType<typeof sectionHistory>>;

/** A section's editing sessions, newest first. Each shows what it changed, and an older one can come back. */
export function HistoryDialog(props: { doc: ChatDoc; section: DocSection; nameOf: (id: number) => string; onClose: () => void }) {
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
    <Dialog title="Section history" onClose={onClose}>
      {entries === null && !error && <p className="dialog-intro">Loading…</p>}
      {entries && (
        <ol className="doc-history">
          {entries.map(({ revision }, i) => (
            <li key={revision.id}>
              <button className={i === picked ? 'is-active' : ''} aria-pressed={i === picked} onClick={() => setPicked(i)}>
                <strong>{nameOf(revision.authorId)}</strong>
                <time>{formatListTime(revision.updatedAt)}</time>
              </button>
            </li>
          ))}
        </ol>
      )}
      {entry && !entry.content && <p className="dialog-intro">This version could not be decrypted.</p>}
      {diff && (
        <pre className="doc-diff" aria-label="What this version changed">
          {diff.map((line, i) => (
            <span key={i} className={`diff-${line.kind}`}>
              {line.kind === 'added' ? '+ ' : line.kind === 'removed' ? '− ' : '  '}
              {line.text}
              {'\n'}
            </span>
          ))}
        </pre>
      )}
      {error && <p className="form-error">{error}</p>}
      {picked > 0 && entry?.content && (
        <button className="button-secondary" onClick={() => void restore()} disabled={busy}>
          Restore this version
        </button>
      )}
    </Dialog>
  );
}
