/**
 * One game from start to end: the per-game reset and the models built for it (`startGame`), the
 * post-game accounting and the auto-queue (`finishGame`), a session break, and the lobby hold
 * ending with a game on the board.
 */

import { log } from "@core/logger";
import { createRng } from "@core/rng";
import { createSelectionState } from "@core/strength/move-selector";
import { createFormLatent } from "@core/strength/persona";
import { errorMessage } from "@core/util/errors";
import type { GameMeta, GameResult } from "@typedefs/game";
import type { LobbyVerdict } from "../lobby";
import { PonderController } from "../ponder";
import type { SessionCore } from "./core";
import type { SessionParts } from "./parts";
import { motorTcClass } from "./position-rules";

export class GameLifecycle {
	/** The finish of the game that just ended, so a repeated `gameEnded` waits on the same work. */
	finishingGame: Promise<void> | null = null;

	constructor(
		private readonly core: SessionCore,
		private readonly parts: SessionParts
	) {}

	startGame(meta: GameMeta): void {
		const core = this.core;
		this.parts.cancelInFlight();
		this.parts.effects.forgetArrival();
		this.cancelQueueForNewGame(meta.gameId);
		this.finishingGame = null;
		core.game = meta;
		core.site = meta.site;
		core.snapshot = null;
		core.positionArrivedAt = null;
		core.rec = null;
		this.parts.arming.drop();
		this.parts.queue.resetForGame();
		this.parts.recorder.resetForGame();
		this.parts.resign.resetForGame();
		core.history.reset();
		this.parts.feed.reset();
		core.selection = createSelectionState();
		const gameSeed = `${core.seed}:${meta.gameId}`;
		core.gameSeed = gameSeed;
		core.rng = createRng(`${gameSeed}:session`);
		core.form = createFormLatent(createRng(`${gameSeed}:form`));
		core.window.discard();
		// A new board: the lobby's clock stillness starts over (the URL flag is the caller's).
		this.parts.lobby.resetStillness();

		const settings = core.settings();
		const targetElo = core.targetElo();
		const { tc, timing } = this.parts.profile.beginGame(meta, settings, targetElo);
		// §4.4: with the switch off nothing will search, so nothing is pre-warmed either.
		if (core.mayAct()) core.deps.warmTiming?.(targetElo);
		// H6.3: the size this game plays with, from the target as it stands at game start.
		this.parts.maia.commitForGame(targetElo, settings);
		this.parts.prediction.policy = null;
		this.parts.prediction.abortPolicy();
		this.parts.maia.warmFor(targetElo, true);
		// H14.1: the opening repertoire's keys are read (or created) before the first book move.
		void core.deps.book
			?.prepare?.()
			.catch((error: unknown) =>
				log.debug("game-session: repertoire not prepared", { error: errorMessage(error) })
			);

		const engine = core.deps.engine;
		if (engine) {
			void engine
				.newGame(meta.gameId)
				.catch((error: unknown) => log.warn("game-session: ucinewgame failed", error));
			core.ponderer?.dispose();
			core.ponderer = new PonderController({
				getTargetElo: () => core.targetElo(),
				engine,
				scheduler: core.scheduler,
				now: core.now,
				onUpdate: () => core.notify(),
			});
		}
		core.pipeline = this.parts.profile.pipelineFor(timing);

		this.parts.executors.attach({
			site: meta.site,
			persona: settings.strength.persona,
			tcClass: motorTcClass(tc),
			gameSeed,
		});
		this.parts.marks.pushContentSettings();
		this.parts.effects.warm();
		log.info("game-session: game started", {
			tabId: core.tabId,
			gameId: meta.gameId,
			site: meta.site,
			targetElo,
			tc,
		});
	}

	async finishGame(result: GameResult, executionSettled: Promise<void>): Promise<void> {
		const core = this.core;
		const settings = core.settings();
		const finishedGameId = core.game?.gameId ?? null;
		// §4.4: the auto-queue asks the *page* for a new game, so the switch gates it like the rest.
		// The opponent goes along (2026-09-13): a titled one earns the rematch step first.
		const opponent = core.opponentInfo;
		if (core.mayQueue())
			await core.deps.autoQueue.schedule(
				core.tabId,
				core.game?.gameId ?? null,
				settings.automation,
				opponent ? { name: opponent.name, title: opponent.title } : null
			);
		// A session break is minutes to hours, not a move window: the mouse goes back to the owner.
		if (core.deps.autoQueue.view(core.tabId)?.status === "break") this.parts.hand.releaseForBreak();
		// Statistics must not delay queuing or enqueue an obsolete game after a slow storage write.
		// Cancellation may be verifying a move that already landed. Its terminal event records
		// the final sample before the serialized game fold; matchmaking need not wait for it.
		await executionSettled;
		await this.parts.recorder.recordGame(finishedGameId);
		try {
			await core.deps.timingLog.flush();
		} catch (error) {
			log.warn("game-session: timing log could not be saved", { error: errorMessage(error) });
		}
		log.info("game-session: game over", { tabId: core.tabId, result });
	}

	/**
	 * The auto-queue moved this tab into its session break after the game ended (2026-09-13: a
	 * rematch step that was not taken while the break was due). The same release the break gets
	 * when it is scheduled straight from `finishGame`; nothing to do once a game is on again.
	 */
	takeQueueBreak(): void {
		if (this.core.state !== "game-over") return;
		this.parts.hand.releaseForBreak();
	}

	/** The lobby hold ended: a game is on the board — arm as a fresh game start would, if asked. */
	endLobbyHold(reason: string, verdict: LobbyVerdict): void {
		const core = this.core;
		this.parts.lobby.clearTimer();
		// Waiting for a pairing is outside the first move's clock.
		if (core.snapshot?.ply === 0) {
			core.positionArrivedAt = core.now();
			// A recommendation computed while waiting carries that old timing epoch. Reuse engine
			// caches through the normal pipeline, but sample the first real turn afresh.
			this.parts.delivery.abortPipeline();
			core.rec = null;
		}
		log.info("game-session: lobby over — a game is on the board", {
			tabId: core.tabId,
			reason,
			verdict,
		});
		const executor = core.executor;
		if (!executor || !core.mayAct()) return;
		if (!this.parts.hand.wantsAutoMove(this.parts.hand.rearmAfterBreak)) {
			void this.parts.delivery.reconsiderGuarded("the lobby hold ended");
			return;
		}
		this.parts.hand.autoArm(executor, "the lobby hold ended");
	}

	cancelQueueForNewGame(gameId: string): void {
		const core = this.core;
		// Clear only the finished game's queue; the playing session spans consecutive games.
		const settings = core.settings();
		void core.deps.autoQueue.observedGame(
			core.tabId,
			gameId,
			core.mayAct() && settings.automation.autoQueue ? settings.automation : undefined
		);
	}
}
