# Inactive-game controls — 2026-09-16

The supplied `.game-icons-container-component` toolbar contains Share, Add to Collection and a live-game Self Analysis link. On a live-game or lobby URL, that rendered combination now takes precedence over a cached `mode: playing`, player colour, running clock or old position. It is classified as read-only (`live-spectate` internally), with the same hands-off behavior the owner requested for the lobby.

The adapter emits page-kind changes independently of position changes. Toolbar insertion, removal, child replacement and relevant visibility/identity attributes trigger detection even when the board, URL and clocks remain unchanged. Hidden copies do not count; scrolling a rendered toolbar out of the viewport does not make its game active. Glyph identities support translated button labels.

Content releases mouse and keyboard ownership and hides the virtual cursor through the existing unlock path. The worker cancels analysis/execution, disarms even an arm still awaiting attachment, releases any held mouse button, clears move highlights and cancels queued new-game actions. It rejects stale arm attempts on the inactive page. Auto-move preference is retained for a subsequent playable game. Completed move-log ratings stay visible.

Validation: 187 passing tests across 12 files covering the adapter, content input gate, new-game/resign/rematch controls, WebGL and publication invariants, lobby transitions, cold start, the master switch, preference-write races and auto-queue. New regressions use the exact supplied HTML and cover unchanged-board arrival, hidden and removed controls, offscreen controls, translated labels, stale ownership grants, initial inactive attachment, running clocks, a drag already holding the button, and returning to a playable game. Focused lint and whitespace checks pass. Production build and ZIP integrity are checked for release.

No personal Chrome or live-game interaction was performed. Changes remain uncommitted.

## Follow-up: preserve end-screen matchmaking

The toolbar plus a usable New Game control (including the end-screen popup), or active matchmaking UI, now identifies `live-postgame`. This admits the native queue gesture only when the worker reports auto-queue enabled; board move execution remains disarmed. The debugger connection and pending auto-queue are retained. Queue eligibility is separate from permission to play moves, and the adapter can discover the requeue control despite a stale playing bridge state.

When a finished game's toolbar arrives before its requeue popup, the queue waits without issuing input. It retains the existing deadline until it is due, then uses its normal admission polling. A late popup resumes that same queue rather than counting the game or sampling the delay again. Turning auto-queue off removes post-game input permission and cancels the queue. Ordinary read-only views still release mouse/keyboard ownership; move-log ratings remain visible.

The shared Miss artwork background is now exactly `#fb7766`, including the move-list text color derived from it.

Follow-up validation: 153 passing tests across queue behavior, adapter detection, content ownership, lobby/drag release, the master switch, move-list rendering and board effects. Explicit regressions cover both game-end/control arrival orders, delayed popup admission, auto-queue disabled, native target discovery with stale bridge state, and queue-only content ownership.
