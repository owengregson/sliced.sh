/**
 * The heuristic prior's rows (§7.2 step 8; Appendix E §3.3/§3.4) as a table: each rule names
 * itself and answers a multiplicative factor for one candidate line, or `null` when it does not
 * apply. `priorForLine` applies them in table order, which is the order the rationale lists them.
 */

import { PIECE_VALUES } from "@core/chess/material";
import { classifyMove, type MoveClassification } from "@core/chess/move-classify";
import { parseUci, type UciParts } from "@core/chess/san";
import { fileOf } from "@core/chess/squares";
import type { EvalLine } from "@typedefs/engine";
import type { Color, Square } from "@typedefs/game";
import type { Chess } from "chess.js";
import { SELECTION_CONSTANTS as C } from "../constants";
import { cpEffective, eloRamp, winProb } from "../elo-map";
import type { PriorContext } from "../types";
import {
	isClosedFile,
	isDefended,
	isMinor,
	isSacrifice,
	type PvPly,
	pawnThreatens,
	relRank,
	WAITING_MOVES,
	walkPv,
} from "./board";

export interface PriorTerm {
	rule: string;
	factor: number;
}

export interface PriorBreakdown {
	value: number;
	terms: PriorTerm[];
}

/** The position-wide facts every rule reads, built once per `heuristicPriorDetailed` call. */
export interface PriorEnv {
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
	/** Appendix E §3.5: an endgame with best ≥ +500 and no queens on the board. */
	wonEndgame: boolean;
	kingSquare: Square | null;
}

/** One candidate line as the rules see it. */
export interface LineView {
	line: EvalLine;
	uci: string;
	parts: UciParts;
	cls: MoveClassification;
	/** The line's PV walked `sacrificePvWindow` plies deep. */
	pv: PvPly[];
	quiet: boolean;
	backRankFrom: boolean;
	backRankTo: boolean;
	/** Appendix E §3.3: a capture of equal or greater value that the reply takes back. */
	trade: boolean;
	/** Appendix E §3.3: the PV holds ≥ `sharpOpponentCaptures` opponent captures. */
	sharp: boolean;
}

export interface PriorRule {
	rule: string;
	factor(m: LineView, env: PriorEnv): number | null;
}

const P = C.prior;
const S = C.situational;

/** Appendix E §3.3's split: "ahead" wins over "behind" when both thresholds would hold. */
const ahead = (env: PriorEnv) => env.bestCp >= S.aheadCp;
const behindFull = (env: PriorEnv) => !ahead(env) && env.bestCp <= S.behindCp && env.E >= S.fullElo;

export const PRIOR_RULES: readonly PriorRule[] = [
	{ rule: "recapture", factor: (m) => (m.cls.isRecapture ? P.recapture : null) },
	{
		rule: "check",
		factor: (m, env) => (m.cls.isCheck ? (env.E < P.checkElo ? P.checkWeak : P.checkStrong) : null),
	},
	{
		rule: "capture-undefended",
		factor: (m, env) =>
			m.cls.isCapture &&
			m.cls.capturedType !== null &&
			m.cls.capturedType !== "p" &&
			!isDefended(env.fen, m.uci, m.parts.to)
				? P.captureUndefended
				: null,
	},
	{
		rule: "castling",
		factor: (m, env) => (m.cls.isCastle && env.ply <= P.castlingMaxPly ? P.castling : null),
	},
	{
		rule: "development",
		factor: (m, env) =>
			isMinor(m.cls.pieceType) && m.backRankFrom && env.ply <= P.developmentMaxPly
				? P.development
				: null,
	},
	{
		rule: "king-shield-pawn-push",
		factor: (m, env) =>
			m.cls.pieceType === "p" &&
			!m.cls.isCapture &&
			env.phase === "middlegame" &&
			fileOf(m.parts.from) >= 5 &&
			env.kingSquare !== null &&
			relRank(env.kingSquare, env.us) === 0 &&
			fileOf(env.kingSquare) >= 6
				? P.kingShieldPawnPush
				: null,
	},
	{
		rule: "quiet-king-move",
		factor: (m, env) =>
			m.cls.pieceType === "k" &&
			!m.cls.isCastle &&
			!m.cls.isCapture &&
			!env.inCheck &&
			env.queensOn.w &&
			env.queensOn.b &&
			env.phase === "middlegame"
				? P.quietKingMove
				: null,
	},
	{
		rule: "rook-lift",
		factor: (m, env) => {
			if (m.cls.pieceType !== "r" || !m.quiet) return null;
			const { from, to } = m.parts;
			const toRel = relRank(to, env.us);
			const lift = fileOf(from) === fileOf(to) && m.backRankFrom && (toRel === 2 || toRel === 3);
			const closed = isClosedFile(env.chess, to);
			const justified = m.pv[2]?.from === to;
			return (lift || closed) && !justified ? P.rookLift : null;
		},
	},
	{
		rule: "retreat",
		factor: (m, env) =>
			(isMinor(m.cls.pieceType) || m.cls.pieceType === "q") &&
			!m.cls.isCapture &&
			!m.backRankFrom &&
			m.backRankTo &&
			env.ply <= P.retreatMaxPly
				? P.retreat
				: null,
	},
	{
		rule: "waiting-move",
		factor: (m, env) => {
			if (
				m.cls.pieceType !== "p" ||
				!m.quiet ||
				!WAITING_MOVES[env.us].includes(m.uci) ||
				pawnThreatens(env.chess, m.parts.to, env.us)
			)
				return null;
			const f = eloRamp(env.E, P.waitingMoveWeakElo, P.waitingMoveWeak, P.waitingMoveStrongElo, 1);
			return f !== 1 ? f : null;
		},
	},
	{
		rule: "underpromotion",
		factor: (m) =>
			m.cls.isPromotion && m.parts.promotion !== "q" && !m.cls.givesMate && !m.cls.isOnlyMove
				? P.underpromotion
				: null,
	},
	{
		rule: "sacrifice",
		factor: (m, env) =>
			isSacrifice(m.pv)
				? eloRamp(env.E, P.sacrificeWeakElo, P.sacrificeWeak, P.sacrificeStrongElo, P.sacrificeStrong)
				: null,
	},
	{
		rule: "back-and-forth",
		factor: (m, env) =>
			env.prevOwn &&
			env.prevOwn.from === m.parts.to &&
			env.prevOwn.to === m.parts.from &&
			env.bestCp >= 0
				? P.backAndForth
				: null,
	},
	{
		rule: "king-activation",
		factor: (m, env) =>
			m.cls.pieceType === "k" &&
			!m.cls.isCastle &&
			env.phase === "endgame" &&
			!env.queensOn.w &&
			!env.queensOn.b &&
			env.ply >= P.kingActivationMinPly &&
			env.E >= P.kingActivationElo
				? P.kingActivation
				: null,
	},
	// Appendix E §3.5 technique: in won endgames prefer pawn pushes / king moves that keep
	// the raw loss ≤ 0.05 even if not top-1 (humans convert by the simplest path).
	{
		rule: "won-endgame-technique",
		factor: (m, env) =>
			env.wonEndgame &&
			(m.cls.pieceType === "p" || (m.cls.pieceType === "k" && !m.cls.isCastle)) &&
			winProb(env.bestCp) - winProb(cpEffective(m.line.score)) <= C.endgame.wonLossMax
				? C.endgame.wonTechnique
				: null,
	},
	// Appendix E §3.3 situational modifiers. Endgames use the smaller, quality-checked exchange
	// preference (`simplification.ts`) instead of trading when ahead.
	{
		rule: "simplify-ahead:trade",
		factor: (m, env) => (ahead(env) && m.trade && env.phase !== "endgame" ? S.tradeWhenAhead : null),
	},
	{
		rule: "simplify-ahead:quiet-sharp",
		factor: (m, env) =>
			ahead(env) && env.E >= S.fullElo && m.quiet && m.sharp ? S.quietSharpWhenAhead : null,
	},
	{
		rule: "complicate-behind:forcing",
		factor: (m, env) =>
			behindFull(env) && (m.cls.isCheck || m.cls.isCapture) ? S.forcingWhenBehind : null,
	},
	{
		rule: "complicate-behind:trade",
		factor: (m, env) => (behindFull(env) && m.trade ? S.tradeWhenBehind : null),
	},
];

/** The rules' view of one line, or `null` when its move cannot be read in `env.fen`. */
export function lineView(line: EvalLine, env: PriorEnv): LineView | null {
	const uci = line.pvUci[0];
	const parts = uci === undefined ? null : parseUci(uci);
	const cls = uci === undefined ? null : classifyMove(env.fen, uci, env.lastMove);
	if (uci === undefined || !parts || !cls) return null;
	const pv = walkPv(env.fen, line.pvUci, P.sacrificePvWindow);
	const reply = pv[1];
	const recaptured = reply?.isCapture === true && reply.to === parts.to;
	return {
		line,
		uci,
		parts,
		cls,
		pv,
		quiet: !cls.isCapture && !cls.isCheck,
		backRankFrom: relRank(parts.from, env.us) === 0,
		backRankTo: relRank(parts.to, env.us) === 0,
		trade:
			cls.isCapture &&
			cls.capturedType !== null &&
			PIECE_VALUES[cls.capturedType] >= PIECE_VALUES[cls.pieceType] &&
			recaptured,
		sharp: pv.filter((p, i) => i % 2 === 1 && p.isCapture).length >= S.sharpOpponentCaptures,
	};
}

/** Every applicable rule's factor for `line`, multiplied on a base of 1. */
export function priorForLine(
	line: EvalLine,
	env: PriorEnv,
	rules: readonly PriorRule[] = PRIOR_RULES
): PriorBreakdown {
	const view = lineView(line, env);
	if (view === null) return { value: 1, terms: [] };
	const terms: PriorTerm[] = [];
	for (const { rule, factor } of rules) {
		const f = factor(view, env);
		if (f !== null) terms.push({ rule, factor: f });
	}
	let value = 1;
	for (const t of terms) value *= t.factor;
	return { value, terms };
}
