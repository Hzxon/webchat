---
name: connect
description: Lets the WebChat agent work in the repository this session is open in, a copy the user already has, instead of cloning its own. Also says when cards need GitHub on this laptop.
disable-model-invocation: true
---

# Connecting a repository to WebChat

The agent works without this: one open Claude Code window serves every folder it knows, and it
offers to clone the others from WebChat. Connecting points it at a copy the user already has.

1. Call the webchat `connect` tool once. Claude Code asks the user to approve it.
2. Tell the user what it answered, in plain words. The user may not be a programmer.
3. If the answer says cards need GitHub on this laptop, offer to set that up with them. Install the
   GitHub CLI (`gh`) if it is missing. Then `gh auth login` signs them in through the browser, and
   `gh auth setup-git` lets git use that login. When a command needs the user to type or press
   something, ask them to run it themselves by typing `!` and the command.

Do not call `disconnect` unless the user asks to disconnect WebChat.
