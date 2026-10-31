import type {
  BootstrapDTO,
  ConfigDTO,
  ConversationDTO,
  MessageDTO,
  SendMessageInput,
  SyncRequest,
  SyncResponse,
  UserDTO,
} from '../../shared/types';

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
      method,
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: 'same-origin',
    });
  } catch {
    throw new ApiError(0, 'Cannot reach the server. Check your connection.');
  }
  if (res.status === 204) return undefined as T;
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new ApiError(res.status, data.error ?? `Request failed (${res.status}).`);
  return data as T;
}

export interface RegisterInput {
  username: string;
  displayName: string;
  password: string;
  inviteCode: string;
}

export const api = {
  config: () => request<ConfigDTO>('GET', '/config'),
  register: (input: RegisterInput) => request<UserDTO>('POST', '/auth/register', input),
  login: (username: string, password: string) => request<UserDTO>('POST', '/auth/login', { username, password }),
  logout: () => request<void>('POST', '/auth/logout'),
  bootstrap: () => request<BootstrapDTO>('GET', '/bootstrap'),
  openDirect: (userId: number) => request<ConversationDTO>('POST', '/conversations/direct', { userId }),
  createGroup: (title: string, memberIds: number[]) =>
    request<ConversationDTO>('POST', '/conversations/group', { title, memberIds }),
  sync: (input: SyncRequest) => request<SyncResponse>('POST', '/sync', input),
  messages: (conversationId: number, before?: number) =>
    request<MessageDTO[]>('GET', `/conversations/${conversationId}/messages${before ? `?before=${before}` : ''}`),
  sendMessage: (conversationId: number, input: SendMessageInput) =>
    request<MessageDTO>('POST', `/conversations/${conversationId}/messages`, input),
  markRead: (conversationId: number, messageId: number) =>
    request<void>('POST', `/conversations/${conversationId}/read`, { messageId }),
  subscribePush: (subscription: PushSubscriptionJSON) => request<void>('POST', '/push/subscribe', subscription),
  unsubscribePush: (endpoint: string) => request<void>('POST', '/push/unsubscribe', { endpoint }),
  testPush: () => request<{ sent: number; failed: number }>('POST', '/push/test'),
};

/** Tells the server this tab closed. A beacon still gets sent while the page unloads. */
export function sendAwayBeacon(tabId: string) {
  navigator.sendBeacon('/api/away', new Blob([JSON.stringify({ tabId })], { type: 'application/json' }));
}
