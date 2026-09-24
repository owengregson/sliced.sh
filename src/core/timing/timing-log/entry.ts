/** A `TimingLogEntry` built from one planned move: the top five head terms and the plan's rationale. */
import type { PersonaId } from "@typedefs/settings";
import type { TimingLogEntry, TimingMode, TimingModelSource } from "@typedefs/timing";

const TOP_TERMS = 5;

export interface TimingLogInput {
	gameId: string;
	ply: number;
	mode: TimingMode;
	plannedMs: number;
	alloc: number;
	clockMs: number;
	comp: number;
	eps: number;
	/** All `β_i f_i` contributions; the entry keeps the top 5 by |value|. */
	terms: ReadonlyArray<readonly [string, number]>;
	persona: PersonaId;
	model?: TimingModelSource;
	targetElo?: number;
	opponentClockMs?: number;
	rationale?: string[];
}

export function buildTimingLogEntry(input: TimingLogInput): TimingLogEntry {
	const topTerms = [...input.terms]
		.sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))
		.slice(0, TOP_TERMS)
		.map(([name, value]): [string, number] => [name, value]);
	return {
		gameId: input.gameId,
		ply: input.ply,
		mode: input.mode,
		plannedMs: input.plannedMs,
		actualMs: null,
		alloc: input.alloc,
		clockMs: input.clockMs,
		comp: input.comp,
		eps: input.eps,
		topTerms,
		persona: input.persona,
		...(input.model ? { model: { ...input.model } } : {}),
		...(input.targetElo !== undefined ? { targetElo: input.targetElo } : {}),
		...(input.opponentClockMs !== undefined ? { opponentClockMs: input.opponentClockMs } : {}),
		...(input.rationale ? { rationale: [...input.rationale] } : {}),
	};
}
