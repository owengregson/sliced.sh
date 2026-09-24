/**
 * Fix G's one pending re-delivery of a withheld position (`GameSession.reconsider`) and its
 * per-position attempt budget, plus the recoveries that must ask the executor for a fresh
 * pre-dispatch position check.
 */

import { TIMINGS } from "@core/constants/timings";
import { log } from "@core/logger";
import { errorMessage } from "@core/util/errors";
import type { ChosenMove, Recommendation } from "@typedefs/game";
import { isMyTurnState } from "../transitions";
import type { SessionCore } from "./core";

export class Redelivery {
	private timer: unknown = null;
	private attempts = 0;
	/** Recoveries always ask the executor for a fresh pre-dispatch position check. */
	private readonly guarded = new WeakSet<ChosenMove>();

	constructor(
		private readonly core: SessionCore,
		private readonly reconsider: (reason: string) => Promise<void>
	) {}

	/** Must the executor re-check the position before dispatching this move? */
	isGuarded(chosen: ChosenMove): boolean {
		return this.guarded.has(chosen);
	}

	/**
	 * Arm the one re-delivery, `TIMINGS.sessionRetryMs` from now. The budget
	 * (`TIMINGS.sessionRetryMax`) is per position — `cancelInFlight` resets it — and when it is
	 * spent the session says so at `warn` rather than sitting silently: the service worker's own
	 * `log.*` calls reach the panel's log stream, where `warn` is already a rendered kind
	 * (`COPY.engine.logKinds.warn`).
	 */
	whenReady(reason: string, stillCurrent?: () => boolean): void {
		const core = this.core;
		if (core.disposed || this.timer !== null) return;
		if (this.attempts >= TIMINGS.sessionRetryMax) {
			log.warn("game-session: nothing became ready — this position cannot be played", {
				tabId: core.tabId,
				ply: core.snapshot?.ply ?? null,
				attempts: this.attempts,
				reason,
			});
			return;
		}
		this.attempts += 1;
		this.timer = core.scheduler.setTimeout(() => {
			this.timer = null;
			if (stillCurrent && !stillCurrent()) return;
			void this.reconsider(reason);
		}, TIMINGS.sessionRetryMs);
	}

	/** A failed pre-dispatch attempt may recover only while the same automatic move is still owed. */
	heldRecommendation(rec: Recommendation, reason: string): void {
		const core = this.core;
		const executor = core.executor;
		const snapshot = core.snapshot;
		if (!executor || !snapshot) return;
		const generation = executor.cancellationGeneration();
		const stillCurrent = (): boolean =>
			!core.disposed &&
			core.executor === executor &&
			core.snapshot === snapshot &&
			core.rec === rec &&
			isMyTurnState(core.state) &&
			core.mayActOn(snapshot) &&
			executor.isArmed() &&
			executor.cancellationGeneration() === generation &&
			executor.pendingMove() === null;
		// Terminal callbacks precede execute()'s finally. Await the hand before reconsidering,
		// otherwise its running guard would consume this position's only recovery attempt.
		void executor
			.whenIdle()
			.then(() => {
				if (!stillCurrent()) return;
				this.whenReady(reason, () => {
					if (!stillCurrent()) return false;
					this.guarded.add(rec.chosen);
					return true;
				});
			})
			.catch((error: unknown) =>
				log.warn("game-session: waiting to recover the held move failed", {
					error: errorMessage(error),
				})
			);
	}

	/** Drop the pending re-delivery and its budget (the position it belonged to is over). */
	clear(): void {
		if (this.timer !== null) this.core.scheduler.clearTimeout(this.timer);
		this.timer = null;
		this.attempts = 0;
	}
}
