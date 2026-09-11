/** Confirm a completed move against its original position and the site's current evidence. */
import { loadPosition, parseFen, plyOf } from "@core/chess/fen";
import { positionKey } from "@core/chess/history";
import { playUci } from "@core/chess/san";
import { CHESS_START_FEN } from "@core/constants/chess";
import type { ExpectedMove } from "@core/constants/messages";
import type { MoveWatch } from "./adapter";
import { placementOf } from "./dom-fen";

/** `null` keeps compatibility with watches opened before a move and without a source position. */
export function createMoveProof(expected: ExpectedMove): ((watch: MoveWatch) => boolean) | null {
	if (expected.beforeFen === undefined) return null;
	const before = parseFen(expected.beforeFen);
	const chess = loadPosition(expected.beforeFen);
	const uci = `${expected.from}${expected.to}${expected.promotion ?? ""}`;
	if (!before || !chess || !playUci(chess, uci)) return () => false;
	const afterFen = chess.fen();
	const afterPlacement = placementOf(afterFen);
	const beforePly = plyOf(before);
	const beforeKey = positionKey(expected.beforeFen);
	let historyKey: string | null = null;
	let historyFen: string | null = null;

	return (watch) => {
		if (!watch.placement || watch.independentPlacement === false) return false;
		if (watch.fen && placementOf(watch.fen) !== watch.placement) return false;
		// Full legal successor plus an authoritative position is enough when no move list exists.
		if (
			watch.placement === afterPlacement &&
			watch.fen &&
			loadPosition(watch.fen)?.fen() === afterFen
		)
			return true;
		const history = watch.history;
		if (!history || history.length <= beforePly) return false;
		const key = history.join(" ");
		if (key !== historyKey) {
			historyKey = key;
			historyFen = null;
			const replay = loadPosition(CHESS_START_FEN);
			if (!replay) return false;
			let found = false;
			try {
				for (const [index, san] of history.entries()) {
					const matchesBefore = index === beforePly && positionKey(replay.fen()) === beforeKey;
					const move = replay.move(san, { strict: false });
					if (matchesBefore && `${move.from}${move.to}${move.promotion ?? ""}` === uci) found = true;
				}
				if (found) historyFen = replay.fen();
			} catch {
				// An incomplete/invalid move list proves nothing.
			}
		}
		// A quick reply may capture the moved piece. Its complete, current replay still proves
		// our exact move at the original ply; an old list disagreeing with the board does not.
		if (historyFen === null || placementOf(historyFen) !== watch.placement) return false;
		// Equal piece placement can recur in a different game or at another ply. When a full
		// position is available, its move counters and rights must corroborate the replay too.
		return watch.fen === undefined || loadPosition(watch.fen)?.fen() === historyFen;
	};
}
