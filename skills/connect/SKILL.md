---
name: connect
description: Connects the repository this session is open in to WebChat, so its owner can ask the agent about it and hand it cards.
disable-model-invocation: true
---

# Connecting a repository to WebChat

1. Call the webchat `connect` tool once. Claude Code asks the user to approve it.
2. Tell the user what it answered, in plain words. The user may not be a programmer.
3. If the answer says cards need GitHub on this laptop, offer to set that up with them. Install the
   GitHub CLI (`gh`) if it is missing. Then `gh auth login` signs them in through the browser, and
   `gh auth setup-git` lets git use that login. When a command needs the user to type or press
   something, ask them to run it themselves by typing `!` and the command.

Do not call `disconnect` unless the user asks to disconnect WebChat.
