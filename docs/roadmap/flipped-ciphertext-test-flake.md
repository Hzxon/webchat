### K: The flipped-ciphertext test fails about once in 4,000 runs

Status: Open. Found on 2026-11-12 while building #188.

Seen: one `npm test` run of four failed in `test/e2ee.test.ts`. The `rejects /bad signature/` after
`flipped` resolved. The next three runs passed.

Cause: the test changes the ciphertext's last two characters to `BA` when it ends in `A`, and to
`AA` otherwise. A ciphertext that already ends in `BA` is left as it was, so the message still
opens. That is about one run in 4,096.

Fix: flip the last character to one it is not, such as `A` to `B` and anything else to `A`.
