/**
 * Resigning a lost game (2026-09-12): the trigger, the "evaluating the forced mate" pause before
 * the resign clicks, and the attempt once it fires — once per game. Cancelled by everything that
 * cancels a scheduled move (`cancelInFlight`, a disarm, disposal).
 */

import { RESIGN } from "@core/constants/resign";
import { log } from "@core/logger";
import { sampleRange } from "@core/motor/geometry";
import { errorMessage } from "@core/util/errors";
import type { MoveContext } from "@service/move-executor";
import type { ResignInput } from "@service/resign-input";
import type { EvalLine } from "@typedefs/engine";
import type { PositionSnapshot, Recommendation } from "@typedefs/game";
import { isResignableFrame } from "../resign-frame";
import { isMyTurnState } from "../transitions";
import type { SessionCore } from "./core";

export interface ResignFlowHooks {
	/** The withheld recommendation re-planned for the wait (`GameSession.reconsider`). */
	repaced(rec: Recommendation): Recommendation;
	moveContext(rec: Recommendation): MoveContext;
}

export class ResignFlow {
	private timer: unknown = null;
	private ac: AbortController | null = null;
	/** Once per game. */
	private attempted = false;

	constructor(
		private readonly core: SessionCore,
		private readonly hooks: ResignFlowHooks
	) {}

	/** A new game may be resigned once again. */
	resetForGame(): void {
		this.cancel();
		this.attempted = false;
	}

	/**
	 * The trigger: the best line is mate *against* us (side-to-move POV, `mate < 0`) in at most
	 * `RESIGN.maxMateIn` moves, from a search at least `RESIGN.minDepth` deep, and every scored
	 * line is mated too — nothing escapes. Once per game, and only when a `ResignInput` exists.
	 * A clock race is not considered on purpose: the mate is forced, so the position is resigned.
	 */
	shouldResign(frame: readonly EvalLine[]): boolean {
		if (this.attempted || !this.core.deps.resignInput) return false;
		// Settings layout, 2026-09-13: the owner can have every position played out instead.
		if (!this.core.settings().automation.resignLostGames) return false;
		// The line rule over one frame (`resign-frame.ts`): the move search's MultiPV frame, or in
		// max-strength mode the deep search's single line, where the best move mated means every move is.
		return isResignableFrame(frame);
	}

	/** The human moment spent "evaluating the forced mate" before the hand reaches for resign. */
	schedule(rec: Recommendation): void {
		const core = this.core;
		const snapshot = core.snapshot;
		if (!snapshot) return;
		this.cancel();
		const delayMs = sampleRange(RESIGN.delayMs, core.rng);
		const best = rec.lines.find((line) => line.multipv === 1) ?? rec.lines[0];
		log.info("game-session: forced mate against us — resigning instead of playing it out", {
			tabId: core.tabId,
			ply: snapshot.ply,
			mateIn: best?.score.mate,
			depth: best?.depth,
			delayMs: Math.round(delayMs),
		});
		this.timer = core.scheduler.setTimeout(() => {
			this.timer = null;
			void this.run(rec, snapshot).catch((error: unknown) =>
				log.warn("game-session: resign attempt failed", { error: errorMessage(error) })
			);
		}, delayMs);
	}

	/**
	 * Perform the resignation, once. `not-ready` (no control on the page) falls back to playing
	 * the recommended move so the game never stalls; `aborted` means something cancelled it and
	 * the position has moved on. Guarded against everything the delay may have outlived.
	 */
	private async run(rec: Recommendation, snapshot: PositionSnapshot): Promise<void> {
		const core = this.core;
		const input = core.deps.resignInput;
		const executor = core.executor;
		const stillCurrent = (): boolean =>
			!core.disposed &&
			core.snapshot === snapshot &&
			core.rec === rec &&
			core.executor === executor &&
			isMyTurnState(core.state) &&
			core.mayActOn(snapshot) &&
			executor?.isArmed() === true &&
			executor.pendingMove() === null;
		if (!input || !executor || !stillCurrent()) return;
		this.attempted = true;
		const ac = new AbortController();
		this.ac = ac;
		let result: Awaited<ReturnType<ResignInput["attempt"]>>;
		try {
			result = await input.attempt(core.tabId, ac.signal);
		} catch (error) {
			log.warn("game-session: resign input failed", { error: errorMessage(error) });
			result = { status: "not-ready" };
		}
		if (this.ac === ac) this.ac = null;
		if (result.status === "resigned") {
			log.info("game-session: resigned", { tabId: core.tabId, ply: snapshot.ply });
			core.notify();
			return;
		}
		if (result.status === "aborted" || ac.signal.aborted) return;
		log.info("game-session: resign control not found — playing the move instead", {
			tabId: core.tabId,
			step: result.step,
		});
		if (!stillCurrent()) return;
		const paced = this.hooks.repaced(rec);
		core.rec = paced;
		executor.schedule(paced, paced.plan, this.hooks.moveContext(paced));
		core.notify();
	}

	cancel(): void {
		if (this.timer !== null) {
			this.core.scheduler.clearTimeout(this.timer);
			this.timer = null;
		}
		this.ac?.abort();
		this.ac = null;
	}
}
