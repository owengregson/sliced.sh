/**
 * The analysis cache's identities: what makes two searches the same search (position with its
 * reversible history, MultiPV, strength, limit, human frame and root set), and which finished
 * results may be reused at all.
 */

import { historyKey, positionKey } from "@core/chess/history";
import { LIMITS } from "@core/constants/limits";
import { TIMINGS } from "@core/constants/timings";
import type { AnalysisLimit, AnalysisResult } from "../types";

/**
 * First four FEN fields (placement, turn, castling, en passant) of the
 * **canonical** spelling of the position.
 *
 * The canonicalisation matters because three sources produce FENs for the same
 * position and they disagree on the en-passant field: chess.com's
 * `game.getFEN()` names the square after any double push, a chess.js replay
 * (`applyMoves`, which is how a ponder / premove result is keyed under the
 * position it reaches) names it only when a pawn can actually capture there, and
 * a DOM reconstruction (`approximateFen`) names it only when it can infer the
 * last move. Keyed raw, the ponder → own-move handoff therefore missed the cache
 * on every double push — silently, because a miss is just a slower move.
 *
 * `loadPosition(fen).fen()` is chess.js's own normalisation: it drops an
 * en-passant square no pawn can use and keeps one that a pawn can, so the two
 * spellings of one position collapse while two genuinely different positions
 * (one of which allows the capture) stay apart. An unparsable FEN keys on its
 * own raw fields, as before.
 */
export function fenKey(fen: string): string {
	return positionKey(fen);
}

/**
 * `inf`, else the concatenation of `d<depth>`, `t<ms>`, `n<nodes>` for the
 * fields present; an empty limit keys as the explicit default movetime the
 * client sends (`t${TIMINGS.analysisDefaultMovetimeMs}`).
 */
export function limitKey(limit: AnalysisLimit): string {
	if (limit.infinite) return "inf";
	let key = "";
	if (limit.depth !== undefined) key += `d${limit.depth}`;
	if (limit.movetimeMs !== undefined) key += `t${limit.movetimeMs}`;
	if (limit.nodes !== undefined) key += `n${limit.nodes}`;
	return key === "" ? `t${TIMINGS.analysisDefaultMovetimeMs}` : key;
}

/** The `sm:` segment of a restricted search's key: its roots sorted, comma-joined. */
export function searchmovesKey(searchmoves: readonly string[] | undefined): string {
	return searchmoves?.length ? [...searchmoves].sort().join(",") : "";
}

/** The same root set (order-insensitive); two unrestricted searches are the same set too. */
export function sameSearchmoves(
	a: readonly string[] | undefined,
	b: readonly string[] | undefined
): boolean {
	return searchmovesKey(a) === searchmovesKey(b);
}

/**
 * `fen|multiPv|elo|limit`, plus `|f<depth>` when the request asks for a human frame other than
 * the default `LIMITS.featureDepth` (H4, 2026-09-13) — the default keys exactly as before — and
 * `|sm:<sorted roots>` for a restricted (`searchmoves`) search (H10, 2026-09-13).
 */
export function cacheKey(
	fen: string,
	multiPv: number,
	elo: number | undefined,
	limit: AnalysisLimit,
	moves: readonly string[] = [],
	featureDepth: number = LIMITS.featureDepth,
	searchmoves?: readonly string[]
): string {
	const frame = featureDepth === LIMITS.featureDepth ? "" : `|f${featureDepth}`;
	const roots = searchmoves?.length ? `|sm:${searchmovesKey(searchmoves)}` : "";
	return `${historyKey(fen, moves)}|${multiPv}|${elo ?? "full"}|${limitKey(limit)}${frame}${roots}`;
}

/**
 * A finished or superseded request is reusable only when its final MultiPV
 * iteration completed. Request completion alone does not establish the depth
 * and candidate coverage promised by the cache key. Failed results never are.
 */
export function isCacheable(result: AnalysisResult): boolean {
	return result.final.complete && (result.status === "complete" || result.status === "superseded");
}
