/** Purposeful bouts, not independent gestures. All Elo rates are explicit design hypotheses. */
import type { Phase } from "@core/chess/phase";
import type { Rng } from "@core/rng";
import type { Square } from "@typedefs/game";
import type { PersonaId } from "@typedefs/settings";
import { REPERTOIRE as R } from "./constants";
import type { MoveCandidate } from "./types";

export interface MotorRepertoireContext {
	targetElo: number;
	phase: Phase;
	persona?: PersonaId;
	sharp?: boolean;
	inCheck?: boolean;
	forced?: boolean;
	/** Queued premove, pending queue, or held piece: the pointer must be left alone. */
	premovePending?: boolean;
}

export type RepertoireIntent = "still" | "prepare" | "inspect" | "compare" | "verify" | "relate";

/** Per game, owned by the caller. Carries purpose, never stale coordinates or selected pieces. */
export interface RepertoireState {
	intent: RepertoireIntent;
	boutsLeft: number;
	contextKey: string;
}

const INTENTS: readonly RepertoireIntent[] = [
	"still",
	"prepare",
	"inspect",
	"compare",
	"verify",
	"relate",
];

export function chooseRepertoire(
	context: MotorRepertoireContext,
	previous: RepertoireState | undefined,
	room: { budgetMs: number; myClockMs: number; candidates: number },
	rng: Rng
): RepertoireState {
	const elo = Number.isFinite(context.targetElo) ? context.targetElo : R.defaultElo;
	const persona = context.persona ?? "balanced";
	const sharp = context.sharp === true || context.inCheck === true;
	const contextKey = `${elo}:${persona}:${context.phase}:${sharp}:${context.forced === true}`;
	// Interrupt coherent browsing immediately. Do not defer a ready move to finish a gesture.
	if (
		context.premovePending ||
		!Number.isFinite(room.budgetMs) ||
		room.budgetMs < R.minWindowMs ||
		!Number.isFinite(room.myClockMs) ||
		room.myClockMs < R.lowClockMs ||
		room.candidates === 0
	)
		return { intent: "still", boutsLeft: 0, contextKey };
	if (context.forced) return { intent: "prepare", boutsLeft: 0, contextKey };
	if (
		previous?.contextKey === contextKey &&
		previous.boutsLeft > 0 &&
		(previous.intent !== "compare" || room.candidates >= R.compareMinCandidates)
	)
		return { ...previous, boutsLeft: previous.boutsLeft - 1 };
	const expertise = Math.max(
		0,
		Math.min(1, (elo - R.eloRange[0]) / (R.eloRange[1] - R.eloRange[0]))
	);
	const weights = INTENTS.map((intent, index) => {
		const base = R.baseWeights[index] ?? 0;
		let weight =
			(base + ((R.expertWeights[index] ?? base) - base) * expertise) *
			(R.persona[persona][index] ?? 1);
		if (intent === "compare" && room.candidates < R.compareMinCandidates) return 0;
		if (intent === "prepare" && context.phase === "opening") weight *= R.openingPrepareScale;
		if (intent === "verify" && sharp) weight *= R.sharpVerifyScale;
		if (intent === "still" && sharp) weight *= R.sharpStillScale;
		if (intent === "relate" && context.phase === "endgame") weight *= R.endgameRelationScale;
		if (previous?.intent === intent) weight *= R.repeatScale;
		return weight;
	});
	return { intent: rng.weighted(INTENTS, weights), boutsLeft: rng.int(...R.bouts) - 1, contextKey };
}

export type RepertoireTarget = { square: Square } | { between: readonly [Square, Square] };

/** A single weighted candidate and a distinct alternative, never an engine-rank scan. */
export function repertoireRoute(
	intent: RepertoireIntent,
	candidates: readonly MoveCandidate[],
	rng: Rng,
	committed?: { from: Square; to: Square }
): RepertoireTarget[] {
	if (intent === "still" || candidates.length === 0) return [];
	const pool = candidates.filter(
		(c, i) => c.from !== c.to && candidates.findIndex((v) => v.uci === c.uci) === i
	);
	const pick = (items: readonly MoveCandidate[]): MoveCandidate | undefined => {
		if (items.length === 0) return undefined;
		const weights = items.map((c) =>
			Number.isFinite(c.probability) ? Math.max(0, c.probability) : 0
		);
		return weights.some((w) => w > 0) ? rng.weighted(items, weights) : rng.pick(items);
	};
	const first = pick(pool);
	if (!first) return [];
	const square = (value: Square): RepertoireTarget => ({ square: value });
	if (intent === "prepare") return [square(committed?.from ?? first.from)];
	if (intent === "relate") return [{ between: [first.from, first.to] }, square(first.to)];
	if (intent === "verify") return [square(first.from), square(first.to), square(first.from)];
	if (intent === "compare") {
		const second = pick(pool.filter((c) => c.from !== first.from || c.to !== first.to));
		if (second) return [first.from, first.to, second.from, second.to, first.from].map(square);
	}
	return [square(first.from), square(first.to)];
}
