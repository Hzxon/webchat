import type { ConversationDTO, MessageDTO, ProjectDTO, PushPayload } from '../shared/types.js';
import type { Config } from './config.js';
import { isAttentive, type Db, type UserRow } from './db.js';
import type { Push } from './push.js';

function preview(text: string, length = 180): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > length ? `${flat.slice(0, length - 1)}…` : flat;
}

/** Push services cap payloads near 4 KB; leave room for encryption overhead. */
const MAX_PAYLOAD_BYTES = 3000;

/** "#design · Capstone" for a channel, the group name for a group, the sender's name for a direct chat. */
async function chatName(db: Db, conversation: ConversationDTO, sender: UserRow) {
  if (conversation.type === 'direct') return sender.display_name;
  if (conversation.type === 'group') return conversation.title ?? 'Group';
  const project = conversation.projectId === null ? undefined : await db.getProject(conversation.projectId);
  return `#${conversation.title ?? 'channel'}${project ? ` · ${project.name}` : ''}`;
}

async function payloadFor(db: Db, recipientId: number, message: MessageDTO, conversation: ConversationDTO, sender: UserRow) {
  const isGroup = conversation.type !== 'direct';
  const name = await chatName(db, conversation, sender);
  if (message.kind === 'reaction') {
    // Only wakes the tab the recipient is looking at. No message id: a reaction is never "delivered".
    const payload: PushPayload = {
      kind: 'reaction',
      title: name,
      body: `${sender.display_name} reacted to a message`,
      bodyPrefix: '',
      urgent: false,
      tag: `chat-${conversation.id}`,
      conversationId: conversation.id,
      messageId: null,
      senderId: sender.id,
      clientId: null,
      envelope: null,
      unreadTotal: null,
      sentAt: message.createdAt,
      url: null,
    };
    return payload;
  }
  const payload: PushPayload = {
    kind: 'message',
    title: message.urgent ? `URGENT from ${name}` : name,
    // The server cannot read encrypted messages. The service worker decrypts the envelope on the
    // device and puts the text after the prefix.
    body: message.envelope ? '' : preview(message.body),
    bodyPrefix: isGroup ? `${sender.display_name}: ` : '',
    urgent: message.urgent,
    // One notification per chat, replaced by newer messages. Urgent ones never get replaced.
    tag: message.urgent ? `urgent-${message.id}` : `chat-${conversation.id}`,
    conversationId: conversation.id,
    messageId: message.id,
    senderId: sender.id,
    clientId: message.clientId,
    envelope: message.envelope,
    unreadTotal: await db.unreadTotal(recipientId),
    sentAt: message.createdAt,
    url: null,
  };
  // A long message does not fit in a push; the notification then says "New message" without text.
  if (new TextEncoder().encode(JSON.stringify(payload)).length > MAX_PAYLOAD_BYTES) payload.envelope = null;
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
 *
 * A reaction is not worth a notification. It goes only to a browser the recipient is looking at,
 * so the reaction shows up there at once.
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
        if (message.kind === 'message') await push.sendToUser(recipientId, payload);
      }),
  ).catch((error: unknown) => config.logger.error('Push delivery failed', error));
}

/** Tells people someone added them to a project. Tapping the notification opens its #general channel. */
export async function notifyAddedToProject(
  push: Push,
  config: Config,
  project: ProjectDTO,
  channelId: number | null,
  adder: UserRow,
  userIds: number[],
) {
  const payload: PushPayload = {
    kind: 'project',
    title: project.name,
    // Project names are not end-to-end encrypted, so the server can say this in plain text.
    body: `${adder.display_name} added you to this project.`,
    bodyPrefix: '',
    urgent: false,
    tag: `project-${project.id}`,
    conversationId: channelId,
    messageId: null,
    senderId: adder.id,
    clientId: null,
    envelope: null,
    unreadTotal: null,
    sentAt: Date.now(),
    url: null,
  };
  await Promise.all(userIds.map((id) => push.sendToUser(id, payload))).catch((error: unknown) =>
    config.logger.error('Push delivery failed', error),
  );
}
