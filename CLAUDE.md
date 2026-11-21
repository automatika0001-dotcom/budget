# Working rules for this repo

- Never wait or sleep for deploys, builds or CI runs to finish (no sleep loops, no polling of GitHub Actions or Pages) unless the user explicitly asks. Push and report.
- Never use the em dash character in any text, code comments or UI.
- ALWAYS ask before using any browser tool (built-in browser, Chrome, computer use), even just to open or read a page, and wait for an explicit yes every time. An earlier yes does not carry over to a later task or session.
- Version (js/version.js) is a.b.c, for example 1.19.22. Bump it with every pushed change:
  - a: massive update with extreme overhauls. Almost never.
  - b: a feature added, a larger change, or a bunch of smaller updates shipped as one package (reset c to 0).
  - c: fixes and tweaks. Example: adding the liquid sim was a b bump, tweaks to it are c bumps.
