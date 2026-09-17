# Free title — 2026-09-16

Board & game now has an opt-in **Free title** switch and a segmented GM / IM / NM / FM / CM selector. The selection is stored independently of the switch; the default is off with GM selected. This changes the local page display only.

The content renderer identifies the signed-in account exclusively through the sidebar's profile activity link. Every player block must have an exact, case-insensitive username match; member links, when present, must agree. Missing, malformed, external, or conflicting sidebar links prevent decoration. Position and board color do not establish ownership.

Supported placements are the first child of small and large player blocks (including game cards, history rows, and popover taglines), the own-profile badges section, and a popover title badge below ratings. The profile card sits immediately after an existing day-streak badge, or first when none exists. Both the entire profile card and the abbreviated title chips link to `https://www.chess.com/members/titled-players`. Profile badges additionally require agreement between the member URL and the large profile block. Popover taglines and avatar member links must agree before either popover decoration is allowed.

Mutation observation handles newly inserted cards, recycled popovers, identity changes, and site rerenders. Route checks also cover URL-only navigation. Disabling the setting, disabling the extension, losing identity, or disposing content removes injected elements and restores existing native titles without rewriting their markup. Unrelated badges remain intact.

## Validation

- Renderer: 12 tests passed, covering own/opponent cards, white/black cards, exact matching, contradictory links, profile ownership, recycled popovers, genuine-title restoration, account changes, and invalid sidebar identities.
- Settings storage: 30 tests passed, including defaults, invalid values, and all five persisted selections.
- Settings panel: 37 tests passed, including ordering, segmented labels, disabled state, updates, and retained selection.
- Content integration: 44 tests passed, including settings propagation and cleanup.
- Session live settings: 2 tests passed, including non-playing profile pages and global disable.
- Production build and release packaging passed.

Native Chrome visual validation was not performed. The focused checks use simulated DOM fixtures based on the supplied Chess.com markup.
