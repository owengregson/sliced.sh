import { loadPosition } from "@core/chess/fen";
import { matchingHistory, replayHistory } from "@core/chess/history";
import { material } from "@core/chess/material";
import { playUci } from "@core/chess/san";
import { fileOf, rankOf } from "@core/chess/squares";
import type { EvalLine } from "@typedefs/engine";
import type { Square } from "@typedefs/game";
import { SELECTION_CONSTANTS as C } from "./constants";
import type { SelectionContext } from "./types";

/** Conversion compares actual searched centipawns; +10 and +30 must not collapse to a tie. */
export function searchedCp(line: EvalLine): number {
	if ((line.score.mate ?? 0) > 0) return Number.POSITIVE_INFINITY;
	if ((line.score.mate ?? 0) < 0) return Number.NEGATIVE_INFINITY;
	return line.score.cp ?? 0;
}

// A recommendation and its conversion guard inspect the same root repeatedly. Keep just that
// root's legal mates, avoiding a fresh legal-move generation for each MultiPV candidate.
let matingFen: string | null = null;
let matingMoves: ReadonlySet<string> = new Set();
export function isImmediateMate(fen: string, uci: string): boolean {
	if (fen !== matingFen) {
		matingFen = fen;
		matingMoves = new Set(
			(loadPosition(fen)?.moves({ verbose: true }) ?? [])
				.filter((move) => move.san.endsWith("#"))
				.map((move) => `${move.from}${move.to}${move.promotion ?? ""}`)
		);
	}
	return matingMoves.has(uci);
}

function distance(a: Square | undefined, b: Square | undefined): number {
	if (!a || !b) return 0;
	return Math.max(Math.abs(fileOf(a) - fileOf(b)), Math.abs(rankOf(a) - rankOf(b)));
}

export interface ConversionPool {
	lines: EvalLine[];
	active: boolean;
	avoidedDraw: boolean;
	progress: ReadonlyMap<EvalLine, number>;
}

/** Protect conversion only when a legal, searched continuation retains a substantial advantage. */
export function conversionPool(
	lines: readonly EvalLine[],
	ctx: Pick<SelectionContext, "fen" | "phase" | "history">
): ConversionPool {
	const unchanged = { lines: [...lines], active: false, avoidedDraw: false, progress: new Map() };
	const root = loadPosition(ctx.fen);
	const counts = material(ctx.fen);
	if (!root || !counts) return unchanged;
	const us = root.turn();
	const them = us === "w" ? "b" : "w";
	const best = Math.max(...lines.map(searchedCp));
	const winning =
		best >= C.conversion.aheadCp &&
		(ctx.phase === "endgame" || counts[us] - counts[them] >= C.conversion.materialPawns);
	if (!winning) return unchanged;
	const immediateMates = lines.filter((line) => isImmediateMate(ctx.fen, line.pvUci[0] ?? ""));
	if (immediateMates.length) return { ...unchanged, lines: immediateMates };
	const history = matchingHistory(ctx.history, ctx.fen);
	const beforeDistance = distance(
		root.findPiece({ color: us, type: "k" })[0],
		root.findPiece({ color: them, type: "k" })[0]
	);
	const progress = new Map<EvalLine, number>();
	const drawn = new Set<EvalLine>();
	const legal = new Set<EvalLine>();
	for (const line of lines) {
		const board = history ? replayHistory(history) : loadPosition(ctx.fen);
		if (!board) continue;
		for (let i = 0; i < Math.min(line.pvUci.length, C.conversion.pvPlies); i++) {
			const uci = line.pvUci[i];
			const move = uci ? playUci(board, uci) : null;
			if (!move) break;
			if (i === 0) {
				legal.add(line);
				let score = move.promotion
					? C.conversion.promotionWeight
					: move.piece === "p"
						? C.conversion.pawnWeight
						: 0;
				if (counts[them] === 0) {
					const kingDistance = distance(
						board.findPiece({ color: us, type: "k" })[0],
						board.findPiece({ color: them, type: "k" })[0]
					);
					if (move.piece === "k")
						score += (beforeDistance - kingDistance) * C.conversion.kingApproachWeight;
					score -= board.moves().length * C.conversion.kingRestrictionWeight;
				}
				progress.set(line, score);
			}
			if (board.isCheckmate()) break;
			if (
				board.isStalemate() ||
				board.isInsufficientMaterial() ||
				board.isDrawByFiftyMoves() ||
				board.isThreefoldRepetition()
			) {
				drawn.add(line);
				break;
			}
		}
	}
	const safe = lines.filter(
		(line) => legal.has(line) && !drawn.has(line) && searchedCp(line) >= C.conversion.keepCp
	);
	if (!safe.length) return unchanged;
	const bestSafe = Math.max(...safe.map(searchedCp));
	const bounded = safe.filter((line) => searchedCp(line) >= bestSafe - C.conversion.maxLossCp);
	return { lines: bounded, active: true, avoidedDraw: drawn.size > 0, progress };
}
