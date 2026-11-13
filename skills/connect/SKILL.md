---
name: connect
description: Asks the WebChat agent's owner to let it work in the repository this session is open in, a copy the user already has, instead of cloning its own.
disable-model-invocation: true
---

# Connecting a repository to WebChat

This plugin is its last release and hosts nothing. The agent runs from the `webchat-agent` program
on the laptop, which `webchat-agent setup` installs. Connecting points the agent at a copy the user
already has, and the user approves it in WebChat.

1. Run `webchat-agent connect` in the repository this session is open in.
2. Tell the user what it printed, in plain words. The user may not be a programmer.
3. If `webchat-agent` is not found, tell the user to run the install line that WebChat's Connect
   coding agent dialog shows, or `webchat-agent setup` if it is installed. It needs an account with
   administrator rights.
