import type {
  AccountKeysInput,
  AddProjectMembersInput,
  BootstrapDTO,
  ChatKeyInput,
  ConfigDTO,
  ConversationDTO,
  CreateChannelInput,
  CreateProjectInput,
  CreateProjectResponse,
  GithubDTO,
  LoginResponse,
  MessageDTO,
  ProjectDTO,
  RegisterInput,
  RemoveGroupMemberInput,
  RemoveProjectMemberInput,
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

/** The account this tab shows. Sent with every request so the server can refuse a stale tab. */
let tabUserId: number | null = null;
export const setTabUser = (userId: number | null) => {
  tabUserId = userId;
};

/** Reloads every tab of this site, for example after signing in to another account. */
const accountChannel = typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel('webchat-account');
export const announceAccountChange = () => accountChannel?.postMessage('changed');
accountChannel?.addEventListener('message', () => location.reload());

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  const headers: Record<string, string> = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (tabUserId !== null) headers['x-webchat-user'] = String(tabUserId);
  try {
    res = await fetch(`/api${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: 'same-origin',
    });
  } catch {
    throw new ApiError(0, 'Cannot reach the server. Check your connection.');
  }
  if (res.status === 204) return undefined as T;
  const data = (await res.json().catch(() => ({}))) as { error?: string; code?: string };
  if (data.code === 'account_changed') {
    // Another tab switched accounts. Start over as the account this browser is now signed in to.
    location.reload();
  }
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
  removeGroupMember: (conversationId: number, userId: number, input: RemoveGroupMemberInput) =>
    request<ConversationDTO>('DELETE', `/conversations/${conversationId}/members/${userId}`, input),
  deleteGroup: (conversationId: number) => request<void>('DELETE', `/conversations/${conversationId}`),
  createProject: (input: CreateProjectInput) => request<CreateProjectResponse>('POST', '/projects', input),
  createChannel: (projectId: number, input: CreateChannelInput) =>
    request<ConversationDTO>('POST', `/projects/${projectId}/channels`, input),
  addProjectMembers: (projectId: number, input: AddProjectMembersInput) =>
    request<ProjectDTO>('POST', `/projects/${projectId}/members`, input),
  removeProjectMember: (projectId: number, userId: number, input: RemoveProjectMemberInput) =>
    request<ProjectDTO>('DELETE', `/projects/${projectId}/members/${userId}`, input),
  deleteProject: (projectId: number) => request<void>('DELETE', `/projects/${projectId}`),
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
  github: (refresh = false) => request<GithubDTO>('GET', `/github${refresh ? '?refresh=1' : ''}`),
  setGithubNotify: (notify: boolean) => request<GithubDTO>('PATCH', '/github', { notify }),
  disconnectGithub: () => request<GithubDTO>('DELETE', '/github'),
};

/** Tells the server this tab closed. A beacon still gets sent while the page unloads. */
export function sendAwayBeacon(tabId: string) {
  navigator.sendBeacon('/api/away', new Blob([JSON.stringify({ tabId })], { type: 'application/json' }));
}
