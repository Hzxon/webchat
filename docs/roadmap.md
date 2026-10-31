# Roadmap

This file lists the work that is planned or set aside, the known issues, and the questions that
are still open. Read it before you start new work. When someone asks what to do next, start with
the items under "Next". The decisions these items build on are in [decisions.md](decisions.md).

## How to use this file

- Features and other work are R-items, known issues are K-items, and open questions are Q-items.
  Numbers never change and are never reused.
- Each item says why it matters, what it covers, and when it is done. Write open questions under
  the item they belong to.
- Status values: Next, Planned, Idea, Blocked, In progress, Done, and Dropped.
- When you start an item, set it to "In progress" and name your branch. When it reaches main, move
  it to "Done" with its pull request number, and record its decisions in `decisions.md`.
- When you drop an item, keep it, set it to "Dropped", and say why.

## Next

### R-001: Task board for projects, like Jira

Status: Next. The owner set it aside on 2026-11-01 so that projects could ship first.

Why: students track who does what by when, and today that lives in other apps.

Scope:

- A board for each project with the columns To do, In progress and Done.
- Tasks with a title, notes, an assignee from the project's members, a due date and a priority.
  Tasks move between the columns.
- A "My tasks" view across all projects, sorted by due date.
- Turning a channel message into a task, with the task filled in from the message.

Constraints:

- Titles and notes are encrypted and signed in the browser, like messages (D-014, D-016).
- Status, assignee, due date and priority may be visible to the server. If they are, list them in
  the README and in D-020.
- Every task change must change the sync fingerprint, or pages will not see it (D-021).
- Schema changes go in migration 5 (D-010).

Done when: typecheck, tests and build pass. Tests prove that the database holds no task text in
plain and that only project members can read or change tasks. The board has been tried in a browser
with two accounts (D-037).

Open questions:

- Which key encrypts tasks: the #general channel's key, or a new key for each project, shared the
  same way as channel keys?
- Should due dates send reminders? That needs R-010.
- Sprints, epics and story points stay out unless students ask for them.

## Planned

### R-002: Rotate keys on removal, and let people leave

Status: Planned. Owners can remove people since #4, without rotation (D-039).

Why: people removed from a project or group keep its keys (D-039). Nobody can leave on their own,
and an owner cannot hand a project or group to someone else.

Scope:

- On removal, every chat in the project or group gets a new key, wrapped for the people who stay.
  Pages keep the old keys to read old messages, so a chat can have more than one key id. The signed
  header already names the key id (D-016).
- Leaving. A page accepts a copy of a key only from a current member (D-015), and a person who
  leaves cannot wrap copies for the others. Someone who stays has to make new copies, so leaving may
  wait for another member's browser.
- Handing a project or group to another member, so that its owner can leave too.

Done when: a removed member cannot decrypt anything sent after the removal, and a test proves it.
Members can leave, and an owner can hand over.

Open question: when someone joins after a rotation, do they get the old keys too, so they can read
the history (D-026)?

### R-003: Add people to groups

Status: Planned.

Why: a group cannot take new members after it is created (D-039), so a late teammate needs a new
group, and a person removed by mistake cannot come back.

Scope: reuse the project mechanism. A member's browser wraps the group's key for the newcomer
(D-026).

Open question: do newcomers to a group read its history, as they do in projects?

### R-005: Photos and files

Status: Planned.

Why: students share drafts, slides and screenshots. WebChat sends text only.

Scope: the browser encrypts each file with a key of its own and uploads only the ciphertext. The
message carries the file's address and key inside its envelope.

Constraints: Vercel Functions accept request bodies of at most 4.5 MB, so files go from the browser
straight to a storage service, such as Vercel Blob with private access. The Content Security Policy
allows connections only to the site itself, so it must also allow the storage service (D-009).

## Ideas

### R-004: Private channels

Status: Idea.

Every project member is in every channel (D-024). A private channel needs its own member list, keys
wrapped only for that list, and a new rule for adding people to a project without adding them to
every channel (D-025).

### R-006: Mentions

Status: Idea.

An @name in a channel would notify the person mentioned. The server cannot read the text, so it
cannot find mentions itself. Either the page sends the mentioned people's ids as signed metadata
the server can see, or each recipient's page or service worker looks for mentions after decrypting.
The first option shows the server who was mentioned, which D-020 would have to list.

### R-007: Edit and delete messages

Status: Idea.

Model them like reactions: new kinds of events that point at a message, with the kind signed
(D-016, D-030). Deleting can only hide a message in members' pages. Anyone who already loaded it
keeps their copy.

### R-008: Search

Status: Idea.

The server cannot search encrypted text. Search has to run in the page over decrypted messages, so
the history must be loaded or kept on the device, for example in IndexedDB.

### R-009: Threads

Status: Idea.

Replies quote a message (D-029) but do not open a side conversation like a Slack thread. Find out
whether quotes are enough for students before building threads.

### R-010: Deadline reminders

Status: Idea. Depends on R-001.

Reminders need a scheduler, because Vercel Hobby cron jobs run once a day. Reuse the `CRON_SECRET`
approach of the GitHub connector (D-034). A reminder that shows a task's title must be decrypted on
the device, like a message (D-017).

### R-011: Typing indicators and instant presence

Status: Blocked on Q-1.

Presence comes from check-ins: a person counts as online for a minute after a check-in from a tab
they were looking at. A tab open in the background does not keep them online. Typing indicators need
a faster channel than check-ins (D-004).

### R-012: Voice and video calls

Status: Idea, out of scope for now.

Calls need WebRTC and TURN servers, which cost money (D-003).

## Known issues

### K-1: Old tabs show reactions as messages they cannot decrypt

A tab that still runs the app from before #2 shows each reaction as "could not be decrypted" until
it reloads. A version check that reloads tabs after a deploy would fix this one and future format
changes.

### K-2: Dialogs open with the focus on the close button

Fields marked `autoFocus` inside a dialog do not get the focus, so typing goes nowhere until the
user clicks the field. This was seen in the New channel dialog on 2026-11-01. The likely cause, not
yet confirmed: `Dialog` in `client/src/components/Dialog.tsx` calls `showModal()` after React has
focused the field, and `showModal()` moves the focus to the dialog's first focusable element, its
close button.

### K-3: The README and package.json disagree about Node

The README asks for Node 22.13 or later to run WebChat locally. The `engines` field in
`package.json` pins Node 26.x (D-013). Decide which versions local development supports, and make
both say the same.

### K-4: A group's member names change order

A group's header lists its members in the order the server returns them, and that order changed
during testing on 2026-11-01: "You, Bob, Carol" became "Bob, You" after a removal and new messages.
The likely cause, not yet confirmed: the members query in `conversations()` in `server/db.ts` has no
`ORDER BY`, so Postgres returns the rows in storage order, which an update changes. Ordering the
members, for example by when they joined, would keep the names still.

## Open questions

### Q-1: Should updates move to WebSockets?

Vercel Functions can now hold WebSockets. That could bring instant delivery, typing indicators and
live presence (R-011). D-004 rules out open connections because of the free plan's limits. Measure
what WebSockets cost on the Hobby plan before changing D-004.

### Q-2: One community per deployment?

Everyone on a deployment can see everyone else (D-002). A student in several classes may want
separate spaces. Projects already group people. Is that enough, or should one deployment host
several communities?

## Done

| Work | Where |
| --- | --- |
| Chat with push notifications and urgent alerts | 74d53ff |
| End-to-end encryption | 10ba6d8 |
| Tabs keep to the account they show | b75d690 |
| GitHub pull requests | #1 |
| Projects with channels, replies and reactions | #2 |
| Owners remove members and delete projects and groups | #4 |
