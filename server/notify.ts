import { describeGithubCard, readGithubCard } from '../shared/github.js';
import { showsEveryPush, type ConversationDTO, type MessageDTO, type ProjectDTO, type PushPayload } from '../shared/types.js';
import type { Config } from './config.js';
import { isAttentive, URGENT_RING_JOB, URGENT_RING_SECONDS, type Db, type UserRow } from './db.js';
import type { Push } from './push.js';

function preview(text: string, length = 180): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > length ? `${flat.slice(0, length - 1)}…` : flat;
}

/** Push services cap payloads near 4 KB; leave room for encryption overhead. */
const MAX_PAYLOAD_BYTES = 3000;

/** "#design · Capstone" for a channel, the group name for a group, the sender's name for a direct chat. */
async function chatName(db: Db, conversation: ConversationDTO, sender: UserRow | null) {
  if (conversation.type === 'direct') return sender?.display_name ?? 'Direct chat';
  if (conversation.type === 'group') return conversation.title ?? 'Group';
  const project = conversation.projectId === null ? undefined : await db.getProject(conversation.projectId);
  return `#${conversation.title ?? 'channel'}${project ? ` · ${project.name}` : ''}`;
}

/** The text of a message the server can read: a card from GitHub, or one sent before encryption. */
function plainText(message: MessageDTO): string {
  if (message.kind !== 'github') return preview(message.body);
  const card = readGithubCard(message.body);
  return card ? preview(`GitHub: ${describeGithubCard(card)}`) : 'GitHub';
}

async function payloadFor(
  db: Db,
  recipientId: number,
  message: MessageDTO,
  conversation: ConversationDTO,
  sender: UserRow | null,
) {
  const isGroup = conversation.type !== 'direct';
  const name = await chatName(db, conversation, sender);
  // A muted chat's message goes out as a sync, which alerts nobody but wakes the tab the recipient
  // looks at. Urgent ones ignore mute: they alert as always (the mute decision, proposed).
  if (message.kind === 'reaction' || message.kind === 'sync' || (conversation.muted && !message.urgent)) {
    // Only wakes the tab the recipient is looking at. No message id: neither is ever "delivered".
    const kind = message.kind === 'reaction' ? 'reaction' : 'sync';
    const payload: PushPayload = {
      kind,
      title: name,
      body: kind === 'reaction' ? `${sender?.display_name ?? 'Someone'} reacted to a message` : '',
      bodyPrefix: '',
      urgent: false,
      // The service worker shows neither kind (D-070); this tag only keeps one from replacing the
      // chat's message notification if a browser ever shows it anyway.
      tag: `${kind}-${conversation.id}`,
      conversationId: conversation.id,
      messageId: null,
      senderId: sender?.id ?? null,
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
    body: message.envelope ? '' : plainText(message),
    bodyPrefix: isGroup && sender ? `${sender.display_name}: ` : '',
    urgent: message.urgent,
    // One notification per chat, replaced by newer messages. Urgent ones never get replaced.
    tag: message.urgent ? `urgent-${message.id}` : `chat-${conversation.id}`,
    conversationId: conversation.id,
    messageId: message.id,
    senderId: sender?.id ?? null,
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
 * so the reaction shows up there at once. A card from GitHub has no sender and goes to everyone.
 */
export async function notifyNewMessage(db: Db, push: Push, config: Config, message: MessageDTO, sender: UserRow | null) {
  const memberIds = await db.memberIds(message.conversationId);
  await Promise.all(
    memberIds
      .filter((id) => id !== sender?.id)
      .map(async (recipientId) => {
        const [recipient, conversation] = await Promise.all([
          db.getUser(recipientId),
          db.conversationFor(recipientId, message.conversationId),
        ]);
        if (!recipient || !conversation) return;
        const payload = await payloadFor(db, recipientId, message, conversation, sender);
        if (isAttentive(recipient)) {
          const endpoint = recipient.attentive_endpoint;
          // Safari would count this push as silent and revoke the subscription (D-047). Its tab
          // checks in every few seconds instead, as a tab without push does. Urgent ones still go:
          // the service worker shows those as notifications.
          if (endpoint && (message.urgent || !showsEveryPush(endpoint))) await push.sendToUser(recipientId, payload, endpoint);
          return;
        }
        if (payload.kind !== 'reaction' && payload.kind !== 'sync') await push.sendToUser(recipientId, payload);
      }),
  ).catch((error: unknown) => config.logger.error('Push delivery failed', error));
}

/**
 * Rings each unread urgent message again, like an alarm, until its recipient reads the chat (D-079).
 * Its push repeats the first one, under the same tag. A recipient looking at the app is skipped:
 * the page rings on its own there.
 */
export async function ringUrgent(db: Db, push: Push): Promise<number> {
  const rang = await Promise.all(
    (await db.urgentRings()).map(async ({ recipientId, message }) => {
      const [recipient, conversation, sender] = await Promise.all([
        db.getUser(recipientId),
        db.conversationFor(recipientId, message.conversationId),
        message.senderId === null ? undefined : db.getUser(message.senderId),
      ]);
      if (!recipient || !conversation || isAttentive(recipient)) return false;
      await push.sendToUser(recipientId, await payloadFor(db, recipientId, message, conversation, sender ?? null));
      return true;
    }),
  );
  return rang.filter(Boolean).length;
}

/**
 * On Vercel nothing runs between requests, so the database keeps the clock for the urgent ring,
 * as for GitHub polls (D-057). Without pg_cron and pg_net this logs why.
 */
export async function scheduleUrgentRings(db: Db, config: Config) {
  if (!config.urgentRingUrl) return;
  try {
    if (await db.scheduleJob(URGENT_RING_JOB, config.urgentRingUrl)) {
      config.logger.info(`Supabase Cron now calls ${config.urgentRingUrl} every ${URGENT_RING_SECONDS} seconds while an urgent message is unread.`);
    }
  } catch (error) {
    config.logger.warn(`Could not schedule urgent rings in the database, so with every tab closed an urgent message rings once: ${String(error)}`);
  }
}

/**
 * Tells people someone added them to a project or group. Project and group names are not
 * end-to-end encrypted, so the server can say this in plain text.
 */
async function notifyAdded(
  push: Push,
  config: Config,
  invite: Pick<PushPayload, 'kind' | 'title' | 'body' | 'tag' | 'conversationId'>,
  adder: UserRow,
  userIds: number[],
) {
  const payload: PushPayload = {
    ...invite,
    bodyPrefix: '',
    urgent: false,
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

/** Tapping the notification opens the project's #general channel. */
export function notifyAddedToProject(
  push: Push,
  config: Config,
  project: ProjectDTO,
  channelId: number | null,
  adder: UserRow,
  userIds: number[],
) {
  const invite = {
    kind: 'project' as const,
    title: project.name,
    body: `${adder.display_name} added you to this project.`,
    tag: `project-${project.id}`,
    conversationId: channelId,
  };
  return notifyAdded(push, config, invite, adder, userIds);
}

/** Tapping the notification opens the group. */
export function notifyAddedToGroup(push: Push, config: Config, group: ConversationDTO, adder: UserRow, userIds: number[]) {
  const invite = {
    kind: 'group' as const,
    title: group.title ?? 'Group',
    body: `${adder.display_name} added you to this group.`,
    tag: `group-${group.id}`,
    conversationId: group.id,
  };
  return notifyAdded(push, config, invite, adder, userIds);
}
