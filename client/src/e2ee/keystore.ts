// This device's encryption keys, kept in IndexedDB so the page and the service worker share them.
// Private keys are stored as non-exportable CryptoKey objects: code can use them but never read
// their bytes, so even a script running on the page cannot copy them off the device.
import type { Identity } from '../../../shared/e2ee';
import type { PublicKeysDTO } from '../../../shared/types';

const DB_NAME = 'webchat-keys';
const STORE = 'keys';

export interface StoredIdentity {
  userId: number;
  identity: Identity;
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

export const keystore = {
  getIdentity: () => get<StoredIdentity>('identity'),
  setIdentity: (value: StoredIdentity) => set('identity', value),

  getChatKey: (conversationId: number, keyId: string) => get<CryptoKey>(`chat:${conversationId}:${keyId}`),
  setChatKey: (conversationId: number, keyId: string, key: CryptoKey) => set(`chat:${conversationId}:${keyId}`, key),

  /** Everyone's public keys, so the service worker can check who signed a pushed message. */
  getDirectory: () => get<Record<number, PublicKeysDTO>>('directory'),
  setDirectory: (directory: Record<number, PublicKeysDTO>) => set('directory', directory),

  /** Key fingerprints seen first for each person. A different one later means their keys changed. */
  getPins: () => get<Record<number, string>>('pins'),
  setPins: (pins: Record<number, string>) => set('pins', pins),

  /**
   * Removes the account's keys from this device, as on sign-out or when an account signs in. The
   * pins stay: they hold only other people's public key fingerprints, and keeping them is what lets
   * a later sign-in notice keys that changed in between (D-018).
   */
  clearKeys: () =>
    run<undefined>('readwrite', (s) => {
      s.delete(IDBKeyRange.upperBound('pins', true));
      return s.delete(IDBKeyRange.lowerBound('pins', true));
    }),
};
