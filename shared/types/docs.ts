import { type EnvelopeDTO } from './chat.js';

/**
 * One section of a doc, or its title, as one person wrote it in one editing session. Encrypted with
 * the chat key and signed like a message, so the server sees only who wrote which section and when.
 */
export interface DocRevisionDTO {
  id: number;
  docId: string;
  /** "title", or the random id the browser gave the section. */
  section: string;
  authorId: number;
  envelope: EnvelopeDTO;
  createdAt: number;
  /** The session's last save. Saves replace the revision until its author stops editing. */
  updatedAt: number;
}

/** A shared Markdown doc in a project (R-020). GET /docs/:id brings its sections. */
export interface DocDTO {
  /** Made by the browser, so every revision is signed with it before the server sees the doc. */
  id: string;
  /** The project's #general channel. Its key encrypts the doc, and its members read and edit it. */
  conversationId: number;
  createdBy: number;
  createdAt: number;
  /** Grows with every save, so an open doc knows to load its sections again. */
  version: number;
  updatedBy: number;
  updatedAt: number;
  /** The newest revision of the title. */
  title: DocRevisionDTO | null;
  /** Who is editing which section now. One person at a time edits a section. */
  locks: Array<{ section: string; userId: number }>;
}

export interface CreateDocInput {
  id: string;
  conversationId: number;
  /** The title and the first sections, each sealed for the chat. */
  revisions: Array<{ section: string; envelope: EnvelopeDTO }>;
}
