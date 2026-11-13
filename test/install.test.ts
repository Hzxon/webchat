// agent/install.sh against a release in a folder: it installs only a file whose checksum matches
// (docs/roadmap/new-agent-build.md).
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { gzipSync } from 'node:zlib';
import { beforeEach, test } from 'node:test';

const name = `webchat-agent-${process.platform}-${process.arch}.gz`;
const program = '#!/bin/sh\nif [ "$1" = --version ]; then echo 9.9.9; else echo "handed over: $*"; fi\n';
let release: string;
let home: string;

async function install() {
  const script = (await fs.readFile('agent/install.sh', 'utf8')).replaceAll('@BASE@', pathToFileURL(release).href);
  await fs.writeFile(path.join(release, 'install.sh'), script);
  return promisify(execFile)('sh', [path.join(release, 'install.sh'), 'the-code'], { env: { PATH: process.env.PATH, HOME: home } });
}

beforeEach(async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'webchat-install-'));
  release = path.join(root, 'release');
  home = path.join(root, 'home');
  await fs.mkdir(release);
  const packed = gzipSync(program);
  await fs.writeFile(path.join(release, name), packed);
  await fs.writeFile(path.join(release, `${name}.sha256`), `${createHash('sha256').update(packed).digest('hex')}  ${name}\n`);
});

test('the installer puts the checked file on the laptop and hands over to setup', async () => {
  const { stdout } = await install();
  assert.match(stdout, /Installed webchat-agent 9\.9\.9/);
  assert.match(stdout, /handed over: setup the-code/);
  assert.equal(await fs.readFile(path.join(home, '.local/bin/webchat-agent'), 'utf8'), program);
});

test('the installer installs nothing when a byte changed', async () => {
  await fs.writeFile(path.join(release, name), gzipSync(program.replace('9.9.9', '9.9.8')));
  await assert.rejects(install(), /does not match the release's checksum/);
  assert.equal(existsSync(path.join(home, '.local/bin/webchat-agent')), false);
});
