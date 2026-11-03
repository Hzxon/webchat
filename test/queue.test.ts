import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { keyedQueue } from '../client/src/queue.ts';

// A job that finishes after `ms` and logs when it starts and ends, so overlap shows in the log.
function job(log: string[], name: string, ms: number, fail = false) {
  return async () => {
    log.push(`start ${name}`);
    await new Promise((resolve) => setTimeout(resolve, ms));
    log.push(`end ${name}`);
    if (fail) throw new Error(name);
    return name;
  };
}

describe('The per-chat send queue in client/src/queue.ts (D-075)', () => {
  test('runs the jobs of one chat one after another, in the order they were queued', async () => {
    const enqueue = keyedQueue();
    const log: string[] = [];
    const results = await Promise.all([
      enqueue(1, job(log, 'one', 30)),
      enqueue(1, job(log, 'two', 10)),
      enqueue(1, job(log, 'three', 1)),
    ]);
    assert.deepEqual(results, ['one', 'two', 'three']);
    assert.deepEqual(log, ['start one', 'end one', 'start two', 'end two', 'start three', 'end three']);
  });

  test('runs the next job of a chat after one that failed', async () => {
    const enqueue = keyedQueue();
    const log: string[] = [];
    const failed = enqueue(1, job(log, 'one', 10, true));
    const next = enqueue(1, job(log, 'two', 1));
    await assert.rejects(failed, /one/);
    assert.equal(await next, 'two');
    assert.deepEqual(log, ['start one', 'end one', 'start two', 'end two']);
  });

  test('does not make one chat wait for another', async () => {
    const enqueue = keyedQueue();
    const log: string[] = [];
    await Promise.all([enqueue(1, job(log, 'slow', 30)), enqueue(2, job(log, 'quick', 1))]);
    assert.deepEqual(log, ['start slow', 'start quick', 'end quick', 'end slow']);
  });
});
