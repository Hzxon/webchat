import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isRepoName } from '../shared/types.ts';

test('a repository name takes the characters GitHub allows', () => {
  for (const name of ['hzxon/webchat', 'a-b/c.d_e', 'owner/.github', 'owner/..x']) assert.ok(isRepoName(name), name);
});

// The agent joins the name onto its clone folder, so a dot segment would leave that folder.
test('a repository name refuses dot segments', () => {
  for (const name of ['../..', 'owner/..', '../repo', './repo', 'owner/.']) assert.equal(isRepoName(name), false, name);
});
