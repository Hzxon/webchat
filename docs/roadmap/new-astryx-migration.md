### R: Move every screen to Astryx

Status: Running in #248.

Why: the owner chose a full migration after the sign-in pilot (docs/roadmap/new-astryx-pilot.md).
One design system replaces the hand-written `styles.css`, and agents build UI from the `astryx`
reference instead of guessing at our classes.

What: in stacked pull requests, one area each. 1: the theme at the app root, Astryx's reset, and
every dialog. 2: the sidebar and app layout. 3: the chat. 4: the board, docs, GitHub and agents
views. 5: delete the CSS nothing uses, and rewrite D-083 for the theme.

Done when: no screen renders an old `styles.css` class that Astryx has a component for, each phase
is checked at desktop width and 375 pixels in light and dark mode, and replies, reactions, urgent
alerts, drafts and the board behave as before.
