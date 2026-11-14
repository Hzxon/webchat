### R: Try the Astryx design system on the sign-in screen

Status: Running in #247.

Why: the client styles every screen by hand in one 3,500-line `styles.css` (D-083). Astryx
(github.com/meta/astryx, MIT, React 19) ships accessible components, themes and dark mode, and
a CLI that coding agents read. Adopting it could shrink our CSS and give agents one reference
for UI work, but it adds `@astryxdesign/core`, a theme and the StyleX runtime to the bundle,
and it may not match the look the owner chose.

What: add `@astryxdesign/core`, one theme and `@astryxdesign/cli` at the same version, run
`astryx init` so agent docs point at it, and rebuild only the sign-in screen (`AuthScreen`)
with Astryx components and a theme set to D-083's colors. No other screen changes.

Done when: a pull request shows the sign-in screen before and after, at desktop width and 375
pixels, light and dark, with the bundle size before and after, so the owner can decide whether
to move more screens, stop, or revert. Signing in and creating an account work as before.
