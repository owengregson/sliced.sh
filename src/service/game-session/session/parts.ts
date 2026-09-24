/**
 * The collaborators one `GameSession` is built from, wired to each other once, plus the three
 * actions nearly all of them share: the `MoveContext` every route to the hand carries, giving up
 * the premove, and cancelling everything in flight for the position that is over.
 */

import type { MoveContext } from "@service/move-executor";
import type { Recommendation } from "@typedefs/game";
import type { BoardEffectsReporter } from "../board-effects";
import type { LobbyVerdict } from "../lobby";
import { BoardMarks } from "./board-marks";
import type { SessionCore } from "./core";
import { DeepSearchPlay } from "./deep-search-play";
import { createSessionReporter, EffectsFeed } from "./effects-feed";
import { ExecutorBinding } from "./executor-binding";
import { FocusDiscipline } from "./focus-discipline";
import { HandArming } from "./hand-arming";
import { LobbyHold } from "./lobby-hold";
import { MaiaWarmup } from "./maia-warmup";
import { moveContextFor } from "./move-context";
import { MoveDelivery } from "./move-delivery";
import { MoveRecorder } from "./move-recorder";
import { OpponentTurn } from "./opponent-turn";
import { PositionFeed } from "./position-feed";
import { Prediction } from "./prediction";
import { PremoveArming } from "./premove";
import { QueuedPremove } from "./queued-premove";
import { Redelivery } from "./redelivery";
import { repaced } from "./replan";
import { ResignFlow } from "./resign-flow";
import { ReviewAdmission } from "./review-admission";
import { ScrambleHold } from "./scramble-hold";
import { TimeControlProfile } from "./time-control";

/** What the parts need from the session's lifecycle, bound after it exists. */
export interface SessionPartsHooks {
	/** The lobby hold ended: a game is on the board. */
	lobbyEnded(reason: string, verdict: LobbyVerdict): void;
}

export class SessionParts {
	readonly hand: HandArming;
	/**
	 * Board effects (owner's brief, 2026-09-13): what the move that just landed did, and how good
	 * it was. Both sides' moves; the rays gated on `Settings.automation.boardEffects`, the rating on
	 * `automation.moveQualityChips`, each on its own (owner, 2026-09-15).
	 */
	readonly boardEffects: BoardEffectsReporter;
	readonly admission: ReviewAdmission;
	readonly effects: EffectsFeed;
	readonly marks: BoardMarks;
	readonly lobby: LobbyHold;
	readonly resign: ResignFlow;
	readonly redelivery: Redelivery;
	readonly profile: TimeControlProfile;
	readonly maia: MaiaWarmup;
	readonly prediction: Prediction;
	readonly recorder: MoveRecorder;
	readonly arming: PremoveArming;
	readonly queue: QueuedPremove;
	readonly holds: ScrambleHold;
	readonly deep: DeepSearchPlay;
	readonly delivery: MoveDelivery;
	readonly executors: ExecutorBinding;
	readonly opponentTurn: OpponentTurn;
	readonly feed: PositionFeed;
	readonly focusDiscipline: FocusDiscipline;

	constructor(
		private readonly core: SessionCore,
		hooks: SessionPartsHooks
	) {
		this.hand = new HandArming(core, {
			reconsider: (reason) => this.delivery.reconsiderGuarded(reason),
			startOpponentExploration: () => this.opponentTurn.explore(),
			cancelResign: () => this.resign.cancel(),
			forgetPremove: (reason) => this.forgetPremove(reason),
			updateReviewAdmission: () => this.admission.update(),
			pipelineRunning: () => this.delivery.pipelineAc !== null,
			hideCursor: () => this.marks.hideCursor(),
			lobbyHeld: () => this.lobby.held(),
		});
		this.boardEffects = createSessionReporter(core);
		this.admission = new ReviewAdmission(core, this.boardEffects);
		this.effects = new EffectsFeed(core, this.boardEffects, this.admission);
		this.marks = new BoardMarks(core);
		this.lobby = new LobbyHold(core, {
			confirmed: () => this.hand.releaseForLobby(),
			ended: (reason, verdict) => hooks.lobbyEnded(reason, verdict),
		});
		this.resign = new ResignFlow(core, {
			repaced: (rec) => repaced(core, rec),
			moveContext: (rec) => this.moveContext(rec),
		});
		this.redelivery = new Redelivery(core, (reason) => this.delivery.reconsiderGuarded(reason));
		this.profile = new TimeControlProfile(core, (snapshot) => this.delivery.runPipeline(snapshot));
		this.maia = new MaiaWarmup(core, () => {
			this.cancelInFlight();
			core.rec = null;
			this.forgetPremove("the active selection configuration changed");
			this.marks.clear();
		});
		this.prediction = new Prediction(core, this.maia, {
			armedPremove: () => this.arming.armed,
			gatePremove: (reply, predicted, result) => this.arming.gateWithPolicy(reply, predicted, result),
		});
		this.recorder = new MoveRecorder(core);
		this.arming = new PremoveArming(core, this.prediction, this.recorder, {
			entered: () => this.queue.entry !== null,
			moveContext: (rec) => this.moveContext(rec),
		});
		this.queue = new QueuedPremove(core, this.arming, this.recorder, {
			moveContext: (rec) => this.moveContext(rec),
			startOpponentExploration: () => this.opponentTurn.explore(),
		});
		this.holds = new ScrambleHold(core, this.arming, this.queue, this.prediction, {
			moveContext: (rec) => this.moveContext(rec),
		});
		this.deep = new DeepSearchPlay(
			core,
			{
				admission: this.admission,
				effects: this.effects,
				marks: this.marks,
				recorder: this.recorder,
				resign: this.resign,
			},
			{
				moveContext: (rec) => this.moveContext(rec),
				takePlayWhenReady: () => this.delivery.takePlayRequest(),
				playNow: () => this.delivery.playNow(),
			}
		);
		this.delivery = new MoveDelivery(
			core,
			{
				admission: this.admission,
				effects: this.effects,
				marks: this.marks,
				recorder: this.recorder,
				prediction: this.prediction,
				maia: this.maia,
				redelivery: this.redelivery,
				resign: this.resign,
				deep: this.deep,
				queue: this.queue,
			},
			{ moveContext: (rec) => this.moveContext(rec) }
		);
		this.executors = new ExecutorBinding(core, {
			hand: this.hand,
			admission: this.admission,
			queue: this.queue,
			marks: this.marks,
			recorder: this.recorder,
			redelivery: this.redelivery,
		});
		this.opponentTurn = new OpponentTurn(core, {
			arming: this.arming,
			queue: this.queue,
			holds: this.holds,
			prediction: this.prediction,
		});
		this.feed = new PositionFeed(core, {
			effects: this.effects,
			lobby: this.lobby,
			profile: this.profile,
		});
		this.focusDiscipline = new FocusDiscipline(core, {
			premoveWindow: () => this.queue.entry?.window ?? null,
			reconsider: (reason) => this.delivery.reconsiderGuarded(reason),
		});
	}

	moveContext(rec: Recommendation): MoveContext {
		return moveContextFor(this.core, rec, {
			premovePending: this.queue.entry !== null || this.holds.holding(),
			requirePositionCheck: this.redelivery.isGuarded(rec.chosen),
			queuedPremove: this.queue.isEntry(rec),
		});
	}

	/** Give up the premove — the arm, and (the site's, Fix F) the entry — and say why. */
	forgetPremove(reason: string): void {
		this.arming.drop();
		this.queue.abandon(reason);
	}

	cancelInFlight(keepHand = false): void {
		const core = this.core;
		core.workGeneration += 1;
		this.delivery.abortPipeline();
		this.deep.abort();
		this.delivery.dropPlayRequest();
		this.resign.cancel();
		// `keepHand`: the hand is releasing a scramble hold into this very position (`onPosition`),
		// and a cancel would abandon it instead. Everything else in flight still stops.
		if (!keepHand) core.executor?.cancel();
		if (!keepHand) this.holds.dropEntry();
		// H7.3: the answer goes with the analysis it sat beside (`onPosition` re-instates the one
		// for the position that has just arrived), and a query in flight is for a stale board.
		this.prediction.forget();
		this.prediction.abortPolicy();
		this.holds.clearTimers();
		void core.ponderer?.stop();
		// The prediction it was preparing for is no longer the live one (§4.4 stops it too).
		this.prediction.stopPreAnalysis();
		// Fix G: whatever the held position was waiting for, it is not this session's business any
		// more — and the per-position retry budget starts fresh with the next one.
		this.redelivery.clear();
		this.profile.clearHold();
	}
}
