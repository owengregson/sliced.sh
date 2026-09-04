/**
 * Heuristic prior table (§7.2 step 8; Appendix E §3.3/§3.4) — pure and
 * deterministic: multiplicative on a base of 1.0 per candidate line, detected
 * with `classifyMove` plus a short walk of each line's PV. Never uses the rng.
 */

import { loadPosition } from "@core/chess/fen";
import { material, PIECE_VALUES, type PieceType } from "@core/chess/material";
import { classifyMove } from "@core/chess/move-classify";
import { applyMoves, legalMoves, parseUci, playUci } from "@core/chess/san";
import { fileOf, rankOf, squareOf } from "@core/chess/squares";
import type { EvalLine } from "@typedefs/engine";
import type { Color, Square } from "@typedefs/game";
import type { Chess } from "chess.js";
import { SELECTION_CONSTANTS as C } from "./constants";
import { cpEffective, effectiveElo, eloRamp } from "./elo-map";
import type { PriorContext } from "./types";

/** One PV ply after the candidate move; `matDiff` is our material balance change from the root. */
interface PvPly {
	from: Square;
	to: Square;
	isCapture: boolean;
	matDiff: number;
}

interface PriorEnv {
	fen: string;
	chess: Chess;
	us: Color;
	E: number;
	ply: number;
	phase: PriorContext["phase"];
	lastMove: string | undefined;
	prevOwn: ReturnType<typeof parseUci>;
	/** Raw `cpEff` of the best line (side-to-move POV). */
	bestCp: number;
	inCheck: boolean;
	queensOn: { w: boolean; b: boolean };
	kingSquare: Square | null;
}

export interface PriorTerm {
	rule: string;
	factor: number;
}

export interface PriorBreakdown {
	value: number;
	terms: PriorTerm[];
}

const WAITING_MOVES: Record<Color, readonly string[]> = {
	w: ["a2a3", "h2h3"],
	b: ["a7a6", "h7h6"],
};

function isMinor(p: PieceType): boolean {
	return p === "n" || p === "b";
}

function relRank(sq: Square, us: Color): number {
	return us === "w" ? rankOf(sq) : 7 - rankOf(sq);
}

function walkPv(fen: string, pv: readonly string[], window: number): PvPly[] {
	const chess = loadPosition(fen);
	if (!chess) return [];
	const sign = chess.turn() === "w" ? 1 : -1;
	const start = material(chess.fen())?.diff ?? 0;
	const out: PvPly[] = [];
	for (let i = 0; i < Math.min(pv.length, window); i++) {
		const uci = pv[i];
		if (uci === undefined) break;
		const m = playUci(chess, uci);
		if (!m) break;
		const diff = material(chess.fen())?.diff ?? start;
		out.push({
			from: m.from,
			to: m.to,
			isCapture: m.isCapture() || m.isEnPassant(),
			matDiff: sign * (diff - start),
		});
	}
	return out;
}

function findKing(chess: Chess, color: Color): Square | null {
	const squares = chess.findPiece({ type: "k", color });
	return squares[0] ?? null;
}

function hasQueen(chess: Chess, color: Color): boolean {
	return chess.findPiece({ type: "q", color }).length > 0;
}

/** After our capture on `to`, can the opponent legally recapture there? */
function isDefended(fen: string, uci: string, to: Square): boolean {
	const after = applyMoves(fen, [uci]);
	if (after === null) return true;
	return legalMoves(after).some((m) => m.slice(2, 4) === to);
}

/** Does the file of `sq` hold pawns of both colours? */
function isClosedFile(chess: Chess, sq: Square): boolean {
	const file = fileOf(sq);
	let white = false;
	let black = false;
	for (let r = 0; r < 8; r++) {
		const s = squareOf(file, r);
		const piece = s ? chess.get(s) : undefined;
		if (piece?.type !== "p") continue;
		if (piece.color === "w") white = true;
		else black = true;
	}
	return white && black;
}

/** Does a pawn of `us` on `to` attack an enemy non-pawn piece? */
function pawnThreatens(chess: Chess, to: Square, us: Color): boolean {
	const dir = us === "w" ? 1 : -1;
	for (const df of [-1, 1]) {
		const s = squareOf(fileOf(to) + df, rankOf(to) + dir);
		const piece = s ? chess.get(s) : undefined;
		if (piece && piece.color !== us && piece.type !== "p") return true;
	}
	return false;
}

/** PV shows us down ≥ `sacrificeMaterial` for ≥ `sacrificePlies` consecutive plies. */
function isSacrifice(pv: readonly PvPly[]): boolean {
	let run = 0;
	for (let i = 1; i < pv.length; i++) {
		const ply = pv[i];
		if (ply !== undefined && ply.matDiff <= -C.prior.sacrificeMaterial) {
			run++;
			if (run >= C.prior.sacrificePlies) return true;
		} else run = 0;
	}
	return false;
}

function priorForLine(line: EvalLine, env: PriorEnv): PriorBreakdown {
	const uci = line.pvUci[0];
	const parts = uci === undefined ? null : parseUci(uci);
	const cls = uci === undefined ? null : classifyMove(env.fen, uci, env.lastMove);
	if (uci === undefined || !parts || !cls) return { value: 1, terms: [] };
	const P = C.prior;
	const S = C.situational;
	const terms: PriorTerm[] = [];
	const apply = (rule: string, factor: number) => terms.push({ rule, factor });
	const { from, to } = parts;
	const pv = walkPv(env.fen, line.pvUci, P.sacrificePvWindow);
	const reply = pv[1];
	const quiet = !cls.isCapture && !cls.isCheck;
	const backRankFrom = relRank(from, env.us) === 0;
	const backRankTo = relRank(to, env.us) === 0;

	if (cls.isRecapture) apply("recapture", P.recapture);
	if (cls.isCheck) apply("check", env.E < P.checkElo ? P.checkWeak : P.checkStrong);
	if (
		cls.isCapture &&
		cls.capturedType !== null &&
		cls.capturedType !== "p" &&
		!isDefended(env.fen, uci, to)
	)
		apply("capture-undefended", P.captureUndefended);
	if (cls.isCastle && env.ply <= P.castlingMaxPly) apply("castling", P.castling);
	if (isMinor(cls.pieceType) && backRankFrom && env.ply <= P.developmentMaxPly)
		apply("development", P.development);
	if (
		cls.pieceType === "p" &&
		!cls.isCapture &&
		env.phase === "middlegame" &&
		fileOf(from) >= 5 &&
		env.kingSquare !== null &&
		relRank(env.kingSquare, env.us) === 0 &&
		fileOf(env.kingSquare) >= 6
	)
		apply("king-shield-pawn-push", P.kingShieldPawnPush);
	if (
		cls.pieceType === "k" &&
		!cls.isCastle &&
		!cls.isCapture &&
		!env.inCheck &&
		env.queensOn.w &&
		env.queensOn.b &&
		env.phase === "middlegame"
	)
		apply("quiet-king-move", P.quietKingMove);
	if (cls.pieceType === "r" && quiet) {
		const toRel = relRank(to, env.us);
		const lift = fileOf(from) === fileOf(to) && backRankFrom && (toRel === 2 || toRel === 3);
		const closed = isClosedFile(env.chess, to);
		const justified = pv[2]?.from === to;
		if ((lift || closed) && !justified) apply("rook-lift", P.rookLift);
	}
	if (
		(isMinor(cls.pieceType) || cls.pieceType === "q") &&
		!cls.isCapture &&
		!backRankFrom &&
		backRankTo &&
		env.ply <= P.retreatMaxPly
	)
		apply("retreat", P.retreat);
	if (
		cls.pieceType === "p" &&
		quiet &&
		WAITING_MOVES[env.us].includes(uci) &&
		!pawnThreatens(env.chess, to, env.us)
	) {
		const f = eloRamp(env.E, P.waitingMoveWeakElo, P.waitingMoveWeak, P.waitingMoveStrongElo, 1);
		if (f !== 1) apply("waiting-move", f);
	}
	if (cls.isPromotion && parts.promotion !== "q" && !cls.givesMate && !cls.isOnlyMove)
		apply("underpromotion", P.underpromotion);
	if (isSacrifice(pv)) {
		const f = eloRamp(
			env.E,
			P.sacrificeWeakElo,
			P.sacrificeWeak,
			P.sacrificeStrongElo,
			P.sacrificeStrong
		);
		apply("sacrifice", f);
	}
	if (env.prevOwn && env.prevOwn.from === to && env.prevOwn.to === from && env.bestCp >= 0)
		apply("back-and-forth", P.backAndForth);
	if (
		cls.pieceType === "k" &&
		!cls.isCastle &&
		env.phase === "endgame" &&
		!env.queensOn.w &&
		!env.queensOn.b &&
		env.ply >= P.kingActivationMinPly &&
		env.E >= P.kingActivationElo
	)
		apply("king-activation", P.kingActivation);

	// Appendix E §3.3 situational modifiers.
	const recaptured = reply?.isCapture === true && reply.to === to;
	const trade =
		cls.isCapture &&
		cls.capturedType !== null &&
		PIECE_VALUES[cls.capturedType] >= PIECE_VALUES[cls.pieceType] &&
		recaptured;
	const opponentCaptures = pv.filter((p, i) => i % 2 === 1 && p.isCapture).length;
	const sharp = opponentCaptures >= S.sharpOpponentCaptures;
	const full = env.E >= S.fullElo;
	if (env.bestCp >= S.aheadCp) {
		if (trade) apply("simplify-ahead:trade", S.tradeWhenAhead);
		if (full && quiet && sharp) apply("simplify-ahead:quiet-sharp", S.quietSharpWhenAhead);
	} else if (env.bestCp <= S.behindCp && full) {
		if (cls.isCheck || cls.isCapture) apply("complicate-behind:forcing", S.forcingWhenBehind);
		if (trade) apply("complicate-behind:trade", S.tradeWhenBehind);
	}

	let value = 1;
	for (const t of terms) value *= t.factor;
	return { value, terms };
}

/** Per-line prior breakdown keyed by UCI (1.0 with no terms for unparseable lines). */
export function heuristicPriorDetailed(
	fen: string,
	lines: readonly EvalLine[],
	ctx: PriorContext
): Map<string, PriorBreakdown> {
	const out = new Map<string, PriorBreakdown>();
	const chess = loadPosition(fen);
	if (!chess) {
		for (const line of lines) {
			const uci = line.pvUci[0];
			if (uci !== undefined) out.set(uci, { value: 1, terms: [] });
		}
		return out;
	}
	const us = chess.turn();
	let bestCp = Number.NEGATIVE_INFINITY;
	for (const line of lines) bestCp = Math.max(bestCp, cpEffective(line.score));
	const prevOwnUci = ctx.state.previousOwnMoves[ctx.state.previousOwnMoves.length - 1];
	const env: PriorEnv = {
		fen,
		chess,
		us,
		E: effectiveElo(ctx.targetElo, ctx.form),
		ply: ctx.ply,
		phase: ctx.phase,
		lastMove: ctx.lastMove,
		prevOwn: prevOwnUci === undefined ? null : parseUci(prevOwnUci),
		bestCp: Number.isFinite(bestCp) ? bestCp : 0,
		inCheck: chess.inCheck(),
		queensOn: { w: hasQueen(chess, "w"), b: hasQueen(chess, "b") },
		kingSquare: findKing(chess, us),
	};
	for (const line of lines) {
		const uci = line.pvUci[0];
		if (uci === undefined) continue;
		out.set(uci, priorForLine(line, env));
	}
	return out;
}

/** `heuristicPrior(fen, lines, ctx) → Map<uci, prior>` (Appendix E §3.4). */
export function heuristicPrior(
	fen: string,
	lines: readonly EvalLine[],
	ctx: PriorContext
): Map<string, number> {
	const out = new Map<string, number>();
	for (const [uci, b] of heuristicPriorDetailed(fen, lines, ctx)) out.set(uci, b.value);
	return out;
}
