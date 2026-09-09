/**
 * Spoken-move vocabulary (§10.6 TTS). These are user-facing words, which
 * normally live in `src/panel/copy.ts` — but the service worker is what calls
 * `chrome.tts.speak` and `src/service/**` may not import `@panel/*` (Task 28
 * ruling), so the vocabulary is registered here instead. C1 still holds: this
 * is the only place the words exist.
 */

export const SPEECH = {
	pieces: {
		K: "king",
		Q: "queen",
		R: "rook",
		B: "bishop",
		N: "knight",
		P: "pawn",
	} as Readonly<Record<string, string>>,
	capture: "takes",
	check: "check",
	checkmate: "checkmate",
	castleShort: "castles kingside",
	castleLong: "castles queenside",
	promotesTo: "promotes to",
	/** Joins the parts of one spoken move. */
	separator: " ",
} as const;
