import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { claudeHarness } from '../agent/claude.ts';
import { AgentClient, type OpenedMessage } from '../agent/client.ts';
import { codexHarness } from '../agent/codex.ts';
import { Plugin } from '../agent/plugin.ts';
import { REQUEST_TTL_MS } from '../agent/runs.ts';
import { newKeyId, newPairingCode, pairingId, openPicks, textHash, permitHash, type MessageContent } from '../shared/e2ee.ts';
import { briefText, harnessRow, LIMITS, type CardDraftDTO, type RunReport, type CreateProjectResponse, type PermitDTO, type PromptDTO, type RunRequest, type SetupChoice } from '../shared/types.ts';
import { copyOf, readCard } from '../shared/board.ts';
import { FAKE_CLAUDE, FAKE_CODEX } from './fakes.ts';
import { sh, git, connect, disconnect, FAKE_GH, newChatKey, withEnv, setEnv, waitFor, approve } from './agentHelpers.ts';
import type { World } from './agentHelpers.ts';

export function serveTests(w: World) {
  test(
    'serves every folder from one window, runs a card in a background Claude, fixes its pull request, and clones a repository on its owner\'s word (R-030, R-035, R-036)',
    // A backlog of 40 proposals alone takes 16 seconds under the send limit (K-71), and the overlap gate's runs as long.
    { timeout: 120_000 },
    async () => {
      // A checkout whose origin is on GitHub, as its config says. Its pushes land in a bare repository here.
      const origin = path.join(w.home, 'app.git');
      const project = path.join(w.home, 'app');
      await sh('git', ['init', '-q', '--bare', '-b', 'main', origin]);
      await sh('git', ['clone', '-q', origin, project]);
      await fs.writeFile(path.join(project, 'README.md'), '# App\n');
      await git(project, 'add', 'README.md');
      await git(project, 'commit', '-q', '-m', 'Start');
      await git(project, 'push', '-q', '-u', 'origin', 'main');
      await git(project, 'remote', 'set-url', 'origin', 'https://github.com/acme/app.git');
      await git(project, 'config', `url.${origin}.insteadOf`, 'https://github.com/acme/app.git');
      const bin = path.join(w.home, 'bin');
      await fs.mkdir(bin);
      await fs.writeFile(path.join(bin, 'gh'), FAKE_GH, { mode: 0o755 });
      await fs.writeFile(path.join(bin, 'claude'), FAKE_CLAUDE, { mode: 0o755 });
      await fs.writeFile(path.join(bin, 'codex'), FAKE_CODEX, { mode: 0o755 });
      const ghState = path.join(w.home, 'gh.json');
      await fs.writeFile(ghState, JSON.stringify({ origin, pulls: [] }));
      const claudeLog = path.join(w.home, 'claude.log');
      const gitConfig = path.join(w.home, 'gitconfig');
      // The agent's own clone fetches from GitHub's address, which the test points at its bare repository.
      await fs.writeFile(gitConfig, `[user]\n\tname = Alice\n\temail = alice@example.com\n[url "${origin}"]\n\tinsteadOf = https://github.com/acme/app.git\n`);
      const restore = setEnv({
        GIT_CONFIG_GLOBAL: gitConfig,
        PATH: `${bin}${path.delimiter}${process.env.PATH}`,
        FAKE_GH_STATE: ghState,
        FAKE_CLAUDE_LOG: claudeLog,
        FAKE_CODEX_LOG: path.join(w.home, 'codex.log'),
        GH_CONFIG_DIR: path.join(w.home, 'gh'),
        CLAUDE_CONFIG_DIR: path.join(w.home, 'claude'),
      });
      const dataDir = path.join(w.home, 'plugin');
      // The owner turned the plan gate off for these runs; the gate has a run of its own below.
      await fs.mkdir(path.join(dataDir, 'laptop'), { recursive: true });
      await fs.writeFile(path.join(dataDir, 'laptop', 'setup.json'), JSON.stringify({ choice: { claudeMd: false, skills: [], noAttribution: false, noPlan: true } }));
      // The owner's settings turn the sandbox off, which no longer counts: the background Claude runs under the plugin's.
      await fs.mkdir(path.join(project, '.claude'));
      await fs.writeFile(path.join(project, '.claude', 'settings.local.json'), JSON.stringify({ sandbox: { enabled: false } }));
      const cloneRoot = path.join(w.home, 'WebChat');
      const options = { harnesses: [claudeHarness(path.join(bin, 'claude'), dataDir), codexHarness(path.join(bin, 'codex'), dataDir)], cloneRoot };
      const turns = async () =>
        (await fs.readFile(claudeLog, 'utf8').catch(() => ''))
          .split('\n')
          // The fake Claude may be mid-write: a line counts once its newline is there.
          .slice(0, -1)
          .map((line) => JSON.parse(line) as { args: string[]; input: string; cwd: string; plugin?: string[]; session: string; resumed: boolean; turn: number; pid: number; mcp?: { mcpServers: { webchat: { url: string; headers: { Authorization: string } } } } });
      try {
        const code = newPairingCode();
        // The page shows its address with the code, so the address setting stays empty (R-031).
        const plugin = new Plugin({ ...options, code: `${w.baseUrl}#${code}`, dataDir });
        const starting = plugin.start();
        const pairingRows = async () => w.instance.sql.query<{ picks: string | null }>('SELECT picks FROM webchat.pairings WHERE id = $1', [await pairingId(code)]);
        await waitFor('the pairing is filed', async () => (await pairingRows()).length > 0);
        const [filed] = await pairingRows();
        assert.ok(filed!.picks && !/Claude|Codex/.test(Buffer.from(filed!.picks, 'base64url').toString('latin1')), 'the server holds the picks sealed');
        assert.equal(JSON.parse(await fs.readFile(path.join(dataDir, 'laptop', 'setup.json'), 'utf8')).choice.linked, undefined, 'nothing links before the owner approves');
        const agent = await approve(w.alice, code, 'Claude Code');
        assert.equal(await starting, true);
        assert.deepEqual(await openPicks(code, agent.keys!, filed!.picks), [{ name: 'Claude Code', version: '2.1.300', signedIn: true }, { name: 'Codex', version: '0.58.0', signedIn: true }]);
        assert.deepEqual(JSON.parse(await fs.readFile(path.join(dataDir, 'laptop', 'setup.json'), 'utf8')).choice.linked, ['Claude Code', 'Codex'], 'the approved picks link');
        // The agent is online with no folder yet, and says what its laptop can do (R-036, D-103).
        await plugin.client!.sync();
        await w.alice.sync();
        assert.deepEqual([w.alice.users.get(agent.id)?.online, w.alice.users.get(agent.id)?.protocol, w.alice.users.get(agent.id)?.agentRepos], [true, 5, []]);
        // The owner's approval writes the mark of a folder they connect (docs/decisions/connect-approval.md).
        await connect(dataDir, 'acme/app', project);
        await plugin.scan();
        await plugin.client!.sync();
        await w.alice.sync();
        assert.deepEqual(w.alice.users.get(agent.id)?.agentRepos.map((seat) => [seat.repo, seat.online, seat.protocol]), [['acme/app', true, 5]]);
        // The status names the address that came with the code, whatever the owner's settings say.
        assert.deepEqual(((await plugin.status()).text).split('\n').slice(0, 2), [`Taking the cards that Alice hands to this agent, on ${w.baseUrl}.`, `Working in acme/app in ${project}.`]);

        const key = await newChatKey(w.alice, [w.alice.id, agent.id, w.carol.id]);
        const app = await w.alice.request<CreateProjectResponse>('POST', '/projects', { name: 'App', memberIds: [agent.id, w.carol.id], key });
        const general = app.channel.id;
        await w.alice.sync();
        await w.carol.sync();
        const board = { id: newKeyId(), conversationId: general };
        const section = newKeyId().slice(0, 11);
        await w.alice.request('POST', '/docs', {
          ...board,
          revisions: [
            { section: 'title', envelope: await w.alice.sealDoc(board, 'title', { text: 'Roadmap', board: 'roadmap' }) },
            { section, envelope: await w.alice.sealDoc(board, section, { text: '### K-7: Sums are off by one\n\nStatus: Open.', pos: 1 }) },
          ],
        });
        // The hash of the brief Alice saw: the card, and no decisions on this board (D-105).
        const brief = await textHash(briefText('### K-7: Sums are off by one\n\nStatus: Open.', []));
        const today = new Date().toISOString().slice(0, 10);
        // The claim-tag workflow deletes a claim's tag when its pull request merges or closes; here nothing does, so each request starts with the card free.
        const freeClaims = (bare = origin) => sh('git', ['--git-dir', bare, 'for-each-ref', '--format=%(refname)', 'refs/tags/claim']).then(({ stdout }) => Promise.all(stdout.split('\n').filter(Boolean).map((ref) => sh('git', ['--git-dir', bare, 'update-ref', '-d', ref]))));
        const ask = async (from: AgentClient, extra: Partial<RunRequest> = {}) =>
          freeClaims().then(() => from.send(general, {
            text: 'Run K-7 with Claude Code',
            run: { kind: 'request', card: 'K-7', title: 'Sums are off by one', docId: board.id, section, runtime: agent.id, sentAt: Date.now(), repo: 'acme/app', hash: brief, ...extra },
          }));
        // A check-in of the plugin's, which hands each message on as its loop does.
        const checkIn = async () => {
          const heard: OpenedMessage[] = await plugin.client!.sync();
          return { heard, handled: Promise.all(heard.map((m) => plugin.handle(m))) };
        };
        // The agent's reports on a request, each with its run field, or only their texts.
        const reports = async (request: number, reader = w.alice) =>
          (await reader.sync())
            .filter((m) => m.senderId === agent.id && m.content?.run?.kind !== 'request' && m.content?.run?.request === request)
            .map((m) => ({ text: m.content!.text, run: m.content!.run as RunReport }));
        const reportsOn = async (request: number, reader = w.alice) => (await reports(request, reader)).map((r) => r.text);
        type FakePull = { head: string; base: string; draft: boolean; title: string; body: string; edited?: object; closed?: string; view?: object };
        const pullsNow = async () => JSON.parse(await fs.readFile(ghState, 'utf8')).pulls as FakePull[];

        // A teammate's request is refused.
        const fromCarol = (await ask(w.carol)).id;
        await (await checkIn()).handled;
        assert.deepEqual(await reportsOn(fromCarol), ['I could not run K-7: Only Alice hands cards to me.']);
        assert.deepEqual(await turns(), [], 'no Claude ran for it');

        // Alice's request starts a run, which holds at the gate.
        const gate = path.join(w.home, 'gate');
        const asked = await withEnv({ FAKE_CLAUDE_GATE: gate }, async () => {
          const id = (await ask(w.alice)).id;
          const { heard, handled } = await checkIn();
          await waitFor('the background Claude started', async () => (await turns()).length === 1);
          // The same signed request under a new id, as a server could post it again, starts nothing (K-47).
          await plugin.handle({ ...heard[0]!, id: heard[0]!.id + 1000 });
          // Another tab's request for the card that runs fails at once (K-51). Carol reads the
          // report, so Alice's next check-in still holds the run's own.
          const twice = (await ask(w.alice)).id;
          await (await checkIn()).handled;
          assert.deepEqual(await reportsOn(twice, w.carol), ['I could not run K-7: K-7 is already running.']);
          assert.equal((await turns()).length, 1, 'only the run started Claude');
          // Put to sleep, the agent finishes the card it runs and starts nothing new until a wake (K-66).
          assert.match(await plugin.goToSleep(), /goes to sleep once it finishes K-7\./);
          assert.match((await plugin.status()).text, /Every card fails at once: I am going to sleep, so I start nothing new/);
          assert.match(await plugin.wake(), /waking up/);
          assert.match(await plugin.wake(), /not asleep/);
          await fs.writeFile(gate, '');
          await handled;
          return id;
        });
        const branch = 'agent/k-7-sums-are-off-by-one';
        assert.deepEqual(await reportsOn(asked), ['I am on K-7: Sums are off by one', `I finished K-7 on ${branch} (acme/app#1). Sums add up now.`]);
        const pullsFile = path.join(dataDir, 'laptop', 'pulls.json');
        assert.equal(JSON.parse(await fs.readFile(pullsFile, 'utf8'))[0].harness, 'Claude Code', 'a request that names no harness ran on the host, which its rounds keep');

        // Two turns ran in a worktree of the checkout, restricted, under the plugin's settings: the
        // check that the card holds, then the work, in the same session (R-042).
        const [first, work] = await turns();
        const worktree = first!.cwd;
        assert.ok(worktree.startsWith(path.join(await fs.realpath(project), '.claude', 'worktrees')), 'the worktree is in the checkout, where the sandboxed shell may write');
        const settings = path.join(dataDir, 'laptop', 'claude.json');
        assert.ok(first!.args.includes('--restricted'));
        assert.equal(first!.args[first!.args.indexOf('--settings') + 1], settings);
        assert.ok(!first!.resumed);
        assert.ok(first!.input.includes('### K-7: Sums are off by one'), 'the brief holds the card');
        assert.ok(first!.input.includes('check that the card still holds'), 'the first turn checks the card');
        assert.equal(work!.session, first!.session, 'the work resumes the check');
        assert.ok(work!.input.includes('acme/app#1 claims it'), 'the draft claims the card before the work');
        const denied = JSON.parse(await fs.readFile(settings, 'utf8')).sandbox.filesystem.denyRead;
        assert.ok(denied.includes(dataDir) && denied.includes(process.env.GH_CONFIG_DIR), 'the shell cannot read the plugin or gh');

        // It pushed its own branch only, the claim before the work, and opened the draft with the
        // check in its body, which the work's title and body then replaced (R-042).
        assert.deepEqual((await sh('git', ['--git-dir', origin, 'branch', '--format=%(refname:short)'])).stdout.trim().split('\n').sort(), [branch, 'main']);
        assert.equal((await sh('git', ['--git-dir', origin, 'tag', '-l', 'claim/*'])).stdout.trim(), 'claim/K-7', 'the claim tag is pushed with the branch, before the draft');
        const log = async (head: string) => (await sh('git', ['--git-dir', origin, 'log', '--format=%s', `main..${head}`])).stdout.trim().split('\n');
        assert.deepEqual(await log(branch), ['Change sum.test.js', 'chore: Claim K-7']);
        const gh = JSON.parse(await fs.readFile(ghState, 'utf8'));
        const claim = { title: 'K-7: Sums are off by one', body: `Claims K-7. Checked ${today}: Read K-7 and sum.js on main.` };
        assert.deepEqual(gh.pulls, [{ head: branch, base: 'main', draft: true, ...claim, edited: { title: 'Fix sums', body: 'Sums were off by one.' } }]);

        // CI fails on it: Claude gets another round, in the same session, with the log.
        const failing = { statusCheckRollup: [{ name: 'test', conclusion: 'FAILURE', detailsUrl: 'https://github.com/acme/app/actions/runs/7/job/8' }] };
        await fs.writeFile(ghState, JSON.stringify({ ...gh, pulls: [{ ...gh.pulls[0], view: failing }] }));
        await withEnv({ FAKE_CLAUDE_ANSWER: JSON.stringify({ outcome: 'done', note: 'The test passes.' }) }, () => plugin.pollPulls());
        const [, , fix] = await turns();
        assert.equal(fix!.session, first!.session, 'the fix resumes the first turn');
        assert.equal(fix!.cwd, worktree);
        assert.ok(fix!.input.includes('CI failed: test') && fix!.input.includes('expected 3, got 4'), 'the brief says what failed, with the end of its log');
        assert.deepEqual(await reportsOn(asked), ['I am back on K-7: CI failed: test', `I finished K-7 on ${branch} (acme/app#1). The test passes.`]);
        assert.equal(JSON.parse(await fs.readFile(ghState, 'utf8')).pulls.length, 1, 'the fix went to the same pull request');

        // A teammate's review waits for Alice's go, with the comments in full (D-105).
        const reviewed = { reviews: [{ author: { login: 'bob' }, body: 'Please rename sum.', submittedAt: new Date().toISOString() }], updatedAt: new Date().toISOString() };
        await fs.writeFile(ghState, JSON.stringify({ ...gh, pulls: [{ ...gh.pulls[0], view: reviewed }] }));
        await plugin.pollPulls();
        assert.equal((await turns()).length, 3, 'nothing runs before the go');
        const [review] = (await w.alice.sync()).filter((m) => m.senderId === agent.id && m.content?.run?.kind === 'review');
        assert.equal(review?.content?.text, 'bob asked for changes on acme/app#1:\n\n- bob: Please rename sum.');
        // A go without the review runs only Alice's words, and none of Bob's text she did not approve.
        await w.alice.send(general, { text: 'Let the agent fix it', run: { kind: 'fix', request: asked, review: review!.id, note: 'Call it add.', sentAt: Date.now() } });
        await withEnv({ FAKE_CLAUDE_ANSWER: JSON.stringify({ outcome: 'done', note: 'Renamed.' }) }, async () => (await checkIn()).handled);
        const [, , , go] = await turns();
        assert.ok(go!.input.includes('Please rename sum.') && go!.input.includes('Call it add.'), "the round has the review and Alice's words");
        assert.ok(go!.input.startsWith('You are fixing the draft') && !go!.input.includes("OWNER'S WORDS"), 'a draft that is not paused gets the fix brief');
        assert.deepEqual(await reportsOn(asked), ['I am back on K-7: review from bob', `I finished K-7 on ${branch} (acme/app#1). Renamed.`]);

        // Someone else pushes to it: it is theirs now, and Claude runs no more.
        await git(worktree, 'commit', '-q', '--allow-empty', '-m', 'By hand');
        await git(worktree, 'push', '-q', 'origin', `HEAD:${branch}`);
        await plugin.pollPulls();
        assert.deepEqual(JSON.parse(await fs.readFile(path.join(dataDir, 'laptop', 'pulls.json'), 'utf8')), []);
        assert.deepEqual(await reportsOn(asked), ['I stopped watching acme/app#1: someone else pushed to it.']);
        assert.equal((await turns()).length, 4, 'four turns in all');

        // Its owner's prompt in their direct chat is answered in a scratch repository of its own, never pushed (R-035).
        const direct = (await w.alice.request<{ id: number }>('POST', '/conversations/direct', { userId: agent.id, key: await newChatKey(w.alice, [w.alice.id, agent.id]) })).id;
        await w.alice.sync();
        await plugin.client!.sync();
        const branches = async () => (await sh('git', ['--git-dir', origin, 'branch', '--format=%(refname:short)'])).stdout.trim().split('\n').sort();
        const before = await branches();
        // Its own branches only: each turn fetches, which moves origin's.
        const refs = async () => (await git(project, 'for-each-ref', 'refs/heads')).stdout;
        const refsBefore = await refs();
        const tell = async (prompt: PromptDTO, text: string) => {
          const sent = await w.alice.send(direct, { text, prompt });
          await Promise.all((await plugin.client!.sync()).map((m) => plugin.handle(m)));
          return sent.clientId!;
        };
        const answers = async () => (await w.alice.sync()).filter((m) => m.senderId === agent.id && m.content?.prompt?.kind === 'answer').map((m) => m.content?.text);
        // Every turn reads the decisions the team holds and the repository's open pull requests (R-041).
        const decisions = { id: newKeyId(), conversationId: general };
        const [held, gone] = [newKeyId().slice(0, 11), newKeyId().slice(0, 11)];
        await w.alice.request('POST', '/docs', {
          ...decisions,
          revisions: [
            { section: 'title', envelope: await w.alice.sealDoc(decisions, 'title', { text: 'Decisions', board: 'decisions' }) },
            { section: held, envelope: await w.alice.sealDoc(decisions, held, { text: '### D-1: Sums stay exact\n\nStatus: Accepted.', pos: 1 }) },
            { section: gone, envelope: await w.alice.sealDoc(decisions, gone, { text: '### D-2: Sums round\n\nStatus: Superseded by D-1.', pos: 2 }) },
          ],
        });
        const ghNow = JSON.parse(await fs.readFile(ghState, 'utf8'));
        await fs.writeFile(ghState, JSON.stringify({ ...ghNow, open: [{ number: 5, title: 'Fix sums' }] }));
        // Alice has her agent load parts of her Claude setup into every turn and run (R-039, D-115).
        await w.instance.sql.query("DELETE FROM webchat.rate_limits WHERE key LIKE 'send:%'");
        const claudeDir = path.join(w.home, 'claude');
        const skill = path.join(claudeDir, 'skills', 'commit-style');
        await fs.mkdir(path.join(skill, 'references'), { recursive: true });
        await fs.writeFile(path.join(claudeDir, 'CLAUDE.md'), 'Write short commit messages.\n');
        await fs.writeFile(path.join(skill, 'SKILL.md'), '---\nname: commit-style\ndescription: >\n  Writes commit\n  messages.\n---\nUse the imperative.\n');
        await fs.writeFile(path.join(skill, 'references', 'style.md'), 'At most 50 characters.\n');
        // A link in a skill could lead to a secret, so the copy leaves it out.
        await fs.symlink(path.join(dataDir, 'account.json'), path.join(skill, 'key.json'));
        await fs.mkdir(path.join(claudeDir, 'skills', 'other'));
        await fs.writeFile(path.join(claudeDir, 'skills', 'other', 'SKILL.md'), '---\nname: other\ndescription: "Does other things."\n---\n');
        // The agent's answers, each naming the ask it answers.
        const setup = async (from: AgentClient, chat: number, choice?: SetupChoice) => {
          const sent = await from.send(chat, { text: 'Settings', setup: { sentAt: Date.now(), ...(choice && { choice }) } });
          await Promise.all((await plugin.client!.sync()).map((m) => plugin.handle(m)));
          const states = (await w.alice.sync()).filter((m) => m.senderId === agent.id && m.content?.setupState).map((m) => m.content!.setupState!);
          return states.map(({ to, ...state }) => (assert.equal(to, sent.clientId), state));
        };
        const offer = { claudeMd: true, skills: [{ name: 'commit-style', description: 'Writes commit messages.' }, { name: 'other', description: 'Does other things.' }] };
        // The runs before loaded nothing of it, as nothing was chosen.
        const { harnesses, ...shown } = (await setup(w.alice, direct))[0]!;
        assert.deepEqual({ ...shown, applied: { ...shown.applied, at: 0 } }, { ...offer, choice: { claudeMd: false, skills: [], noAttribution: false, linked: ['Claude Code', 'Codex'], noPlan: true }, applied: { claudeMd: false, skills: [], noAttribution: false, at: 0 } });
        const claudeCode = { name: 'Claude Code', path: path.join(bin, 'claude'), linked: true, attention: undefined, version: '2.1.300', signedIn: true, answers: undefined, refusal: undefined, instructions: path.join(claudeDir, 'CLAUDE.md'), skills: path.join(claudeDir, 'skills'), knobs: ['claudeMd', 'skills', 'noAttribution', 'noPlan', 'own'], models: ['opus', 'sonnet', 'haiku'], efforts: { '': ['low', 'medium', 'high', 'xhigh', 'max'], opus: ['low', 'medium', 'high', 'xhigh', 'max'], sonnet: ['low', 'medium', 'high', 'xhigh', 'max'], haiku: ['low', 'medium', 'high', 'xhigh', 'max'] } };
        const codexState = { name: 'Codex', path: path.join(bin, 'codex'), linked: true, attention: undefined, version: '0.58.0', signedIn: true, answers: undefined, refusal: undefined, instructions: '~/.codex/AGENTS.md', skills: '~/.agents/skills', knobs: ['own'], models: ['gpt-5.5-codex', 'gpt-5.5-mini'], efforts: { 'gpt-5.5-codex': ['low', 'medium', 'high', 'xhigh'], 'gpt-5.5-mini': ['low', 'medium', 'high'], '': ['low', 'medium', 'high', 'xhigh'] } };
        assert.deepEqual(harnesses, [claudeCode, codexState], 'the pane learns each harness the laptop has, the knobs it honors');
        // Turned off, Claude Code leaves the linked harnesses, and only Codex is left; a page from before the list keeps it off.
        const [{ harnesses: offHarnesses }] = await setup(w.alice, direct, { claudeMd: false, skills: [], noAttribution: false, off: ['Claude Code'] });
        assert.deepEqual(
          offHarnesses!.map((h) => [h.name, h.answers]),
          [['Claude Code', 'You turned Claude Code off, so I start nothing with it. Link it in my settings under Coding agents.'], ['Codex', undefined]],
          'a question may still pick Codex',
        );
        await setup(w.alice, direct, { claudeMd: false, skills: [], noAttribution: false });
        assert.match((await plugin.status()).text, /^Taking the cards[\s\S]*Linked: Codex\./);
        // Carol's word changes nothing and hears nothing; Alice's is kept, a skill she chose that is gone too.
        const chosen = { claudeMd: true, skills: ['commit-style', 'gone'], noAttribution: true, noPlan: true };
        assert.deepEqual(await setup(w.carol, general, chosen), []);
        assert.deepEqual((await setup(w.alice, direct, { ...chosen, off: [] })).map((s) => s.choice), [{ ...chosen, off: [], linked: ['Claude Code', 'Codex'] }]);
        assert.deepEqual(JSON.parse(await fs.readFile(settings, 'utf8')).attribution, { commit: '', pr: '' }, 'the settings hide the attribution lines');
        // A prompt naming a coding agent the laptop does not have fails with the reason, and no turn runs.
        const turnsBeforePrompts = (await turns()).length;
        await tell({ kind: 'prompt', repo: 'acme/app', sentAt: Date.now(), project: app.project.id, harness: 'Gemini' }, 'What does sum.js do?');
        const refusedPrompt = (await w.alice.sync()).filter((m) => m.senderId === agent.id && m.content?.prompt?.kind === 'failed').map((m) => m.content?.text);
        assert.deepEqual(refusedPrompt, ['I could not answer. I have no Gemini on this laptop. Pick another coding agent.']);
        assert.equal((await turns()).length, turnsBeforePrompts, 'no Claude ran for it');
        // One naming Codex is answered by it, in a scratch copy.
        await tell({ kind: 'prompt', repo: 'acme/app', sentAt: Date.now(), project: app.project.id, harness: 'Codex' }, 'What does sum.js do?');
        const codexAnswer = (await w.alice.sync()).filter((m) => m.senderId === agent.id && m.content?.prompt?.kind === 'answer').map((m) => m.content?.text);
        assert.deepEqual(codexAnswer.slice(-1), ['It adds.']);
        assert.equal((await turns()).length, turnsBeforePrompts, 'no Claude ran for it either');
        // The owner links each harness (docs/decisions/harness-linking.md): only linked ones run, and a prompt that names none runs on the first she linked.
        const lkLink = (...linked: string[]) => setup(w.alice, direct, { ...chosen, linked, off: [] });
        const lkFailures = async () => (await w.alice.sync()).filter((m) => m.senderId === agent.id && m.content?.prompt?.kind === 'failed').map((m) => m.content?.text);
        const lkHarnessOf = async (root: string) => (JSON.parse(await fs.readFile(path.join(dataDir, 'laptop', 'conversations.json'), 'utf8')) as Array<{ root: string; harness?: string }>).find((c) => c.root === root)?.harness;
        const lkCodexPrompt = () => tell({ kind: 'prompt', repo: 'acme/app', sentAt: Date.now(), project: app.project.id, harness: 'Codex' }, 'What does sum.js do?');
        const lkPlain = () => tell({ kind: 'prompt', repo: 'acme/app', sentAt: Date.now(), project: app.project.id }, 'What does sum.js do?');
        const lkNotLinked = (name: string) => [`I could not answer. You have not linked ${name}, so I start nothing with it. Link it in my settings under Coding agents.`];
        const [lkOnlyClaude] = await lkLink('Claude Code');
        assert.deepEqual(lkOnlyClaude!.harnesses!.map((h) => [h.name, harnessRow(h)]), [['Claude Code', 'linked'], ['Codex', 'found']]);
        assert.equal(plugin.client!.protocol, 511, 'Claude Code linked, and gh signed in: cards, it asks, it runs own setups, sends steps, takes controls, lists sessions and asks anywhere');
        await lkCodexPrompt();
        assert.deepEqual(await lkFailures(), lkNotLinked('Codex'));
        assert.equal(await lkHarnessOf(await withEnv({ FAKE_CLAUDE_ANSWER: '{"reply":"It adds."}' }, lkPlain)), 'Claude Code', 'Claude Code still runs');
        await lkLink('Codex', 'Claude Code');
        assert.equal(plugin.client!.protocol, 511);
        assert.equal(await lkHarnessOf(await lkPlain()), 'Codex', 'a prompt that names none runs on the first she linked');
        const [lkOnlyCodex] = await lkLink('Codex');
        assert.equal(plugin.client!.protocol, 511, 'Codex takes cards, asks and runs own setups too');
        assert.deepEqual(lkOnlyCodex!.harnesses!.map((h) => harnessRow(h)), ['found', 'linked']);
        await lkLink();
        assert.equal(plugin.client!.protocol, 357, 'with none linked the agent still answers settings');
        assert.match((await plugin.status()).text, /Every card fails at once: You have linked no coding agent[\s\S]*Linked: none\./);
        await lkPlain();
        assert.deepEqual(await lkFailures(), ['I could not answer. You have linked no coding agent on this laptop, so I start nothing. Link one in my settings under Coding agents.']);

        // `webchat-agent link`: the laptop asks in the owner's direct chat, and only her signed word links it, once (D-089, K-47).
        const lkAsks = async () => (await w.alice.sync()).filter((m) => m.senderId === agent.id && m.content?.ask).map((m) => m.content!);
        const lkAnswer = async (from: AgentClient, chat: number, step: 'approve' | 'decline', to: string, extra: object = {}) => {
          await from.send(chat, { text: 'Answer', ask: { kind: 'link', step, to, sentAt: Date.now(), ...extra } as MessageContent['ask'] });
          const lkHeard = await plugin.client!.sync();
          await Promise.all(lkHeard.map((m) => plugin.handle(m)));
          return lkHeard;
        };
        const lkLinked = async () => (JSON.parse(await fs.readFile(path.join(dataDir, 'laptop', 'setup.json'), 'utf8')) as { choice: SetupChoice }).choice.linked;
        // What the laptop remembers it asked, by the request message's client id.
        const lkPending = () => (plugin as unknown as { setup: { asks?: Record<string, { what: string; at: number }> } }).setup.asks ?? {};
        await lkLink('Claude Code');
        const lkDir = path.join(dataDir, 'asks');
        const lkFile = (name: string, body: object) => fs.writeFile(path.join(lkDir, name), JSON.stringify(body));
        assert.match(await plugin.requestLink('Codex'), /Approve it in WebChat/);
        // A file naming no supported harness, or filed more than 10 minutes ago, sends nothing.
        await lkFile('gemini.json', { kind: 'link', harness: 'Gemini', at: Date.now() });
        await lkFile('old.json', { kind: 'link', harness: 'Codex', at: Date.now() - REQUEST_TTL_MS - 1000 });
        await plugin.sendAsks();
        assert.deepEqual((await lkAsks()).map((c) => c.ask), [{ kind: 'link', step: 'request', harness: 'Codex' }]);
        assert.equal((await fs.readdir(lkDir)).length, 0, 'every file was taken');
        // One request waits for each harness.
        await plugin.requestLink('Codex');
        await plugin.sendAsks();
        assert.deepEqual(await lkAsks(), []);
        const [lkAsked] = Object.keys(lkPending());
        // Not the owner's word: Carol's, one outside the direct chat, a request nobody made, and one signed too long ago.
        await lkAnswer(w.carol, general, 'approve', lkAsked!);
        await lkAnswer(w.alice, general, 'approve', lkAsked!);
        await lkAnswer(w.alice, direct, 'approve', 'nobody');
        await lkAnswer(w.alice, direct, 'approve', lkAsked!, { sentAt: Date.now() - REQUEST_TTL_MS - 1000 });
        assert.deepEqual(await lkLinked(), ['Claude Code']);
        // Her approve links the harness the laptop recorded, whatever name the message adds, and says so.
        const lkHeard = await lkAnswer(w.alice, direct, 'approve', lkAsked!, { harness: 'Claude Code' });
        assert.deepEqual(await lkLinked(), ['Claude Code', 'Codex']);
        assert.equal(plugin.client!.protocol, 511);
        assert.ok((await lkAsks()).some((c) => c.ask?.step === 'done'), 'the laptop says it linked it');
        // The same message again, or another that names the same request, changes nothing.
        await lkLink('Claude Code');
        await plugin.handle(lkHeard.find((m) => m.content?.ask)!);
        await lkAnswer(w.alice, direct, 'approve', lkAsked!);
        assert.deepEqual(await lkLinked(), ['Claude Code']);
        // A decline links nothing; a request left past 10 minutes fails with a note.
        await plugin.requestLink('Codex');
        await plugin.sendAsks();
        const lkDeclined = Object.keys(lkPending()).find((id) => id !== lkAsked)!;
        await lkAnswer(w.alice, direct, 'decline', lkDeclined);
        assert.deepEqual(await lkLinked(), ['Claude Code']);
        await plugin.requestLink('Codex');
        await plugin.sendAsks();
        const lkLapsed = Object.keys(lkPending()).find((id) => id !== lkAsked && id !== lkDeclined)!;
        lkPending()[lkLapsed]!.at -= REQUEST_TTL_MS + 1000;
        await lkAsks();
        await lkAnswer(w.alice, direct, 'approve', lkLapsed);
        assert.deepEqual(await lkLinked(), ['Claude Code']);
        assert.match((await lkAsks()).find((c) => c.ask?.step === 'failed')?.text ?? '', /older than 10 minutes/);
        await lkLink('Claude Code', 'Codex');
        // The board Alice's page picked goes in the brief, and no other (D-104).
        const prompted = await withEnv({ FAKE_CLAUDE_ANSWER: '{"reply":"It adds."}' }, () => tell({ kind: 'prompt', repo: 'acme/app', sentAt: Date.now(), project: app.project.id }, 'What does sum.js do?'));
        const kept = JSON.parse(await fs.readFile(path.join(dataDir, 'laptop', 'conversations.json'), 'utf8')) as Array<{ root: string; harness?: string }>;
        assert.equal(kept.find((c) => c.root === prompted)?.harness, 'Claude Code', 'a prompt that names no harness runs on the host, which each reply keeps');
        const [chat] = (await turns()).slice(-1);
        assert.ok(chat!.input.includes('### D-1: Sums stay exact') && !chat!.input.includes('### D-2'), 'the brief holds the decisions the team holds');
        assert.ok(chat!.input.includes('#5: Fix sums'), 'the brief holds the open pull requests');
        assert.ok(chat!.input.includes('Before you draft, check the draft'), 'the brief asks for the check');
        const scratch = chat!.cwd;
        assert.ok(scratch.startsWith(path.join(await fs.realpath(os.tmpdir()), 'webchat-scratch')), 'the prompt runs in a scratch repository, not in the project');
        assert.equal((await git(scratch, 'remote')).stdout.trim(), '', 'the scratch copy has no remote');
        assert.ok(!chat!.resumed, 'the first turn starts a session');
        assert.ok(chat!.input.includes('What does sum.js do?') && chat!.input.includes('scratch copy'), 'the brief holds the prompt');
        assert.ok(chat!.input.includes('opens a draft pull request'), 'the brief says a card run, unlike a question, ends in a draft');
        assert.deepEqual(await answers(), ['It adds.']);
        // The turn got her CLAUDE.md, the Skill tool, and copies of the chosen skills still there, with no link.
        const flag = (name: string) => chat!.args[chat!.args.indexOf(name) + 1]!;
        assert.equal(flag('--append-system-prompt-file'), path.join(claudeDir, 'CLAUDE.md'));
        assert.equal(flag('--tools'), 'Bash,Read,Edit,Write,Glob,Grep,WebSearch,WebFetch,Skill');
        assert.equal(flag('--add-dir'), flag('--plugin-dir'), "the skills' own files can be read");
        const copied = ['skills', 'skills/commit-style', 'skills/commit-style/SKILL.md', 'skills/commit-style/references', 'skills/commit-style/references/style.md'];
        assert.deepEqual(chat!.plugin, copied.map((f) => f.split('/').join(path.sep)), 'only skills/, with the chosen skills');
        assert.equal(existsSync(flag('--plugin-dir')), false, 'the copy goes once the turn ends');
        const [loaded] = await setup(w.alice, direct);
        assert.deepEqual({ ...loaded!.applied!, at: 0 }, { claudeMd: true, skills: ['commit-style'], noAttribution: true, at: 0 }, 'the pane learns what the turn loaded');
        assert.equal((await git(scratch, 'rev-parse', '--abbrev-ref', 'HEAD')).stdout.trim(), 'HEAD', 'the scratch copy is detached');
        const was = (await git(project, 'rev-parse', 'refs/remotes/origin/main')).stdout.trim();
        assert.equal((await git(scratch, 'rev-list', '--max-parents=0', 'HEAD')).stdout.trim(), was, 'it starts at origin/main, and the fake Claude commits on top');
        // A merge on GitHub between turns: the reply's copy moves to it, and the agent hears what moved.
        const merger = path.join(w.home, 'merger');
        await sh('git', ['clone', '-q', origin, merger]);
        await fs.writeFile(path.join(merger, 'merged.txt'), 'new\n');
        await git(merger, 'add', 'merged.txt');
        await git(merger, 'commit', '-q', '-m', 'Merge');
        await git(merger, 'push', '-q', 'origin', 'HEAD:main');
        const now = (await git(merger, 'rev-parse', 'HEAD')).stdout.trim();
        // A decision changes between turns, and a pull request opens: the reply holds both.
        await w.alice.sync();
        const decisionsDoc = (await w.alice.boardDocs(app.project.id)).decisions!;
        await w.alice.editSection(decisionsDoc, held, () => ({ text: '### D-1: Sums stay exact\n\nStatus: Accepted.\n\nWhy: money.', pos: 1 }));
        await fs.writeFile(ghState, JSON.stringify({ ...ghNow, open: [{ number: 5, title: 'Fix sums' }, { number: 6, title: 'Add a test' }] }));
        await withEnv({ FAKE_CLAUDE_ANSWER: '{"reply":"Still adds."}' }, () => tell({ kind: 'reply', to: prompted, sentAt: Date.now() }, 'And sum.test.js?'));
        const [again] = (await turns()).slice(-1);
        assert.ok(again!.input.includes('Why: money.') && !again!.input.includes('### K-7'), 'the reply holds the decision that changed, and no card that did not');
        assert.ok(again!.input.includes('#6: Add a test'), 'the reply holds the open pull requests');
        assert.equal(again!.session, chat!.session, 'the reply resumes the session');
        assert.equal(again!.cwd, scratch);
        assert.ok(again!.input.includes('Your owner replies:') && again!.input.includes('And sum.test.js?'));
        assert.ok(again!.input.includes(`main moved from ${was.slice(0, 7)} to ${now.slice(0, 7)}`), 'the reply says what moved');
        assert.equal((await git(scratch, 'rev-list', '--max-parents=0', 'HEAD')).stdout.trim(), now, 'the copy moved to the merge');
        assert.match((await git(scratch, 'diff', '--stat', was, now)).stdout, /merged\.txt/, 'both commits are in the copy, so the agent can diff them');
        assert.deepEqual(await answers(), ['Still adds.']);
        // A draft that changes a card names it, with the hash of the text the brief held (D-104).
        assert.ok(chat!.input.includes('### K-7: Sums are off by one') && chat!.input.includes("TEAMMATES' TEXT START"), 'the brief holds the board, fenced');
        // Its related ids are only those the brief held: a superseded decision, a card or a pull request it never had are left out (R-041).
        const related = [
          { id: '#5', kind: 'duplicate', why: 'It fixes the same sums.' },
          { id: 'D-1', kind: 'conflict', why: 'Exact sums.' },
          { id: 'D-2', kind: 'conflict', why: 'Superseded.' },
          { id: 'K-99', kind: 'duplicate', why: 'Not on the board.' },
          { id: '#9', kind: 'duplicate', why: 'Not open.' },
        ];
        const card = { kind: 'issue', title: 'Sums are off by two', body: 'Seen: in the tests.', replaces: 'K-7', checked: 'Read 1 card, 1 decision, the code and 2 open pull requests.', related };
        // A full card, past a chat message's 4,000 characters and its 32 KB padding band, reaches the
        // owner whole: three-byte characters, a check and a related reason fill the message.
        const long = `Why: money.\n\nDone when: ${'两个账户在聊天中都能看到照片。'.repeat(700)}`.slice(0, LIMITS.docSectionLength);
        const decision = { kind: 'decision', title: 'Sums round to cents', body: long, checked: '读'.repeat(LIMITS.checkedLength), related: [{ id: 'D-1', kind: 'conflict', why: '冲'.repeat(LIMITS.relatedWhyLength) }] };
        await withEnv({ FAKE_CLAUDE_ANSWER: JSON.stringify({ reply: 'Here is the change.', drafts: [card, decision] }), FAKE_CLAUDE_COMMIT: '0' }, () =>
          tell({ kind: 'reply', to: prompted, sentAt: Date.now() }, 'Draft a change to K-7.'),
        );
        const seen = await textHash('### K-7: Sums are off by one\n\nStatus: Open.');
        assert.deepEqual((await w.alice.sync()).filter((m) => m.senderId === agent.id).map((m) => [m.content?.text, m.content?.prompt]), [
          ['Here is the change.', { kind: 'answer', to: prompted }],
          [
            'Card draft: Sums are off by two',
            {
              kind: 'answer',
              to: prompted,
              card: { kind: 'K', title: 'Sums are off by two', body: 'Seen: in the tests.', replaces: { card: 'K-7', doc: board.id, section, seen }, checked: card.checked, related: related.slice(0, 2) },
            },
          ],
          ['Decision draft: Sums round to cents', { kind: 'answer', to: prompted, card: { kind: 'D', title: 'Sums round to cents', body: long, checked: decision.checked, related: decision.related } }],
        ]);
        // Runs below hash a brief with no decisions.
        await w.alice.request('DELETE', `/docs/${decisions.id}`);
        assert.deepEqual(await branches(), before, 'nothing of the conversation was pushed');
        assert.equal(await refs(), refsBefore, 'the owner\'s checkout gained no branch or commit');
        // The agent has sent many messages in a few seconds by now (D-091).
        await w.instance.sql.query("DELETE FROM webchat.rate_limits WHERE key LIKE 'send:%'");
        // A question about a project's board alone, as one that links no repository asks, runs in an
        // empty folder, with the board in its brief (R-038).
        await withEnv({ FAKE_CLAUDE_ANSWER: '{"reply":"From the board."}', FAKE_CLAUDE_COMMIT: '0' }, () => tell({ kind: 'prompt', sentAt: Date.now(), project: app.project.id }, 'What is left to do?'));
        const [boardTurn] = (await turns()).slice(-1);
        assert.deepEqual(await fs.readdir(boardTurn!.cwd), [], 'an empty folder, with no code');
        assert.ok(boardTurn!.input.includes('It links no code') && boardTurn!.input.includes('### K-7: Sums are off by one'), 'the brief holds the board');
        assert.deepEqual(await answers(), ['From the board.']);
        // With neither a project nor a repository, it runs in an empty folder with no board, and the check-in says it can.
        assert.equal(plugin.client!.protocol & 256, 256);
        await withEnv({ FAKE_CLAUDE_ANSWER: '{"reply":"Anything."}', FAKE_CLAUDE_COMMIT: '0' }, () => tell({ kind: 'prompt', sentAt: Date.now() }, 'What is a monad?'));
        const [looseTurn] = (await turns()).slice(-1);
        assert.deepEqual(await fs.readdir(looseTurn!.cwd), [], 'an empty folder, with no code');
        assert.ok(looseTurn!.input.includes('about no project and no code') && !looseTurn!.input.includes('### K-7'), 'no board in the brief');
        assert.deepEqual((await answers()).slice(-1), ['Anything.']);

        // Her own setup (D-157) is off at first, so a question she typed runs restricted all the same.
        const ownPrompt = (own?: true) => withEnv({ FAKE_CLAUDE_ANSWER: '{"reply":"Mine."}', FAKE_CLAUDE_COMMIT: '0' }, () => tell({ kind: 'prompt', repo: 'acme/app', sentAt: Date.now(), project: app.project.id, asks: true, ...(own && { own }) }, 'What does sum.js do?'));
        const lastTurn = async () => (await turns()).at(-1)!;
        const unrestricted = ['--restricted', '--settings', '--tools', '--strict-mcp-config', '--plugin-dir', '--append-system-prompt-file', '--permission-mode'];
        await ownPrompt(true);
        assert.ok((await lastTurn()).args.includes('--restricted'), 'the switch is off at first');
        assert.deepEqual((harnesses.find((h) => h.name === 'Claude Code')?.knobs as string[] | undefined)?.includes('own'), true, 'Claude Code offers it');
        assert.equal(plugin.client!.protocol & 16, 16, 'the check-in says the agent runs own setups');
        await setup(w.alice, direct, { ...chosen, linked: ['Claude Code', 'Codex'], off: [], own: ['Claude Code'] });
        // Turned on, a question she typed runs in her folder, with her own setup and nothing of WebChat's but the question endpoint.
        await ownPrompt(true);
        const ownTurn = await lastTurn();
        assert.equal(ownTurn.cwd, await fs.realpath(project), 'in her connected folder');
        assert.deepEqual(ownTurn.args.filter((a) => unrestricted.includes(a)), [], 'none of the restricted run');
        assert.ok(ownTurn.args.includes('--permission-prompt-tool'), 'what her rules would ask about comes to her');
        assert.ok(ownTurn.input.includes('their own copy of it'), 'the brief says where it runs');
        assert.deepEqual({ ...(await setup(w.alice, direct))[0]!.applied!, at: 0 }, { claudeMd: false, skills: [], noAttribution: false, own: ['Claude Code'], at: 0 }, 'the pane learns the turn ran in her setup');
        // A prompt with no `own`, as Check again and `webchat-agent card` send, stays restricted.
        await ownPrompt();
        assert.ok((await lastTurn()).args.includes('--restricted'), 'Check again stays restricted');

        // A page that shows a session's steps gets them sealed, in one quiet batch before the answer (R-072).
        await w.instance.sql.query("DELETE FROM webchat.rate_limits WHERE key LIKE 'send:%'");
        const stepped = await withEnv({ FAKE_CLAUDE_ANSWER: '{"reply":"It adds."}', FAKE_CLAUDE_COMMIT: '0', FAKE_CLAUDE_STEPS: '1' }, () => tell({ kind: 'prompt', repo: 'acme/app', sentAt: Date.now(), project: app.project.id, events: true }, 'What does sum.js do?'));
        const heardSteps = (await w.alice.sync()).filter((m) => m.senderId === agent.id && (m.content?.prompt as { to?: string } | undefined)?.to === stepped);
        assert.deepEqual(heardSteps.map((m) => [m.kind, m.content!.prompt!.kind]), [['events', 'events'], ['message', 'answer']], 'one batch of steps, then the answer');
        const batch = heardSteps[0]!.content!.prompt as Extract<PromptDTO, { kind: 'events' }>;
        assert.deepEqual(batch.events.map((e) => [e.kind, e.title]), [['thinking', 'Where is the sum?'], ['read', 'sum.js'], ['command', 'npm test']]);
        assert.deepEqual(batch.about, { own: false, branch: 'main', hooks: 0 }, 'what the session runs with goes along: a restricted run on main, with no hooks');
        assert.ok(batch.events[2]!.detail!.endsWith('1 passing') && batch.events[2]!.detail!.length === LIMITS.eventDetailLength, 'a command shows its output, cut to its end');
        // The history leaves the steps out, so loading an agent chat does not grow with them; they page apart.
        const page = await w.alice.request<Array<{ id: number; kind: string }>>('GET', `/conversations/${direct}/messages`);
        assert.ok(!page.some((m) => m.kind === 'events'), 'the history leaves steps out');
        const stepsPage = await w.alice.request<Array<{ id: number; kind: string }>>('GET', `/conversations/${direct}/messages?events=1`);
        assert.deepEqual(stepsPage.map((m) => m.id), [heardSteps[0]!.id], 'the steps page apart');
        // Only an agent sends steps.
        await assert.rejects(w.alice.send(direct, { text: 'Steps', prompt: { kind: 'events', to: stepped, events: [] } }, { kind: 'events' }), /Unknown message kind/);
        // A prompt from a page that shows no steps gets none.
        await withEnv({ FAKE_CLAUDE_ANSWER: '{"reply":"It adds."}', FAKE_CLAUDE_COMMIT: '0', FAKE_CLAUDE_STEPS: '1' }, () => tell({ kind: 'prompt', repo: 'acme/app', sentAt: Date.now(), project: app.project.id }, 'What does sum.js do?'));
        assert.ok(!(await w.alice.sync()).some((m) => m.kind === 'events'), 'an older page hears no steps');

        // The new card form asks for one checked draft of its kind, from its fields as they stand (R-071).
        await w.instance.sql.query("DELETE FROM webchat.rate_limits WHERE key LIKE 'send:%'");
        const two = JSON.stringify({ reply: 'Checked.', drafts: [{ kind: 'idea', title: 'Sums add cents', body: 'Why: totals.', checked: 'Read sum.js.' }, { kind: 'decision', title: 'Cents stay exact', body: 'Why.', checked: 'Read sum.js.' }] });
        const form = { kind: 'R' as const, title: 'Sums add cents', body: 'My edit: keep two places.' };
        const carded = await withEnv({ FAKE_CLAUDE_ANSWER: two, FAKE_CLAUDE_COMMIT: '0' }, () => tell({ kind: 'prompt', repo: 'acme/app', sentAt: Date.now(), project: app.project.id, card: form }, 'Turn this into an idea.'));
        const cardTurn2 = await lastTurn();
        assert.ok(cardTurn2.input.includes('exactly one draft in drafts, of kind idea') && cardTurn2.input.includes('My edit: keep two places.'), 'the brief asks for one idea and carries the fields');
        assert.ok(cardTurn2.input.includes("OWNER'S WORDS START"), "the fields are fenced as the owner's words");
        const formDrafts = (await w.alice.sync()).filter((m) => m.senderId === agent.id && m.content?.prompt?.kind === 'answer' && (m.content.prompt as { to: string }).to === carded && m.content.prompt.card);
        assert.deepEqual(formDrafts.map((m) => (m.content!.prompt as { card: CardDraftDTO }).card.title), ['Sums add cents'], 'only the one draft of the kind it asked for');
        // A reply carries the fields as they stand, so the next draft builds on the edits.
        await withEnv({ FAKE_CLAUDE_ANSWER: two, FAKE_CLAUDE_COMMIT: '0' }, () => tell({ kind: 'reply', to: carded, sentAt: Date.now(), card: { ...form, body: 'Edited again.' } }, 'Shorter, please.'));
        assert.ok((await lastTurn()).input.includes('Edited again.'), 'the reply carries the edited fields');
        await w.alice.sync();

        // The session's controls (R-072): a model and an effort the harness offers, and a permission mode only in her own setup.
        await w.instance.sql.query("DELETE FROM webchat.rate_limits WHERE key LIKE 'send:%'");
        const controlled = await withEnv({ FAKE_CLAUDE_ANSWER: '{"reply":"Sure."}', FAKE_CLAUDE_COMMIT: '0' }, () => tell({ kind: 'prompt', repo: 'acme/app', sentAt: Date.now(), project: app.project.id, own: true, model: 'sonnet', effort: 'xhigh', mode: 'plan' }, 'Plan it.'));
        const flagOf = (args: string[], name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
        let args = (await lastTurn()).args;
        assert.deepEqual([flagOf(args, '--model'), flagOf(args, '--effort'), flagOf(args, '--permission-mode')], ['sonnet', 'xhigh', 'plan'], 'her own setup takes the model, the effort and the mode');
        await withEnv({ FAKE_CLAUDE_ANSWER: '{"reply":"Sure."}', FAKE_CLAUDE_COMMIT: '0' }, () => tell({ kind: 'prompt', repo: 'acme/app', sentAt: Date.now(), project: app.project.id, model: 'gpt-9', effort: 'turbo', mode: 'default' }, 'Plan it.'));
        args = (await lastTurn()).args;
        assert.deepEqual([flagOf(args, '--model'), flagOf(args, '--effort'), flagOf(args, '--permission-mode')], [undefined, undefined, 'acceptEdits'], 'a restricted run keeps its mode, and a model or effort the harness does not offer is dropped');
        // Hand over (D-156): the harness that ran it writes a summary, which she reads and edits; the other starts from it, in the same thread.
        await withEnv({ FAKE_CLAUDE_ANSWER: '{"reply":"Goal: plan sums. Done: read sum.js. Next: fix."}', FAKE_CLAUDE_COMMIT: '0' }, () => tell({ kind: 'reply', to: controlled, sentAt: Date.now(), handover: { harness: 'Codex' } }, 'Hand over to Codex'));
        assert.ok((await lastTurn()).input.includes('hands this session over to Codex'), 'the old harness is asked for the summary');
        const summary = (await w.alice.sync()).find((m) => m.senderId === agent.id && m.content?.prompt?.kind === 'summary');
        assert.deepEqual([summary?.content?.prompt, summary?.content?.text], [{ kind: 'summary', to: controlled, harness: 'Codex' }, 'Goal: plan sums. Done: read sum.js. Next: fix.']);
        const codexTurns = async () => (await fs.readFile(path.join(w.home, 'codex.log'), 'utf8')).split('\n').filter(Boolean).map((l) => JSON.parse(l) as { method?: string; input?: string }).filter((l) => l.method === 'turn/start');
        const codexBefore = (await codexTurns()).length;
        await tell({ kind: 'reply', to: controlled, sentAt: Date.now(), handover: { harness: 'Codex', summary: 'Goal: plan sums. Edited by Alice.' } }, 'Hand over to Codex');
        const handed = (await codexTurns()).slice(codexBefore);
        assert.equal(handed.length, 1, 'Codex starts a session of its own');
        assert.ok(handed[0]!.input!.includes('Edited by Alice.'), 'from the summary as she edited it');
        const keptAfter = JSON.parse(await fs.readFile(path.join(dataDir, 'laptop', 'conversations.json'), 'utf8')) as Array<{ root: string; harness?: string }>;
        assert.equal(keptAfter.find((c) => c.root === controlled)?.harness, 'Codex', 'replies go to Codex now');
        await w.alice.sync();

        // A terminal's session, continued (R-072): the agent lists her Claude Code sessions in the connected folder, and goes on with one in her own setup.
        await w.instance.sql.query("DELETE FROM webchat.rate_limits WHERE key LIKE 'send:%'");
        const terminal = '33333333-3333-4333-8333-333333333333';
        const sessionsDir = path.join(claudeDir, 'projects', (await fs.realpath(project)).replace(/[^a-zA-Z0-9]/g, '-'));
        await fs.mkdir(sessionsDir, { recursive: true });
        await fs.writeFile(path.join(sessionsDir, `${terminal}.jsonl`), JSON.stringify({ type: 'user', message: { content: 'Why are sums off?' } }) + '\n');
        const listAsk = await w.alice.send(direct, { text: 'Sessions', sessions: { repo: 'acme/app', sentAt: Date.now() } });
        await Promise.all((await plugin.client!.sync()).map((m) => plugin.handle(m)));
        const listed = (await w.alice.sync()).find((m) => m.senderId === agent.id && m.content?.sessionList)!;
        assert.equal(listed.kind, 'sync', 'the list is quiet');
        assert.deepEqual(listed.content!.sessionList, { to: listAsk.clientId, repo: 'acme/app', harness: 'Claude Code', sessions: [{ id: terminal, title: 'Why are sums off?', at: listed.content!.sessionList!.sessions[0]!.at }] });
        await withEnv({ FAKE_CLAUDE_ANSWER: '{"reply":"Going on."}', FAKE_CLAUDE_COMMIT: '0' }, () => tell({ kind: 'prompt', repo: 'acme/app', sentAt: Date.now(), project: app.project.id, own: true, harness: 'Claude Code', resume: terminal }, 'Go on.'));
        const resumedTurn = await lastTurn();
        assert.deepEqual([flagOf(resumedTurn.args, '--resume'), resumedTurn.cwd, resumedTurn.args.includes('--restricted')], [terminal, await fs.realpath(project), false], 'it resumes the session in her folder, in her own setup');
        // Not in a restricted run: the session is hers, with her setup.
        await tell({ kind: 'prompt', repo: 'acme/app', sentAt: Date.now(), project: app.project.id, harness: 'Claude Code', resume: terminal }, 'Go on.');
        assert.match((await w.alice.sync()).find((m) => m.content?.prompt?.kind === 'failed')?.content?.text ?? '', /only in your own setup/);

        // A draft whose request is not in Alice's direct chat with the agent, as every one from before
        // D-105 is, ends when the plugin loads: the pane shows a card's thread only from that chat (K-58).
        const old = (await ask(w.alice)).id;
        await (await checkIn()).handled;
        const request: RunRequest = { kind: 'request', card: 'K-7', title: 'Sums are off by one', docId: board.id, section, runtime: agent.id, sentAt: Date.now(), repo: 'acme/app', hash: brief };
        await freeClaims();
        const current = (await w.alice.send(direct, { text: 'Run K-7 with Claude Code', run: request })).id;
        await (await checkIn()).handled;
        // A card run in the same minute stays restricted, with her own setup on (D-157).
        const cardTurn = await lastTurn();
        assert.ok(cardTurn.args.includes('--restricted') && cardTurn.cwd.includes(path.join('.claude', 'worktrees')), 'a card run stays restricted');
        await setup(w.alice, direct, { ...chosen, linked: ['Claude Code', 'Codex'], off: [] });
        const watching = async () => (JSON.parse(await fs.readFile(path.join(dataDir, 'laptop', 'pulls.json'), 'utf8')) as Array<{ pull: { number: number } }>).map((w) => w.pull.number);
        assert.deepEqual(await watching(), [2, 3]);
        await plugin.endStrandedDrafts();
        assert.deepEqual(await watching(), [3], 'the draft from the direct chat is watched on');
        assert.equal((await reportsOn(old)).at(-1), 'I stopped watching acme/app#2: its request is not in your direct chat with me, so the pane cannot show you its reviews.');
        assert.ok(!(await reportsOn(current)).some((text) => text?.startsWith('I stopped')), 'the other draft says nothing');

        // A second process on the laptop waits until this one closes (D-094).
        const second = new Plugin({ ...options, code: '', dataDir });
        // Caught: after 60 seconds it takes the lock again, in a folder the suite has removed by then.
        void second.start().catch(() => undefined);
        await waitFor('the second window waits', () => second.problem.startsWith('Another'));
        assert.match(second.problem, /Another process on this laptop serves your agent/);

        // Alice and the agent have sent many messages in a few seconds by now (D-091).
        const unthrottle = () => w.instance.sql.query("DELETE FROM webchat.rate_limits WHERE key LIKE 'send:%'");
        await unthrottle();
        // A repository with no folder on the laptop: the agent says so, and the run waits for Alice
        // to have it cloned. It clones only on her word, and only a repository her project links (R-036, D-108).
        const webOrigin = path.join(w.home, 'web.git');
        await sh('git', ['init', '-q', '--bare', '-b', 'main', webOrigin]);
        await git(project, 'push', '-q', webOrigin, 'refs/remotes/origin/main:refs/heads/main');
        await w.instance.sql.query(
          'INSERT INTO webchat.project_repos (project_id, repo, repo_id, installation_id, conversation_id, added_by, added_at) VALUES ($1, $2, 7, 8, $3, $4, $5)',
          [app.project.id, 'acme/web', general, w.alice.id, Date.now()],
        );
        await fs.appendFile(gitConfig, `[url "${webOrigin}"]\n\tinsteadOf = https://github.com/acme/web.git\n`);
        const inDirect = async (repo: string) => (await w.alice.send(direct, { text: 'Run K-7 with Claude Code', run: { ...request, repo, sentAt: Date.now() } })).id;
        const offered = async (id: number, repo: string) => {
          // Each look reads only what came since, so a seen offer stays seen.
          let seen = false;
          await waitFor('the agent offers a clone', async () => (seen ||= (await reportsOn(id)).includes(`I have no copy of ${repo} on this laptop.`)));
        };
        const clone = (from: AgentClient, chat: number, id: number, repo: string) => from.send(chat, { text: `Clone ${repo}`, run: { kind: 'clone', request: id, repo, sentAt: Date.now() } });
        const unlinked = await inDirect('acme/other');
        const waits = (await checkIn()).handled;
        await offered(unlinked, 'acme/other');
        await clone(w.alice, direct, unlinked, 'acme/other');
        await (await checkIn()).handled;
        await waits;
        assert.deepEqual(await reportsOn(unlinked), ['I could not run K-7: None of your projects links acme/other, so I do not clone it.']);
        const webRun = await inDirect('acme/web');
        const webWaits = (await checkIn()).handled;
        await offered(webRun, 'acme/web');
        // Carol's word is not Alice's, whatever it names.
        await clone(w.carol, general, webRun, 'acme/web');
        await (await checkIn()).handled;
        const cloneDir = path.join(cloneRoot, 'acme', 'web');
        assert.equal(existsSync(cloneDir), false, "a teammate's clone request does nothing");
        await clone(w.alice, direct, webRun, 'acme/web');
        await (await checkIn()).handled;
        await webWaits;
        assert.deepEqual(await reportsOn(webRun), [`Cloning acme/web into ${cloneDir}. This can take a while.`, `I finished K-7 on ${branch} (acme/web#4). Sums add up now.`]);
        assert.equal((await git(cloneDir, 'config', '--get', 'remote.origin.url')).stdout.trim(), 'https://github.com/acme/web.git', 'the clone pushes where GitHub has the repository');
        assert.equal((await git(cloneDir, 'rev-parse', 'HEAD')).stdout.trim(), (await git(cloneDir, 'rev-parse', 'origin/main')).stdout.trim(), 'it is on the default branch');
        assert.ok((await turns()).at(-1)!.cwd.startsWith(path.join(await fs.realpath(cloneDir), '.claude', 'worktrees')), 'the run went on in the clone');
        assert.deepEqual(plugin.client!.repos, ['acme/app', 'acme/web']);

        // The folder now takes runs like any other.
        await unthrottle();
        const askWeb = async () => {
          await freeClaims(webOrigin);
          const id = (await ask(w.alice, { repo: 'acme/web' })).id;
          await (await checkIn()).handled;
          return reportsOn(id);
        };
        const failed = JSON.stringify({ outcome: 'failed', note: 'Not today.' });
        assert.deepEqual(await withEnv({ FAKE_CLAUDE_ANSWER: failed }, askWeb), ['I am on K-7: Sums are off by one', 'I could not run K-7: Not today.']);
        assert.equal((await pullsNow()).at(-1)!.closed, 'The agent stopped: Not today. The branch stays.', 'a run that fails after its claim closes its draft (R-042)');
        // A turn that says done but commits nothing fails, and its draft closes.
        assert.deepEqual(await withEnv({ FAKE_CLAUDE_COMMIT: '0' }, askWeb), ['I am on K-7: Sums are off by one', 'I could not run K-7: I left no new commits.']);
        assert.equal((await pullsNow()).at(-1)!.closed, 'The agent stopped: I left no new commits. The branch stays.');
        // Disconnecting forgets the folder, never its files.
        await disconnect(dataDir, 'acme/web');
        await plugin.scan();
        assert.deepEqual(plugin.client!.repos, ['acme/app']);
        assert.ok(existsSync(path.join(cloneDir, 'README.md')));
        // A folder connected in another window lets a run that waits for it go on, with no clone (R-036).
        const connectWaits = async () => {
          await freeClaims(webOrigin);
          const id = (await ask(w.alice, { repo: 'acme/web' })).id;
          const handled = (await checkIn()).handled;
          await offered(id, 'acme/web');
          await connect(dataDir, 'acme/web', cloneDir);
          await plugin.scan();
          await handled;
          return reportsOn(id);
        };
        assert.deepEqual(await withEnv({ FAKE_CLAUDE_ANSWER: failed }, connectWaits), ['I could not run K-7: Not today.'], 'the run went on in the connected folder');
        await disconnect(dataDir, 'acme/web');
        await plugin.scan();
        // Alice forgets the app's folder from the pane, and Carol cannot: the mark goes, the files stay (R-038).
        const forget = (from: AgentClient, chat: number) => from.send(chat, { text: 'Forget the folder of acme/app', forget: { repo: 'acme/app', sentAt: Date.now() } });
        await forget(w.carol, general);
        await (await checkIn()).handled;
        assert.deepEqual(plugin.client!.repos, ['acme/app'], "a teammate's word forgets nothing");
        await forget(w.alice, direct);
        await (await checkIn()).handled;
        assert.deepEqual(plugin.client!.repos, []);
        // The laptop's next check-in names no folder, so the pane shows none at once.
        await plugin.client!.sync();
        await w.alice.sync();
        assert.deepEqual(w.alice.users.get(agent.id)?.agentRepos, []);
        assert.ok(existsSync(path.join(project, 'README.md')));

        // Alice links the board to the repository, whose docs then copy the board (R-040, D-117).
        await connect(dataDir, 'acme/app', project);
        await plugin.scan();
        await unthrottle();
        await git(project, 'config', 'user.name', 'Alice');
        await git(project, 'config', 'user.email', 'alice@example.com');
        const docsAt = async (files: Record<string, string>) => {
          await git(merger, 'pull', '-q', 'origin', 'main');
          for (const [file, text] of Object.entries(files)) {
            await fs.mkdir(path.dirname(path.join(merger, file)), { recursive: true });
            await fs.writeFile(path.join(merger, file), text);
          }
          await git(merger, 'add', '-A');
          await git(merger, 'commit', '-q', '-m', 'Docs');
          await git(merger, 'push', '-q', 'origin', 'HEAD:main');
        };
        await docsAt({
          'docs/decisions.md': '# Decisions\n\n## A topic\n\n### D-001: Keep sums exact\n\nAccepted 2026-11-01.\n\nWhy: money.\n',
          'docs/roadmap.md': '# Roadmap\n\n## Known issues\n\n### K-3: Totals lag\n\nStatus: Open.\n',
          'docs/roadmap/K-9.md': '### K-9: Not folded in yet\n\nStatus: Open.\n',
          'docs/roadmap/new-thing.md': '### R: A new thing\n\nStatus: Idea.\n\nWhy: tests.\n',
        });
        const link = (await w.alice.send(direct, { text: 'Link the board to acme/app', board: { kind: 'link', project: app.project.id, repo: 'acme/app', sentAt: Date.now() } })).clientId!;
        await (await checkIn()).handled;
        const fromAgent = async () => (await w.alice.sync()).filter((m) => m.senderId === agent.id && m.content?.board).map((m) => ({ ...m.content!.board!, clientId: m.clientId!, sentAs: m.kind }));
        const [entries] = await fromAgent();
        assert.deepEqual(entries?.kind === 'entries' && [entries.to, entries.part, entries.parts, entries.entries.map((e) => readCard(e)!.id)], [link, 1, 1, ['D-001', 'K-3', 'K-9']], "the repository's entries, with one not folded in yet, and no proposal");
        assert.equal(entries.sentAs, 'sync', 'entries are quiet traffic with the page (K-69)');
        // Alice's page imports them, then names the repository in the Roadmap's title; a teammate's naming counts for nothing.
        await w.alice.sync();
        const roadmapDoc = (await w.alice.boardDocs(app.project.id)).roadmap!;
        await w.carol.sync();
        await w.carol.editSection(roadmapDoc, 'title', () => ({ text: 'Roadmap', board: 'roadmap', repo: 'acme/app' }));
        await plugin.client!.sync();
        await plugin.syncBoards(Date.now() + 11 * 60_000);
        assert.equal((await fromAgent()).length, 0, 'nothing comes of a link the owner did not write');
        await w.alice.editSection(roadmapDoc, 'title', () => ({ text: 'Roadmap', board: 'roadmap', repo: 'acme/app' }));
        await fs.writeFile(ghState, JSON.stringify({ ...JSON.parse(await fs.readFile(ghState, 'utf8')), open: [{ number: 8, title: 'Fix totals', body: 'Claims K-7. Checked it.', headRefName: 'claude/k7-totals' }] }));
        const pullsBefore = JSON.parse(await fs.readFile(ghState, 'utf8')).pulls.length;
        await plugin.client!.sync();
        // A change waits until the board stays unchanged for 10 minutes.
        const start = Date.now();
        await plugin.syncBoards(start);
        const atBoard = (file: string) => sh('git', ['--git-dir', origin, 'show', `agent/board:${file}`]).then((r) => r.stdout, () => null);
        assert.equal(await atBoard('docs/roadmap.md'), null, 'no copy before the board is quiet');
        const sent = await fromAgent();
        const proposal = sent.find((m) => m.kind === 'proposal');
        assert.deepEqual(proposal?.kind === 'proposal' && proposal.card, { kind: 'R', title: 'A new thing', body: 'Why: tests.' }, 'a proposal on main comes as a draft');
        assert.equal(proposal?.sentAs, 'message', 'a proposal is news to the owner');
        assert.deepEqual(sent.find((m) => m.kind === 'claims'), { kind: 'claims', project: app.project.id, repo: 'acme/app', claims: [{ card: 'K-7', pull: 8 }], clientId: sent.find((m) => m.kind === 'claims')!.clientId, sentAs: 'sync' }, 'an open pull request claims K-7, quietly');
        await plugin.syncBoards(start + 11 * 60_000);
        const cards = (await w.alice.sections(roadmapDoc)).map((s) => s.text);
        assert.equal(await atBoard('docs/roadmap.md'), copyOf('roadmap', cards), 'the copy is what Copy as Markdown gives');
        assert.equal(await atBoard('docs/decisions.md'), copyOf('decisions', []));
        assert.equal(await atBoard('docs/roadmap/K-9.md'), null, 'the entry the import took in leaves its file');
        assert.ok((await atBoard('docs/roadmap/new-thing.md'))?.includes('A new thing'), 'a proposal stays until it is on the board');
        assert.deepEqual(
          JSON.parse(await fs.readFile(ghState, 'utf8')).pulls.slice(pullsBefore).map((p: { head: string; base: string; draft: boolean; title: string }) => [p.head, p.base, p.draft, p.title]),
          [['agent/board', 'main', true, 'docs: Copy the board']],
          'one draft, on agent/board',
        );
        // Alice adds the proposal; the board changes, and the next copy drops its file, on the same draft.
        await w.alice.send(direct, { text: 'Added R-1 to the board.', added: { to: proposal!.clientId, draft: proposal!.clientId, card: 'R-1' } });
        await (await checkIn()).handled;
        await w.alice.editSection(roadmapDoc, newKeyId().slice(0, 11), () => ({ text: '### R-1: A new thing\n\nStatus: Idea.\n\nWhy: tests.', pos: 9 }));
        await plugin.client!.sync();
        await plugin.syncBoards(start + 12 * 60_000);
        await plugin.syncBoards(start + 23 * 60_000);
        assert.equal(await atBoard('docs/roadmap/new-thing.md'), null, 'the added proposal leaves its file');
        assert.ok((await atBoard('docs/roadmap.md'))?.includes('### R-1: A new thing'));
        assert.equal(JSON.parse(await fs.readFile(ghState, 'utf8')).pulls.length, pullsBefore + 1, 'still one draft');
        // A session with no card sends one from its working tree, checked, and gets the number Alice's page gives it (R-044).
        const typed = '### R: From the terminal\n\nStatus: Idea.\n\nWhy: no merge first.\n';
        const checkedDraft = { kind: 'idea', title: 'From the terminal', body: 'Why: no merge first.', checked: 'Read the board and the code.' };
        const fromTerminal = (waitMs?: number) => plugin.requestCard('acme/app', 'docs/roadmap/new-terminal.md', typed, waitMs);
        const typedCard = withEnv({ FAKE_CLAUDE_ANSWER: JSON.stringify({ reply: 'No card covers it.', drafts: [checkedDraft] }) }, () => fromTerminal());
        let drafted: Awaited<ReturnType<typeof fromAgent>>[number] | undefined;
        while (!(drafted = (await fromAgent()).find((m) => m.kind === 'proposal'))) await sleep(50);
        assert.deepEqual(drafted.kind === 'proposal' && [drafted.card, drafted.project, drafted.sentAs], [{ ...checkedDraft, kind: 'R' }, app.project.id, 'message'], 'the checked draft goes to the owner, as a proposal does');
        await w.alice.send(direct, { text: 'Added R-2 to the board.', added: { to: drafted.clientId, draft: drafted.clientId, card: 'R-2' } });
        await (await checkIn()).handled;
        const added = await typedCard;
        assert.equal(added.card, 'R-2', 'the command gets the number the board gave');
        assert.match(added.text, /No card covers it/, "it shows the agent's check");
        // A draft nobody adds in time leaves the command without a number; the draft stays in the pane.
        assert.equal((await withEnv({ FAKE_CLAUDE_ANSWER: JSON.stringify({ reply: 'Fine.', drafts: [checkedDraft] }) }, () => fromTerminal(10))).card, undefined);
        // A check that drafts nothing sends nothing, and says why.
        await fromAgent();
        await assert.rejects(withEnv({ FAKE_CLAUDE_ANSWER: JSON.stringify({ reply: 'R-1 covers it.' }) }, () => fromTerminal()), /R-1 covers it/);
        await assert.rejects(plugin.requestCard('acme/app', 'docs/roadmap/K-3.md', '### K-3: Totals lag\n\nStatus: Open.'), /has its number/);
        await assert.rejects(plugin.requestCard('acme/web', 'docs/roadmap/new-x.md', typed), /no copy|Connect it/i);
        assert.equal((await fromAgent()).filter((m) => m.kind === 'proposal').length, 0, 'nothing refused reaches the owner');
        // A check that finds the card changes a contract and uses it proposes the split: the contract card, then the card after it (docs/roadmap/new-after-edge.md).
        const contractDraft = { kind: 'idea', title: 'Totals type', body: 'Why: the terminal card needs it.', checked: 'Read shared/types.ts.' };
        const afterDraft = { ...checkedDraft, after: 'Totals type' };
        const split = await withEnv({ FAKE_CLAUDE_ANSWER: JSON.stringify({ reply: 'It changes a shared type and uses it.', drafts: [contractDraft, afterDraft] }) }, () => fromTerminal(10));
        assert.ok((await turns()).at(-1)!.input.includes('split it: a shared type, a migration'), "the check's brief asks for the split");
        assert.match(split.text, /split it: “From the terminal” waits on the board until it is done/);
        assert.deepEqual(
          (await fromAgent()).flatMap((m) => (m.kind === 'proposal' ? [m.card] : [])),
          [{ ...contractDraft, kind: 'R' }, { ...afterDraft, kind: 'R' }],
          'both drafts reach the owner, who adds both or neither, and the second names the first',
        );
        // An after that names no card drafted before it is dropped.
        await withEnv({ FAKE_CLAUDE_ANSWER: JSON.stringify({ reply: 'Fine.', drafts: [{ ...checkedDraft, after: 'Nothing' }] }) }, () => fromTerminal(10));
        assert.deepEqual((await fromAgent()).flatMap((m) => (m.kind === 'proposal' ? [m.card] : [])), [{ ...checkedDraft, kind: 'R' }]);
        // On cards Alice opened, Carol's Ready and Carol's removal do not stand, so the copy shows neither, as the board does (the card-owner decision).
        const [owned, unremoved] = [newKeyId().slice(0, 11), newKeyId().slice(0, 11)];
        await w.alice.editSection(roadmapDoc, owned, () => ({ text: '### K-10: Owned\n\nStatus: Open.', pos: 10, opened: true }));
        await w.alice.editSection(roadmapDoc, unremoved, () => ({ text: '### K-11: Kept\n\nStatus: Open.', pos: 11, opened: true }));
        await w.carol.sync();
        await w.carol.editSection(roadmapDoc, owned, () => ({ text: '### K-10: Owned\n\nStatus: Ready.', pos: 10 }));
        await w.carol.editSection(roadmapDoc, unremoved, () => ({ text: '### K-11: Kept\n\nStatus: Open.', pos: 11, removed: true }));
        await plugin.client!.sync();
        await plugin.syncBoards(start + 24 * 60_000);
        await plugin.syncBoards(start + 35 * 60_000);
        const copyNow = (await atBoard('docs/roadmap.md'))!;
        assert.ok(copyNow.includes('### K-10: Owned\n\nStatus: Open.') && !copyNow.includes('## Ready'), "Carol's Ready on Alice's card is not copied");
        assert.ok(copyNow.includes('### K-11: Kept'), "Carol's removal of Alice's card is not copied");

        // A new install keeps no record of what it sent, and main still holds the added proposal's file
        // until the copy merges: the board's R-1 has its title, so no draft goes again (K-71).
        (plugin as unknown as { copies: Record<number, { proposals: object }> }).copies[app.project.id]!.proposals = {};
        await fromAgent();
        await plugin.syncBoards(start + 41 * 60_000);
        assert.deepEqual((await fromAgent()).filter((m) => m.kind === 'proposal' && m.card.title === 'A new thing'), [], 'no draft for a card the board has');
        // A backlog of 40 proposals goes out under the send limit, and the same round names the claims.
        await docsAt(Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`docs/roadmap/new-burst-${i}.md`, `### K: Burst ${i}\n\nStatus: Open.\n`])));
        const ghBefore = JSON.parse(await fs.readFile(ghState, 'utf8'));
        await fs.writeFile(ghState, JSON.stringify({ ...ghBefore, open: [...ghBefore.open, { number: 9, title: 'Own it', body: 'Claims K-10.', headRefName: 'claude/k10' }] }));
        await unthrottle();
        await plugin.syncBoards(start + 47 * 60_000);
        const burst = await fromAgent();
        assert.equal(burst.filter((m) => m.kind === 'proposal').length, 40, 'every proposal went out, with no 429');
        const claimsNow = burst.find((m) => m.kind === 'claims');
        assert.deepEqual(claimsNow?.kind === 'claims' && claimsNow.claims, [{ card: 'K-7', pull: 8 }, { card: 'K-10', pull: 9 }]);
        await fs.writeFile(ghState, JSON.stringify(ghBefore));

        // A card run follows the repository's workflow (R-042, D-118).
        await unthrottle();
        const k7Now = async () => (await plugin.client!.sections(plugin.client!.docs.find((d) => d.id === board.id)!)).find((s) => s.id === section)!.text;
        // The brief as Alice's page hashes it now: the card, then the decisions the team holds (D-105).
        const briefNow = async () => {
          const { decisions: held } = await plugin.client!.boardDocs(app.project.id);
          return textHash(briefText(await k7Now(), held ? (await plugin.client!.sections(held)).map((s) => s.text) : []));
        };
        const runK7 = async (env: Record<string, string> = {}) =>
          withEnv(env, async () => {
            const id = (await ask(w.alice, { hash: await briefNow() })).id;
            await (await checkIn()).handled;
            return { id, said: await reports(id) };
          });
        const DAY = 24 * 60 * 60_000;

        // An open pull request that claims the card refuses the run, before the agent takes it.
        const turnsBefore = (await turns()).length;
        assert.deepEqual((await runK7()).said.map((r) => r.text), ['I could not run K-7: acme/app#8 claims K-7 already. Pick another card, or ask whoever opened it.']);
        assert.equal((await turns()).length, turnsBefore, 'no Claude ran for it');

        // A card the code already does ends at its check, pushes nothing, and offers its new status
        // as a change Alice adds (D-104).
        await fs.writeFile(ghState, JSON.stringify({ ...JSON.parse(await fs.readFile(ghState, 'utf8')), open: [] }));
        // A card whose After line names a card that is not Done or Fixed is refused before the agent
        // takes it, as a claimed one is; once that card is Done, it runs (docs/roadmap/new-after-edge.md).
        await w.alice.sync();
        const boardDoc = w.alice.docs.find((d) => d.id === board.id)!;
        const [k7Text, contract] = ['### K-7: Sums are off by one\n\nStatus: Open.', newKeyId().slice(0, 11)];
        const afterK12 = (status: string, removed = false) => w.alice.editSection(boardDoc, contract, () => ({ text: `### K-12: Totals type\n\nStatus: ${status}.`, pos: 2, removed }));
        await afterK12('Ready');
        await w.alice.editSection(boardDoc, section, () => ({ text: `${k7Text}\n\nAfter: K-12`, pos: 1 }));
        await plugin.client!.sync();
        const turnsBeforeAfter = (await turns()).length;
        assert.deepEqual((await runK7()).said.map((r) => r.text), ['I could not run K-7: K-7 waits for K-12, which must be Done or Fixed first. Start it once they are.']);
        assert.equal((await turns()).length, turnsBeforeAfter, 'no Claude ran for it');
        await afterK12('Done on 2026-11-18');
        await plugin.client!.sync();
        const afterDone = await runK7({ FAKE_CLAUDE_CHECK: JSON.stringify({ outcome: 'stale', status: 'Done', note: 'sum.js adds exactly already.', checked: 'Read K-7.' }) });
        assert.equal(afterDone.said[0]?.text, 'I am on K-7: Sums are off by one', 'K-12 is Done, so K-7 runs');
        await w.alice.editSection(boardDoc, section, () => ({ text: k7Text, pos: 1 }));
        await afterK12('Done on 2026-11-18', true);
        await plugin.client!.sync();
        const [pullsBeforeRuns, branchesBeforeRuns] = [(await pullsNow()).length, await branches()];
        const turnsBeforeStale = (await turns()).length;
        const check = { outcome: 'stale', status: 'Done', note: 'sum.js adds exactly already.', checked: 'Read K-7 and sum.js on main.' };
        const stale = await runK7({ FAKE_CLAUDE_CHECK: JSON.stringify(check) });
        assert.deepEqual(stale.said.map((r) => r.text), ['I am on K-7: Sums are off by one', 'K-7 no longer holds: sum.js adds exactly already.']);
        assert.deepEqual(stale.said[1]!.run.card, {
          kind: 'K',
          title: 'Sums are off by one',
          body: '',
          status: `Done on ${today}: sum.js adds exactly already`,
          checked: 'Read K-7 and sum.js on main.',
          replaces: { card: 'K-7', doc: board.id, section, seen: await textHash((await k7Now()).trim()) },
        });
        assert.equal((await turns()).length, turnsBeforeStale + 1, 'only the check ran');
        assert.deepEqual([(await pullsNow()).length, await branches()], [pullsBeforeRuns, branchesBeforeRuns], 'nothing was pushed or opened');

        // A run that finds a decision nobody foresaw stops for it, with its claim and its work so far
        // pushed, and holds the card. The plan gate's knob is off, so no plan waits for a go first.
        const needed = { kind: 'decision', title: 'Sums round half to even', body: 'Why: money.', checked: 'Read sum.js.' };
        const paused = await runK7({ FAKE_CLAUDE_ANSWER: JSON.stringify({ outcome: 'decision', note: 'Rounding needs a rule.', drafts: [needed] }) });
        assert.deepEqual(paused.said.map((r) => r.text), ['I am on K-7: Sums are off by one', 'K-7 needs a decision first: Sums round half to even. Add it on the board, then tell me to go on.']);
        assert.deepEqual(paused.said[1]!.run.card, { kind: 'D', title: 'Sums round half to even', body: 'Why: money.', checked: 'Read sum.js.' });
        const number = pullsBeforeRuns + 1;
        const pausedPull = (await pullsNow())[number - 1]!;
        assert.deepEqual(pausedPull, { head: pausedPull.head, base: 'main', draft: true, ...claim }, 'the claim opened the draft, and nothing edited it');
        assert.deepEqual(await log(pausedPull.head), ['Change sum.test.js', 'chore: Claim K-7']);
        // It waits for the go, with one reminder after a day.
        const [pausedCheck] = (await turns()).slice(-2);
        const turnsPaused = (await turns()).length;
        await plugin.pollPulls(Date.now() + 2 * DAY);
        await plugin.pollPulls(Date.now() + 3 * DAY);
        assert.deepEqual((await reports(paused.id)).map((r) => r.text), ['I still wait for your decision on K-7. Add it on the board, then tell me to go on.']);
        assert.equal((await turns()).length, turnsPaused, 'nothing runs before the go');
        // Alice adds the decision, which the board numbers D-1, and says go: the run goes on in its session.
        const decisionsNow = { id: newKeyId(), conversationId: general };
        const d1 = newKeyId().slice(0, 11);
        await w.alice.request('POST', '/docs', {
          ...decisionsNow,
          revisions: [
            { section: 'title', envelope: await w.alice.sealDoc(decisionsNow, 'title', { text: 'Decisions', board: 'decisions' }) },
            { section: d1, envelope: await w.alice.sealDoc(decisionsNow, d1, { text: '### D-1: Sums round half to even\n\nStatus: Proposed.\n\nWhy: money.', pos: 1 }) },
          ],
        });
        const gap = { kind: 'issue', title: 'Totals round twice', body: 'Seen: in totals.js.', checked: 'Read totals.js.' };
        const finished = { outcome: 'done', note: 'Sums round half to even.', title: 'fix: Round sums half to even', body: 'As D-1 says.', decisions: ['D-1', 'D-9'], drafts: [gap] };
        await w.alice.send(general, { text: 'Go on with D-1', run: { kind: 'fix', request: paused.id, note: 'I added the decision as D-1. Go on with the work.', sentAt: Date.now() } });
        await withEnv({ FAKE_CLAUDE_ANSWER: JSON.stringify(finished) }, async () => (await checkIn()).handled);
        const resumed = (await turns()).at(-1)!;
        assert.equal(resumed.session, pausedCheck!.session, 'it resumes the run');
        assert.ok(resumed.input.includes('I added the decision as D-1') && resumed.input.includes('Your owner added the decision you waited for'), 'the round has the number');
        const goneOn = await reports(paused.id);
        assert.deepEqual(goneOn.map((r) => r.text), [
          'I am back on K-7: you added the decision',
          `I finished K-7 on ${pausedPull.head} (acme/app#${number}). Sums round half to even.`,
          'Card draft: Totals round twice',
        ]);
        assert.deepEqual(goneOn[2]!.run.card, { kind: 'K', title: 'Totals round twice', body: 'Seen: in totals.js.', checked: 'Read totals.js.' }, 'a gap the run found waits for Alice');
        assert.deepEqual((await pullsNow())[number - 1]!.edited, { title: 'fix: Round sums half to even', body: 'As D-1 says.' });
        // Once it is merged, the agent says so, with the decision the work made true, which Alice's
        // page accepts; a decision the board does not have is left out.
        const merging = await pullsNow();
        merging[number - 1] = { ...merging[number - 1]!, view: { state: 'MERGED' } };
        await fs.writeFile(ghState, JSON.stringify({ ...JSON.parse(await fs.readFile(ghState, 'utf8')), pulls: merging }));
        await plugin.pollPulls();
        assert.deepEqual(await reports(paused.id), [
          { text: `I stopped watching acme/app#${number}: it was merged.`, run: { kind: 'merged', request: paused.id, note: 'it was merged', pull: { repo: 'acme/app', number }, decisions: ['D-1'] } },
        ]);

        // A finished run's draft closed unmerged says so, and Alice's page moves the card back.
        await unthrottle();
        const dropped = await runK7({ FAKE_CLAUDE_ANSWER: JSON.stringify({ outcome: 'done', note: 'Done.', title: 'fix: Sums', body: 'Fixed.' }) });
        const closing = await pullsNow();
        closing[closing.length - 1] = { ...closing.at(-1)!, view: { state: 'CLOSED' } };
        await fs.writeFile(ghState, JSON.stringify({ ...JSON.parse(await fs.readFile(ghState, 'utf8')), pulls: closing }));
        await plugin.pollPulls();
        assert.deepEqual((await reports(dropped.id)).map((r) => r.run.kind), ['closed']);

        // A run left waiting for 7 days fails, and its draft closes with its branch kept.
        await unthrottle();
        const left = await runK7({ FAKE_CLAUDE_ANSWER: JSON.stringify({ outcome: 'decision', note: 'Totals need a rule.', drafts: [{ ...needed, title: 'Totals round once' }] }) });
        assert.equal(left.said.at(-1)!.text, 'K-7 needs a decision first: Totals round once. Add it on the board, then tell me to go on.');
        await plugin.pollPulls(Date.now() + 8 * DAY);
        assert.deepEqual((await reports(left.id)).map((r) => r.text), ['I could not run K-7: No decision came within 7 days.']);
        const leftPull = (await pullsNow()).at(-1)!;
        assert.equal(leftPull.closed, 'The agent stopped: No decision came within 7 days. The branch stays.');
        assert.ok((await branches()).includes(leftPull.head), 'the branch stays');

        // A stop before the work is done pauses the run: what is committed is pushed, and the
        // worktree, branch, draft and session wait for the owner's words (docs/decisions/stop-pauses-run.md).
        const hold = path.join(w.home, 'hold');
        const stopK7 = async () => {
          await unthrottle();
          const before = (await turns()).length;
          return withEnv({ FAKE_CLAUDE_HOLD: hold }, async () => {
            const id = (await ask(w.alice, { hash: await briefNow() })).id;
            const { handled } = await checkIn();
            // The work turn says what it does as soon as it starts, and the report follows. Polled
            // slowly: a tight loop of check-ins starves the plugin's own requests to the server.
            await waitFor('the work turn started', async () => (await turns()).length === before + 2);
            const said: Array<{ text: string; run: RunReport }> = [];
            const more = async () => void said.push(...(await reports(id)));
            for (let tries = 0; tries < 50 && !said.some((r) => r.run.kind === 'progress'); tries++) await sleep(100).then(more);
            await w.alice.send(general, { text: 'Stop', run: { kind: 'cancel', request: id } });
            await (await checkIn()).handled;
            await handled;
            await more();
            return { id, said, turns: (await turns()).slice(before) };
          });
        };
        const stopped = await stopK7();
        const [stoppedCheck, stoppedWork] = stopped.turns;
        const stoppedPull = (await pullsNow()).at(-1)!;
        assert.deepEqual(
          stopped.said.map((r) => [r.run.kind, r.text]),
          [
            ['claimed', 'I am on K-7: Sums are off by one'],
            ['progress', 'Run the tests'],
            ['paused', `I stopped K-7 as you asked. What I committed is on ${stoppedPull.head} (acme/app#${(await pullsNow()).length}), and I keep where I was. Tell me what to change, or start the card over.`],
          ],
          'two progress lines within 30 seconds send one report',
        );
        assert.deepEqual(await log(stoppedPull.head), ['Change sum.test.js', 'chore: Claim K-7'], 'what was committed is pushed');
        assert.equal(stoppedPull.closed, undefined, 'the draft stays open');
        await fs.access(stoppedWork!.cwd);
        const stoppedRecord = (JSON.parse(await fs.readFile(path.join(dataDir, 'laptop', 'pulls.json'), 'utf8')) as Array<{ taken: { message: number }; session: string; unfinished?: { paused?: number; stopped?: true } }>).find((w) => w.taken.message === stopped.id)!;
        assert.equal(stoppedRecord.session, stoppedCheck!.session, 'the session is kept');
        assert.ok(stoppedRecord.unfinished?.paused && stoppedRecord.unfinished.stopped, 'the run waits as paused');
        await plugin.pollPulls();
        assert.deepEqual(await reports(stopped.id), [], 'nothing ends a paused run');
        // A second stop starts the card over: the draft closes, and the branch stays.
        await w.alice.send(general, { text: 'Stop', run: { kind: 'cancel', request: stopped.id } });
        await (await checkIn()).handled;
        await plugin.pollPulls();
        assert.deepEqual((await reports(stopped.id)).map((r) => r.text), ['I could not run K-7: You started it over.']);
        assert.equal((await pullsNow()).at(-1)!.closed, 'The agent stopped: You started it over. The branch stays.');
        assert.ok((await branches()).includes(stoppedPull.head), 'the branch stays');
        // With no words, a paused run fails after 7 days, as a decision pause does.
        const silent = await stopK7();
        assert.equal(silent.said.at(-1)!.run.kind, 'paused');
        await plugin.pollPulls(Date.now() + 8 * DAY);
        assert.deepEqual((await reports(silent.id)).map((r) => r.text), ['I could not run K-7: No words came within 7 days.']);
        // The owner's words redirect a stopped run: its session goes on with them, fenced, and ends the run.
        const redirected = await stopK7();
        const words = 'Do not add a table; reuse messages.';
        await w.alice.send(general, { text: words, run: { kind: 'fix', request: redirected.id, note: words, sentAt: Date.now() } });
        await (await checkIn()).handled;
        const [redirectedCheck] = redirected.turns;
        const steered = (await turns()).at(-1)!;
        assert.equal(steered.session, redirectedCheck!.session, 'the same session goes on');
        assert.ok(steered.input.includes(`OWNER'S WORDS START ============\n${words}\n============`), 'the words are fenced');
        assert.ok(steered.input.includes('read `git status` first'), 'it looks at the worktree first');
        const redirectedPull = (await pullsNow()).at(-1)!;
        assert.deepEqual((await reports(redirected.id)).map((r) => r.text), [
          'I am back on K-7: you told me what to change',
          `I finished K-7 on ${redirectedPull.head} (acme/app#${(await pullsNow()).length}). Sums add up now.`,
        ]);

        // With the gate on, a card that holds shows its plan and waits, with nothing committed or
        // pushed; the owner's go claims it, and the work goes on in the check's session
        // (docs/decisions/redirect-plan-gate.md). Every run above had the knob off, and none waited.
        await setup(w.alice, direct, { ...chosen, noPlan: false });
        await unthrottle();
        const [pullsBeforePlan, branchesBeforePlan, turnsBeforePlan] = [(await pullsNow()).length, await branches(), (await turns()).length];
        const plan = 'Fix the off-by-one in sum.js.\nAdd a test for it.';
        const planned = await runK7({ FAKE_CLAUDE_CHECK: JSON.stringify({ outcome: 'holds', note: '', checked: 'Read K-7 and sum.js on main.', plan }) });
        assert.deepEqual(
          planned.said.map((r) => [r.run.kind, r.text, r.run.note]),
          [
            ['claimed', 'I am on K-7: Sums are off by one', undefined],
            ['planned', `K-7 holds. My plan:\n\n${plan}\n\nSay go, or tell me what to change.`, plan],
          ],
        );
        const [planCheck] = (await turns()).slice(turnsBeforePlan);
        assert.equal((await turns()).length, turnsBeforePlan + 1, 'only the check ran');
        assert.deepEqual([(await pullsNow()).length, await branches()], [pullsBeforePlan, branchesBeforePlan], 'nothing was pushed or opened');
        assert.notEqual((await git(planCheck!.cwd, 'log', '-1', '--format=%s')).stdout.trim(), 'chore: Claim K-7', 'nothing was committed');
        await w.alice.send(general, { text: 'Go', run: { kind: 'fix', request: planned.id, sentAt: Date.now() } });
        await (await checkIn()).handled;
        const planPull = (await pullsNow()).at(-1)!;
        assert.equal((await pullsNow()).length, pullsBeforePlan + 1, 'the go opened the draft');
        assert.deepEqual(await reportsOn(planned.id), ['I am back on K-7: you said go', `I finished K-7 on ${planPull.head} (acme/app#${pullsBeforePlan + 1}). Sums add up now.`]);
        assert.deepEqual(await log(planPull.head), ['Change sum.test.js', 'chore: Claim K-7']);
        const [, planWork] = (await turns()).slice(turnsBeforePlan);
        assert.equal(planWork!.session, planCheck!.session, 'the work resumes the check');
        assert.ok(planWork!.input.includes('says go') && planWork!.input.includes(`acme/app#${pullsBeforePlan + 1} claims it`), 'the brief carries the go');
        // A card run asks its owner before an action Claude Code would ask about, through its permission
        // prompt tool, which the fake calls on a loopback endpoint of the plugin; the owner's second
        // device answers (docs/decisions/harness-approvals.md). The plan gate is off again for these.
        await setup(w.alice, direct, { ...chosen, noPlan: true });
        await unthrottle();
        await fs.writeFile(ghState, JSON.stringify({ ...JSON.parse(await fs.readFile(ghState, 'utf8')), open: [] }));
        await fs.copyFile(path.join(w.home, 'alice.json'), path.join(w.home, 'alice-phone2.json'));
        const phone = await AgentClient.load(path.join(w.home, 'alice-phone2.json'));
        const askedLog = path.join(w.home, 'asked.log');
        const restoreAsk = setEnv({ FAKE_CLAUDE_ASK: JSON.stringify([{ tool_name: 'Write', input: { file_path: '$CWD/.claude/settings.json', content: '{}' } }]), FAKE_CLAUDE_ASKED: askedLog });
        try {
          const decisions = async () => (await fs.readFile(askedLog, 'utf8').catch(() => '')).split('\n').filter(Boolean).map((l) => JSON.parse(l) as { decision: { behavior?: string; message?: string; updatedInput?: object; status?: number } });
          const heardPermits: OpenedMessage[] = [];
          const nextQuestion = async (n: number) => {
            await waitFor('the question reaches the owner', async () => {
              heardPermits.push(...(await phone.sync()).filter((m) => m.senderId === agent.id && m.content?.permit));
              return heardPermits.filter((m) => m.content!.permit!.kind === 'question').length > n;
            });
            return heardPermits.filter((m) => m.content!.permit!.kind === 'question')[n]!;
          };
          const reply = async (question: OpenedMessage, decision: 'once' | 'run' | 'deny') => {
            const permit = question.content!.permit as Extract<PermitDTO, { kind: 'question' }>;
            await phone.send(direct, { text: 'Answer', permit: { kind: 'answer', to: question.clientId!, decision, seen: await permitHash(permit), sentAt: Date.now() } });
            for (const m of await plugin.client!.sync()) await plugin.handle(m);
          };
          const startAsking = async () => {
            const id = (await ask(w.alice, { hash: await briefNow(), asks: true })).id;
            return { id, handled: (await checkIn()).handled };
          };

          // Allow, from the second device: the run goes on and finishes. The question names the file Claude Code would write.
          const turnsBeforeAsk = (await turns()).length;
          const allowed = await startAsking();
          const first = await nextQuestion(0);
          const permit = first.content!.permit as Extract<PermitDTO, { kind: 'question' }>;
          assert.deepEqual([permit.what, permit.request, permit.detail.startsWith('Write ') && permit.detail.endsWith('.claude/settings.json')], ['edit', allowed.id, true]);
          assert.deepEqual(await decisions(), [], 'Claude Code waits for the answer');
          await reply(first, 'once');
          await allowed.handled;
          const allowedPull = (await pullsNow()).at(-1)!;
          assert.deepEqual((await reportsOn(allowed.id)).at(-1), `I finished K-7 on ${allowedPull.head} (acme/app#${(await pullsNow()).length}). Sums add up now.`);
          const [answered] = await decisions();
          assert.deepEqual([answered!.decision.behavior, typeof answered!.decision.updatedInput], ['allow', 'object'], 'the tool answers allow, with the input');
          // One process took both turns, started with the prompt tool and no refusal of what it asks.
          const [check, work] = (await turns()).slice(turnsBeforeAsk);
          assert.equal(check!.pid, work!.pid, 'one process for the session');
          for (const flag of ['--mcp-config', '--permission-prompt-tool', '--disallowedTools']) assert.ok(check!.args.includes(flag), flag);
          assert.ok(!check!.args.includes('--permission-prompts'), 'it no longer refuses what it asks');
          const approveFile = check!.args[check!.args.indexOf('--mcp-config') + 1]!;
          assert.equal((await fs.stat(approveFile)).mode & 0o777, 0o600, 'the token file is for the owner only');
          assert.ok(approveFile.startsWith(path.join(dataDir, 'laptop')), 'it is in the plugin\'s folder, which the shell cannot read');
          // Only the plugin's own endpoint is called, and only with the token.
          const server = check!.mcp!.mcpServers.webchat;
          const post = (headers: Record<string, string>) => fetch(server.url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
          assert.equal((await post({})).status, 401, 'no token');
          assert.equal((await post({ authorization: 'Bearer wrong' })).status, 401, 'a wrong token');
          assert.equal((await post({ authorization: server.headers.Authorization, origin: 'https://evil.example' })).status, 401, 'a page in a browser');
          const tools = (await (await post({ authorization: server.headers.Authorization })).json()) as { result: { tools: Array<{ name: string }> } };
          // On macOS the run browses (R-046): the dev server's tool, and the browser's own server beside it.
          assert.deepEqual(tools.result.tools.map((t) => t.name), process.platform === 'darwin' ? ['approve', 'dev_server', 'send_screenshot'] : ['approve']);
          assert.equal(!!(check!.mcp!.mcpServers as Record<string, unknown>).browser, process.platform === 'darwin');

          // Deny stops that action: the fake writes nothing and commits nothing, so the run has no work to push.
          await unthrottle();
          const denied = await startAsking();
          await reply(await nextQuestion(1), 'deny');
          await denied.handled;
          assert.deepEqual((await decisions()).at(-1)!.decision, { behavior: 'deny', message: 'Your owner said no. Do not try it again: do something else, or stop.' });
          assert.equal((await reportsOn(denied.id)).at(-1), 'I could not run K-7: I left no new commits.');

          // A question left 7 days ends the run: it fails with the reason, closes its draft, and keeps the branch.
          await unthrottle();
          const forgotten = await startAsking();
          await nextQuestion(2);
          const draftsBefore = (await pullsNow()).length;
          await plugin.pollPulls(Date.now() + 8 * DAY);
          await forgotten.handled;
          assert.equal((await reportsOn(forgotten.id)).at(-1), 'I could not run K-7: No answer came within 7 days.');
          assert.equal((await pullsNow()).at(-1)!.closed, 'The agent stopped: No answer came within 7 days. The branch stays.');
          assert.equal((await pullsNow()).length, draftsBefore, 'the draft it opened is the one closed');
          await waitFor('the owner is told it expired', async () => {
            heardPermits.push(...(await phone.sync()).filter((m) => m.senderId === agent.id && m.content?.permit));
            return heardPermits.some((m) => m.content!.permit!.kind === 'settled' && m.content!.permit!.outcome === 'expired');
          });
          // A request from a page that sets no flag asks nothing, and the process refuses what it would ask, as before.
          await unthrottle();
          const before = (await turns()).length;
          const refused = (await ask(w.alice, { hash: await briefNow() })).id;
          await (await checkIn()).handled;
          const [plain] = (await turns()).slice(before);
          assert.ok(plain!.args.includes('--permission-prompts') && !plain!.args.includes('--mcp-config'), 'no question can be asked, so it refuses');
          assert.equal((await reportsOn(refused)).length > 0, true);
        } finally {
          restoreAsk();
        }
        // Two runs never hold the same file at once (docs/roadmap/new-overlap-gate.md). Carol owns K-12,
        // whose draft #2, which scripts/claim.sh opened, holds sum.test.js by its Touches line. Only the
        // plugin's drafts still open count from here, each with its body and the files it changes.
        const fakeGh = async () => JSON.parse(await fs.readFile(ghState, 'utf8'));
        const setGh = async (change: object) => fs.writeFile(ghState, JSON.stringify({ ...(await fakeGh()), ...change }));
        const settle = async () => setGh({ pulls: (await fakeGh()).pulls.map((p: FakePull) => ({ ...p, gone: true })) });
        const k12Pull = { number: 2, title: 'K-12: Totals', headRefName: 'claude/k12-totals', body: 'Claims K-12.\n\nTouches: sum.test.js', files: [] };
        await sh('git', ['--git-dir', origin, 'branch', 'claude/k12-totals', 'main']);
        await settle();
        await setGh({ files: true, open: [k12Pull] });
        const k12 = newKeyId().slice(0, 11);
        await w.carol.sync();
        await w.carol.editSection(roadmapDoc, k12, () => ({ text: '### K-12: Totals\n\nStatus: Running: acme/app#2.', pos: 12, opened: true }));
        // The check names the files it will change; its work then commits sum.test.js.
        const runTouching = async (...touches: string[]) => {
          await unthrottle();
          const run = await runK7({ FAKE_CLAUDE_CHECK: JSON.stringify({ outcome: 'holds', note: '', checked: 'Read K-7 and sum.js on main.', touches }) });
          const pulls = await pullsNow();
          return { ...run, pull: pulls.at(-1)!, number: pulls.length };
        };
        const choose = async (who: AgentClient, choice: string) => {
          await who.sync();
          await who.editSection(roadmapDoc, section, (now) => ({ text: `${now!.text}\n\nOverlap with K-12: ${choice}`, pos: now!.pos }));
        };
        const overlapSaid = 'K-7 waits for K-12, which changes sum.test.js too. The owners of the two cards choose on K-7: wait for K-12, stack on it, or fold into it.';
        const bodyOf = (pull: FakePull) => (pull.edited as { body?: string } | undefined)?.body ?? pull.body;

        // The second of two cards that touch one file waits before its work, and its owner hears why.
        const turnsAtWait = (await turns()).length;
        const waited = await runTouching('sum.test.js');
        assert.deepEqual(waited.said.map((r) => [r.run.kind, r.run.waits, r.text]), [['claimed', undefined, 'I am on K-7: Sums are off by one'], ['overlap', 'K-12', overlapSaid]]);
        assert.equal((await turns()).length, turnsAtWait + 1, 'only the check ran: the work did not start');
        assert.match(waited.pull.body, /^Claims K-7\. Checked .*\n\nTouches: sum\.test\.js$/, 'the draft says what it will touch');
        assert.deepEqual(await log(waited.pull.head), ['chore: Claim K-7'], 'only the claim is pushed');
        // Wait changes nothing while K-12's draft holds the file; once it lets go, the work starts with its own brief.
        await choose(w.alice, 'wait');
        await plugin.pollPulls();
        assert.equal((await turns()).length, turnsAtWait + 1, 'it still waits');
        await setGh({ open: [] });
        await plugin.pollPulls();
        const [waitCheck, waitWork] = (await turns()).slice(turnsAtWait);
        assert.equal(waitWork!.session, waitCheck!.session, 'the work resumes the check');
        assert.ok(waitWork!.input.startsWith('K-12 no longer holds the files you need') && waitWork!.input.includes(`acme/app#${waited.number} claims it`), 'with the brief the work would have started with');
        assert.deepEqual((await reports(waited.id)).map((r) => r.text), ['I am back on K-7: K-12 no longer holds its files', `I finished K-7 on ${waited.pull.head} (acme/app#${waited.number}). Sums add up now.`]);

        // Stack, from Carol, who owns K-12: the draft names #2, which takes it out of the rule, and the work goes on on K-12's branch.
        await settle();
        await setGh({ open: [k12Pull] });
        const stacked = await runTouching('sum.test.js');
        assert.equal(stacked.said.at(-1)!.text, overlapSaid);
        await choose(w.carol, 'stack');
        await plugin.pollPulls();
        const stackTurn = (await turns()).at(-1)!;
        assert.ok(stackTurn.input.startsWith('Your card\'s owners stacked it on K-12: `origin/claude/k12-totals` is fetched.'), 'the brief says to merge the branch under it');
        assert.equal((await git(project, 'rev-parse', 'refs/remotes/origin/claude/k12-totals')).stdout.trim(), (await sh('git', ['--git-dir', origin, 'rev-parse', 'claude/k12-totals'])).stdout.trim(), 'which is in the folder');
        assert.equal((await git(project, 'symbolic-ref', 'refs/remotes/origin/HEAD')).stdout.trim(), 'refs/remotes/origin/main', 'and the default branch stays main');
        assert.deepEqual((await reports(stacked.id)).map((r) => r.text), ['I am back on K-7: its owners stacked it on K-12', `I finished K-7 on ${stacked.pull.head} (acme/app#${stacked.number}). Sums add up now.`]);
        assert.equal(bodyOf((await pullsNow()).at(-1)!), 'Sums were off by one.\n\nStacked on #2', 'the work\'s body keeps naming the draft under it');

        // Fold, from Alice: the run ends, its draft closes and its branch stays. Carol's stack from before the wait does not count.
        await settle();
        const folded = await runTouching('sum.test.js');
        assert.equal(folded.said.at(-1)!.run.kind, 'overlap');
        await plugin.pollPulls();
        assert.deepEqual(await reports(folded.id), [], 'a choice from before the wait chooses nothing');
        await choose(w.alice, 'fold');
        await plugin.pollPulls();
        assert.deepEqual((await reports(folded.id)).map((r) => r.text), ['I could not run K-7: Its owners folded K-7 into K-12.']);
        assert.equal((await pullsNow()).at(-1)!.closed, 'The agent stopped: Its owners folded K-7 into K-12. The branch stays.');

        // A run that grows into a held file pauses before it pushes more, and pushes once the file is free.
        await settle();
        const grown = await runTouching('README.md');
        assert.deepEqual(grown.said.map((r) => [r.run.kind, r.run.waits, r.text]), [['claimed', undefined, 'I am on K-7: Sums are off by one'], ['overlap', 'K-12', overlapSaid]]);
        assert.deepEqual(await log(grown.pull.head), ['chore: Claim K-7'], 'its work is not pushed');
        await setGh({ open: [] });
        await plugin.pollPulls();
        assert.ok((await turns()).at(-1)!.input.includes('Your work is committed but not pushed.'));
        assert.deepEqual(await log(grown.pull.head), ['Change sum.test.js', 'Change sum.test.js', 'chore: Claim K-7'], 'both turns of work are pushed');

        // Two cards with no shared file run at once.
        await settle();
        await setGh({ open: [{ ...k12Pull, body: 'Claims K-12.\n\nTouches: lib/' }] });
        const apart = await runTouching('sum.test.js');
        assert.deepEqual(apart.said.map((r) => r.run.kind), ['claimed', 'done']);

        // Ending the sessions ends the processes, and the token files go with them.
        await Promise.all(options.harnesses.map((h) => h.end?.()));
        assert.deepEqual(await fs.readdir(path.join(dataDir, 'laptop', 'approve')), []);
      } finally {
        restore();
      }
    },
  );
}
