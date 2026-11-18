### K: picomatch has a ReDoS advisory with no patched release

Status: Blocked. Found 2026-11-18 by `npm audit` while fixing the zod advisory in #281. Waits for a
picomatch release after 4.0.7.

Why: `npm audit` reports GHSA-fc5q-39xc-vjpf (high): picomatch can take very long on a glob with
repeated single-branch extglobs. Every version up to 4.0.7, the newest, is affected, so no update
or override fixes it. A red audit hides new advisories that do matter.

Scope: picomatch comes in only through devDependencies: `vite` (directly and through
`tinyglobby` and `fdir`) and `@astryxdesign/cli` (through `jscodeshift`). `npm ls picomatch
--omit=dev` is empty, so neither the server nor the client bundle holds it. The patterns come from
our own build config, not from users, so nobody outside can reach it. Dependabot opened no alert.

Fix: when picomatch publishes a patched version, update the lockfile so every path resolves to it.
Do not run `npm audit fix --force`: it downgrades vite to 6.2.7, a breaking change.

Done when: `npm audit` reports no picomatch advisory.
