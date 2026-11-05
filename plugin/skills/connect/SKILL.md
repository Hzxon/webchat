---
name: connect
description: Connects the repository this session is open in to WebChat, so the cards its owner hands to the agent run here.
disable-model-invocation: true
---

# Connecting a repository to WebChat

1. Call the webchat `connect` tool once. Claude Code asks the user to approve it.
2. Call `status` and tell the user its first line.
3. If `status` says the session is not paired, tell the user how pairing works, as the status text
   says.

Do not call `disconnect` unless the user asks to disconnect WebChat.
