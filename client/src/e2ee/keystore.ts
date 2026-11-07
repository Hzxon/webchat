// This device's encryption keys, kept in IndexedDB so the page and the service worker share them.
// Private keys are stored as non-exportable CryptoKey objects: code can use them but never read
// their bytes, so even a script running on the page cannot copy them off the device.
// Drafts and unsent messages live here too, so that signing out removes them with the keys.
import type { Identity, MessageContent } from '../../../shared/e2ee';
import type { PublicKeysDTO } from '../../../shared/types';

const DB_NAME = 'webchat-keys';
const STORE = 'keys';

export interface StoredIdentity {
  userId: number;
  identity: Identity;
}

/** What someone typed in a chat's message box and has not sent. */
export interface StoredDraft {
  userId: number;
  text: string;
}

/** A message the server has not confirmed. It stays until the server has it or the user removes it. */
export interface StoredUnsent {
  userId: number;
  /** The tab sending it. Another tab takes it over only once this one has closed. */
  tabId: string;
  conversationId: number;
  clientId: string;
  urgent: boolean;
  createdAt: number;
  content: MessageContent;
}

let opening: Promise<IDBDatabase> | undefined;

function database(): Promise<IDBDatabase> {
  opening ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => {
      const db = request.result;
      // Another tab upgrading or deleting the database: let it, and reopen next time.
      db.onversionchange = () => {
        db.close();
        opening = undefined;
      };
      resolve(db);
    };
    request.onerror = () => {
      opening = undefined;
      reject(request.error);
    };
  });
  return opening;
}

async function run<T>(mode: IDBTransactionMode, action: (store: IDBObjectStore) => IDBRequest): Promise<T> {
  const db = await database();
  return new Promise<T>((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const request = action(tx.objectStore(STORE));
    tx.oncomplete = () => resolve(request.result as T);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

const get = <T>(key: string) => run<T | undefined>('readonly', (s) => s.get(key));
const set = (key: string, value: unknown) => run<IDBValidKey>('readwrite', (s) => s.put(value, key));
const remove = (key: string) => run<undefined>('readwrite', (s) => s.delete(key));

export const keystore = {
  getIdentity: () => get<StoredIdentity>('identity'),
  setIdentity: (value: StoredIdentity) => set('identity', value),

  getChatKey: (conversationId: number, keyId: string) => get<CryptoKey>(`chat:${conversationId}:${keyId}`),
  setChatKey: (conversationId: number, keyId: string, key: CryptoKey) => set(`chat:${conversationId}:${keyId}`, key),

  /** By chat id, the key ids a key link showed replaced (K-43). */
  getReplaced: () => get<Record<number, string[]>>('replaced'),
  setReplaced: (replaced: Record<number, string[]>) => set('replaced', replaced),

  /** Everyone's public keys, so the service worker can check who signed a pushed message. */
  getDirectory: () => get<Record<number, PublicKeysDTO>>('directory'),
  setDirectory: (directory: Record<number, PublicKeysDTO>) => set('directory', directory),

  /** Key fingerprints seen first for each person. A different one later means their keys changed. */
  getPins: () => get<Record<number, string>>('pins'),
  setPins: (pins: Record<number, string>) => set('pins', pins),

  /** By chat id, or by "doc:<doc id>:<section>" for a doc section someone is editing. */
  getDraft: (name: number | string) => get<StoredDraft>(`draft:${name}`),
  setDraft: (name: number | string, draft: StoredDraft) => set(`draft:${name}`, draft),
  deleteDraft: (name: number | string) => remove(`draft:${name}`),

  /** The version of each doc this device last showed, so a newer one gets its "Updated" dot. */
  getDocsSeen: () => get<Record<string, number>>('docs-seen'),
  setDocsSeen: (seen: Record<string, number>) => set('docs-seen', seen),

  /** Every unsent message on this device, from every tab. ";" is the character after ":". */
  getUnsent: () => run<StoredUnsent[]>('readonly', (s) => s.getAll(IDBKeyRange.bound('unsent:', 'unsent;', false, true))),
  setUnsent: (message: StoredUnsent) => set(`unsent:${message.clientId}`, message),
  deleteUnsent: (clientId: string) => remove(`unsent:${clientId}`),

  /** Ids of the urgent messages dismissed on this device, which do not alert again as a page opens (D-078). */
  getDismissed: () => get<number[]>('dismissed'),
  setDismissed: (ids: number[]) => set('dismissed', ids),

  /**
   * Removes the account's keys, drafts, unsent messages and dismissed alerts from this device, as on
   * sign-out or when an account signs in. The pins stay: they hold only other people's public key
   * fingerprints, and keeping them is what lets a later sign-in notice keys that changed in between
   * (D-018).
   */
  clearKeys: () =>
    run<undefined>('readwrite', (s) => {
      s.delete(IDBKeyRange.upperBound('pins', true));
      return s.delete(IDBKeyRange.lowerBound('pins', true));
    }),
};
