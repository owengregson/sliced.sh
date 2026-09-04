/**
 * Premove candidates (Task 15, §7.4, Appendix E §3.1). After our move `m`,
 * predict the opponent's reply `r` (the engine's `ponder` or a short MultiPV-3
 * search), require `p(r) ≥ 0.6` under softmax(τ = 0.06) over the opponent's
 * lines, then analyse `m r` and premove our reply `q` only when it is
 * forced-looking: a recapture on the just-captured square, the only legal move
 * or a clear-only move (`loss_2nd ≥ 0.25`) — never a king move. The engine
 * searches are injected (`analyseAfter`); the timing model's π_p arrives as
 * the optional `piP` multiplier.
 */

import { classifyMove } from "@core/chess/move-classify";
import { applyMoves, legalMoves, parseUci } from "@core/chess/san";
import { type ExplorerSpeed, PREMOVE } from "@core/constants/books";
import type { Rng } from "@core/rng";
import { clamp } from "@core/util/clamp";
import type { EvalLine } from "@typedefs/engine";
import type { Square, TimeControl } from "@typedefs/game";
import { speedFor } from "./book/explorer";
import { cpEffective, winProb } from "./elo-map";

export interface PremoveContext {
	/** Position before our move. */
	fen: string;
	/** Our chosen move `m` (UCI). */
	move: string;
	/** Effective Elo `E`. */
	targetElo: number;
	timeControl?: TimeControl | undefined;
	/** The engine's `ponder` move after `m`, when it reported one. */
	ponder?: string | undefined;
	rng: Rng;
	/** Timing-model premove propensity π_p in [0, 1] (default 1). */
	piP?: number | undefined;
}

export interface AnalyseOptions {
	movetimeMs: number;
	multiPv: number;
}

export interface PremoveDeps {
	/** MultiPV lines (side-to-move POV) after playing `moves` from `fen`. */
	analyseAfter(fen: string, moves: readonly string[], opts: AnalyseOptions): Promise<EvalLine[]>;
}

export type PremoveReason = "recapture" | "only-move" | "loss2nd";

export interface PremoveCandidate {
	/** The opponent reply `r` the premove is conditioned on. */
	reply: string;
	/** Our premove `q`. */
	premove: string;
	from: Square;
	to: Square;
	promotion?: "q" | "r" | "b" | "n";
	reason: PremoveReason;
	replyProbability: number;
}

/** `0.35 + 0.5·clamp((E − 1200)/1200, 0, 1)` × π_p; 0 below E = 1200. */
export function premoveProbability(E: number, piP = 1): number {
	if (E < PREMOVE.minElo) return 0;
	const base =
		PREMOVE.probBase + PREMOVE.probRange * clamp((E - PREMOVE.minElo) / PREMOVE.probSpan, 0, 1);
	return clamp(base * clamp(piP, 0, 1), 0, 1);
}

/** Softmax(τ = 0.06) over the opponent lines' win fractions; 0 when `reply` is not among them. */
export function replyProbability(reply: string, lines: readonly EvalLine[]): number {
	if (lines.length === 0) return 0;
	const wins = lines.map((line) => winProb(cpEffective(line.score)));
	const max = Math.max(...wins);
	let total = 0;
	let own = 0;
	for (let i = 0; i < lines.length; i++) {
		const w = Math.exp(((wins[i] ?? 0) - max) / PREMOVE.replyTau);
		total += w;
		if (lines[i]?.pvUci[0] === reply) own += w;
	}
	return total > 0 ? own / total : 0;
}

function isPremoveSpeed(timeControl: TimeControl | undefined): boolean {
	if (!timeControl) return false;
	const speed = speedFor(timeControl);
	return (PREMOVE.speeds as readonly ExplorerSpeed[]).includes(speed);
}

/**
 * The premove to arm after `ctx.move`, or `null` when the situation is not
 * forced enough (or the gates say no). Cheap gates run before any engine time is spent.
 */
export async function premoveCandidate(
	ctx: PremoveContext,
	deps: PremoveDeps
): Promise<PremoveCandidate | null> {
	if (!isPremoveSpeed(ctx.timeControl) || ctx.targetElo < PREMOVE.minElo) return null;
	const p = premoveProbability(ctx.targetElo, ctx.piP);
	if (p <= 0 || !ctx.rng.chance(p)) return null;

	const afterMove = applyMoves(ctx.fen, [ctx.move]);
	if (afterMove === null) return null;

	const legalReplies = legalMoves(afterMove);
	if (ctx.ponder !== undefined && !legalReplies.includes(ctx.ponder)) return null;
	// The opponent's MultiPV after `m` gives p(r); `r` itself is the ponder move when we have one.
	const opponentLines = await deps.analyseAfter(ctx.fen, [ctx.move], {
		movetimeMs: PREMOVE.ponderMovetimeMs,
		multiPv: PREMOVE.ponderMultiPv,
	});
	const reply = ctx.ponder ?? opponentLines[0]?.pvUci[0];
	if (reply === undefined || !legalReplies.includes(reply)) return null;
	const pReply = replyProbability(reply, opponentLines);
	if (pReply < PREMOVE.replyMinProb) return null;

	const afterReply = applyMoves(afterMove, [reply]);
	if (afterReply === null) return null;
	const lines = await deps.analyseAfter(ctx.fen, [ctx.move, reply], {
		movetimeMs: PREMOVE.replyMovetimeMs,
		multiPv: PREMOVE.replyMultiPv,
	});
	const best = lines[0];
	const q = best?.pvUci[0];
	if (best === undefined || q === undefined) return null;
	const facts = classifyMove(afterReply, q, reply);
	if (!facts || facts.pieceType === "k" || facts.isCastle) return null;
	// A recapture needs the opponent's reply to have captured on the square we now take back.
	const replyCaptured = classifyMove(afterMove, reply)?.isCapture ?? false;

	let reason: PremoveReason | null = null;
	if (facts.isRecapture && replyCaptured) reason = "recapture";
	else if (facts.isOnlyMove) reason = "only-move";
	else {
		const second = lines[1];
		if (second !== undefined) {
			const loss2nd = winProb(cpEffective(best.score)) - winProb(cpEffective(second.score));
			if (loss2nd >= PREMOVE.loss2ndMin) reason = "loss2nd";
		}
	}
	if (reason === null) return null;

	const parts = parseUci(q);
	if (!parts) return null;
	const candidate: PremoveCandidate = {
		reply,
		premove: q,
		from: parts.from,
		to: parts.to,
		reason,
		replyProbability: pReply,
	};
	if (parts.promotion !== undefined) candidate.promotion = parts.promotion;
	return candidate;
}
