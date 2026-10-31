import type {
  AccountKeysInput,
  BootstrapDTO,
  ChatKeyInput,
  ConfigDTO,
  ConversationDTO,
  LoginResponse,
  MessageDTO,
  RegisterInput,
  SendMessageInput,
  SyncRequest,
  SyncResponse,
  UserDTO,
} from '../../shared/types';

export class ApiError extends Error {
  status: number;
  /** The server's machine-readable reason, such as "upgrade_required". */
  code: string | undefined;
  constructor(status: number, message: string, code?: string) {
    super(message);
    this.status = status;
    this.code = code;
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
  const data = (await res.json().catch(() => ({}))) as { error?: string; code?: string };
  if (!res.ok) throw new ApiError(res.status, data.error ?? `Request failed (${res.status}).`, data.code);
  return data as T;
}

export const api = {
  config: () => request<ConfigDTO>('GET', '/config'),
  register: (input: RegisterInput) => request<UserDTO>('POST', '/auth/register', input),
  login: (username: string, authKey: string) => request<LoginResponse>('POST', '/auth/login', { username, authKey }),
  upgrade: (username: string, password: string, authKey: string) =>
    request<LoginResponse>('POST', '/auth/upgrade', { username, password, authKey }),
  logout: () => request<void>('POST', '/auth/logout'),
  keysBackup: (authKey: string) => request<LoginResponse>('POST', '/keys/backup', { authKey }),
  putKeys: (authKey: string, keys: AccountKeysInput) => request<UserDTO>('PUT', '/keys', { authKey, keys }),
  bootstrap: () => request<BootstrapDTO>('GET', '/bootstrap'),
  openDirect: (userId: number, key: ChatKeyInput) =>
    request<ConversationDTO>('POST', '/conversations/direct', { userId, key }),
  createGroup: (title: string, memberIds: number[], key: ChatKeyInput) =>
    request<ConversationDTO>('POST', '/conversations/group', { title, memberIds, key }),
  setChatKey: (conversationId: number, key: ChatKeyInput) =>
    request<ConversationDTO>('POST', `/conversations/${conversationId}/key`, key),
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
