import type {
  AccountKeysInput,
  AddGroupMembersInput,
  AddProjectMembersInput,
  ApprovePairingInput,
  BarkDTO,
  BootstrapDTO,
  ChatKeyInput,
  ConfigDTO,
  ConversationDTO,
  CreateChannelInput,
  CreateDocInput,
  CreateProjectInput,
  CreateProjectResponse,
  DocDTO,
  DocRevisionDTO,
  EnvelopeDTO,
  FirstChatKeyInput,
  GithubDTO,
  LoginResponse,
  MessageDTO,
  PairingDTO,
  ProjectDTO,
  LinkRepoInput,
  ProjectReposDTO,
  RegisterInput,
  NewOwnerInput,
  RemoveGroupMemberInput,
  RemoveProjectMemberInput,
  RotatedKeyInput,
  SendMessageInput,
  SyncRequest,
  SyncResponse,
  UploadDTO,
  UserDTO,
} from '../../shared/types';
import { noteBuild } from './build';

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

/**
 * How long a request waits for its answer to start. Vercel ends a function after 30 seconds, so a
 * healthy answer starts by then; the rest leaves room for a slow upload. Reading the body is not
 * timed, so a large check-in answer on a slow phone still arrives whole (D-077).
 */
const ANSWER_TIMEOUT_MS = 60_000;

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  const headers: Record<string, string> = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (tabUserId !== null) headers['x-webchat-user'] = String(tabUserId);
  // A timer and not AbortSignal.timeout, which iOS 15.4 lacks (D-052).
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), ANSWER_TIMEOUT_MS);
  try {
    res = await fetch(`/api${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: 'same-origin',
      signal: abort.signal,
    });
  } catch {
    throw new ApiError(0, 'Cannot reach the server. Check your connection.');
  } finally {
    clearTimeout(timer);
  }
  noteBuild(res);
  if (res.status === 204) return undefined as T;
  let data: { error?: string; code?: string };
  try {
    data = await res.json();
  } catch {
    // A 2xx whose body breaks off, for example when the connection drops mid-answer, must not pass
    // as success: the sync loop would read its cursor as NaN and ask from 0 until a reload (K-7).
    if (res.ok) throw new ApiError(res.status, 'The server answer broke off. Try again.');
    data = {};
  }
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
  deleteAccount: () => request<void>('DELETE', '/auth/account'),
  keysBackup: (authKey: string) => request<LoginResponse>('POST', '/keys/backup', { authKey }),
  putKeys: (authKey: string, keys: AccountKeysInput) => request<UserDTO>('PUT', '/keys', { authKey, keys }),
  bootstrap: () => request<BootstrapDTO>('GET', '/bootstrap'),
  reserveConversationId: () => request<{ id: number }>('POST', '/conversations/ids'),
  openDirect: (userId: number, key: FirstChatKeyInput) =>
    request<ConversationDTO>('POST', '/conversations/direct', { userId, key }),
  createGroup: (title: string, memberIds: number[], key: FirstChatKeyInput) =>
    request<ConversationDTO>('POST', '/conversations/group', { title, memberIds, key }),
  addGroupMembers: (conversationId: number, input: AddGroupMembersInput) =>
    request<ConversationDTO>('POST', `/conversations/${conversationId}/members`, input),
  removeGroupMember: (conversationId: number, userId: number, input: RemoveGroupMemberInput) =>
    request<ConversationDTO>('DELETE', `/conversations/${conversationId}/members/${userId}`, input),
  leaveGroup: (conversationId: number) => request<void>('POST', `/conversations/${conversationId}/leave`),
  setMuted: (conversationId: number, muted: boolean) => request<void>('PUT', `/conversations/${conversationId}/mute`, { muted }),
  handOverGroup: (conversationId: number, input: NewOwnerInput) =>
    request<ConversationDTO>('PUT', `/conversations/${conversationId}/owner`, input),
  deleteGroup: (conversationId: number) => request<void>('DELETE', `/conversations/${conversationId}`),
  createProject: (input: CreateProjectInput) => request<CreateProjectResponse>('POST', '/projects', input),
  createChannel: (projectId: number, input: CreateChannelInput) =>
    request<ConversationDTO>('POST', `/projects/${projectId}/channels`, input),
  deleteChannel: (projectId: number, conversationId: number) =>
    request<void>('DELETE', `/projects/${projectId}/channels/${conversationId}`),
  addProjectMembers: (projectId: number, input: AddProjectMembersInput) =>
    request<ProjectDTO>('POST', `/projects/${projectId}/members`, input),
  removeProjectMember: (projectId: number, userId: number, input: RemoveProjectMemberInput) =>
    request<ProjectDTO>('DELETE', `/projects/${projectId}/members/${userId}`, input),
  leaveProject: (projectId: number) => request<void>('POST', `/projects/${projectId}/leave`),
  handOverProject: (projectId: number, input: NewOwnerInput) => request<ProjectDTO>('PUT', `/projects/${projectId}/owner`, input),
  deleteProject: (projectId: number) => request<void>('DELETE', `/projects/${projectId}`),
  projectRepos: (projectId: number) => request<ProjectReposDTO>('GET', `/projects/${projectId}/repos`),
  linkRepo: (projectId: number, input: LinkRepoInput) => request<ProjectReposDTO>('POST', `/projects/${projectId}/repos`, input),
  unlinkRepo: (projectId: number, repoId: number) => request<ProjectReposDTO>('DELETE', `/projects/${projectId}/repos/${repoId}`),
  setChatKey: (conversationId: number, key: ChatKeyInput) =>
    request<ConversationDTO>('POST', `/conversations/${conversationId}/key`, key),
  replaceChatKey: (conversationId: number, key: RotatedKeyInput) =>
    request<ConversationDTO>('PUT', `/conversations/${conversationId}/key`, key),
  sync: (input: SyncRequest) => request<SyncResponse>('POST', '/sync', input),
  createDoc: (input: CreateDocInput) => request<DocDTO>('POST', '/docs', input),
  deleteDoc: (docId: string) => request<void>('DELETE', `/docs/${docId}`),
  docSections: (docId: string) => request<DocRevisionDTO[]>('GET', `/docs/${docId}`),
  docWords: (docId: string) => request<DocRevisionDTO[]>('GET', `/docs/${docId}/words`),
  sectionHistory: (docId: string, section: string) => request<DocRevisionDTO[]>('GET', `/docs/${docId}/sections/${section}`),
  lockSection: (docId: string, section: string) => request<void>('POST', `/docs/${docId}/sections/${section}/lock`),
  unlockSection: (docId: string, section: string) => request<void>('DELETE', `/docs/${docId}/sections/${section}/lock`),
  saveSection: (docId: string, section: string, envelope: EnvelopeDTO) =>
    request<DocRevisionDTO>('PUT', `/docs/${docId}/sections/${section}`, { envelope }),
  messages: (conversationId: number, before?: number) =>
    request<MessageDTO[]>('GET', `/conversations/${conversationId}/messages${before ? `?before=${before}` : ''}`),
  sendMessage: (conversationId: number, input: SendMessageInput) =>
    request<MessageDTO>('POST', `/conversations/${conversationId}/messages`, input),
  uploadAddress: (conversationId: number, size: number) => request<UploadDTO>('POST', `/conversations/${conversationId}/files`, { size }),
  fileAddress: (fileId: string) => request<{ url: string }>('GET', `/files/${fileId}`),
  markRead: (conversationId: number, messageId: number) =>
    request<void>('POST', `/conversations/${conversationId}/read`, { messageId }),
  subscribePush: (subscription: PushSubscriptionJSON) => request<void>('POST', '/push/subscribe', subscription),
  unsubscribePush: (endpoint: string) => request<void>('POST', '/push/unsubscribe', { endpoint }),
  testPush: () => request<{ sent: number; failed: number }>('POST', '/push/test'),
  bark: () => request<BarkDTO>('GET', '/bark'),
  linkBark: () => request<BarkDTO>('POST', '/bark/link'),
  unlinkBark: () => request<BarkDTO>('DELETE', '/bark/link'),
  setBarkEncryption: (enabled: boolean) => request<BarkDTO>('PUT', '/bark/encryption', { enabled }),
  github: (refresh = false) => request<GithubDTO>('GET', `/github${refresh ? '?refresh=1' : ''}`),
  setGithubNotify: (notify: boolean) => request<GithubDTO>('PATCH', '/github', { notify }),
  disconnectGithub: () => request<GithubDTO>('DELETE', '/github'),
  pairing: (id: string) => request<PairingDTO | undefined>('GET', `/pairings/${id}`),
  approvePairing: (id: string, input: ApprovePairingInput) => request<UserDTO>('POST', `/pairings/${id}/approve`, input),
  removeAgent: (id: number) => request<void>('DELETE', `/agents/${id}`),
};

/** Tells the server this tab closed. A beacon still gets sent while the page unloads. */
export function sendAwayBeacon(tabId: string) {
  navigator.sendBeacon('/api/away', new Blob([JSON.stringify({ tabId })], { type: 'application/json' }));
}
