#!/bin/sh
# Vercel's Ignored Build Step: exit 0 skips the build, exit 1 runs it.
# A Release Please commit changes only the version and CHANGELOG.md. Nothing
# at runtime reads either, so the build would ship the app the commit before
# it already deployed. See D-058.
case "$VERCEL_GIT_COMMIT_MESSAGE" in
  "chore(main): Release "*) exit 0 ;;
esac
exit 1
