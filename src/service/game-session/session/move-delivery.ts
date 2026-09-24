/**
 * Our own move, from the position to the hand: the §3.2 pipeline run for the position we are to
 * move in, what is done with its recommendation (schedule, resign, deepen, or leave it on display),
 * the manual play-now, and Fix G's one re-delivery of a position that was withheld because
 * something was not ready yet.
 */

import { EXECUTOR } from "@core/constants/cdp";
import { log } from "@core/logger";
import { createRng } from "@core/rng";
import { isMaxStrength } from "@core/strength/max-strength";
import { type QualityContext, qualityCohortKey } from "@core/strength/session-quality";
import { errorMessage } from "@core/util/errors";
import type { MoveContext } from "@service/move-executor";
import type { PositionSnapshot, Recommendation } from "@typedefs/game";
import type { RecommendationOutcome } from "../recommendation";
import { isMyTurnState } from "../transitions";
import type { BoardMarks } from "./board-marks";
import type { SessionCore } from "./core";
import type { DeepSearchPlay } from "./deep-search-play";
import type { EffectsFeed } from "./effects-feed";
import type { MaiaWarmup } from "./maia-warmup";
import type { MoveRecorder } from "./move-recorder";
import { boardKeyOf } from "./position-rules";
import type { Prediction } from "./prediction";
import type { QueuedPremove } from "./queued-premove";
import type { Redelivery } from "./redelivery";
import { repaced, timingContextFor } from "./replan";
import type { ResignFlow } from "./resign-flow";
import type { ReviewAdmission } from "./review-admission";

export interface MoveDeliveryParts {
	admission: ReviewAdmission;
	effects: EffectsFeed;
	marks: BoardMarks;
	recorder: MoveRecorder;
	prediction: Prediction;
	maia: MaiaWarmup;
	redelivery: Redelivery;
	resign: ResignFlow;
	deep: DeepSearchPlay;
	queue: QueuedPremove;
}

export interface MoveDeliveryHooks {
	moveContext(rec: Recommendation): MoveContext;
}

export class MoveDelivery {
	/** The pipeline run in flight for the position we are to move in. */
	pipelineAc: AbortController | null = null;
	/** A `playNow` issued while the pipeline was still running. */
	private playWhenReady = false;

	constructor(
		private readonly core: SessionCore,
		private readonly parts: MoveDeliveryParts,
		private readonly hooks: MoveDeliveryHooks
	) {}

	/** Abort the pipeline run in flight (its answer is for a position that is over). */
	abortPipeline(): void {
		this.pipelineAc?.abort();
		this.pipelineAc = null;
	}

	/** Forget a `playNow` that was waiting for the search. */
	dropPlayRequest(): void {
		this.playWhenReady = false;
	}

	/** Consume a `playNow` that was waiting (`true`): the caller plays now. */
	takePlayRequest(): boolean {
		if (!this.playWhenReady) return false;
		this.playWhenReady = false;
		return true;
	}

	/**
	 * §3.2 steps 1–5 for the current position.
	 *
	 * **Precondition — `turnFieldOf(snapshot.fen)` is `snapshot.myColor`, or the FEN states no turn
	 * and `snapshot.sideToMove` is `snapshot.myColor`.** The pipeline searches, selects, plans, marks
	 * and (armed) plays for whoever the FEN says is to move, so running it on the opponent's turn is
	 * the defect this lane exists to close (owner's live game, 2026-09-10).
	 *
	 * Both call sites establish exactly that by composition, rather than by a fourth test here that
	 * nothing could reach: `selfConsistent(snapshot)` gives `turnFieldOf(fen) === sideToMove` *or* a
	 * turn-less FEN, and `myTurn` gives `sideToMove === myColor`. The second disjunct is not an
	 * oversight — it is the bounded answer to a site that states no turn at all, which would otherwise
	 * stop the assistant for a whole game (`selfConsistent`'s own note), and
	 * `wrong-colour-guard.test.ts:200` asserts it on purpose. A new caller owes the same two.
	 * `test/behavioral/game/wrong-colour-guard.test.ts` pins the consequence — every move this produces
	 * is a legal move for `myColor` — and pins each conjunct with its own failing case.
	 */
	async runPipeline(snapshot: PositionSnapshot): Promise<void> {
		if (!this.core.pipeline || !this.core.timing) return;
		const ac = new AbortController();
		this.pipelineAc = ac;
		const prepared = this.parts.admission.beginPreparation(ac.signal);
		try {
			await this.runPipelinePrepared(snapshot, ac, prepared);
		} finally {
			prepared();
		}
	}

	private async runPipelinePrepared(
		snapshot: PositionSnapshot,
		ac: AbortController,
		prepared: () => void
	): Promise<void> {
		const core = this.core;
		const pipeline = core.pipeline;
		const timing = core.timing;
		// Fix G looked at this return first — "the engine is not ready yet" — and it is *not* the
		// silent hold that loses the first move. Both halves are decided once, for good, before any
		// position arrives: `SessionRegistry` always hands the session its `EngineController`
		// (non-null from worker boot), and `core.pipeline` / `core.timing` are written only by
		// `startGame` and `reprofile`. Nothing here becomes true a moment later, so there is nothing
		// to re-deliver. The engine being slow reaches us further down, at `!outcome`.
		if (!pipeline || !timing) return;
		// The engine queue waits for ponder's bestmove before sending the next go.
		// Keep that transition inside the pipeline's preparation deadline.
		void core.ponderer?.stop();
		const settings = core.settings();
		const expected = core.ponderer?.expectedReply(snapshot.fen) ?? null;
		const targetElo = core.targetElo();
		const qualityContext: QualityContext = {
			gameId: snapshot.gameId,
			targetElo,
			cohortKey: qualityCohortKey(targetElo, settings.strength, core.currentTimeControl()),
		};
		// §13.6 / 2026-09-11: the opponent's rating is the Maia query's second rating when known.
		const opponentElo = core.opponentInfo?.ratingEstimate ?? null;
		// H6.3: the first move decided locks the game's size; H7.3: the pre-inferred answer, when it
		// is for this very position (`onPosition` carried it across the cancel).
		const maiaSize = this.parts.maia.lockForDecision();
		const policyAnswer = this.parts.prediction.currentPolicyFor(snapshot);
		let outcome: RecommendationOutcome | null = null;
		try {
			outcome = await pipeline.run({
				snapshot,
				settings,
				targetElo,
				...(opponentElo !== null ? { opponentElo } : {}),
				...(maiaSize !== null ? { maiaSize } : {}),
				...(policyAnswer ? { policyAnswer } : {}),
				persona: settings.strength.persona,
				form: core.form.value,
				tau: timing.persona.tau,
				moves: core.history.moves,
				history: core.historyFor(snapshot.fen),
				expectedOppReply: expected,
				oppThinkMsHistory: core.history.oppThinkMs,
				myThinkMsHistory: core.history.myThinkMs,
				selectionState: core.selection,
				budgetUsedRatio: core.budgetUsedRatio(snapshot),
				// Seeded per position, not drawn from the game's stream: a republish of the same board
				// (an exact FEN replacing an approximate one, a clock tick carrying a different FEN
				// string) re-runs this pipeline, and a fresh draw from a shared stream made that re-run
				// land on a different move — the arrow jumping on the board with nothing on it changed.
				// With the seed tied to the position, identical inputs give the identical choice and
				// only an input that genuinely changed (the lines, the budget) can change the move. The
				// draws are as random across positions as before; they are simply reproducible within one.
				rng: createRng(`${core.gameSeed}:${snapshot.ply}:${boardKeyOf(snapshot.fen)}`),
				signal: ac.signal,
				nowMs: Math.min(core.positionArrivedAt ?? snapshot.capturedAt, core.now()),
				engineReady: core.deps.engine !== null,
				autoQueen: true,
				inputMethod: EXECUTOR.committedTier,
			});
		} catch (error) {
			log.warn("game-session: pipeline failed", { error: errorMessage(error) });
		}
		if (core.disposed || ac.signal.aborted || core.snapshot !== snapshot) return;
		this.pipelineAc = null;
		if (!outcome) {
			log.info("game-session: no recommendation for this position", { fen: snapshot.fen });
			// Fix G: the engine produced no usable line and the book had nothing — a search that
			// failed, crashed or answered `bestmove (none)` while Stockfish was still coming up. A
			// moment later it would have. Every move but the first gets that moment from the
			// opponent's reply; the first move as white has to ask again itself.
			this.parts.redelivery.whenReady("the engine produced no line for this position");
			return;
		}
		core.rec = outcome.rec;
		this.parts.recorder.noteQuality(outcome.rec.chosen, qualityContext);
		this.parts.recorder.notePosition(outcome.rec.chosen, snapshot.gameId, snapshot.ply);
		core.recNReasonable = outcome.nReasonable;
		// Board effects (2026-09-14): open our planned move's rating now, so the review engine
		// searches the position it will produce while the hand waits out the think time.
		this.parts.effects.preparePlanned(snapshot, outcome.rec.chosen.uci, settings, outcome.fromBook);
		core.apply("recommended");
		this.parts.marks.highlight(outcome.rec);
		core.notify();
		// Scheduling publishes the input budget synchronously before preparation reopens review.
		const acting = this.actOnRecommendation(outcome.rec);
		prepared();
		await acting;
	}

	/** §3.2 step 5 / §8.5: schedule, play at once, or leave the plan on display. */
	async actOnRecommendation(rec: Recommendation): Promise<void> {
		const core = this.core;
		const executor = core.executor;
		if (this.playWhenReady) {
			this.playWhenReady = false;
			await this.playNow();
			return;
		}
		if (!executor?.isArmed()) {
			// Panel-only mode (§7.5): keep deepening the eval on our own position.
			const history = core.historyFor(rec.fen);
			await core.ponderer?.start("panel", history.fen, history.moves);
			// Mirror of the opponent-turn re-check above: `start` can await, so a flip-off landing
			// inside it would have run `stopDisabled`'s stop before this search existed, leaving a
			// `go infinite` running with the assistant off.
			if (!core.mayAct()) await core.ponderer?.stop();
			return;
		}
		// 2026-09-12: a forced mate against us is resigned, not played out — unless the resign
		// control cannot be found, in which case the resign flow falls back to this very schedule.
		if (this.parts.resign.shouldResign(rec.lines)) {
			this.parts.resign.schedule(rec);
			return;
		}
		if (isMaxStrength(core.targetElo())) {
			await this.parts.deep.play(rec);
			return;
		}
		executor.schedule(rec, rec.plan, this.hooks.moveContext(rec));
	}

	/**
	 * One re-delivery of the position the session is still sitting on.
	 *
	 * The invariant: **a recommendation withheld because something was not ready yet is acted on
	 * when that thing becomes ready.** For every move but the first, the opponent's reply is what
	 * supplies that second chance — a fresh position runs the whole §3.2 pipeline again, so a
	 * momentary "not ready" costs one move. Playing white at ply 0 there is no reply and the
	 * position cannot change until the owner moves by hand, so the session has to carry its own
	 * second chance; without it the game sits there until the clock runs out (owner's report,
	 * 2026-09-10: "it sometimes doesnt make the first move (if youre on white)").
	 *
	 * One mechanism, because "not ready yet" is one condition. Its triggers are the moments a hold
	 * is released: the automatic `executor.arm()` resolving (`HandArming.autoArm` — the manual
	 * `arm()` has always re-checked, this is the same re-check for the path that did not), and the
	 * `Redelivery` timer armed where `runPipeline` gives up on a search that answered nothing.
	 * It re-runs the *same* tail `onPosition` would: the standing recommendation if there is one, a
	 * fresh pipeline run if there is not.
	 *
	 * The failure mode of all of this is playing twice, so every re-delivery goes through one gate:
	 *
	 *   - a move already pending (or on its way to the board) **is** this position's move — the
	 *     check `arm()` makes, widened by the hand's own run because a timer can fire mid-move and
	 *     a second request behind a cancelled run is parked, i.e. a second piece;
	 *   - and the §3.3 state — not the snapshot — is what says whether a move is still owed at all.
	 *     `live:opponent-turn` reaches here holding a *stale* my-turn snapshot and its
	 *     recommendation whenever the owner played by hand (or our move landed and the page has not
	 *     published the next position yet); running the pipeline on that would recommend, and an
	 *     armed hand would play, a move for the **opponent**.
	 *
	 * A re-delivered plan is **re-planned** before it is handed over, and what that buys is a truthful
	 * *record*, nothing more. `rec.plan.deadlineMs` is in the past by definition — that is what
	 * "withheld" means — so `MoveExecutor.schedule` fits the plan's `thinkMs` down to
	 * `EXECUTOR.minExecutionMs`, and the §8.6 row would then report a move that waited twenty seconds
	 * as a 250 ms think. `TimingModel.replan(…, "withheld-then-released")` is the existing reason for "the
	 * move could not be made when it was due": it folds the elapsed wait into the think, so
	 * `plannedMs`, the panel's plan line and `preMoveHoverMs` all match the wall-clock hold chess.com
	 * saw.
	 *
	 * It does **not** change the interval the page observes between the release and the move. That is
	 * the hand's motor path, which was already drawn per move: measured over 14 seeds it is
	 * 590–1010 ms with the re-plan and 590–1010 ms without it, 12 of the 14 byte-identical. An earlier
	 * round of this lane claimed the re-plan removed a constant-250 ms signature; there was no
	 * constant, and the claim was never measured. Keep the change for the record; do not claim the
	 * interval.
	 */
	async reconsider(reason: string): Promise<void> {
		const core = this.core;
		if (core.disposed) return;
		const snapshot = core.snapshot;
		// §4.4: the switch and the colour hold here exactly as they do on the position path.
		if (!snapshot || !core.mayActOn(snapshot)) return;
		const executor = core.executor;
		if (executor && (executor.pendingMove() !== null || executor.isRunning())) return;
		if (core.state !== "live:my-turn:analysing" && core.state !== "live:my-turn:recommended") return;
		// Max-strength mode: a deep search already running for the standing recommendation is itself
		// the second chance — it schedules the move when it settles.
		if (this.parts.deep.running()) return;
		const rec = core.rec;
		if (rec) {
			const paced = repaced(core, rec);
			log.info("game-session: acting on the recommendation that was held back", {
				tabId: core.tabId,
				ply: snapshot.ply,
				uci: paced.chosen.uci,
				thinkMs: Math.round(paced.plan.thinkMs),
				reason,
			});
			core.rec = paced;
			await this.actOnRecommendation(paced);
			return;
		}
		// A search already running for this position is itself the second chance.
		if (this.pipelineAc !== null) return;
		log.info("game-session: running the pipeline again for the held position", {
			tabId: core.tabId,
			ply: snapshot.ply,
			reason,
		});
		await this.runPipeline(snapshot);
	}

	/**
	 * `reconsider`, guaranteed not to reject. Every trigger is either a fire-and-forget callback (an
	 * arm's `.then`, the retry timer) or a command whose own result must not become an error because
	 * the follow-up failed — and the two that replaced synchronous code (`arm`'s tail, `handArmed`)
	 * would otherwise have turned a rejection into an unhandled one.
	 */
	async reconsiderGuarded(reason: string): Promise<void> {
		try {
			await this.reconsider(reason);
		} catch (error) {
			log.warn("game-session: acting on the held position failed", {
				tabId: this.core.tabId,
				reason,
				error: errorMessage(error),
			});
		}
	}

	/**
	 * Will `playNow()` reach the hand if called right now? Every condition `playNow` itself checks —
	 * §4.4's switch, §13.4's armed hand, and something to play — because `playNowRequested` answers
	 * the panel `true` on the strength of this and nothing may fall between the two: they run in one
	 * synchronous step, and `playNow` is synchronous up to its own `await`.
	 */
	hasPlayableMove(): boolean {
		const core = this.core;
		const executor = core.executor;
		if (!executor || !core.mayAct() || !executor.isArmed() || !isMyTurnState(core.state))
			return false;
		const pending = executor.pendingMove();
		if (pending && pending.rec === this.parts.queue.entry?.rec) return false;
		return (
			executor.canFastForward() &&
			(pending !== null ||
				core.rec !== null ||
				(this.pipelineAc !== null && !this.pipelineAc.signal.aborted))
		);
	}

	/** §8.5 manual path: the pending move (else the current recommendation) plays now. */
	async playNow(): Promise<void> {
		const core = this.core;
		const executor = core.executor;
		if (!executor) return;
		if (!isMyTurnState(core.state)) return;
		if (!core.mayAct()) {
			log.info("game-session: playNow refused — the assistant is off", { tabId: core.tabId });
			return;
		}
		if (!executor.isArmed()) {
			log.info("game-session: playNow ignored — the hand is not armed (§13.4)", {
				tabId: core.tabId,
			});
			return;
		}
		if (!executor.canFastForward()) return;
		const pending = executor.pendingMove();
		// Fix F: the only thing pending during the opponent's turn is a premove waiting for its
		// human moment. "Play the best move" is about *our* move, so it neither commits that premove
		// early nor falls through to a recommendation for the opponent's position.
		if (pending && this.parts.queue.isEntry(pending.rec)) {
			log.info("game-session: playNow ignored — the pending move is a premove", {
				tabId: core.tabId,
				uci: pending.rec.chosen.uci,
			});
			return;
		}
		if (pending) {
			core.apply("playNow");
			core.notify();
			await executor.playNow(pending.rec, pending.rec.plan, this.hooks.moveContext(pending.rec));
			return;
		}
		const rec = core.rec;
		if (!rec) {
			// The search is still running: play it the moment it answers.
			this.playWhenReady = true;
			core.apply("playNow");
			return;
		}
		// Max-strength mode: the deep search ends now and what it found is played at once — its
		// settlement (`DeepSearchPlay.play`) takes this `playWhenReady` back into `playNow`.
		const harvested = this.parts.deep.harvestFor(rec, () => {
			this.playWhenReady = true;
			core.apply("playNow");
			core.notify();
		});
		if (harvested) return;
		const timing = core.timing;
		const ctx = timing ? timingContextFor(core, rec) : null;
		const plan = timing && ctx ? timing.replan(rec.plan, ctx, "manual-now") : rec.plan;
		core.apply("playNow");
		core.notify();
		await executor.playNow(rec, plan, this.hooks.moveContext(rec));
	}
}
