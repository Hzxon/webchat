// Sign-up, sign-in and unlock. The password never leaves the browser: it is turned into a login
// key for the server and a backup key that opens this account's private keys.
import { deriveAccountSecrets, openIdentity, sealIdentity, type AccountSecrets } from '../../../shared/e2ee';
import type { LoginResponse, UserDTO } from '../../../shared/types';
import { api, ApiError } from '../api';
import { keyring } from './keyring';

async function secretsFor(username: string, password: string): Promise<AccountSecrets> {
  const { kdfSalt } = await api.config();
  return deriveAccountSecrets(password, username, kdfSalt);
}

/** Opens the sealed keys from the server, or creates keys for an account that has none yet. */
async function finishKeys(response: LoginResponse, secrets: AccountSecrets) {
  if (response.backup) {
    const identity = await openIdentity(response.backup, secrets.backupKey);
    // Others encrypt to the public keys the server lists for this account. They must be the ones
    // sealed in the backup, or someone replaced them to read new chats.
    const listed = response.user.keys;
    if (!listed || listed.dh !== identity.publicKeys.dh || listed.sign !== identity.publicKeys.sign) {
      throw new Error('The server lists different encryption keys for your account than your backup holds. Do not use this site until the owner checks it.');
    }
    await keyring.adopt(response.user.id, identity);
    return;
  }
  const created = await keyring.createSecrets();
  const backup = await sealIdentity(created, secrets.backupKey);
  await api.putKeys(secrets.authKey, { ...created.publicKeys, backup });
  await keyring.adopt(response.user.id, created);
}

/**
 * Accounts from before encryption have a hash of the raw password. This sends the password one
 * last time so the server can check it and switch to the login key.
 */
async function upgrade(username: string, password: string, secrets: AccountSecrets) {
  const response = await api.upgrade(username, password, secrets.authKey);
  await finishKeys(response, secrets);
}

export async function register(input: { username: string; displayName: string; password: string; inviteCode: string }) {
  const secrets = await secretsFor(input.username, input.password);
  const created = await keyring.createSecrets();
  const user = await api.register({
    username: input.username,
    displayName: input.displayName,
    authKey: secrets.authKey,
    inviteCode: input.inviteCode,
    keys: { ...created.publicKeys, backup: await sealIdentity(created, secrets.backupKey) },
  });
  await keyring.adopt(user.id, created);
}

export async function signIn(username: string, password: string) {
  const secrets = await secretsFor(username, password);
  try {
    await finishKeys(await api.login(username, secrets.authKey), secrets);
  } catch (error) {
    if (error instanceof ApiError && error.code === 'upgrade_required') return upgrade(username, password, secrets);
    throw error;
  }
}

/** For a signed-in session on a device that does not hold the keys yet. */
export async function unlock(me: UserDTO, password: string) {
  const secrets = await secretsFor(me.username, password);
  try {
    await finishKeys(await api.keysBackup(secrets.authKey), secrets);
  } catch (error) {
    if (error instanceof ApiError && error.code === 'upgrade_required') return upgrade(me.username, password, secrets);
    throw error;
  }
}
