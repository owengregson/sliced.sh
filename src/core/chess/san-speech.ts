/**
 * SAN → spoken words (§10.6): `"Nf3"` → `"knight f3"`, `"exd5"` → `"e takes d5"`,
 * `"O-O"` → `"castles kingside"`, `"e8=Q+"` → `"e8 promotes to queen check"`.
 * Pure; the vocabulary is `SPEECH` (`@core/constants/speech`).
 */

import { SPEECH } from "@core/constants/speech";

const CASTLE_LONG = /^O-O-O/;
const CASTLE_SHORT = /^O-O/;

/** The words a TTS voice should say for `san`; the input itself when it is not SAN. */
export function sanToSpeech(san: string): string {
	const trimmed = san.trim();
	if (trimmed === "") return "";
	const parts: string[] = [];
	let body = trimmed;

	// Suffixes first so the castling shapes are matched on the bare move.
	let suffix = "";
	if (body.endsWith("#")) {
		suffix = SPEECH.checkmate;
		body = body.slice(0, -1);
	} else if (body.endsWith("+")) {
		suffix = SPEECH.check;
		body = body.slice(0, -1);
	}
	body = body.replace(/[!?]+$/, "");

	if (CASTLE_LONG.test(body)) parts.push(SPEECH.castleLong);
	else if (CASTLE_SHORT.test(body)) parts.push(SPEECH.castleShort);
	else {
		const promotion = /=([QRBN])/.exec(body);
		if (promotion) body = body.slice(0, promotion.index);
		const first = body.charAt(0);
		const piece = SPEECH.pieces[first];
		if (piece !== undefined && first === first.toUpperCase()) {
			parts.push(piece);
			body = body.slice(1);
		}
		for (const chunk of body.split("x")) {
			if (chunk !== "") parts.push(chunk);
			parts.push(SPEECH.capture);
		}
		parts.pop(); // the trailing separator the split above always appends
		if (promotion) {
			const promoted = SPEECH.pieces[promotion[1] ?? ""];
			if (promoted !== undefined) parts.push(SPEECH.promotesTo, promoted);
		}
	}
	if (suffix !== "") parts.push(suffix);
	return parts.join(SPEECH.separator);
}
