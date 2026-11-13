#!/bin/sh
# Vercel's Ignored Build Step: exit 0 skips the build, exit 1 runs it. See
# D-058. A Release Please commit builds, since it changes package.json's
# version, which GET /api/config names (docs/decisions/agent-install.md).
# Commits that change only the docs, the tests, the CI, these scripts, or
# the coding agent and its Claude Code plugin, which run on people's own
# machines, since the last deployment would ship the same app again, and
# every open tab would check the new build for nothing (K-36). When the last
# deployment's commit is unknown or not in Vercel's shallow clone, git
# fails and the build runs.
if [ -n "${VERCEL_GIT_PREVIOUS_SHA:-}" ] &&
  git diff --quiet "$VERCEL_GIT_PREVIOUS_SHA" HEAD -- . ':!docs' ':!test' ':!.github' ':!scripts' ':!agent' ':!plugin' ':!*.md' 2>/dev/null; then
  exit 0
fi
exit 1
