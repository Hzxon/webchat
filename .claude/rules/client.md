---
paths:
  - "client/src/**"
  - "test/store.test.ts"
  - "test/queue.test.ts"
  - "test/build.test.ts"
  - "test/ios.test.ts"
  - "test/ignoreBuild.test.ts"
---
# The page

Each line is a constraint the code cannot state on its own. The number names the decision in
docs/decisions.md that explains it. Encryption, GitHub and projects have their own files.

- Every API request names the account its tab shows in `x-webchat-user`; on `409 account_changed` the tab reloads (D-008).
- A tab with no push subscription checks in every 3 seconds; a closing tab sends `POST /api/away` (D-007).
- Reload a tab only when the page's `/assets/` files changed, and never while `holdReloadWhile` holds, as it does for an open section editor (K-63); a tab in use waits until hidden or idle for 30 seconds (D-040).
- `client/src/viewport.ts` sets `--visible-height`; it runs only while the chat layout shows and leaves a pinch-zoomed page alone (D-053).
- Every hover style sits behind `@media (hover: hover)`; opening a chat on a touch screen does not focus the message box (D-053).
- The palette is warm neutrals plus one orange accent; success uses `--ok`, never the accent; every corner uses `--radius`; no font loads from a font host; colors and shapes change in `styles.css` only, and `astryxTheme.ts` points Astryx's tokens at those variables rather than at colors of its own (D-083).
- Panels are flat with a 1px line; only dialogs, toasts and the reaction tray cast a shadow (D-083).
- A message alerts only when its id is above the loaded cursor and the user's read pointer, and it is encrypted; the urgent flag counts only when the signature checks out (D-049, D-023, D-078).
- Drafts and unsent messages live in IndexedDB, are removed at sign-out, and a retry keeps the client id (D-051).
- A tab holds a Web Lock while it keeps unsent messages, and takes over only the messages of tabs with no lock (D-051).
- A 2xx with an unparseable body is a failed request in `request` (D-056).
- A chat's sends go through `keyedQueue`; a failed send does not block the ones behind it (D-075).
- A 401 on a check-in or first load ends the browser's push subscription (D-072).
- Every change the page makes to its chats or projects must go through the counted store actions, or a late check-in answer undoes it (D-069).
- `request` aborts when the answer has not started after 60 seconds, using `AbortController`, not `AbortSignal.timeout` (D-077).
- A reply's envelope holds the quoted message id, sender and at most 160 characters of text; when the original is loaded, show it, not the copy (D-029).
- A reaction is a message of kind `reaction`; the newest per person and message wins, an empty emoji removes it; reactions never count as unread, reorder chats or replace the preview (D-030).
- A quote stands for the message at its id only when sender and text match; a reaction signs its target's sender and client id and shows only on a match (D-109).
- History paging goes from the oldest row fetched, not the oldest message shown, and continues while pages hold only reactions (D-030).
- Alerts on iPhones without Web Push go through the Bark app; `client/src/ios.ts` spots iOS before 16.4 (D-054).
- Bark link state is not in the sync fingerprint: the page fetches it once at load on iOS before 16.4 only, the bell dialog writes each answer to the store, and `notificationWarning` in `client/src/banner.ts` hides the warning once a phone registered (D-054, D-004).
- The user's direct chats with their own agents show only in the Coding agents pane, as conversations; a new list of chats leaves them out, and a notification for one opens the pane (D-103).
- While a conversation's turn runs, the pane offers Stop instead of Send, so each answer follows what it answers (D-103).
- The pane lists the user's projects; a question signs its project into the prompt, and one of the project's repositories unless it links none (D-103, D-104).
- A photo shows only from bytes the page decrypted and checked with `fileTypeOf`; any other file is only downloaded, never opened in the page; uploads skip `request`, whose timer would cut them (D-123, D-077).
- Safari before 17 runs Astryx's layers on `@oddbird/popover-polyfill`: keep its layer first in `layers.css`, and style an open layer with `.\:popover-open` too, since `:popover-open` in CSS fails there (D-052).
- `styles.css` loads through `layers.css` in the `app` layer, above Astryx's reset and under its components; a stylesheet imported any other way stays unlayered and restyles every Astryx component (the astryx-migration decision, proposed in #248).
- An Astryx field has no `maxLength` or native `required`: cut the value in `onChange` and check empty fields before a request (the astryx-migration decision, proposed in #248).
- A class on an Astryx component wins only from `overrides.css`, the layer above Astryx's; keep it to states no prop covers (the astryx-migration decision, proposed in #248).
