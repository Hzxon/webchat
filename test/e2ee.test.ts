import assert from 'node:assert/strict';
import { before, describe, test } from 'node:test';
import {
  createIdentity,
  decryptMessage,
  deriveAccountSecrets,
  encryptMessage,
  fromBase64Url,
  importChatKey,
  importIdentity,
  keyFingerprint,
  newChatKeyBytes,
  newKeyId,
  openIdentity,
  safetyCode,
  sealIdentity,
  toBase64Url,
  unwrapChatKey,
  wrapChatKey,
  WrongPasswordError,
  type Identity,
  type IdentitySecrets,
  type MessageMeta,
} from '../shared/e2ee.ts';

// Fewer PBKDF2 rounds keep the suite fast; one test runs the real count.
const FAST = 1000;

describe('end-to-end encryption', () => {
  let aliceSecrets: IdentitySecrets;
  let alice: { id: number; identity: Identity };
  let bob: { id: number; identity: Identity };
  let carol: { id: number; identity: Identity };

  before(async () => {
    aliceSecrets = await createIdentity();
    alice = { id: 1, identity: await importIdentity(aliceSecrets) };
    bob = { id: 2, identity: await importIdentity(await createIdentity()) };
    carol = { id: 3, identity: await importIdentity(await createIdentity()) };
  });

  test('base64url round-trips every byte value', () => {
    const bytes = new Uint8Array(256).map((_, i) => i);
    assert.deepEqual(fromBase64Url(toBase64Url(bytes)), bytes);
    assert.doesNotMatch(toBase64Url(bytes), /[+/=]/);
  });

  test('the password gives a stable login key that reveals nothing about the backup key', async () => {
    const one = await deriveAccountSecrets('correct horse', 'Alice', 'salt-1', FAST);
    const again = await deriveAccountSecrets('correct horse', ' alice ', 'salt-1', FAST);
    const otherPassword = await deriveAccountSecrets('correct horsf', 'alice', 'salt-1', FAST);
    const otherSite = await deriveAccountSecrets('correct horse', 'alice', 'salt-2', FAST);
    assert.equal(one.authKey, again.authKey, 'usernames are case- and space-insensitive');
    assert.notEqual(one.authKey, otherPassword.authKey);
    assert.notEqual(one.authKey, otherSite.authKey);
    assert.match(one.authKey, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(one.backupKey.extractable, false);
  });

  test('the real PBKDF2 round count runs', async () => {
    const started = performance.now();
    const secrets = await deriveAccountSecrets('correct horse', 'alice', 'salt-1');
    assert.match(secrets.authKey, /^[A-Za-z0-9_-]{43}$/);
    console.log(`600k PBKDF2 rounds took ${(performance.now() - started).toFixed(0)} ms`);
  });

  test('a sealed backup opens only with the right password', async () => {
    const right = await deriveAccountSecrets('correct horse', 'alice', 'salt-1', FAST);
    const wrong = await deriveAccountSecrets('wrong horse', 'alice', 'salt-1', FAST);
    const backup = await sealIdentity(aliceSecrets, right.backupKey);
    assert.deepEqual(await openIdentity(backup, right.backupKey), aliceSecrets);
    await assert.rejects(openIdentity(backup, wrong.backupKey), WrongPasswordError);
  });

  test('importing rejects public keys that do not belong to the private keys', async () => {
    const other = await createIdentity();
    await assert.rejects(importIdentity({ ...aliceSecrets, publicKeys: { ...aliceSecrets.publicKeys, dh: other.publicKeys.dh } }));
    await assert.rejects(importIdentity({ ...aliceSecrets, publicKeys: { ...aliceSecrets.publicKeys, sign: other.publicKeys.sign } }));
    assert.equal(alice.identity.dhPrivate.extractable, false);
    assert.equal(alice.identity.signPrivate.extractable, false);
  });

  test('a wrapped chat key opens only for its member, from its real creator, under its key id', async () => {
    const raw = newChatKeyBytes();
    const keyId = newKeyId();
    const forBob = await wrapChatKey(raw, alice, { id: bob.id, dh: bob.identity.publicKeys.dh }, keyId);
    const aliceAsWrapper = { id: alice.id, dh: alice.identity.publicKeys.dh };

    const bobKey = await unwrapChatKey(forBob, bob, aliceAsWrapper, keyId);
    const meta: MessageMeta = { conversationId: 7, senderId: alice.id, urgent: false, clientId: 'c1' };
    const envelope = await encryptMessage(await importChatKey(raw), keyId, alice.identity.signPrivate, meta, 'hi');
    assert.equal(await decryptMessage(bobKey, alice.identity.publicKeys.sign, meta, envelope), 'hi');

    await assert.rejects(unwrapChatKey(forBob, carol, aliceAsWrapper, keyId), 'another member cannot open it');
    await assert.rejects(
      unwrapChatKey(forBob, bob, { id: carol.id, dh: carol.identity.publicKeys.dh }, keyId),
      'a different claimed creator fails',
    );
    await assert.rejects(unwrapChatKey(forBob, bob, aliceAsWrapper, newKeyId()), 'a different key id fails');
  });

  test('the creator can wrap the chat key for their own other devices', async () => {
    const raw = newChatKeyBytes();
    const keyId = newKeyId();
    const forSelf = await wrapChatKey(raw, alice, { id: alice.id, dh: alice.identity.publicKeys.dh }, keyId);
    const key = await unwrapChatKey(forSelf, alice, { id: alice.id, dh: alice.identity.publicKeys.dh }, keyId);
    assert.equal(key.extractable, false);
  });

  test('messages decrypt only unchanged, with their original metadata, from their real sender', async () => {
    const keyId = newKeyId();
    const chatKey = await importChatKey(newChatKeyBytes());
    const meta: MessageMeta = { conversationId: 7, senderId: alice.id, urgent: true, clientId: 'c2' };
    const text = 'Call me now — it is urgent 🚨';
    const envelope = await encryptMessage(chatKey, keyId, alice.identity.signPrivate, meta, text);
    const aliceSign = alice.identity.publicKeys.sign;

    assert.equal(await decryptMessage(chatKey, aliceSign, meta, envelope), text);
    assert.ok(!JSON.stringify(envelope).includes('urgent'), 'no plain text in the envelope');

    const flipped = { ...envelope, ct: envelope.ct.slice(0, -2) + (envelope.ct.endsWith('A') ? 'BA' : 'AA') };
    await assert.rejects(decryptMessage(chatKey, aliceSign, meta, flipped), /bad signature/);
    for (const changed of [
      { ...meta, urgent: false },
      { ...meta, senderId: bob.id },
      { ...meta, conversationId: 8 },
      { ...meta, clientId: 'c3' },
    ]) {
      await assert.rejects(decryptMessage(chatKey, aliceSign, changed, envelope), /bad signature/);
    }
    await assert.rejects(decryptMessage(chatKey, aliceSign, meta, { ...envelope, kid: newKeyId() }), /bad signature/);

    // A member who holds the chat key still cannot pass a message off as Alice's.
    const forged = await encryptMessage(chatKey, keyId, bob.identity.signPrivate, meta, 'I owe Bob money');
    await assert.rejects(decryptMessage(chatKey, aliceSign, meta, forged), /bad signature/);

    const wrongKey = await importChatKey(newChatKeyBytes());
    await assert.rejects(decryptMessage(wrongKey, aliceSign, meta, envelope), /decryption failed/);
  });

  test('safety codes match on both sides and change when a key changes', async () => {
    const a = { id: alice.id, keys: alice.identity.publicKeys };
    const b = { id: bob.id, keys: bob.identity.publicKeys };
    const code = await safetyCode(a, b);
    assert.deepEqual(code, await safetyCode(b, a));
    assert.equal(code.length, 12);
    for (const group of code) assert.match(group, /^\d{5}$/);
    assert.notDeepEqual(code, await safetyCode(a, { id: bob.id, keys: carol.identity.publicKeys }));
    assert.notEqual(await keyFingerprint(a.keys), await keyFingerprint(b.keys));
  });
});
