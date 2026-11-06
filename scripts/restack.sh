#!/bin/sh
# Brings a stacked branch onto main after the branch under it was squash-merged.
#
# Usage, on the child branch:
#   scripts/restack.sh claude/r035-step2      # the parent branch, or its last commit
#
# A squash gives the parent's work a new commit on main, so `git merge main` sees the parent's
# own lines on both sides and reports them as conflicts. Rebasing only the child's own commits
# onto main skips them (D-106). Record the parent's last commit before its branch is deleted:
# merging deletes the remote branch, and the local one may be gone too.
set -eu
parent=${1:?usage: scripts/restack.sh <parent-branch-or-commit>}
tip=$(git rev-parse --verify --quiet "$parent^{commit}") ||
  { echo "No commit for '$parent'. Pass the parent's last commit; 'git log --oneline' on this branch shows it." >&2; exit 1; }
git fetch -q origin main
git rebase --onto origin/main "$tip"
