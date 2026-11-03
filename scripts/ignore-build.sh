#!/bin/sh
# Vercel's Ignored Build Step: exit 0 skips the build, exit 1 runs it.
# A Release Please commit changes only the version and CHANGELOG.md. Nothing
# at runtime reads either, so the build would ship the app the commit before
# it already deployed. See D-058.
case "$VERCEL_GIT_COMMIT_MESSAGE" in
  "chore(main): Release "*) exit 0 ;;
esac
# Commits that change only the docs, the tests, the CI or these scripts
# since the last deployment would ship the same app again, and every open
# tab would check the new build for nothing (K-36). When the last
# deployment's commit is unknown or not in Vercel's shallow clone, git
# fails and the build runs.
if [ -n "${VERCEL_GIT_PREVIOUS_SHA:-}" ] &&
  git diff --quiet "$VERCEL_GIT_PREVIOUS_SHA" HEAD -- . ':!docs' ':!test' ':!.github' ':!scripts' ':!*.md' 2>/dev/null; then
  exit 0
fi
exit 1
