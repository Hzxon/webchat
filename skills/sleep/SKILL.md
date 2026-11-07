---
name: sleep
description: Puts the WebChat agent to sleep on this laptop, so it takes no cards and answers no questions until the user wakes it with /webchat:wake.
disable-model-invocation: true
---

# Putting the WebChat agent to sleep

The agent serves from any open Claude Code window on this laptop. Asleep, it serves from none of
them, new ones included, until the user types /webchat:wake. The cards and questions it runs
finish first.

1. Call the webchat `sleep` tool once.
2. Tell the user what it answered, in plain words. The user may not be a programmer.
