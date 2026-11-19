import type { Router } from 'express';
import { FILE_OVERHEAD, randomBytes, toBase64Url } from '../../shared/e2ee.js';
import { notifyNewMessage } from '../notify.js';
import { LIMITS, type MessageKind, type UploadDTO } from '../../shared/types.js';
import { HttpError, MAX_ID, base64url, chatKey, currentUser, envelope, inBackground, positiveInt } from './helpers.js';
import type { Context } from './context.js';

export function messagesRoutes(router: Router, { db, push, files, config, sweepFiles, requireAuth, requireMember, requireCurrentKey, requireKeys }: Context) {
  /** Sets the key of a chat from before encryption. The first member to send a message does this. */
  router.post('/conversations/:id/key', requireAuth, async (req, res) => {
    const me = currentUser(res);
    const conversationId = positiveInt(req.params.id, 'Chat id');
    await requireMember(conversationId, me.id);
    const memberIds = await db.memberIds(conversationId);
    await requireKeys(memberIds);
    const key = chatKey(req.body, memberIds);
    // The members can change before the key is stored, so they are checked again under the lock.
    const result = await db.setConversationKey(conversationId, key.keyId, me.id, key.wrappedKeys);
    if (result === 'has_key') throw new HttpError(409, 'This chat already has a key.', 'has_key');
    if (result === 'stale') throw new HttpError(409, 'The group changed while you were editing. Try again.', 'stale_group');
    res.json(await db.conversationFor(me.id, conversationId));
  });

  router.get('/conversations/:id/messages', requireAuth, async (req, res) => {
    const me = currentUser(res);
    const conversationId = positiveInt(req.params.id, 'Chat id');
    await requireMember(conversationId, me.id);
    // Read with the WHATWG URL API: on Vercel, reading req.query logs Node's url.parse()
    // deprecation warning (DEP0169).
    const params = new URL(req.originalUrl, 'http://localhost').searchParams;
    const beforeParam = params.get('before');
    const before = beforeParam === null ? MAX_ID : positiveInt(beforeParam, 'before');
    // A session's steps page apart, so a chat's history does not grow with them (R-072).
    res.json(await db.messagesBefore(conversationId, before, LIMITS.pageSize, params.get('events') === '1'));
  });

  router.post('/conversations/:id/messages', requireAuth, async (req, res) => {
    const me = currentUser(res);
    const conversationId = positiveInt(req.params.id, 'Chat id');
    // The server only ever receives ciphertext; it checks the shape, not the content.
    // An agent's card draft is a message of its own that holds a full card, so an agent's message
    // may be as long as a doc section.
    const sealed = envelope(req.body?.envelope, me.agent_owner === null ? LIMITS.ciphertextLength : LIMITS.docCiphertextLength);
    // Signed into the envelope, so it must stay exactly as the client sent it.
    const clientId = base64url(req.body?.clientId, 'clientId', 1, 64);
    const kinds = ['reaction', 'sync', ...(me.agent_owner === null ? [] : ['events'])];
    const kind: Exclude<MessageKind, 'github'> = kinds.includes(req.body?.kind) ? req.body.kind : 'message';
    // Only an agent sends a session's steps (R-072).
    if (req.body?.kind !== undefined && req.body.kind !== kind) throw new HttpError(400, 'Unknown message kind.');
    await requireMember(conversationId, me.id);
    await requireCurrentKey(conversationId, sealed.kid);
    if (!(await db.takeRateLimit(`send:${me.id}`, 30, 10_000))) throw new HttpError(429, 'Slow down a little.');
    // A message with a photo or file names its upload, which the server keeps from then on (R-005).
    // What the file is stays sealed in the envelope.
    if (req.body?.fileId !== undefined) {
      const fileId = base64url(req.body.fileId, 'File id', 22);
      if (!(await db.markFileSent(fileId, conversationId, me.id))) {
        throw new HttpError(409, 'The file is no longer on the server. Attach it again.', 'file_gone');
      }
    }

    const urgent = req.body?.urgent === true;
    // The urgent flag is signed into the envelope, so it is refused rather than quietly dropped.
    if (urgent && kind !== 'message') throw new HttpError(400, 'Only a message can be urgent.');
    const { message, repeated } = await db.insertMessage(conversationId, me.id, kind, sealed, urgent, clientId);
    // Answer the sender first; pushes go out after, while the function stays alive.
    if (!repeated) inBackground(notifyNewMessage(db, push, config, message, me), config.logger);
    res.status(repeated ? 200 : 201).json(message);
  });

  /**
   * An address to upload one file's ciphertext to, for a member of the chat (R-005, D-123). Any
   * member client can use it, a page or an agent. The limits keep a Hobby Blob store from being
   * blocked: a month's uploads and the bytes stored, for the server and for each person.
   */
  router.post('/conversations/:id/files', requireAuth, async (req, res) => {
    if (!files) throw new HttpError(404, 'This server keeps no files.', 'files_off');
    const me = currentUser(res);
    const conversationId = positiveInt(req.params.id, 'Chat id');
    const size = Number(req.body?.size);
    if (!Number.isInteger(size) || size <= FILE_OVERHEAD || size > LIMITS.fileBytes + FILE_OVERHEAD) {
      throw new HttpError(400, 'A file is at most 10 MB.');
    }
    await requireMember(conversationId, me.id);
    if (!(await db.takeRateLimit(`upload:${me.id}`, 20, 60_000))) throw new HttpError(429, 'Slow down a little.');
    await sweepFiles();
    // The person's share first, so someone over it takes nothing from everyone's count.
    if ((await db.storedFileBytes(me.id)) + size > LIMITS.storedBytesPerPerson) {
      const share = LIMITS.storedBytesPerPerson / 1024 / 1024;
      throw new HttpError(507, `Your files fill your share of this server, ${share} MB. Try again when older ones expire.`, 'own_storage_full');
    }
    if ((await db.storedFileBytes()) + size > LIMITS.storedBytes) {
      throw new HttpError(507, 'The server is full of files. Try again when older ones expire.', 'storage_full');
    }
    const month = `uploads:${new Date().toISOString().slice(0, 7)}`;
    if (!(await db.countUpload(`${month}:${me.id}`, LIMITS.uploadsPerPerson))) {
      throw new HttpError(429, `You sent your share of files this month, ${LIMITS.uploadsPerPerson}. Try again next month.`, 'own_upload_limit');
    }
    if (!(await db.countUpload(month, LIMITS.uploadsPerMonth))) {
      throw new HttpError(429, 'This server took all the files it can this month.', 'upload_limit');
    }
    const id = toBase64Url(randomBytes(16));
    await db.insertFile(id, conversationId, me.id, size);
    const body: UploadDTO = { id, url: await files.uploadUrl(id, size, Date.now() + 10 * 60_000) };
    res.status(201).json(body);
  });

  /** An address to download a file's ciphertext, for a member of its chat, until it is 7 days old. */
  router.get('/files/:id', requireAuth, async (req, res) => {
    if (!files) throw new HttpError(404, 'This server keeps no files.', 'files_off');
    const file = await db.getFile(base64url(req.params.id, 'File id', 22));
    if (!file?.conversation_id) throw new HttpError(404, 'File not found.');
    await requireMember(file.conversation_id, currentUser(res).id);
    const expires = file.created_at + LIMITS.fileDays * 86_400_000;
    if (expires <= Date.now()) throw new HttpError(410, 'No longer on the server.', 'expired');
    res.json({ url: await files.downloadUrl(file.id, Math.min(expires, Date.now() + 3_600_000)) });
  });

  router.post('/conversations/:id/read', requireAuth, async (req, res) => {
    const me = currentUser(res);
    const conversationId = positiveInt(req.params.id, 'Chat id');
    await requireMember(conversationId, me.id);
    await db.markRead(conversationId, me.id, positiveInt(req.body?.messageId, 'messageId'));
    res.status(204).end();
  });

  /** Mutes a chat for the signed-in member only; urgent messages still push (the mute decision, proposed). */
  router.put('/conversations/:id/mute', requireAuth, async (req, res) => {
    const me = currentUser(res);
    const conversationId = positiveInt(req.params.id, 'Chat id');
    const muted = req.body?.muted;
    if (typeof muted !== 'boolean') throw new HttpError(400, 'muted must be true or false.');
    await requireMember(conversationId, me.id);
    await db.setMuted(conversationId, me.id, muted);
    res.status(204).end();
  });

  /** Called by the service worker when a push arrives, so the sender sees "delivered" even with the app closed. */
  router.post('/delivered', requireAuth, async (req, res) => {
    const me = currentUser(res);
    const conversationId = positiveInt(req.body?.conversationId, 'conversationId');
    const messageId = positiveInt(req.body?.messageId, 'messageId');
    await requireMember(conversationId, me.id);
    await db.markDelivered(me.id, new Map([[conversationId, messageId]]));
    res.status(204).end();
  });
}
