import type { Router } from 'express';
import { LIMITS, type CreateDocInput } from '../../shared/types.js';
import { HttpError, currentUser, docId, docSection, envelope, positiveInt } from './helpers.js';
import type { Context } from './context.js';

export function docsRoutes(router: Router, { db, requireAuth, requireMember, requireProjectOwner, requireCurrentKey, requireDoc }: Context) {
  /** A new doc in a project's channel, with its title and first sections (R-020). */
  router.post('/docs', requireAuth, async (req, res) => {
    const me = currentUser(res);
    const input = (req.body ?? {}) as Partial<CreateDocInput>;
    const id = docId(input.id);
    const conversationId = positiveInt(input.conversationId, 'Chat id');
    const raw = Array.isArray(input.revisions) ? input.revisions : [];
    const revisions = raw.map((r) => ({ section: docSection(r?.section), envelope: envelope(r?.envelope, LIMITS.docCiphertextLength) }));
    const sections = new Set(revisions.map((r) => r.section));
    if (!sections.has('title') || sections.size !== revisions.length || revisions.length > LIMITS.docSectionsAtOnce + 1) {
      throw new HttpError(400, `A doc needs a title and at most ${LIMITS.docSectionsAtOnce} sections, each once.`);
    }
    await requireMember(conversationId, me.id);
    if ((await db.getConversation(conversationId))?.type !== 'channel') throw new HttpError(400, 'Docs belong to a project.');
    for (const kid of new Set(revisions.map((r) => r.envelope.kid))) await requireCurrentKey(conversationId, kid);
    if (!(await db.takeRateLimit(`docs:${me.id}`, 30, 10_000))) throw new HttpError(429, 'Slow down a little.');
    if (!(await db.createDoc(id, conversationId, me.id, revisions))) throw new HttpError(409, 'A doc with this id exists.');
    res.status(201).json(await db.docFor(me.id, id));
  });

  /** The newest revision of every section of a doc. */
  router.get('/docs/:id', requireAuth, async (req, res) => {
    const me = currentUser(res);
    const doc = await requireDoc(docId(req.params.id), me.id);
    res.json(await db.docSections(doc.id));
  });

  /** Each section's oldest revision and each author's newest, which the board reads for owners and words. */
  router.get('/docs/:id/words', requireAuth, async (req, res) => {
    const me = currentUser(res);
    const doc = await requireDoc(docId(req.params.id), me.id);
    res.json(await db.docWords(doc.id));
  });

  /** One person deletes a doc for everyone: whoever made it, or the project's owner. */
  router.delete('/docs/:id', requireAuth, async (req, res) => {
    const me = currentUser(res);
    const doc = await requireDoc(docId(req.params.id), me.id);
    if (doc.created_by !== me.id) await requireProjectOwner((await db.getConversation(doc.conversation_id))!.project_id!, me.id);
    await db.deleteDoc(doc.id);
    res.status(204).end();
  });

  /** A section's earlier revisions, newest first. */
  router.get('/docs/:id/sections/:section', requireAuth, async (req, res) => {
    const me = currentUser(res);
    const doc = await requireDoc(docId(req.params.id), me.id);
    res.json(await db.sectionHistory(doc.id, docSection(req.params.section)));
  });

  /** Starts editing a section. Only one person edits a section at a time. */
  router.post('/docs/:id/sections/:section/lock', requireAuth, async (req, res) => {
    const me = currentUser(res);
    const doc = await requireDoc(docId(req.params.id), me.id);
    const holder = await db.lockSection(doc.id, docSection(req.params.section), me.id);
    if (holder !== me.id) {
      const name = holder ? (await db.getUser(holder))?.display_name : undefined;
      throw new HttpError(409, `${name ?? 'Someone'} is editing this section. Try again when they are done.`, 'locked');
    }
    res.status(204).end();
  });

  router.delete('/docs/:id/sections/:section/lock', requireAuth, async (req, res) => {
    const me = currentUser(res);
    const doc = await requireDoc(docId(req.params.id), me.id);
    await db.unlockSection(doc.id, docSection(req.params.section), me.id);
    res.status(204).end();
  });

  /** Saves a section, sealed for the doc's chat, by the person who holds its lock. */
  router.put('/docs/:id/sections/:section', requireAuth, async (req, res) => {
    const me = currentUser(res);
    const doc = await requireDoc(docId(req.params.id), me.id);
    const sealed = envelope(req.body?.envelope, LIMITS.docCiphertextLength);
    await requireCurrentKey(doc.conversation_id, sealed.kid);
    if (!(await db.takeRateLimit(`docs:${me.id}`, 30, 10_000))) throw new HttpError(429, 'Slow down a little.');
    const revision = await db.saveSection(doc.id, docSection(req.params.section), me.id, sealed);
    if (!revision) throw new HttpError(409, 'Someone else is editing this section now.', 'not_locked');
    res.json(revision);
  });
}
