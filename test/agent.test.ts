import fs from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe } from 'node:test';
import { createApp } from '../server/app.ts';
import { loadConfig } from '../server/config.ts';
import { briefText, type RunRequest, type RunDTO } from '../shared/types.ts';
import { textHash } from '../shared/e2ee.ts';
import { type World } from './agentHelpers.ts';
import { accountTests } from './agentAccount.ts';
import { connectTests } from './agentConnect.ts';
import { pairingTests } from './agentPairing.ts';
import { promptTests } from './agentPrompts.ts';
import { runTests } from './agentRuns.ts';
import { runnerTests } from './agentRunner.ts';
import { serveTests } from './agentServe.ts';
import { setupTests } from './agentSetup.ts';

// The tests of the agent client run in order and share one server and one set of accounts. Each
// feature has its own file, which registers its tests in the order they run here; the standalone
// tests that need no server are in agentHarness.ts. Add the tests of a new feature in a new file.
describe('agent client (R-027)', () => {
  const w = {
    cardText: '### K-1: Pushes with bad keys\n\nStatus: Open.\n\nSeen: on a phone.',
    k2: '',
    k2Text: '### K-2: Sums are off\n\nStatus: Open.',
  } as World;
  // The hash of the brief the owner saw: the card as it is now, and this board has no decisions (D-105).
  w.runOf = async (extra: Partial<RunRequest> = {}): Promise<RunDTO> => ({
    kind: 'request',
    card: 'K-1',
    title: 'Pushes with bad keys',
    docId: w.roadmap.id,
    section: w.cardId,
    runtime: w.bot.id,
    sentAt: Date.now(),
    hash: await textHash(briefText((await w.alice.sections(w.roadmap)).find((c) => c.id === w.cardId)?.text ?? '', [])),
    ...extra,
  });
  w.runOfK2 = async () => w.runOf({ card: 'K-2', title: 'Sums are off', section: w.k2, hash: await textHash(briefText(w.k2Text, [])) });

  before(async () => {
    w.home = await fs.mkdtemp(path.join(os.tmpdir(), 'webchat-agent-'));
    const config = loadConfig({ PGLITE_DIR: ':memory:', INVITE_CODE: 'friends-only', GITHUB_POLL_SECONDS: '0', SESSION_DAYS: '1', FILES_DIR: path.join(w.home, 'files') });
    w.instance = await createApp({ ...config, logger: { info() {}, warn() {}, error() {} } });
    w.server = http.createServer(w.instance.app);
    await new Promise<void>((resolve) => w.server.listen(0, '127.0.0.1', resolve));
    w.baseUrl = `http://127.0.0.1:${(w.server.address() as AddressInfo).port}`;
    w.botFile = path.join(w.home, 'bot', 'account.json');
  });

  after(async () => {
    await new Promise<void>((resolve) => w.server?.close(() => resolve()));
    await w.instance?.close();
    await fs.rm(w.home, { recursive: true, force: true });
  });

  pairingTests(w);
  runTests(w);
  serveTests(w);
  runnerTests(w);
  connectTests(w);
  promptTests(w);
  accountTests(w);
  setupTests(w);
});

await import('./agentHarness.ts');
