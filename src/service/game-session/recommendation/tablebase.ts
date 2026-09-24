/**
 * The endgame tablebase's part (2026-09-23): a probe for a ≤ 7-man position that overlaps the
 * search, and the tables' best move read from it before selection. When it answers in time with
 * a legal move, that move replaces the selector's; otherwise the engine plays as before.
 *
 * Ordering against the Maia calibration (`MAIA_CALIBRATION`): the tablebase decision comes first
 * and sits outside the selector. `decideTablebase` judges the advertised rating (target and form,
 * no calibration) because its policy was measured against human ratings directly; the calibration
 * lives inside `selectMove`'s Maia branch and only shapes a move the tables did not supply. When
 * the tables answer, `selectMove` is not called at all, so none of its draws (tilt, rails, Maia
 * draw) consume the game's rng on that move (`docs/qa/endgame-tablebases-2026-09-23.md`).
 */

import { TABLEBASE } from "@core/constants/tablebase";
import { log } from "@core/logger";
import { effectiveElo } from "@core/strength/elo-map";
import { isMaxStrength } from "@core/strength/max-strength";
import { decideTablebase } from "@core/strength/tablebase-policy";
import { tablebaseChosenMove } from "@core/tablebase/choice";
import type { TablebasePort } from "@core/tablebase/client";
import { pieceCount, type TablebaseProbe } from "@core/tablebase/probe";
import { rankTablebaseMoves } from "@core/tablebase/rank";
import { errorMessage } from "@core/util/errors";
import type { EvalLine } from "@typedefs/engine";
import type { ChosenMove } from "@typedefs/game";

import type { OwnMoveContext, PreparationWindow } from "./context";
import { ownMoveClockRace } from "./own-move";
import type { RecommendationInput } from "./types";

/** A probe in flight and the policy probability it was drawn at (for the rationale). */
export interface TablebasePending {
	pending: Promise<TablebaseProbe | null>;
	p: number;
}

/**
 * Start a tablebase probe for a ≤ 7-man position when the policy plays the tables' move here
 * (`decideTablebase`: always at max strength, occasionally at human ratings, never below the
 * floor), or `null`. The draw is made first, so a position the policy would not play from never
 * leaves the browser; it consumes the game's rng only when the probability is strictly between
 * 0 and 1.
 */
export function tablebaseProbe(
	port: TablebasePort | null,
	input: RecommendationInput
): TablebasePending | null {
	const fen = input.snapshot.fen;
	const pieces = pieceCount(fen);
	if (!port || !input.settings.strength.useTablebase || pieces === null) return null;
	if (pieces > TABLEBASE.maxPieces) return null;
	const E = effectiveElo(input.targetElo, input.form);
	const decision = decideTablebase(input.targetElo, E, pieces, input.rng);
	if (!decision.use) {
		if (decision.p > 0)
			log.debug("recommendation: tablebase not consulted this move", { p: decision.p, pieces });
		return null;
	}
	let pending: Promise<TablebaseProbe | null>;
	try {
		pending = port.probe(fen).catch((error: unknown) => {
			log.debug("recommendation: tablebase probe failed", { error: errorMessage(error) });
			return null;
		});
	} catch (error) {
		log.debug("recommendation: tablebase probe refused", { error: errorMessage(error) });
		return null;
	}
	return { pending, p: decision.p };
}

/**
 * How long the selection stage may wait for the probe: up to the preparation deadline, and at max
 * strength outside a clock race at least `TABLEBASE.maxStrengthMinWaitMs` from the start of
 * preparation — max strength always plays the tables' move, so it waits a little past a quick
 * search for the probe already in flight.
 */
export function tablebaseWaitMs(
	input: RecommendationInput,
	own: OwnMoveContext,
	window: PreparationWindow,
	now: number
): number {
	const clockRace = ownMoveClockRace({
		fen: input.snapshot.fen,
		myClockMs: own.myClockMs,
		oppClockMs: own.oppClockMs,
		timeControl: input.snapshot.timeControl,
	});
	return Math.max(
		window.deadlineMs - now,
		isMaxStrength(input.targetElo) && clockRace === null
			? window.startedAt + TABLEBASE.maxStrengthMinWaitMs - now
			: 0
	);
}

/**
 * The tables' best move for the position, waiting at most `waitMs` for the probe (0 reads only
 * an answer already in hand), or `null` — no answer in time, nothing legal in it, or the
 * position moved on. The engine's lines only break ties between moves of equal result.
 */
export async function tablebaseMove(
	input: RecommendationInput,
	probe: TablebasePending,
	lines: readonly EvalLine[],
	options: { waitMs: number }
): Promise<ChosenMove | null> {
	const answer = await new Promise<TablebaseProbe | null>((resolve) => {
		const finish = (value: TablebaseProbe | null) => {
			clearTimeout(timer);
			input.signal?.removeEventListener("abort", onAbort);
			resolve(value);
		};
		const onAbort = () => finish(null);
		// A zero wait is still a macrotask: an already-settled probe is read before the timer fires.
		const timer = setTimeout(() => finish(null), Math.max(0, options.waitMs));
		if (input.signal?.aborted) onAbort();
		else input.signal?.addEventListener("abort", onAbort, { once: true });
		probe.pending.then(finish, () => finish(null));
	});
	if (!answer) {
		log.debug("recommendation: no tablebase answer in time, engine plays", {
			waitMs: Math.round(options.waitMs),
		});
		return null;
	}
	const fen = input.snapshot.fen;
	const ranked = rankTablebaseMoves({
		fen,
		probe: answer,
		history: input.history,
		enginePreference: lines.flatMap((line) => (line.pvUci[0] ? [line.pvUci[0]] : [])),
	});
	if (!ranked) return null;
	const chosen = tablebaseChosenMove(fen, ranked, lines, [
		`tablebase: ${ranked.outcome} (p=${Number(probe.p.toFixed(3))})`,
	]);
	if (chosen)
		log.debug("recommendation: tablebase move", {
			uci: chosen.uci,
			outcome: ranked.outcome,
			zeroingPlies: ranked.best.zeroingPlies,
		});
	return chosen;
}
