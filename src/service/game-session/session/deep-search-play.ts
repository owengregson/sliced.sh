/**
 * Max-strength mode (owner, 2026-09-15): "just play the absolute best possible move in every
 * situation with the deepest thought we can". The standing recommendation's deep move search
 * (`max-strength.ts`), from the moment it is issued until it settles: `cancelInFlight` and
 * `dispose` abort it; `playNow` harvests it — the search ends and what it found is played at once.
 */

import type { AnalysisResult } from "@core/engine/types";
import { log } from "@core/logger";
import { errorMessage } from "@core/util/errors";
import type { MoveContext } from "@service/move-executor";
import type { PositionSnapshot, Recommendation } from "@typedefs/game";
import { remainingClockMs } from "../clock";
import {
	type DeepenedMove,
	type DeepSearch,
	deepenRecommendation,
	deepSearchRequest,
	deepSearchWindowMs,
	startDeepSearch,
} from "../max-strength";
import type { BoardMarks } from "./board-marks";
import type { SessionCore } from "./core";
import type { EffectsFeed } from "./effects-feed";
import type { MoveRecorder } from "./move-recorder";
import type { ResignFlow } from "./resign-flow";
import type { ReviewAdmission } from "./review-admission";

/** Max-strength mode's deep move search for one standing recommendation. */
interface DeepSearchEntry {
	rec: Recommendation;
	ac: AbortController;
	search: DeepSearch | null;
}

export interface DeepSearchPlayParts {
	admission: ReviewAdmission;
	effects: EffectsFeed;
	marks: BoardMarks;
	recorder: MoveRecorder;
	resign: ResignFlow;
}

export interface DeepSearchPlayHooks {
	moveContext(rec: Recommendation): MoveContext;
	/** A `playNow` arrived while the search ran: consume it (`true`) so it is played now. */
	takePlayWhenReady(): boolean;
	playNow(): Promise<void>;
}

export class DeepSearchPlay {
	private entry: DeepSearchEntry | null = null;

	constructor(
		private readonly core: SessionCore,
		private readonly parts: DeepSearchPlayParts,
		private readonly hooks: DeepSearchPlayHooks
	) {}

	/** A deep search is running for the standing recommendation (it is itself the second chance). */
	running(): boolean {
		return this.entry !== null;
	}

	/** Drop the deep move search, if one is running (what it found is discarded). */
	abort(): void {
		const deep = this.entry;
		this.entry = null;
		deep?.ac.abort();
	}

	/**
	 * `playNow` on `rec` while its deep search runs: end the search now so what it found is played
	 * at once (`play` takes the caller's `playWhenReady` back into `playNow`). `false` when there is
	 * no live search for `rec`.
	 */
	harvestFor(rec: Recommendation, beforeHarvest: () => void): boolean {
		const deep = this.entry;
		if (!deep || deep.rec !== rec || deep.ac.signal.aborted) return false;
		beforeHarvest();
		deep.search?.harvest();
		return true;
	}

	/**
	 * The move is decided by the deep search (`max-strength.ts`), which runs until the hand must
	 * start its approach, and is then scheduled on the timing model's own plan — the deadline does
	 * not move, so the move is never played faster than planned (C7). A position, switch or hand
	 * change during the search drops its answer; a play-now harvests it. A forced mate the deep
	 * frame proves is resigned exactly as the move search's would be.
	 */
	async play(rec: Recommendation): Promise<void> {
		const core = this.core;
		const snapshot = core.snapshot;
		const deep = await this.deepen(rec);
		const executor = core.executor;
		if (
			core.disposed ||
			!snapshot ||
			core.snapshot !== snapshot ||
			core.rec !== rec ||
			!executor?.isArmed() ||
			executor.pendingMove() !== null ||
			executor.isRunning() ||
			!core.mayActOn(snapshot)
		)
			return;
		if (deep) this.adopt(rec, deep.rec, snapshot);
		const act = deep?.rec ?? rec;
		if (this.hooks.takePlayWhenReady()) {
			await this.hooks.playNow();
			return;
		}
		if (deep && this.parts.resign.shouldResign(deep.frame)) {
			this.parts.resign.schedule(act);
			return;
		}
		executor.schedule(act, act.plan, this.hooks.moveContext(act));
	}

	/**
	 * Run the deep search for `rec` and read its answer (`deepenRecommendation`), or `null` when there
	 * is nothing to search with, the window is too short (`deepSearchWindowMs`), the search was
	 * aborted or failed, or it found nothing deeper than the move search already had.
	 */
	private async deepen(rec: Recommendation): Promise<DeepenedMove | null> {
		const core = this.core;
		const snapshot = core.snapshot;
		const engine = core.deps.engine;
		const myColor = snapshot?.myColor ?? null;
		if (!snapshot || !engine || myColor === null || rec.fen !== snapshot.fen) return null;
		// The tablebase's move is already perfect: no search can improve on it (2026-09-23).
		if (rec.chosen.source === "tablebase") return null;
		const windowMs = deepSearchWindowMs({
			nowMs: core.now(),
			searchStartedAtMs: rec.computedAt,
			plan: rec.plan,
			myClockMs: remainingClockMs(snapshot, myColor, rec.computedAt),
			raceMaxSearchMs: core.racePolicyFor(snapshot)?.maxSearchMs,
		});
		if (windowMs === 0) return null;
		const request = deepSearchRequest({
			fen: snapshot.fen,
			history: core.historyFor(snapshot.fen),
			targetElo: core.targetElo(),
			windowMs,
		});
		const entry: DeepSearchEntry = { rec, ac: new AbortController(), search: null };
		this.entry = entry;
		const prepared = this.parts.admission.beginPreparation(entry.ac.signal);
		log.debug("game-session: max strength — deep move search", {
			tabId: core.tabId,
			ply: snapshot.ply,
			windowMs,
			searched: rec.chosen.uci,
			depth: rec.depth,
		});
		try {
			entry.search = startDeepSearch(engine, request, {
				deadlineMs: core.now() + windowMs,
				now: () => core.now(),
				signal: entry.ac.signal,
			});
			const result: AnalysisResult | null = await entry.search.result;
			if (entry.ac.signal.aborted) return null;
			const deepened = deepenRecommendation(rec, result);
			log.debug("game-session: max strength — deep move search settled", {
				tabId: core.tabId,
				depth: result?.final.depth ?? 0,
				uci: deepened?.rec.chosen.uci ?? rec.chosen.uci,
				changed: deepened !== null && deepened.rec.chosen !== rec.chosen,
			});
			return deepened;
		} catch (error) {
			log.debug("game-session: max-strength search unavailable", { error: errorMessage(error) });
			return null;
		} finally {
			if (this.entry === entry) this.entry = null;
			prepared();
		}
	}

	/**
	 * The deep search's recommendation replaces the standing one. A changed move carries the move's
	 * bookkeeping, gets its own review of the position it produces, and replaces the board mark.
	 */
	private adopt(previous: Recommendation, next: Recommendation, snapshot: PositionSnapshot): void {
		const core = this.core;
		core.rec = next;
		if (next.chosen !== previous.chosen) {
			this.parts.recorder.carryOver(previous.chosen, next.chosen, snapshot);
			this.parts.effects.preparePlanned(snapshot, next.chosen.uci, core.settings());
			this.parts.marks.highlight(next);
		}
		core.notify();
	}
}
