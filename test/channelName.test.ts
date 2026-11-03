import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isChannelName, LIMITS, toChannelName } from '../shared/types.ts';

const almostFull = 'a'.repeat(LIMITS.channelNameLength - 1);

test('the dialog turns what people type into a Slack-style name', () => {
  assert.equal(toChannelName('Slides & Design'), 'slides-design');
  assert.equal(toChannelName('  --Дизайн 2--  '), 'дизайн-2');
});

test('a name cut to the limit never ends with a hyphen', () => {
  assert.equal(toChannelName(`${almostFull} b`), almostFull);
});

test('a capital with no lowercase form becomes its plain letter', () => {
  assert.equal(toChannelName('ℂhat'), 'chat');
});

test('the cut never splits a character in two', () => {
  assert.equal(toChannelName(`${almostFull}𠀀`), almostFull);
});

test('every name the dialog makes passes the check', () => {
  for (const value of [`${almostFull} b`, 'ℂhat', `${almostFull}𠀀`, 'Slides & Design', '设计 Team', 'ǅemal']) {
    assert.ok(isChannelName(toChannelName(value)), value);
  }
});

test('the check refuses capitals, stray hyphens and long names', () => {
  for (const name of ['Design', 'ℂhat', 'design--team', '-design', 'design-', 'a'.repeat(LIMITS.channelNameLength + 1)]) {
    assert.equal(isChannelName(name), false, name);
  }
});
