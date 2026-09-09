# sliced.sh

Manifest V3 chess assistant for chess.com and lichess — the sliced.gg extension, v2.

- **[CLAUDE.md](CLAUDE.md)** — commands, conventions and the gotchas that bite. Start here.
- **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)** — the shape of the system.
- **[docs/DEVELOPMENT.md](docs/DEVELOPMENT.md)** — build, load, test, release, and the
  licensing obligations that shipping a build triggers.
- **[docs/qa-checklist.md](docs/qa-checklist.md)** — everything only a real browser can answer.
- **[docs/third-party.md](docs/third-party.md)** — third-party notices (generated; do not edit).

```sh
bun install
bun run check          # lint + typecheck + tests
bun run build --dev    # load dist/ unpacked at chrome://extensions
```

The full implementation guide this was built from is
`docs/superpowers/plans/2026-09-03-sliced-v2-implementation-guide-v2.md`.
