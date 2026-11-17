// Types shared by the server, the web client, and the service worker.
// The file also holds the few values and checks that more than one of them must agree on: LIMITS,
// the channel name rules, the build header and the test for Apple's push service.
// They live with the types so that each side imports one file and none can drift from the others.
// They are small and import nothing outside this folder, so they add little code to the page and the service worker.
//
// Each domain has its own file in `types/`, so a change to one touches only that file. This file
// re-exports them all, so every importer keeps its import of `shared/types`. Add a type to the file
// of its domain, and a file for a new domain with a line here.
export * from './types/account.js';
export * from './types/agent.js';
export * from './types/chat.js';
export * from './types/docs.js';
export * from './types/files.js';
export * from './types/github.js';
export * from './types/limits.js';
export * from './types/push.js';
export * from './types/runs.js';
