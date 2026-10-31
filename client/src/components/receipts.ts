import type { ConversationDTO } from '../../../shared/types';

/** Read once every other member read it; delivered once it reached every other member. */
export function receiptState(conversation: ConversationDTO, messageId: number, meId: number | undefined) {
  const others = conversation.members.filter((m) => m.userId !== meId);
  if (others.length > 0 && others.every((m) => m.lastReadId >= messageId)) return 'read';
  if (others.length > 0 && others.every((m) => m.lastDeliveredId >= messageId)) return 'delivered';
  return 'sent';
}
