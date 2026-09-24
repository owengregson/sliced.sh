/**
 * The accounting for moves the session played: the §8.6 timing-log row and its realised think,
 * the §13.2 telemetry record of the move's window, and the §13.6 statistics fold — plus the
 * per-move bookkeeping all three are keyed by (the quality cohort a move was chosen under, the
 * game and ply it belongs to).
 */

import { parseFen, plyOf } from "@core/chess/fen";
import { TELEMETRY_BANDS } from "@core/constants/telemetry";
import type { QualityContext } from "@core/strength/session-quality";
import { buildTimingLogEntry } from "@core/timing/timing-log";
import type { ExecutionReport } from "@service/move-executor";
import type {
	ChosenMove,
	ExecutionResult,
	PositionSnapshot,
	Recommendation,
	SessionStats,
	Square,
} from "@typedefs/game";
import type { MoveTelemetryRecord } from "@typedefs/telemetry";
import type { TimingPlan } from "@typedefs/timing";
import { foldGame, foldMove } from "../stats";
import { selectedMultiplePieces } from "../telemetry";
import type { SessionCore } from "./core";
import { isScoredMove, TOP_LINE_RANK } from "./position-rules";
import { queueStatsWrite } from "./stats-writer";

/** A premove the next position confirmed, as `recordQueuedPremove` needs it. */
export interface ConfirmedPremove {
	chosen: ChosenMove;
	/** Ply of the position the premove belongs to: the one after the reply. */
	ply: number;
	plan: TimingPlan;
	/** Our clock in the position it was entered from (the §8.6 row's `clockMs`). */
	clockMs: number;
	/** The §13.2 record of the window the drag happened in. */
	record: MoveTelemetryRecord | null;
}

export class MoveRecorder {
	private readonly qualityContexts = new WeakMap<ChosenMove, QualityContext>();
	private readonly movePositions = new WeakMap<ChosenMove, { gameId: string; ply: number }>();
	/**
	 * Fix F / §13.2: the from-square of a premove the site **dropped**, after the page had already
	 * seen the press. The site's move window does not end when our drag does — it ends at the next
	 * submission — so that press is one of the pieces it counts as selected for the *next* move, and
	 * our own record of that move has to say so or the export understates the preview rate by
	 * exactly the premoves that were dropped. Consumed by the next move recorded.
	 */
	private droppedPremoveFrom: Square | null = null;

	constructor(private readonly core: SessionCore) {}

	resetForGame(): void {
		this.droppedPremoveFrom = null;
	}

	/** The quality cohort `chosen` was selected under. */
	noteQuality(chosen: ChosenMove, context: QualityContext): void {
		this.qualityContexts.set(chosen, context);
	}

	/** The game and ply `chosen` is played in. */
	notePosition(chosen: ChosenMove, gameId: string, ply: number): void {
		this.movePositions.set(chosen, { gameId, ply });
	}

	/** A deepened recommendation replaced `previous`: its move carries the same bookkeeping. */
	carryOver(previous: ChosenMove, next: ChosenMove, snapshot: PositionSnapshot): void {
		const quality = this.qualityContexts.get(previous);
		if (quality) this.qualityContexts.set(next, quality);
		this.movePositions.set(next, { gameId: snapshot.gameId, ply: snapshot.ply });
	}

	/** A premove the site dropped after the page had seen its press (see `droppedPremoveFrom`). */
	notePressedPremove(from: Square): void {
		this.droppedPremoveFrom = from;
	}

	/** The §8.6 row for a premove, which never goes through `planMove`. */
	appendPremoveRow(gameId: string, ply: number, plannedMs: number, clockMs: number): void {
		this.core.deps.timingLog.append(
			buildTimingLogEntry({
				gameId,
				ply,
				mode: "premove",
				plannedMs,
				alloc: 0,
				clockMs,
				comp: 1,
				eps: 0,
				terms: [],
				persona: this.core.settings().strength.persona,
			})
		);
	}

	/** §8.6 + §13.2: the realised think time and the move's telemetry record. */
	recordMove(report: ExecutionReport, current = true): void {
		const core = this.core;
		const { rec, result } = report;
		const snapshot = core.snapshot;
		const timing = core.timing;
		// §13.2: a premove the site dropped leaves its press inside the window the *site* closes with
		// this move, so it is one of the pieces it saw selected (Fix F).
		const alsoPressed = current ? this.droppedPremoveFrom : null;
		if (current) this.droppedPremoveFrom = null;
		const submittedAt =
			result.submittedAt ??
			(result.startedAt === undefined
				? (result.at ?? core.now())
				: result.startedAt + result.elapsedMs);
		// The plan starts before search/setup. Feeding only the remaining hand window back into
		// it makes an on-time move look too fast and drives subsequent plans shorter.
		const thinkMs = Math.max(result.elapsedMs, submittedAt - rec.computedAt);
		const qualityContext = this.qualityContexts.get(rec.chosen);
		const origin = this.movePositions.get(rec.chosen);
		const gameId = origin?.gameId ?? qualityContext?.gameId ?? core.game?.gameId ?? "";
		const original = parseFen(rec.fen);
		const ply =
			origin?.ply ?? (current ? snapshot?.ply : undefined) ?? (original ? plyOf(original) : 0);
		if (timing)
			timing.observe(thinkMs, rec.plan, { gameId, ply, adaptPace: result.paceOverride !== true });
		if (gameId === core.game?.gameId) core.history.myThinkMs.push(thinkMs);
		// A late confirmation belongs to its original ply, never the new position's open
		// telemetry window. Keep its timing/statistics without closing the newer window.
		core.deps.timingLog.markActual(gameId, ply, thinkMs, result.elapsedMs);
		if (current && snapshot && core.game) {
			const record = core.window.close({
				elapsedMs: result.elapsedMs,
				pointerOffsetPx: result.pointerOffsetPx ?? 0,
				multiplePieces:
					selectedMultiplePieces(result, rec.chosen.from) ||
					(alsoPressed !== null && alsoPressed !== rec.chosen.from),
				orientationMs: rec.plan.orientationMs,
				multiSelectEligible: multiSelectEligible(rec, snapshot),
				nReasonable: core.recNReasonable,
				// §13.6: only a move the engine actually ranked carries a quality pair.
				quality: isScoredMove(rec.chosen)
					? { top1: rec.chosen.rankInLines === TOP_LINE_RANK, cpLoss: rec.chosen.cpLoss ?? Number.NaN }
					: undefined,
				searchQuality: rec.chosen.quality,
				qualityContext: this.qualityContexts.get(rec.chosen),
				at: result.at ?? core.now(),
			});
			if (record) core.deps.timingLog.attachTelemetry(core.game.gameId, snapshot.ply, record);
		}
		void queueStatsWrite((stats) =>
			foldMove(stats, {
				thinkMs,
				scored: isScoredMove(rec.chosen),
				top1: rec.chosen.rankInLines === TOP_LINE_RANK,
				cpLoss: rec.chosen.cpLoss ?? Number.NaN,
				qualityContext: this.qualityContexts.get(rec.chosen),
			})
		);
	}

	/**
	 * §8.6 + §13.2 + §13.6 for a premove the next position confirmed. The row is written *here*,
	 * not when the drag went out: a row written at entry time would say a premove was played in a
	 * position the site may have dropped it in. `markActual` and `attachTelemetry` then find it
	 * under the ply the premove belongs to — the position after the reply, which this session never
	 * saw, because the site played our move in it.
	 */
	recordQueuedPremove(entry: ConfirmedPremove, result: ExecutionResult): void {
		const core = this.core;
		// The gesture happened before the opponent moved, and the two accepted plies may arrive
		// in one snapshot. Keep its physical duration without inventing a turn-to-acceptance time
		// or teaching the timing model that entry gesture as an ordinary own-turn observation.
		const gameId = core.game?.gameId ?? "";
		this.appendPremoveRow(gameId, entry.ply, entry.plan.thinkMs, entry.clockMs);
		core.deps.timingLog.markActual(gameId, entry.ply, null, result.elapsedMs);
		if (entry.record) core.deps.timingLog.attachTelemetry(gameId, entry.ply, entry.record);
		void queueStatsWrite((stats) =>
			foldMove(stats, {
				scored: isScoredMove(entry.chosen),
				top1: entry.chosen.rankInLines === TOP_LINE_RANK,
				cpLoss: entry.chosen.cpLoss ?? Number.NaN,
				qualityContext: this.qualityContexts.get(entry.chosen),
			})
		);
	}

	/** §13.6: the finished game's fold (serialized behind every move fold in the worker). */
	recordGame(gameId: string | null): Promise<void> {
		return queueStatsWrite((stats: SessionStats) => foldGame(stats, gameId));
	}
}

/** §13.2 / §9.3a: a move where a preview selection is plausible at all. */
function multiSelectEligible(rec: Recommendation, snapshot: PositionSnapshot): boolean {
	const b = TELEMETRY_BANDS.multiSelect;
	const mode = rec.plan.mode;
	const clockMs = snapshot.myColor ? snapshot.clocks[snapshot.myColor].ms : 0;
	return (
		(mode === "normal" || mode === "long") &&
		rec.plan.thinkMs >= b.minThinkMs &&
		clockMs >= b.minClockMs
	);
}
