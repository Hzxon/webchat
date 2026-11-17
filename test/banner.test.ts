import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { BarkDTO } from '../shared/types.ts';

type Push = { permission: string; oldIos: boolean; needsInstall: boolean };

// The path lives in a variable so the tools tsconfig, which has no DOM types, does not typecheck
// the client module. tsx still loads it.
const clientBanner = '../client/src/banner.ts';
const { notificationWarning, shownWarning } = (await import(clientBanner)) as {
  notificationWarning: (push: Push, bark: BarkDTO | null) => string | null;
  shownWarning: (warning: string | null, dismissed: string | null) => string | null;
};

const push = (over: Partial<Push>): Push => ({
  permission: 'unsupported',
  needsInstall: false,
  oldIos: false,
  ...over,
});

const bark = (phones: number | null): BarkDTO => ({
  configured: true,
  link:
    phones === null
      ? null
      : {
          serverUrl: 'https://chat.example/bark/token',
          cipherKey: null,
          devices: Array.from({ length: phones }, (_, i) => ({ key: `phone-${i}`, registeredAt: 1, seenAt: 1 })),
        },
});

test('iOS before 16.4 shows no notification warning once a phone registered in Bark', () => {
  assert.equal(notificationWarning(push({ oldIos: true }), bark(1)), null);
});

test('iOS before 16.4 keeps the warning without a Bark link, a phone, or an answer', () => {
  for (const state of [null, bark(null), bark(0)])
    assert.match(notificationWarning(push({ oldIos: true }), state) ?? '', /need iOS 16\.4/);
});

test('other browsers keep their warning, whatever Bark says', () => {
  assert.match(notificationWarning(push({ permission: 'default' }), bark(1)) ?? '', /Turn on notifications/);
  assert.match(notificationWarning(push({ permission: 'default', needsInstall: true }), bark(1)) ?? '', /Home Screen/);
  assert.match(notificationWarning(push({ permission: 'denied', oldIos: true }), bark(1)) ?? '', /blocked/);
  assert.equal(notificationWarning(push({ permission: 'granted' }), null), null);
});

test('a closed warning stays hidden, and a different one shows again', () => {
  const blocked = notificationWarning(push({ permission: 'denied' }), null);
  const turnOn = notificationWarning(push({ permission: 'default' }), null);
  assert.equal(shownWarning(blocked, blocked), null);
  assert.equal(shownWarning(turnOn, blocked), turnOn);
  assert.equal(shownWarning(blocked, null), blocked);
});
