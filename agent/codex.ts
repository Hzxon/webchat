// The plugin's harness adapter for OpenAI's Codex CLI (harness.ts): a `codex exec` for each turn,
// with the message on stdin and its JSONL events on stdout. Codex's sandbox lets the shell read
// every folder, the secret ones among them, so Codex answers questions and takes no cards
// (docs/decisions/new-harness-isolation-proof.md).
import { execFile } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { Harness } from './harness.ts';
import { start, type Final } from './runner.ts';

const exec = promisify(execFile);

/** Why Codex takes no cards, which Settings shows on its row. */
export const CODEX_GAP = 'Codex’s sandbox lets its shell read every folder, your GitHub login among them, so Codex answers questions and takes no cards.';

type Schema = { type?: string; properties?: Record<string, Schema>; required?: string[]; items?: Schema };

/**
 * The schema as OpenAI's strict structured output takes it: every property required, the optional
 * ones nullable, and no others. The answer's nulls are dropped again in `codexResult`.
 */
function strictSchema(schema: Schema): object {
  if (schema.type === 'array' && schema.items) return { ...schema, items: strictSchema(schema.items) };
  if (schema.type !== 'object' || !schema.properties) return schema;
  const required = new Set(schema.required);
  const properties = Object.entries(schema.properties).map(([name, s]) => [name, required.has(name) ? strictSchema(s) : { anyOf: [strictSchema(s), { type: 'null' }] }]);
  return { ...schema, properties: Object.fromEntries(properties), required: Object.keys(schema.properties), additionalProperties: false };
}

/**
 * One turn's arguments. The owner's config.toml, execpolicy rules and hooks stay out, as for Claude
 * Code (D-115). The shell writes only the turn's folder, reaches no network and gets only the core
 * environment variables, none of the owner's tokens. Options go before `resume`, which takes the
 * thread id; `-` reads the message from stdin.
 */
function codexArgs({ schema, thread }: { schema: string; thread?: string }) {
  return [
    'exec',
    '--json',
    '--output-schema',
    schema,
    '--sandbox',
    'workspace-write',
    '--skip-git-repo-check',
    '--ignore-user-config',
    '--ignore-rules',
    '-c',
    'approval_policy="never"',
    '-c',
    'shell_environment_policy.inherit="core"',
    '-c',
    'features.hooks=false',
    ...(thread ? ['resume', thread] : []),
    '-',
  ];
}

/** Reads Codex's JSONL events: the thread it started, its last message, and how the turn ended. */
function codexResult() {
  let thread: string | undefined;
  let text = '';
  return (line: string): Final | undefined => {
    let event: { type?: string; thread_id?: string; item?: { type?: string; text?: string }; message?: string; error?: { message?: string } } | null;
    try {
      event = JSON.parse(line) as typeof event;
    } catch {
      return undefined;
    }
    if (event?.type === 'thread.started') thread = event.thread_id;
    if (event?.type === 'item.completed' && event.item?.type === 'agent_message') text = event.item.text ?? '';
    if (event?.type === 'turn.failed' || event?.type === 'error') return { text: event.error?.message ?? event.message ?? '', error: true, session: thread };
    if (event?.type !== 'turn.completed') return undefined;
    try {
      return { text, error: false, session: thread, answer: JSON.parse(text, (_key, value: unknown) => (value === null ? undefined : value)) as unknown };
    } catch {
      return { text, error: true, session: thread };
    }
  };
}

/**
 * The adapter: turns in `program`. Codex names its own threads, so the thread of each of the
 * plugin's sessions is kept in `dataDir`, where a restart still finds it.
 */
export function codexHarness(program: string, dataDir: string): Harness {
  const home = process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex');
  const file = path.join(dataDir, 'codex-threads.json');
  let threads: Record<string, string> | undefined;
  return {
    name: 'Codex',
    async refusal(dir, purpose) {
      if (!program) return 'I cannot find Codex on this laptop.';
      if (dir && purpose !== 'answers') return CODEX_GAP;
    },
    // Codex reads both on every turn, whatever the owner chose: its config has no switch for them.
    offers: () => ({ instructions: path.join(home, 'AGENTS.md'), skills: path.join(os.homedir(), '.agents', 'skills'), knobs: [] }),
    async found() {
      if (!program) return {};
      const [version, signedIn] = await Promise.all([
        exec(program, ['--version'], { timeout: 10_000 }).then((r) => /\d[\w.-]*/.exec(r.stdout)?.[0], () => undefined),
        // It exits 0 when credentials are present.
        exec(program, ['login', 'status'], { timeout: 10_000 }).then(() => true, () => false),
      ]);
      return { version, signedIn };
    },
    async apply() {},
    async turn({ cwd, session, resume, message, schema, signal }) {
      threads ??= existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as Record<string, string>) : {};
      const schemaFile = path.join(os.tmpdir(), 'webchat-codex', `${session}.json`);
      await fs.mkdir(path.dirname(schemaFile), { recursive: true });
      await fs.writeFile(schemaFile, JSON.stringify(strictSchema(schema as Schema)));
      const args = codexArgs({ schema: schemaFile, thread: resume ? threads[session] : undefined });
      const turn = await start(program, args, cwd, signal, codexResult(), message).finally(() => fs.rm(schemaFile, { force: true }));
      if (turn.session && threads[session] !== turn.session) {
        threads[session] = turn.session;
        // At once, so two turns that end together cannot interleave their writes.
        writeFileSync(file, JSON.stringify(threads));
      }
      if (turn.error || !turn.answer) throw new Error(turn.text.trim().slice(0, 500) || 'Codex stopped without an answer.');
      return turn.answer;
    },
  };
}
