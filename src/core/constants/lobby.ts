/**
 * The lobby hold (owner, 2026-09-13): "dont lock the mouse on …/play/online/ (no other url) if
 * both timers are locked at 3:00 or some other time and arent moving — this is because this is
 * the QUEUE screen BEFORE you've queued a game".
 *
 * `/play/online` shows a board with the default time control's clocks before any game has been
 * queued; the page's own game object calls it `playing`, so the adapter reports it as a live game.
 * The worker tells the two apart by the clocks (`src/service/game-session/lobby.ts`).
 */
export const LOBBY = {
	/**
	 * How long both clock readings must stay unchanged, from the first credible reading, before
	 * the lobby is *confirmed* and a hand that was already armed is released. A fresh automatic
	 * arm is withheld from the first reading; this is only the grace before undoing one already in
	 * place, so an auto-queue hop through the lobby that leaves within a second does not release
	 * and re-arm the hand for nothing. A real game's first tick lands well inside it.
	 */
	clockStillMs: 1_500,
} as const;
