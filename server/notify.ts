import type { ConversationDTO, MessageDTO, PushPayload } from '../shared/types.js';
import type { Config } from './config.js';
import { isAttentive, type Db, type UserRow } from './db.js';
import type { Push } from './push.js';

function preview(text: string, length = 180): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > length ? `${flat.slice(0, length - 1)}…` : flat;
}

async function payloadFor(db: Db, recipientId: number, message: MessageDTO, conversation: ConversationDTO, sender: UserRow) {
  const isGroup = conversation.type === 'group';
  const name = isGroup ? (conversation.title ?? 'Group') : sender.display_name;
  const text = preview(message.body);
  const payload: PushPayload = {
    kind: 'message',
    title: message.urgent ? `URGENT from ${name}` : name,
    body: isGroup ? `${sender.display_name}: ${text}` : text,
    urgent: message.urgent,
    // One notification per chat, replaced by newer messages. Urgent ones never get replaced.
    tag: message.urgent ? `urgent-${message.id}` : `chat-${conversation.id}`,
    conversationId: conversation.id,
    messageId: message.id,
    unreadTotal: await db.unreadTotal(recipientId),
    sentAt: message.createdAt,
  };
  return payload;
}

/**
 * Push is how a new message reaches other people, both as a notification and as the signal that
 * makes an open tab fetch it at once. There is no open connection to the server.
 *
 * - Recipient looking at the app: push only to the browser in use. Its service worker hands the
 *   message to the page instead of showing a notification, and their phone stays quiet. A tab
 *   without push checks in every few seconds instead.
 * - Recipient not looking: push to every device they turned notifications on for.
 */
export async function notifyNewMessage(db: Db, push: Push, config: Config, message: MessageDTO, sender: UserRow) {
  const memberIds = await db.memberIds(message.conversationId);
  await Promise.all(
    memberIds
      .filter((id) => id !== sender.id)
      .map(async (recipientId) => {
        const [recipient, conversation] = await Promise.all([
          db.getUser(recipientId),
          db.conversationFor(recipientId, message.conversationId),
        ]);
        if (!recipient || !conversation) return;
        const payload = await payloadFor(db, recipientId, message, conversation, sender);
        if (isAttentive(recipient)) {
          if (recipient.attentive_endpoint) await push.sendToUser(recipientId, payload, recipient.attentive_endpoint);
          return;
        }
        await push.sendToUser(recipientId, payload);
      }),
  ).catch((error: unknown) => config.logger.error('Push delivery failed', error));
}
