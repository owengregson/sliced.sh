/**
 * Which colour we play and which way round the board faces — two different questions on
 * chess.com. The site's own `getPlayingAs()` / `getOptions().flipped` answer them when the bridge
 * is up; the page's rendering (the bottom player block, else the bottom clock) is the fallback,
 * and the rendering is exactly what a board turned round by hand changes.
 */

import type { Color, PageKind } from "@typedefs/game";
import { type BridgeState, bridgeColor } from "../bridge-protocol";
import { bottomClockColor } from "../clocks";
import { queryFirstElement, querySafe } from "../query";
import { SELECTORS as S } from "../selectors";

/**
 * The colour the page shows at the bottom: the bottom player panel's colour
 * block, else the bottom clock's colour. The live (WebGL) layout's panel
 * carries no colour class — its clocks do (owner's capture, 2026-09-09).
 */
export function bottomColorOf(doc: Document): Color | null {
	const bottom = queryFirstElement(S.playerBottom, doc);
	if (bottom) {
		if (querySafe(bottom, S.bottomColorClass.w)) return "w";
		if (querySafe(bottom, S.bottomColorClass.b)) return "b";
	}
	return bottomClockColor(doc);
}

/** The colour we play; `null` when spectating, on analysis, or before anything is known. */
export function myColourOf(
	state: BridgeState | null,
	pageKind: () => PageKind,
	bottomColor: () => Color | null
): Color | null {
	// The bridge has spoken about the board's mode, so the ladder ends at the site's own
	// `getPlayingAs()`, whatever the mode is *called*.
	//
	// It is the one reading only a **player** has: a spectator's board answers nothing, and so
	// does a board in a mode we cannot read. Both halves matter.
	//   - `"playing"` with a colour is the answer, and with no colour the honest `null` — as
	//     before.
	//   - A mode name we do not hard-code (chess.com is free to rename or add one) no longer
	//     returns `null` on its own: `mayActOn` holds on a null colour with nothing to release it,
	//     so one renamed mode would strand a live game colourless for its whole length. But it
	//     must not reach the *render* either (below), because the bottom of the board is something
	//     a spectator has just as much as a player — that would hand the owner the bottom
	//     player's colour for a game they are only watching.
	//   - `"observing"` / `"analysis"` during a game of our own — the brief's stranding case — is
	//     the same rung: `getPlayingAs()` still names our colour there, and a real spectator's
	//     board still does not.
	if (state?.mode !== undefined) return bridgeColor(state.playingAs);
	// No mode at all: the live page's first second, before the bridge has answered anything, which
	// is the case the DOM ladder below exists for.
	const kind = pageKind();
	if (kind !== "live-game" && kind !== "vs-computer" && kind !== "daily") return null;
	const playing = bridgeColor(state?.playingAs);
	if (playing) return playing;
	// The page shows my colour at the bottom unless the user turned the board round by hand,
	// which it does not report separately: the bottom colour is the best DOM answer there is.
	//
	// And when there is none — the bridge has not answered AND the clocks have not rendered,
	// which is the live page's first second (owner's live test, 2026-09-09) — the answer is
	// `null`, never a guess. `isFlipped()` would have said "white at the bottom" by default and
	// the session would have predicted, highlighted and played the *opponent's* moves; a
	// session that holds until the colour is known predicts nothing instead, which is strictly
	// better. The bridge fills this in a moment later (`getPlayingAs()`); the reading is then
	// republished because `SnapshotPublisher.apply` treats `null → known` on the game it is already
	// following as a change worth delivering — the dedupe key below is the position alone — and
	// `GameSession`'s own feed key carries `myColor` so the republish is not taken for the
	// reconnect replay.
	return bottomColor();
}

/**
 * "Black at the bottom", which is what `geometry.ts` means by `flipped`.
 * chess.com's `getOptions().flipped` means exactly that — measured on live
 * games: white is `playingAs 1 / flipped false`, black is
 * `playingAs 2 / flipped true` — so the bridge value passes straight through
 * (it is NOT "the user flipped it by hand", and combining it with
 * `playingAs` would mirror every square when playing black).
 *
 * Without that flag: the board's own `flipped` class (DOM renderer only — the
 * WebGL board does not carry it even when black is at the bottom), then the
 * colour *we* are playing, whatever supplied it.
 *
 * That last rung is not redundant with the first. `getFEN`, `getPlayingAs` and
 * `getOptions().flipped` are three independent `safe(...)` reads of the same
 * page object in the bridge, so `getOptions()` throwing while `getPlayingAs()`
 * answers leaves the colour known and the flag absent — and since chess.com's
 * `flipped` already folds the colour in (playing black *is* black at the
 * bottom), the colour is the right answer there. Defaulting to white at the
 * bottom instead would mirror every square for the side playing black, for the
 * mark and for the hand alike.
 *
 * `false` only when nothing at all is known; nothing is planned, drawn or
 * dispatched in that state (`GameSession.mayActOn`).
 */
export function flippedOf(
	state: BridgeState | null,
	board: Element | null,
	bottomColor: () => Color | null,
	myColour: () => Color | null
): boolean {
	if (typeof state?.flipped === "boolean") return state.flipped;
	if (board?.classList.contains(S.boardFlippedClass) === true) return true;
	// `bottomColor()` is render-truthful — it reads whichever colour the page actually shows at
	// the bottom (the player block, else the bottom clock), so it tracks a board the owner has
	// turned round by hand. The colour does not: `playingAs` says which side we are, not which
	// way the board faces. So ask the render first and fall back to the colour only when the
	// page shows nothing, otherwise a hand flip during a partial bridge failure (no `flipped`
	// flag, and on a WebGL board no `flipped` class either) would mirror every square.
	// `getMyColor()` never consults `isFlipped()`, so there is no cycle. It returns null early
	// for analysis and spectated pages, which is why it is a fallback and not the answer.
	const shown = bottomColor();
	if (shown !== null) return shown === "b";
	const mine = myColour();
	return mine !== null && mine === "b";
}
