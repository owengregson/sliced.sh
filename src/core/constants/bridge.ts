/**
 * Wire field names of the MAIN ⇄ ISOLATED bridge protocol (§13.3 rule 5).
 *
 * Every `window.postMessage` envelope between a page bridge and the content
 * script is `{ [spoofedKey]: token, k, i?, p? }` and every payload inside `p`
 * uses the single-letter names below, so nothing page-visible names a chess
 * concept, the product or an engine. The page programs (build time) and
 * `src/content/page-bridge-client.ts` (runtime) both read this registry, so
 * the two sides can never disagree (C1). Message kinds (`k` values) are
 * `BRIDGE_KINDS` in `src/content/adapters/adapter.ts`.
 */
export const BRIDGE_WIRE = {
	// envelope
	kind: "k",
	id: "i",
	payload: "p",
	// board state (`getState` reply, `move` / `load` / `state` / `gameover` events)
	position: "f",
	turn: "t",
	playingAs: "a",
	mode: "m",
	flipped: "o",
	lastMove: "l",
	timeControl: "c",
	timestamps: "s",
	gameOver: "g",
	result: "r",
	// moves (`lastMove`, `legalMoves` entries)
	from: "f",
	to: "t",
	san: "s",
	promotion: "p",
	// drawing (`draw` request / reply, `clear` request)
	orientation: "r",
	highlights: "h",
	arrows: "a",
	square: "q",
	color: "c",
	keys: "y",
	// pointer (`cursor` reply)
	x: "x",
	y: "y",
	at: "t",
	/** Left-button state of the mirrored pointer (`cursorTo` request). */
	down: "d",
} as const;

/** `orientation` values on the wire. */
export const BRIDGE_ORIENTATION = { white: "w", black: "b" } as const;
