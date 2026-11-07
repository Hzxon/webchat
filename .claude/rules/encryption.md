---
paths:
  - "shared/e2ee.ts"
  - "shared/keyring.ts"
  - "agent/client.ts"
  - "client/src/e2ee/**"
  - "client/src/sw.ts"
  - "server/push.ts"
  - "server/notify.ts"
  - "test/e2ee.test.ts"
  - "test/keyring.test.ts"
  - "test/sw.test.ts"
---
# End-to-end encryption

Each line is a constraint the code cannot state on its own. The number names the decision in
docs/decisions.md that explains it.

- All end-to-end encryption lives in `shared/e2ee.ts` on Web Crypto only; it runs in the page, the service worker and the tests (D-014).
- The password never leaves the browser, except on the one-time upgrade sign-in of an `auth_version` 1 account (D-014, D-019).
- The server stores the login key only as a scrypt hash and the private keys only sealed with the backup key (D-014).
- Device keys are non-exportable IndexedDB keys (D-014).
- A page accepts a wrapped chat key only when the wrapper is a chat member; the server checks a new key is wrapped exactly once per member (D-015).
- Sign every field the server could change and the page relies on; the server refuses bad values and never corrects a signed field (D-016).
- Add a new signed header field only for new kinds, so old messages still verify (D-016).
- The page checks a decrypted message again when the server sends it with any signed field or the signature changed (D-016).
- A push payload is at most 3,000 bytes and never carries the plain text of an encrypted message (D-017).
- Push shows "New message" when too long, and "New encrypted message" when keys are missing or the signature fails (D-017).
- The service worker needs chat keys and everyone's public keys in IndexedDB (D-017).
- Never wrap a new chat key for a person whose keys changed until the user checks the security code (D-018).
- Until checked, trust nothing signed or wrapped with the changed keys: do not open their new chat keys, show their messages unreadable (D-018).
- Key pins stay on the device across sign-out and sign-in and hold only public key fingerprints (D-018).
- Chats from before encryption take their key from the first member who sends; the first key set wins (D-019).
- The server refuses unencrypted messages; ones from the database show "Not encrypted:" and never alert (D-019).
- A feature that shows the server something new must be added to D-020's list and to the README section "What it does not protect against" (D-020).
- On leave or removal, make a new chat key for everyone who stays, never for the leaver, and link the old key under it in `key_links` (D-044).
- The server checks each new key under the project's or group's lock: it names the current key and is wrapped for exactly the people who stay (D-044).
- A chat with `needs_new_key` refuses messages with `409 needs_new_key`; a losing `PUT /conversations/:id/key` gets `409 stale_key` (D-044).
- A page or agent never encrypts with a key a link says was replaced, and keeps those key ids per chat on the device, since the server can drop a link (D-044, K-43).
- Every copy of a chat key names its chat (`webchat/chat-key/v2`); a new chat's first key is wrapped for the id `POST /conversations/ids` reserves, and opening still falls back to v1 for older copies (D-111).
- The page and the agent take the chat-key checks, the key cache and the pins from `shared/keyring.ts`; never copy them into one side (K-40, D-085).
- Message content is padded to powers of two from 256 bytes inside the AES-GCM ciphertext; `decryptContent` tells it from older unpadded content by the last byte, and both open (D-059).
- The service worker never shows a reaction notification; it hands it to open pages, under the tag `reaction-` plus the chat id (D-070).
