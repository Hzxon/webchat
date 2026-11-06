#!/bin/sh
# Claims a roadmap item before any code is written, so two sessions never fix
# the same one. See D-062 and "How to work here" in AGENTS.md.
#
# Usage, on a new branch cut from main whose name carries the item:
#   scripts/claim.sh -c "<what you checked>" K-12 "fix(push): Drop a subscription with bad keys"
#   scripts/claim.sh -c "<what you checked>" K-14 "fix(auth): Count only failed sign-ins" D-068
#
# -c says, in a line, why the item still holds: what was read on main and in
# decisions.md, and what overlap was looked for (D-107). It goes into the draft.
# The script refuses an item with no entry, one whose status says Done, Fixed
# or Dropped, or one in the Done table, and prints the decisions and entries
# that name the item, for the check. It refuses when an open pull request names
# the item, or the decision number given as the third argument, warns about a
# remote branch that names the item, then pushes an empty commit and opens a
# draft pull request whose body names both. Later commits go to the same
# branch. See D-062, D-076 and D-107.
set -eu

usage='usage: scripts/claim.sh -c "<what you checked>" <K-12|R-005|Q-1> "<pull request title>" [D-077]'
checked=
while getopts c: opt; do
  case "$opt" in
    c) checked=$OPTARG ;;
    *) echo "$usage" >&2; exit 1 ;;
  esac
done
shift $((OPTIND - 1))
item=${1:?$usage}
title=${2:?$usage}
decision=${3:-}
if [ -z "$checked" ]; then
  echo "Say with -c what you checked: that the item is still open on main, that no decision since settles it, and that no other entry or pull request covers it (D-107)." >&2
  exit 1
fi
case "$item" in
  [KRQ]-[0-9]|[KRQ]-[0-9][0-9]|[KRQ]-[0-9][0-9][0-9]) ;;
  *) echo "The item is a roadmap id such as K-12, R-005 or Q-1." >&2; exit 1 ;;
esac
case "$decision" in
  ''|D-[0-9][0-9][0-9]) ;;
  *) echo "The decision is a number such as D-077, or left out." >&2; exit 1 ;;
esac
# The entry is in docs/roadmap.md or, until housekeeping folds it in, docs/roadmap/<id>.md (D-106).
entry=$(grep -l "^### $item:" docs/roadmap.md "docs/roadmap/$item.md" 2>/dev/null | head -1 || true)
if [ -z "$entry" ]; then
  echo "$item has no entry in docs/roadmap.md or docs/roadmap/$item.md. Add one first, or pick an item that exists." >&2
  exit 1
fi
status=$(sed -n "/^### $item:/,/^### /p" "$entry" | grep -m1 '^Status:' || true)
case "$status" in
  "Status: Done"*|"Status: Fixed"*|"Status: Dropped"*)
    echo "$item is finished: \"$status\". Pick another item." >&2; exit 1 ;;
esac
if grep -q "^| $item\b" docs/roadmap.md; then
  echo "$item is in the Done table of docs/roadmap.md. Pick another item." >&2
  exit 1
fi
echo "$item: $status"
echo "Named by these decisions and entries; make sure none settles or covers it (D-107):"
grep -n "\b$item\b" docs/decisions.md docs/roadmap.md docs/roadmap/*.md 2>/dev/null | grep -v "^$entry:[0-9]*:### $item:" || echo "  none"
branch=$(git rev-parse --abbrev-ref HEAD)
# K-12 matches branch names such as claude/k12-bad-push-keys and claude/k-12-keys.
slug=$(printf '%s' "$item" | tr 'A-Z' 'a-z' | sed 's/-/-\\{0,1\\}/')

case "$branch" in
  main) echo "Cut a branch from main first; main is never pushed to directly." >&2; exit 1 ;;
esac
if ! printf '%s' "$branch" | grep -qi -- "$slug"; then
  echo "Name the branch after the item, for example claude/$(printf '%s' "$item" | tr 'A-Z' 'a-z' | tr -d -)-short-title, so other claims can find it." >&2
  exit 1
fi

git fetch -q origin
# Open pull requests whose title or body names the id, as a whole word.
named_by_open_pr() {
  gh pr list --state open --json number,title,body \
    --jq ".[] | select((.title + \" \" + (.body // \"\")) | test(\"\\\\b$1\\\\b\"; \"i\")) | \"#\\(.number) \\(.title)\""
}
taken=$(named_by_open_pr "$item")
if [ -n "$taken" ]; then
  echo "$item is already claimed by an open pull request:" >&2
  echo "$taken" >&2
  echo "Pick another item, or ask its owner." >&2
  exit 1
fi
if [ -n "$decision" ]; then
  if grep -q "^### $decision:" docs/decisions.md; then
    echo "$decision is already in docs/decisions.md on this branch. Take the next free number." >&2
    exit 1
  fi
  reserved=$(named_by_open_pr "$decision")
  if [ -n "$reserved" ]; then
    echo "$decision is already reserved by an open pull request:" >&2
    echo "$reserved" >&2
    echo "Take the next free number." >&2
    exit 1
  fi
fi
others=$(git ls-remote --heads origin | awk '{print $2}' | sed 's#^refs/heads/##' | grep -i -- "$slug" | grep -vx -- "$branch" || true)
if [ -n "$others" ]; then
  echo "Warning: these remote branches also name $item, with no open pull request. Make sure they are abandoned:" >&2
  echo "$others" >&2
fi

body="Claims $item. Checked $(date +%Y-%m-%d): $checked"
[ -n "$decision" ] && body="$body Reserves $decision."
git commit -q --allow-empty -m "chore: Claim $item"
git push -q -u origin "$branch"
gh pr create --draft --title "$title" --body "$body Work in progress: the diff comes with later commits."
