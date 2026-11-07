// Shared Markdown docs in projects (R-020, D-081). A doc is a title and sections, each sealed with
// the key of the project's #general channel and signed by its author. One person edits a section at
// a time: editing locks it on the server, and every check-in of the editing tab keeps the lock.
import { newKeyId, randomBytes, toBase64Url, type DocContent } from '../../shared/e2ee';
import type { DocRevisionDTO } from '../../shared/types';
import { api, ApiError } from './api';
import { COLUMN_TITLES, idOf, parseCard, type BoardColumn, type CardKind } from './board';
import { currentLookup, loadDraft, openDocs, setEditing, withChatKey } from './chat';
import { keystore } from './e2ee/keystore';
import { keyring, type ChatDoc } from './e2ee/keyring';
import { actions, generalOf, store } from './store';

export interface DocSection {
  id: string;
  text: string;
  pos: number;
  /** Its revision did not decrypt, or its signature did not check. */
  failed: boolean;
  /** Who wrote its newest revision, for the brief that marks teammates' text (D-105). */
  authorId?: number;
}

export const newSectionId = () => toBase64Url(randomBytes(8));

/** The device's draft of a section someone is editing. */
export const draftName = (docId: string, section: string) => `doc:${docId}:${section}`;

/** Each revision with what it holds, or null when it does not open. */
function openRevisions(doc: ChatDoc, revisions: DocRevisionDTO[]) {
  const chat = store.get().conversations[doc.conversationId]!;
  const keysOf = currentLookup();
  return Promise.all(revisions.map(async (revision) => ({ revision, content: await keyring.openDoc(revision, chat, keysOf) })));
}

/** Creates a doc in a project, with a title and the sections of a template, or a column of the board. Returns its id. */
export async function createDoc(projectId: number, title: string, sections: string[], board?: DocContent['board']): Promise<string> {
  const general = generalOf(store.get(), projectId);
  if (!general) throw new Error('Project not found.');
  const id = newKeyId();
  const dto = await withChatKey(general.id, async (key, keyId) => {
    const seal = (section: string, content: DocContent) => keyring.sealDoc(key, keyId, { conversationId: general.id, docId: id, section }, content);
    const revisions = [{ section: 'title', envelope: await seal('title', { text: title, board }) }];
    for (const [i, text] of sections.entries()) {
      const section = newSectionId();
      revisions.push({ section, envelope: await seal(section, { text, pos: i + 1 }) });
    }
    return api.createDoc({ id, conversationId: general.id, revisions });
  });
  const [doc] = await openDocs([dto], [general], currentLookup());
  actions.upsertDoc(doc!);
  return id;
}

/** Makes the doc behind a board column, empty. Its first card is the section written right after. */
export async function createBoard(projectId: number, column: BoardColumn): Promise<ChatDoc> {
  const id = await createDoc(projectId, COLUMN_TITLES[column], [], column);
  return store.get().docs[id]!;
}

/** The doc's sections in order, without the ones deleted. */
export async function loadSections(doc: ChatDoc): Promise<DocSection[]> {
  const opened = await openRevisions(doc, await api.docSections(doc.id));
  return opened
    .filter(({ revision, content }) => revision.section !== 'title' && !content?.removed)
    .map(({ revision, content }) => ({
      id: revision.section,
      text: content?.text ?? '',
      // A section that does not open keeps its place among the others by when it was written.
      pos: content?.pos ?? revision.createdAt,
      failed: !content,
      authorId: revision.authorId,
    }))
    .sort((a, b) => a.pos - b.pos);
}

/** A section's revisions, newest first, each with what it held. */
export const sectionHistory = async (doc: ChatDoc, section: string) => openRevisions(doc, await api.sectionHistory(doc.id, section));

/** Locks a section for this tab's editor, which every check-in keeps. Throws, naming the editor, when someone else holds it. */
export async function startEditing(docId: string, section: string) {
  await api.lockSection(docId, section);
  setEditing({ docId, section });
}

/** The section a page edits: one in the doc, or a new one that goes in at `pos`. */
export interface Editing {
  id: string;
  pos: number;
  /** What the server holds. */
  saved: string;
  /** What the editor starts with: the server's text, or a draft this device kept. */
  text: string;
  /**
   * Just added, so the editor offers Cancel, which takes it back, instead of Delete. The server holds
   * it already when `saved` has text, as a new card does (D-116).
   */
  isNew: boolean;
}

/** Locks a section and picks up the device's draft of it, if any. */
export async function beginEditing(docId: string, section: string, saved: string, pos: number, isNew: boolean): Promise<Editing> {
  await startEditing(docId, section);
  return { id: section, pos, saved, isNew, text: (await loadDraft(draftName(docId, section))) || saved };
}

export async function stopEditing(docId: string, section: string) {
  setEditing(null);
  await api.unlockSection(docId, section);
}

/** Saves a section this user holds the lock of. */
export const saveSection = (doc: ChatDoc, section: string, content: DocContent) =>
  withChatKey(doc.conversationId, async (key, keyId) =>
    api.saveSection(doc.id, section, await keyring.sealDoc(key, keyId, { conversationId: doc.conversationId, docId: doc.id, section }, content)),
  );

/** Saves a section in an editing session of its own, as for a new title or an earlier version brought back. */
export async function replaceSection(doc: ChatDoc, section: string, content: DocContent) {
  await api.lockSection(doc.id, section);
  try {
    await saveSection(doc, section, content);
  } finally {
    await api.unlockSection(doc.id, section);
  }
}

/** Rewrites a section from what it holds under its lock, so no save lands between the read and the write. Null leaves it. */
export async function rewriteSection(doc: ChatDoc, section: string, make: (current: DocSection | undefined) => Promise<DocContent | null>) {
  await api.lockSection(doc.id, section);
  try {
    const content = await make((await loadSections(doc)).find((s) => s.id === section));
    if (content) await saveSection(doc, section, content);
    return content !== null;
  } finally {
    await api.unlockSection(doc.id, section);
  }
}

/**
 * Saves a new card with the next free number of its kind, under the lock of its column doc's title
 * (D-116): it takes the lock, reads the numbers, saves the card, then lets the lock go, so two pages
 * never give one number. Nobody edits a board's title, so the lock blocks nothing else, and a tab
 * that dies holding it loses it after 2 minutes. A page that finds it held tries again for 5 seconds.
 */
export async function addCard(doc: ChatDoc, section: string, kind: CardKind, text: (id: string) => string) {
  for (let tries = 1; ; tries++) {
    try {
      await api.lockSection(doc.id, 'title');
      break;
    } catch (err) {
      if (!(err instanceof ApiError && err.code === 'locked')) throw err;
      if (tries === 10) throw new Error('Someone is adding a card to this column. Try again in a moment.');
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  try {
    const cards = (await loadSections(doc)).map(parseCard);
    const id = idOf(cards.map((c) => c.cardId), kind);
    const content = { text: text(id), pos: Math.max(0, ...cards.map((c) => c.pos)) + 1 };
    await replaceSection(doc, section, content);
    return { id, ...content };
  } finally {
    await api.unlockSection(doc.id, 'title').catch(() => undefined);
  }
}

export async function deleteDoc(docId: string) {
  await api.deleteDoc(docId);
  actions.dropDoc(docId);
}

/** Notes that this device showed a doc at its current version, which clears its "Updated" dot. */
export function markSeen(doc: ChatDoc) {
  const seen = store.get().docsSeen;
  if (seen[doc.id] === doc.version) return;
  const next = { ...seen, [doc.id]: doc.version };
  actions.setDocsSeen(next);
  keystore.setDocsSeen(next).catch(() => undefined);
}

/** Words as a word processor counts them: runs of letters and digits, with apostrophes inside. */
export const wordCount = (texts: string[]) => texts.reduce((n, t) => n + (t.match(/[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu)?.length ?? 0), 0);

interface DiffLine {
  kind: 'same' | 'added' | 'removed';
  text: string;
}

/** The lines one text adds to and removes from another, from their longest common subsequence. */
export function lineDiff(before: string, after: string): DiffLine[] {
  let a = before ? before.split('\n') : [];
  let b = after ? after.split('\n') : [];
  // An edit usually touches a few lines, so the table below only spans the lines between the ones
  // both texts share at their start and end.
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  const same = (lines: string[]) => lines.map((text): DiffLine => ({ kind: 'same', text }));
  const start = same(a.slice(0, head));
  const end = same(a.slice(a.length - tail));
  a = a.slice(head, a.length - tail);
  b = b.slice(head, b.length - tail);
  // common[i][j] is the length of the longest common subsequence of a[i..] and b[j..].
  const common = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      common[i]![j] = a[i] === b[j] ? common[i + 1]![j + 1]! + 1 : Math.max(common[i + 1]![j]!, common[i]![j + 1]!);
    }
  }
  const lines = start;
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      lines.push({ kind: 'same', text: a[i++]! });
      j++;
    } else if (j < b.length && (i === a.length || common[i]![j + 1]! >= common[i + 1]![j]!)) {
      lines.push({ kind: 'added', text: b[j++]! });
    } else {
      lines.push({ kind: 'removed', text: a[i++]! });
    }
  }
  return lines.concat(end);
}
