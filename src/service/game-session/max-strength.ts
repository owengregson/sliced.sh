/**
 * Max-strength mode's deep move search (owner, 2026-09-15): "when elo rating bar is 3800 … just
 * play the absolute best possible move in every situation with the deepest thought we can and
 * maximal performance - just the strongest possible outcome."
 *
 * The own-move pipeline (`recommendation.ts`) still runs first, unchanged: its MultiPV frame is
 * what the timing model's features read (`features.ts` derives complexity from the lines, so a
 * single line would change the human timing distribution — C7), what the panel shows and what the
 * predicted-position pre-analysis makes a cache hit. The timing model then plans the move, and only
 * then is the move itself decided by this search: one principal variation, no depth ceiling, full
 * strength, running until the hand must start its approach so the move still lands at the plan's
 * deadline. The session (`actOnRecommendation`) issues it only while the hand is armed.
 *
 * Board ratings never read any of it: they come from the move-review engine alone.
 */

import { matchingHistory, type PositionHistory } from "@core/chess/history";
import { legalMoves, parseUci, uciToSan } from "@core/chess/san";
import { MAX_STRENGTH } from "@core/constants/max-strength";
import type { AnalysisHandle, AnalysisRequest, AnalysisResult } from "@core/engine/types";
import { log } from "@core/logger";
import { moveQuality } from "@core/strength/quality";
import { errorMessage } from "@core/util/errors";
import { newId } from "@core/util/ids";
import type { EvalLine } from "@typedefs/engine";
import type { ChosenMove, Recommendation } from "@typedefs/game";
import type { TimingPlan } from "@typedefs/timing";
import { mergeLines } from "./recommendation/lines";
import { searchResultBeforeDeadline } from "./search-deadline";

export interface DeepSearchWindowInput {
	nowMs: number;
	/** When this position's search began (`Recommendation.computedAt`): the clock bounds count from it. */
	searchStartedAtMs: number;
	/** The timing model's plan for the move: its deadline and the hand's approach are fixed. */
	plan: Pick<TimingPlan, "deadlineMs" | "window">;
	/** Our clock when the search began; `0` when the page reports none (an untimed game). */
	myClockMs: number;
	/** `clockRacePolicy(...).maxSearchMs` when the position is a clock race. */
	raceMaxSearchMs?: number | undefined;
}

/**
 * How long the deep search may run from `nowMs`, or `0` when it is not worth starting. It ends at
 * the earliest of: the moment the hand must begin its approach (`plan.deadlineMs −
 * plan.window.approachMs − MAX_STRENGTH.handReserveMs`, so the move lands at the planned deadline,
 * never earlier and never later); `MAX_STRENGTH.clockFraction` of our clock after the position's
 * search began; and, in a clock race, the race's own `maxSearchMs` after that. Shorter than
 * `MAX_STRENGTH.minSearchMs` is `0`.
 */
export function deepSearchWindowMs(input: DeepSearchWindowInput): number {
	const ends = [input.plan.deadlineMs - input.plan.window.approachMs - MAX_STRENGTH.handReserveMs];
	if (input.myClockMs > 0)
		ends.push(input.searchStartedAtMs + MAX_STRENGTH.clockFraction * input.myClockMs);
	if (input.raceMaxSearchMs !== undefined)
		ends.push(input.searchStartedAtMs + input.raceMaxSearchMs);
	const windowMs = Math.floor(Math.min(...ends) - input.nowMs);
	return Number.isFinite(windowMs) && windowMs >= MAX_STRENGTH.minSearchMs ? windowMs : 0;
}

export interface DeepSearchRequestInput {
	fen: string;
	/** The validated game history, so the engine sees repetitions (ignored when it does not reach `fen`). */
	history?: PositionHistory | undefined;
	/** The session's active target (network routing and the engine's max-strength options). */
	targetElo: number;
	windowMs: number;
}

/**
 * The deep search: `MAX_STRENGTH.multiPv` line, `MAX_STRENGTH.searchDepth` (no ceiling of its own),
 * `movetime` = the window, no `elo` (full strength), at `move` priority so nothing else preempts it.
 */
export function deepSearchRequest(input: DeepSearchRequestInput): AnalysisRequest {
	const valid = matchingHistory(input.history, input.fen);
	return {
		id: newId(),
		targetElo: input.targetElo,
		fen: valid?.fen ?? input.fen,
		...(valid?.moves.length ? { moves: [...valid.moves] } : {}),
		multiPv: MAX_STRENGTH.multiPv,
		limit: { movetimeMs: input.windowMs, depth: MAX_STRENGTH.searchDepth },
		priority: "move",
	};
}

/** The engine surface the deep search needs (`EngineController` satisfies it). */
export interface DeepSearchEngine {
	analyse(req: AnalysisRequest): AnalysisHandle;
}

export interface DeepSearch {
	/** End the search now and keep what it found (a manual play-now). */
	harvest(): void;
	/** The search's result at its deadline or harvest; `null` when cancelled or failed. */
	readonly result: Promise<AnalysisResult | null>;
}

/** Issue `request`; it stops at `deadlineMs`, on `signal` (discarding) or on `harvest()` (keeping). */
export function startDeepSearch(
	engine: DeepSearchEngine,
	request: AnalysisRequest,
	options: { deadlineMs: number; now: () => number; signal: AbortSignal }
): DeepSearch {
	const handle = engine.analyse(request);
	return {
		harvest() {
			try {
				void handle
					.stop()
					.catch((error: unknown) =>
						log.debug("max strength: harvest stop failed", { error: errorMessage(error) })
					);
			} catch (error) {
				log.debug("max strength: harvest stop refused", { error: errorMessage(error) });
			}
		},
		result: searchResultBeforeDeadline(handle, request, options),
	};
}

export interface DeepenedMove {
	rec: Recommendation;
	/** The deep search's own frame (one line): what the resign rule reads for this move. */
	frame: EvalLine[];
}

/**
 * The recommendation with the deep search's move, or `null` to keep `rec` as it is: no result, no
 * legal scored line, a bounded (fail-high/low) line, or a frame shallower than the search that
 * already answered. The move is the engine's `bestmove` when a scored line starts with it, else the
 * frame's first line. An unchanged move keeps `rec.chosen` itself (the session keys state on it);
 * a changed one is a new `engine-elo` choice (`mate` for a searched forced mate). The deep line leads `lines` (the panel's top line and
 * eval), followed by the pipeline's other roots, renumbered.
 */
export function deepenRecommendation(
	rec: Recommendation,
	result: AnalysisResult | null
): DeepenedMove | null {
	if (!result) return null;
	const legal = new Set(legalMoves(rec.fen));
	const usable = result.final.lines
		.filter((line) => {
			const uci = line.pvUci[0];
			return uci !== undefined && legal.has(uci) && line.bound === undefined;
		})
		.sort((a, b) => a.multipv - b.multipv);
	const line =
		usable.find((candidate) => candidate.pvUci[0] === result.bestmove) ?? usable[0] ?? null;
	const uci = line?.pvUci[0];
	if (!line || uci === undefined || line.depth <= 0 || line.depth < rec.depth) return null;
	let chosen: ChosenMove = rec.chosen;
	if (uci !== rec.chosen.uci) {
		const parts = parseUci(uci);
		if (!parts) return null;
		// A searched forced mate is a mate, exactly as the selector labels one: no loss sample.
		const mating = (line.score.mate ?? 0) > 0;
		const measured = moveQuality([line], line);
		if (mating) {
			delete measured.cpLoss;
			measured.quality.eligible = false;
			measured.quality.reason = "mate";
		}
		chosen = {
			uci,
			san: line.pvSan[0] ?? uciToSan(rec.fen, uci) ?? uci,
			from: parts.from,
			to: parts.to,
			source: mating ? "mate" : "engine-elo",
			rankInLines: 1,
			...measured,
			rationale: [
				`max strength: the deep search's best move at depth ${line.depth} (the move search chose ${rec.chosen.san})`,
			],
		};
		if (parts.promotion !== undefined) chosen.promotion = parts.promotion;
	}
	const top: EvalLine = { ...line, multipv: 1 };
	const next: Recommendation = {
		...rec,
		chosen,
		lines: mergeLines([top], rec.lines),
		eval: line.score,
		depth: line.depth,
		nps: result.final.nps > 0 ? result.final.nps : rec.nps,
	};
	if (line.wdl) next.wdl = line.wdl;
	else delete next.wdl;
	return { rec: next, frame: [top] };
}
