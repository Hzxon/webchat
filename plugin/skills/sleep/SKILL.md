---
name: sleep
description: Puts the WebChat agent to sleep on this laptop, so it takes no cards and answers no questions until the user wakes it with /webchat:wake.
disable-model-invocation: true
---

# Putting the WebChat agent to sleep

The agent runs from the `webchat-agent` program, which `webchat-agent setup` installs. Asleep, it
starts nothing new until the user wakes it. The cards and questions it runs finish first.

1. Run `webchat-agent sleep`.
2. Tell the user what it printed, in plain words. The user may not be a programmer.
3. If `webchat-agent` is not found, tell the user to run `webchat-agent setup`, which needs an
   account with administrator rights.
