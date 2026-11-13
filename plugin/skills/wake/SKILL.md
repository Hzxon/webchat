---
name: wake
description: Wakes the WebChat agent that was put to sleep, so it takes cards and answers questions again.
disable-model-invocation: true
---

# Waking the WebChat agent

The agent runs from the `webchat-agent` program, which `webchat-agent setup` installs.

1. Run `webchat-agent wake`.
2. Tell the user what it printed, in plain words. The user may not be a programmer.
3. If `webchat-agent` is not found, tell the user to run `webchat-agent setup`, which needs an
   account with administrator rights.
