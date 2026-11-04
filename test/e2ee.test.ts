import assert from 'node:assert/strict';
import { before, describe, test } from 'node:test';
import {
  createIdentity,
  decryptContent,
  decryptDoc,
  decryptMessage,
  deriveAccountSecrets,
  encryptDoc,
  encryptMessage,
  fromBase64Url,
  importChatKey,
  importIdentity,
  keyFingerprint,
  linkChatKey,
  newChatKeyBytes,
  newKeyId,
  openChatKeyBytes,
  openIdentity,
  openKeyLink,
  padContent,
  PAD_MIN_BYTES,
  safetyCode,
  sealIdentity,
  toBase64Url,
  unpadContent,
  unwrapChatKey,
  wrapChatKey,
  WrongPasswordError,
  type Identity,
  type DocContent,
  type DocMeta,
  type IdentitySecrets,
  type MessageMeta,
} from '../shared/e2ee.ts';
import type { PullCardDTO } from '../shared/types.ts';

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

  test('a member can share a chat key with a newcomer, who opens it only from that member', async () => {
    const raw = newChatKeyBytes();
    const keyId = newKeyId();
    const forBob = await wrapChatKey(raw, alice, { id: bob.id, dh: bob.identity.publicKeys.dh }, keyId);
    const bobsCopy = await openChatKeyBytes(forBob, bob, { id: alice.id, dh: alice.identity.publicKeys.dh }, keyId);
    assert.deepEqual(bobsCopy, raw);

    const forCarol = await wrapChatKey(bobsCopy, bob, { id: carol.id, dh: carol.identity.publicKeys.dh }, keyId);
    const meta: MessageMeta = { conversationId: 9, senderId: alice.id, urgent: false, clientId: 'old' };
    const history = await encryptMessage(await importChatKey(raw), keyId, alice.identity.signPrivate, meta, 'from before Carol joined');
    const carolKey = await unwrapChatKey(forCarol, carol, { id: bob.id, dh: bob.identity.publicKeys.dh }, keyId);
    assert.equal(await decryptMessage(carolKey, alice.identity.publicKeys.sign, meta, history), 'from before Carol joined');
    await assert.rejects(
      unwrapChatKey(forCarol, carol, { id: alice.id, dh: alice.identity.publicKeys.dh }, keyId),
      'the copy names Bob as its wrapper, not Alice',
    );
  });

  test('a new chat key carries the old one, which opens only with the new key, in its own chat and place', async () => {
    const oldRaw = newChatKeyBytes();
    const oldId = newKeyId();
    const meta: MessageMeta = { conversationId: 5, senderId: alice.id, urgent: false, clientId: 'before' };
    const before = await encryptMessage(await importChatKey(oldRaw), oldId, alice.identity.signPrivate, meta, 'sent before Carol left');

    const newKey = await importChatKey(newChatKeyBytes());
    const newId = newKeyId();
    const link = await linkChatKey(newKey, newId, 5, oldRaw, oldId);
    const opened = await openKeyLink(newKey, newId, 5, link, oldId);
    assert.equal(await decryptMessage(opened, alice.identity.publicKeys.sign, meta, before), 'sent before Carol left');
    assert.equal(opened.extractable, false);

    await assert.rejects(openKeyLink(await importChatKey(oldRaw), newId, 5, link, oldId), 'the old key cannot open it');
    await assert.rejects(openKeyLink(newKey, newId, 6, link, oldId), 'it belongs to one chat');
    await assert.rejects(openKeyLink(newKey, newKeyId(), 5, link, oldId), 'it belongs to the key that replaced it');
    await assert.rejects(openKeyLink(newKey, newId, 5, link, newKeyId()), 'it names the key it holds');
  });

  test('replies and reactions travel inside the envelope, and the kind is signed', async () => {
    const key = await importChatKey(newChatKeyBytes());
    const keyId = newKeyId();
    const meta: MessageMeta = { conversationId: 4, senderId: alice.id, urgent: false, clientId: 'r1', kind: 'reaction' };
    const content = { text: '', reaction: { messageId: 12, emoji: '👍' } };
    const envelope = await encryptMessage(key, keyId, alice.identity.signPrivate, meta, content);
    assert.deepEqual(await decryptContent(key, alice.identity.publicKeys.sign, meta, envelope), content);
    await assert.rejects(decryptContent(key, alice.identity.publicKeys.sign, { ...meta, kind: 'message' }, envelope), /bad signature/);

    const reply = { text: 'Yes', replyTo: { id: 12, senderId: bob.id, text: 'x'.repeat(500) } };
    const plain = { ...meta, kind: undefined };
    const opened = await decryptContent(key, alice.identity.publicKeys.sign, plain, await encryptMessage(key, keyId, alice.identity.signPrivate, plain, reply));
    assert.equal(opened.replyTo!.text.length, 160, 'a quote is cut to its limit');
  });

  test('a shared pull request travels inside the envelope, and a card that points elsewhere is dropped', async () => {
    const key = await importChatKey(newChatKeyBytes());
    const keyId = newKeyId();
    const meta: MessageMeta = { conversationId: 4, senderId: alice.id, urgent: false, clientId: 'p1' };
    const pull = {
      repo: 'acme/app',
      number: 7,
      title: 'Add login page',
      url: 'https://github.com/acme/app/pull/7',
      draft: false,
      review: 'approved' as const,
      checks: 'failure' as const,
      conflicts: true,
    };
    const content = { text: 'Pull request acme/app#7: Add login page', pull };
    const envelope = await encryptMessage(key, keyId, alice.identity.signPrivate, meta, content);
    assert.deepEqual(await decryptContent(key, alice.identity.publicKeys.sign, meta, envelope), content);

    const elsewhere = { ...content, pull: { ...pull, url: 'https://evil.example/acme/app/pull/7' } };
    const opened = await decryptContent(key, alice.identity.publicKeys.sign, meta, await encryptMessage(key, keyId, alice.identity.signPrivate, meta, elsewhere));
    assert.equal(opened.pull, undefined, 'the text stays, the card goes');
    assert.equal(opened.text, content.text);
  });

  test('a card names who still has to review; a card from before reviewers keeps none, not an empty list', async () => {
    const key = await importChatKey(newChatKeyBytes());
    const keyId = newKeyId();
    const meta: MessageMeta = { conversationId: 4, senderId: alice.id, urgent: false, clientId: 'p2' };
    // Some cards here are malformed on purpose, as a page with a bug or a hostile member could send.
    const open = async (pull: object) => {
      const content = { text: 'Pull request', pull: pull as PullCardDTO };
      const envelope = await encryptMessage(key, keyId, alice.identity.signPrivate, meta, content);
      return (await decryptContent(key, alice.identity.publicKeys.sign, meta, envelope)).pull;
    };
    const old = {
      repo: 'acme/app',
      number: 8,
      title: 'Add sign-up page',
      url: 'https://github.com/acme/app/pull/8',
      draft: false,
      review: 'review_required' as const,
      checks: null,
      conflicts: false,
    };
    const card = { ...old, reviewers: ['bob', 'acme/designers'], assignees: ['alice'] };

    assert.deepEqual(await open(card), card);
    assert.deepEqual(await open(old), old);
    assert.deepEqual(await open({ ...card, auto: true }), card, 'a card from before D-050 loses its automatic mark');
    const odd = await open({ ...card, reviewers: ['bob', 42, 'two words', 'a/b/c'], assignees: 'alice' });
    assert.deepEqual([odd!.reviewers, odd!.assignees], [['bob'], undefined]);
  });

  test('a reply can quote a card from GitHub, which has no sender, as sender 0', async () => {
    const key = await importChatKey(newChatKeyBytes());
    const keyId = newKeyId();
    const meta: MessageMeta = { conversationId: 4, senderId: alice.id, urgent: false, clientId: 'q1' };
    const quoting = async (senderId: number) => {
      const content = { text: 'On it', replyTo: { id: 12, senderId, text: 'octo opened a pull request' } };
      const envelope = await encryptMessage(key, keyId, alice.identity.signPrivate, meta, content);
      return (await decryptContent(key, alice.identity.publicKeys.sign, meta, envelope)).replyTo;
    };
    assert.deepEqual(await quoting(0), { id: 12, senderId: 0, text: 'octo opened a pull request' });
    assert.equal(await quoting(-1), undefined);
  });

  test('the creator can wrap the chat key for their own other devices', async () => {
    const raw = newChatKeyBytes();
    const keyId = newKeyId();
    const forSelf = await wrapChatKey(raw, alice, { id: alice.id, dh: alice.identity.publicKeys.dh }, keyId);
    const key = await unwrapChatKey(forSelf, alice, { id: alice.id, dh: alice.identity.publicKeys.dh }, keyId);
    assert.equal(key.extractable, false);
  });

  test('padding fills the content to the next band, and comes off again', () => {
    const bytes = (length: number) => new Uint8Array(length).map((_, i) => 32 + (i % 90));
    for (const [length, band] of [
      [0, 256],
      [255, 256],
      [256, 512],
      [511, 512],
      [512, 1024],
      [5000, 8192],
    ] as const) {
      const padded = padContent(bytes(length));
      assert.equal(padded.length, band, `${length} bytes pad to ${band}`);
      assert.deepEqual(unpadContent(padded), bytes(length));
    }
    assert.equal(PAD_MIN_BYTES, 256);
  });

  test('a reaction, a take-back and a short message give ciphertexts of the same length', async () => {
    const key = await importChatKey(newChatKeyBytes());
    const keyId = newKeyId();
    const sign = alice.identity.signPrivate;
    const message = (clientId: string): MessageMeta => ({ conversationId: 4, senderId: alice.id, urgent: false, clientId });
    const reaction = (clientId: string): MessageMeta => ({ ...message(clientId), kind: 'reaction' });
    const lengths = await Promise.all([
      encryptMessage(key, keyId, sign, message('m1'), 'ok'),
      encryptMessage(key, keyId, sign, message('m2'), 'See you at the library at six, bring the slides'),
      encryptMessage(key, keyId, sign, reaction('r1'), { text: '', reaction: { messageId: 12, emoji: '❤️' } }),
      encryptMessage(key, keyId, sign, reaction('r2'), { text: '', reaction: { messageId: 12, emoji: '👍' } }),
      encryptMessage(key, keyId, sign, reaction('r3'), { text: '', reaction: { messageId: 12, emoji: '' } }),
    ]).then((envelopes) => envelopes.map((e) => fromBase64Url(e.ct).length));
    assert.deepEqual(lengths, Array(5).fill(PAD_MIN_BYTES + 16), 'the smallest band plus the AES-GCM tag');

    const longer = await encryptMessage(key, keyId, sign, message('m3'), 'x'.repeat(300));
    assert.equal(fromBase64Url(longer.ct).length, 2 * PAD_MIN_BYTES + 16);
    assert.equal(await decryptMessage(key, alice.identity.publicKeys.sign, message('m3'), longer), 'x'.repeat(300));
  });

  test('a message from before padding still opens', async () => {
    const key = await importChatKey(newChatKeyBytes());
    const keyId = newKeyId();
    const meta: MessageMeta = { conversationId: 4, senderId: alice.id, urgent: false, clientId: 'old1' };
    const head = `webchat/msg/v1|conv:${meta.conversationId}|kid:${keyId}|from:${meta.senderId}|urgent:0|cid:${meta.clientId}`;
    const subtle = globalThis.crypto.subtle;
    const encode = (text: string) => new TextEncoder().encode(text);
    const iv = toBase64Url(globalThis.crypto.getRandomValues(new Uint8Array(12)));
    const text = 'Sent before envelopes were padded';
    const ct = toBase64Url(
      await subtle.encrypt({ name: 'AES-GCM', iv: fromBase64Url(iv), additionalData: encode(head) }, key, encode(JSON.stringify({ text }))),
    );
    const sig = toBase64Url(await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, alice.identity.signPrivate, encode(`${head}|iv:${iv}|ct:${ct}`)));
    assert.ok(fromBase64Url(ct).length < PAD_MIN_BYTES, 'not padded');
    assert.equal(await decryptMessage(key, alice.identity.publicKeys.sign, meta, { v: 1, kid: keyId, iv, ct, sig }), text);
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

  test('a doc revision opens only in its own doc and section, from its author, and never as a message', async () => {
    const key = await importChatKey(newChatKeyBytes());
    const keyId = newKeyId();
    const meta: DocMeta = { conversationId: 7, authorId: alice.id, docId: newKeyId(), section: 'goals' };
    const content = { text: '## Goals\n\n- Ship the export', pos: 2 };
    const envelope = await encryptDoc(key, keyId, alice.identity.signPrivate, meta, content);
    const aliceSign = alice.identity.publicKeys.sign;
    assert.deepEqual(await decryptDoc(key, aliceSign, meta, envelope), content);
    for (const moved of [{ ...meta, section: 'title' }, { ...meta, docId: newKeyId() }, { ...meta, conversationId: 8 }, { ...meta, authorId: bob.id }]) {
      await assert.rejects(decryptDoc(key, aliceSign, moved, envelope), /bad signature/);
    }
    const asMessage: MessageMeta = { conversationId: 7, senderId: alice.id, urgent: false, clientId: 'd1' };
    await assert.rejects(decryptContent(key, aliceSign, asMessage, envelope), /bad signature/);
    const forged = await encryptDoc(key, keyId, bob.identity.signPrivate, meta, { text: 'Bob wrote this' });
    await assert.rejects(decryptDoc(key, aliceSign, meta, forged), /bad signature/);
    // A board doc's title carries which column it is (R-021), and nothing else slips through.
    const title = await encryptDoc(key, keyId, alice.identity.signPrivate, meta, { text: 'Decisions', board: 'decisions', extra: 1 } as DocContent);
    assert.deepEqual(await decryptDoc(key, aliceSign, meta, title), { text: 'Decisions', board: 'decisions' });
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
