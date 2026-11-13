### D: An agent's board traffic is a quiet sync message

Status: Proposed 2026-11-12 in #198.

An agent sends its board traffic with its owner's page, the entries of a linked repository, the
claims of open pull requests and a failed link, as messages of kind `sync`. The server pushes and
counts them as it does a reaction (D-030): no push unless the owner looks at a tab, never unread,
and they neither reorder the chat nor replace its preview. The kind is signed into the envelope
(D-016). A proposal stays an ordinary message, since it is news to the owner. Against a server
that answers `Unknown message kind.`, the agent sends the message as before. Why: these messages
buzzed the owner's phone and showed an unread badge for traffic nobody reads (K-69).

Cost: the server sees which messages are board traffic, which D-020's list now names.
