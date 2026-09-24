/** SAN spelled out for `aria-live` / TTS ("Nf3" → "knight f3"): the single implementation. */

import { COPY } from "../copy";

type PieceLetter = keyof typeof COPY.a11y.pieces;

const SAN_RE = /^([KQRBN])?([a-h]?[1-8]?)(x?)([a-h][1-8])(?:=?([QRBN]))?$/;
const CASTLE_QUEEN_RE = /^[O0]-[O0]-[O0]$/;
const CASTLE_KING_RE = /^[O0]-[O0]$/;

function pieceWord(letter: string): string {
	return COPY.a11y.pieces[letter as PieceLetter];
}

/**
 * "Nf3" → "knight f3", "O-O" → "castles kingside", "exd5+" → "e takes d5 check",
 * "e8=Q#" → "e8 promotes to queen checkmate". Annotations (`!?`) are dropped; anything that is
 * not SAN (null moves, "e.p.") yields "".
 */
export function sanToSpeech(san: string): string {
	const raw = san.trim().replace(/[!?]+$/, "");
	if (!raw) return "";
	const suffix = /[+#]$/.exec(raw)?.[0] ?? "";
	const core = raw.replace(/[+#]+$/, "");
	const words: string[] = [];
	if (CASTLE_QUEEN_RE.test(core)) words.push(COPY.a11y.castleQueen);
	else if (CASTLE_KING_RE.test(core)) words.push(COPY.a11y.castleKing);
	else {
		const m = SAN_RE.exec(core);
		if (!m) return "";
		const [, piece, disambiguation, capture, target, promotion] = m;
		if (piece) words.push(pieceWord(piece));
		if (disambiguation) words.push(disambiguation);
		if (capture) words.push(COPY.a11y.takes);
		if (target) words.push(target);
		if (promotion) words.push(COPY.a11y.promotes, pieceWord(promotion));
	}
	if (suffix === "#") words.push(COPY.a11y.checkmate);
	else if (suffix === "+") words.push(COPY.a11y.check);
	return words.join(" ");
}
