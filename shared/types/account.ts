import { type ConversationDTO, type MessageDTO, type ProjectDTO } from './chat.js';
import { type DocDTO } from './docs.js';

// Types shared by the server, the web client, and the service worker.
// The file also holds the few values and checks that more than one of them must agree on: LIMITS,
// the channel name rules, the build header and the test for Apple's push service.
// They live with the types so that each side imports one file and none can drift from the others.
// They are small and import nothing, so they add little code to the page and the service worker.

/** A user's public keys, base64url of the raw P-256 points. Null until the user sets up encryption. */
export interface PublicKeysDTO {
  /** ECDH key: other members wrap chat keys for it. */
  dh: string;
  /** ECDSA key: verifies the messages this user signs. */
  sign: string;
}

export interface UserDTO {
  id: number;
  username: string;
  displayName: string;
  online: boolean;
  lastSeen: number | null;
  keys: PublicKeysDTO | null;
  /** For a coding agent's account (R-027, D-085), the person it runs cards for (D-089). */
  agentOwner: number | null;
  /** What the agent's laptop can do, as a level of AGENT_LEVEL; 0 until a plugin that serves every folder checked in (R-036). */
  protocol: number;
  /** For an agent in Claude Code: a session per repository, each taking that repository's runs (R-032). */
  agentRepos: AgentRepoDTO[];
  /** The account was deleted (R-028). It stays listed so its old messages keep their sender's name. */
  deleted: boolean;
}

/** An agent's Claude Code session, by the repository it is open in, as "owner/name" (R-032, D-094). */
export interface AgentRepoDTO {
  repo: string;
  online: boolean;
  lastSeen: number;
  /** What it can do, as a level of AGENT_LEVEL; 0 for a session on an older plugin (D-103). */
  protocol: number;
}

export interface BootstrapDTO {
  me: UserDTO;
  users: UserDTO[];
  projects: ProjectDTO[];
  conversations: ConversationDTO[];
  /** Newest message id the client has now seen. Sync returns messages after it. */
  cursor: number;
  /** Fingerprint of everything this user can see. Sync answers "unchanged" while it matches. */
  stamp: string;
  /**
   * Each chat's newest urgent message from someone else that this user has not read, sent in the
   * last 3 days. The page alerts for them as it opens (D-078).
   */
  urgent: MessageDTO[];
  docs: DocDTO[];
}

export interface ConfigDTO {
  vapidPublicKey: string;
  /** Random per deployment; mixed into the password key derivation. */
  kdfSalt: string;
  /** The release this server runs, such as 0.10.0, whose agent files the Connect dialog names. */
  release: string;
  /** The server has a file store, so the message box offers photos and files (R-005). */
  files: boolean;
}

/** Private keys encrypted with a key only the user's password can derive. */
export interface SealedBackupDTO {
  iv: string;
  data: string;
}

export interface AccountKeysInput {
  dh: string;
  sign: string;
  backup: SealedBackupDTO;
}

export interface RegisterInput {
  username: string;
  displayName: string;
  /** Derived from the password in the browser. The password itself never leaves the browser. */
  authKey: string;
  inviteCode: string;
  keys: AccountKeysInput;
}

export interface LoginInput {
  username: string;
  /** Derived from the password in the browser, or for an agent, the random key it paired with. */
  authKey: string;
}

export interface LoginResponse {
  user: UserDTO;
  /** Null when the account has no keys yet; the client then creates them. */
  backup: SealedBackupDTO | null;
}
