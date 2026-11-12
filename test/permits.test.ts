// What the plugin does when a harness asks before an action (docs/decisions/harness-approvals.md),
// without a server: the client is a stub that keeps what it sends.
import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';
import { permitHash } from '../shared/e2ee.ts';
import { ASK_WAIT_MS, type PermitDTO } from '../shared/types.ts';
import type { AgentClient, OpenedMessage } from '../agent/client.ts';
import type { Ask, Reply } from '../agent/harness.ts';
import { Permits } from '../agent/permits.ts';
import { Quiet, watchdog } from '../agent/runner.ts';
import { REQUEST_TTL_MS } from '../agent/runs.ts';

type Question = Extract<PermitDTO, { kind: 'question' }>;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('questions to the owner', () => {
  const CHAT = 7;
  const folder = '/work/app';
  const shell = (detail = 'npm test'): Ask => ({ tool: 'Bash', kind: 'execute', paths: [], detail });
  let sent: Array<{ chat: number; text: string; permit: PermitDTO; cid: string }>;
  let seenIds: Set<string>;
  let permits: Permits;
  let ids = 0;

  beforeEach(() => {
    sent = [];
    seenIds = new Set();
    const client = {
      send: async (chat: number, content: { text: string; permit: PermitDTO }) => {
        const cid = `cid-${++ids}`;
        sent.push({ chat, text: content.text, permit: content.permit, cid });
        return { clientId: cid };
      },
      remember: (id: string) => !seenIds.has(id) && !!seenIds.add(id),
    } as unknown as AgentClient;
    permits = new Permits(client, (m) => m.senderId === 1 && m.conversationId === CHAT && m.security === 'encrypted');
  });

  const turn = (session = 's-1') => permits.forTurn({ session, chat: CHAT, thread: { to: 'root-1' } });
  const questions = () => sent.filter((m) => m.permit.kind === 'question');
  const settled = () => sent.filter((m) => m.permit.kind === 'settled').map((m) => (m.permit as { outcome: string }).outcome);
  /** What the owner's page sends: it signs the time and a hash of the question it showed. */
  const answer = async (to: string, decision: 'once' | 'run' | 'deny', over: Partial<OpenedMessage> & { sentAt?: number; seen?: string } = {}) => {
    const question = sent.find((m) => m.cid === to)?.permit as Question | undefined;
    const permit: PermitDTO = { kind: 'answer', to, decision, seen: over.seen ?? (question ? await permitHash(question) : 'x'), sentAt: over.sentAt ?? Date.now() };
    await permits.answer({ senderId: 1, conversationId: CHAT, security: 'encrypted', clientId: `a-${++ids}`, ...over, content: { text: 'answer', permit } } as OpenedMessage);
  };
  /** Waits for the next question, and returns its client id. */
  const open = async (_waiting: Promise<Reply>) => {
    const before = questions().length;
    for (let tries = 0; tries < 50 && questions().length === before; tries++) await sleep(5);
    return questions().at(-1)!.cid;
  };
  const last = () => questions().at(-1)!.cid;

  test('asks in the direct chat with what the harness gave, and the answer decides', async () => {
    const t = turn();
    const allowed = t.ask(shell());
    const to = await open(allowed);
    assert.equal(questions().length, 1);
    const question = questions()[0]!;
    assert.equal(question.chat, CHAT);
    assert.deepEqual({ ...question.permit, expires: 0 }, { kind: 'question', to: 'root-1', what: 'run', detail: 'npm test', expires: 0 });
    assert.ok(Math.abs((question.permit as Question).expires - (Date.now() + ASK_WAIT_MS)) < 5_000, 'it waits 7 days');
    assert.match(question.text, /^Your agent asks your permission to run a command:\nnpm test$/);
    await answer(to, 'once');
    assert.deepEqual(await allowed, { allow: true });
    assert.deepEqual(settled(), ['allowed']);
    // Once: the same action asks again.
    const again = t.ask(shell());
    await open(again);
    assert.equal(questions().length, 2);
    await answer(last(), 'deny');
    assert.equal((await again).allow, false);
  });

  test('deny says no in fixed words, and stops that action, not the turn', async () => {
    const t = turn();
    const denied = t.ask(shell());
    const to = await open(denied);
    await answer(to, 'deny');
    assert.deepEqual(await denied, { allow: false, message: 'Your owner said no. Do not try it again: do something else, or stop.' });
    assert.deepEqual(settled(), ['denied']);
  });

  test('allow for this run covers exactly the same action, until the run ends or the agent restarts', async () => {
    const t = turn();
    const first = t.ask(shell('npm test'));
    await answer(await open(first), 'run');
    assert.deepEqual(await first, { allow: true });
    assert.deepEqual(settled(), ['allowedForRun']);
    assert.deepEqual(await t.ask(shell('npm test')), { allow: true }, 'the same action goes on with no message');
    assert.equal(questions().length, 1);
    // Another command, another tool, or another kind asks again.
    for (const other of [shell('npm test -- --watch'), { ...shell('npm test'), tool: 'Edit' }, { ...shell('npm test'), kind: 'edit' as const, paths: [folder] }]) {
      const before = questions().length;
      void t.ask(other);
      await sleep(20);
      assert.equal(questions().length, before + 1, JSON.stringify(other));
    }
    // Another session never had the grant, and a session that is over loses it.
    const other = turn('s-2');
    void other.ask(shell('npm test'));
    await sleep(20);
    assert.equal(questions().length, 5, 'another run asks');
    permits.drop('s-1');
    void turn().ask(shell('npm test'));
    await sleep(20);
    assert.equal(questions().length, 6, 'a run that ended asks again');
    // A sweep drops the grants of sessions that are not live, and keeps a turn's.
    const grantedAgain = turn('s-3');
    const third = grantedAgain.ask(shell('ls'));
    await answer(await open(third), 'run');
    await third;
    permits.sweep(new Set());
    assert.equal(questions().length, 7);
    void grantedAgain.ask(shell('ls'));
    await sleep(20);
    assert.equal(questions().length, 7, 'a turn that runs keeps its grants');
    grantedAgain.done();
    permits.sweep(new Set());
    void turn('s-3').ask(shell('ls'));
    await sleep(20);
    assert.equal(questions().length, 8, 'a session nobody holds loses them');
  });

  test('refuses a detail too long to read whole, and posts nothing', async () => {
    const refused = await turn().ask(shell('x'.repeat(1501)));
    assert.deepEqual(refused, { allow: false, message: 'That is too long for your owner to read whole. Do it in smaller steps.' });
    assert.deepEqual(sent, [], 'a refusal posts nothing');
  });

  test('asks at most 3 at once and 25 for a run, then says no', async () => {
    const t = turn();
    const waiting = [1, 2, 3].map((n) => t.ask(shell(`step ${n}`)));
    await sleep(20);
    assert.equal(questions().length, 3);
    assert.deepEqual(await t.ask(shell('step 4')), { allow: false, message: 'Your owner was asked too many times. Do not ask again: do something else, or stop.' });
    assert.equal(questions().length, 3);
    for (const { cid } of questions()) await answer(cid, 'once');
    await Promise.all(waiting);
    for (let n = 4; n <= 25; n++) {
      const next = t.ask(shell(`step ${n}`));
      await answer(await open(next), 'once');
      await next;
    }
    assert.equal(questions().length, 25);
    assert.equal((await t.ask(shell('step 26'))).allow, false, 'the 26th is refused');
    assert.equal(questions().length, 25);
  });

  test('counts an answer once, from the owner, in their chat, within 10 minutes, for the question they saw', async () => {
    const t = turn();
    const pending = t.ask(shell());
    const to = await open(pending);
    // Not the owner, not their direct chat, no such question, and an answer for another action.
    await answer(to, 'once', { senderId: 2 });
    await answer(to, 'once', { conversationId: 99 });
    await answer('nobody', 'once');
    await answer(to, 'once', { seen: 'not what the owner saw' });
    // Not encrypted.
    await answer(to, 'once', { security: 'plain' as never });
    assert.deepEqual(settled(), []);
    // Signed more than 10 minutes ago: it says so, and the question stays open.
    await answer(to, 'once', { sentAt: Date.now() - REQUEST_TTL_MS - 1000 });
    assert.deepEqual(settled(), ['stale']);
    await answer(to, 'once');
    assert.deepEqual(await pending, { allow: true });
    // A second answer finds nothing; the same message again under a new server id is one already counted.
    const replay = { senderId: 1, conversationId: CHAT, security: 'encrypted', clientId: 'a-replay', content: { text: 'x', permit: { kind: 'answer', to, decision: 'once', seen: 'x', sentAt: Date.now() } } } as OpenedMessage;
    await permits.answer(replay);
    await permits.answer({ ...replay, id: 1000 } as OpenedMessage);
    assert.deepEqual(settled(), ['stale', 'allowed']);
  });

  test('a question nobody answers fails its turn after 7 days, by the wall clock', async () => {
    const t = turn();
    const pending = t.ask(shell());
    pending.catch(() => undefined);
    await open(pending);
    await permits.expire(Date.now() + ASK_WAIT_MS - 60_000);
    assert.deepEqual(settled(), [], 'not yet');
    await permits.expire(Date.now() + ASK_WAIT_MS + 60_000);
    await assert.rejects(pending, /^Error: No answer came within 7 days\.$/);
    assert.deepEqual(settled(), ['expired']);
    await answer(last(), 'once');
    assert.deepEqual(settled(), ['expired'], 'a late answer changes nothing');
  });

  test('a turn that ends leaves nothing open, and says it stopped', async () => {
    const t = turn();
    const pending = t.ask(shell());
    await open(pending);
    t.done();
    assert.deepEqual(await pending, { allow: false, message: 'Your owner said no. Do not try it again: do something else, or stop.' });
    assert.deepEqual(settled(), ['stopped']);
    await permits.expire(Date.now() + ASK_WAIT_MS + 60_000);
    assert.deepEqual(settled(), ['stopped'], 'a stopped question never expires later');
    await answer(last(), 'once');
    assert.deepEqual(settled(), ['stopped'], 'nothing is left to answer');
  });

  test('holds the turn\'s silence timer while a question waits, and starts it whole again after', async () => {
    const quiet = new Quiet();
    let stalled = 0;
    const dog = watchdog(50, quiet, () => stalled++);
    await sleep(80);
    assert.equal(stalled, 1, 'silence with no question is a stuck agent');
    stalled = 0;
    let release!: () => void;
    const waiting = quiet.during(new Promise<void>((resolve) => (release = resolve)));
    dog.arm();
    await sleep(120);
    assert.equal(stalled, 0, 'a held timer never fires');
    release();
    await waiting;
    await sleep(30);
    assert.equal(stalled, 0, 'it starts again for its whole time');
    await sleep(60);
    assert.equal(stalled, 1, 'and then fires');
    dog.stop();
  });
});
