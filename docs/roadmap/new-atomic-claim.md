### K: Two claims seconds apart both get the item

Status: Open. Raised 2026-11-17 from the parallel work design.

`scripts/claim.sh` lists the open pull requests at line 91 and opens its draft at line 134. Two
sessions that claim one item between those lines both pass the check and both open a draft. The
plugin has the same gap: it looks for a claim with `openPulls` (`agent/plugin.ts:551`) and opens
its draft later. With one person's sessions this is rare. With several teammates who each run
several cards it is not. Decision numbers had the same race, and D-076 closed it with a tag the
remote creates only once.

Done when the claim pushes `refs/tags/claim/<item>` before the draft, in the script and in the
plugin, and a second claim fails with the name of the first; the tag goes when the pull request
merges or closes, so an abandoned item frees up (step 6 in AGENTS.md); and a test starts two claims
at once and shows that one gets the item.
