/**
 * `GameSession` (Part I §3.2, §3.3): one per tab, the thing every other lane
 * plugs into. It owns
 *
 *   - the §3.3 state machine (`transitions.ts`, a table so every edge is tested);
 *   - the position feed for its tab — deduplicated, because a reconnecting
 *     content script replays `hello` + the last `position` *and* its outbox
 *     (Task 21), so the same ply can arrive twice;
 *   - the §3.2 pipeline (`recommendation.ts`) and the ponder / panel search
 *     (`ponder.ts`), one at a time, with the search cancelled the moment the
 *     position moves on (Appendix E §4.4);
 *   - the per-tab `MoveExecutor`: armed in the waiting view (§13.4), scheduled
 *     for `plan.deadlineMs`, cancelled by a blur inside the move window;
 *   - the §8.6 timing log and its §13.2 telemetry record, the §13.6 session
 *     stats, TTS, keybinds, `chrome.commands` and the auto-queue.
 *
 * This class is the orchestrator: it decides *what happens when* — a port message, a position, a
 * settings write, an executor report — and the collaborators in `session/` own the state and the
 * mechanics of each concern (the hand's arming, the premove, the scramble hold, the predicted
 * position, the resign, the lobby hold, the board marks and effects, the move accounting). Every
 * collaborator reads the shared position state from one `SessionCore`.
 *
 * Focus discipline (§13.4) is absolute here: nothing in this file changes the
 * active tab or window, raises a notification or calls `Page.bringToFront`; a
 * move that cannot run because the page is not focused *waits* for the next
 * position instead.
 *
 * `Settings.enabled` (§4.4) is the master switch and it is enforced *here*,
 * because this is the only place that asks the engine for anything, draws on
 * the board or hands a move to the hand. The switch is read through `mayAct()`,
 * which is three-valued in practice: on, off, and *not known yet* — a worker
 * woken by a queued port connect can be handed a position before its
 * `chrome.storage.local` read answers, and guessing `DEFAULT_SETTINGS` there
 * fails open in whichever direction that default currently points. Unknown
 * therefore holds: the session acts on nothing until the real settings arrive,
 * and the first read's fan-out resumes whatever it was holding.
 *
 * While the switch is off (or unknown) the session still
 * follows the game — positions, clocks, the move list, the state machine — so
 * the panel stays truthful and a flip back on resumes from the live position,
 * but nothing is analysed, pondered, recommended, highlighted, scheduled,
 * played or queued, and the hand is neither armed nor left armed (the
 * debugger is released with it: §13.4 forbids a mid-game attach, so keeping it
 * attached while the switch is off buys nothing and only leaves the infobar).
 *
 * **One exception, and it is not ours to fix** (Fix F): a premove already sent to the site during
 * the opponent's turn is the *site's* state. Switching off stops everything above and sends nothing
 * more, but it cannot retract a gesture the page has already had — chess.com fires or drops it when
 * the opponent moves, whenever that is. `forgetPremove` says so in the log; the lane report says
 * what it would take to do better.
 */

import { turnFieldOf } from "@core/chess/fen";
import { historyFromSan } from "@core/chess/history";
import { sanToSpeech } from "@core/chess/san-speech";
import { DEBUGGER_DETACH_REASONS, EXECUTOR } from "@core/constants/cdp";
import type { GamePortMessage } from "@core/constants/messages";
import { log } from "@core/logger";
import { createRng } from "@core/rng";
import { isMaxStrength } from "@core/strength/max-strength";
import { createSelectionState } from "@core/strength/move-selector";
import { createFormLatent } from "@core/strength/persona";
import { type QualityContext, qualityCohortKey } from "@core/strength/session-quality";
import { errorMessage } from "@core/util/errors";
import type { ExecutionReport, MoveContext, MoveExecutor } from "@service/move-executor";
import type { OpponentView, SessionGameView, SessionSource } from "@service/panel-broadcaster";
import type {
	GameMeta,
	GameResult,
	GameSessionState,
	PageKind,
	PositionSnapshot,
	Recommendation,
	Site,
} from "@typedefs/game";
import type { BoardEffectsReporter } from "./board-effects";
import { executorSettingsFor } from "./executor-settings";
import type { LobbyVerdict } from "./lobby";
import { PonderController } from "./ponder";
import { timingSettingsFor } from "./presets";
import type { RecommendationOutcome } from "./recommendation";
import { BoardMarks } from "./session/board-marks";
import {
	COMMAND_NAMES,
	commandForKeybind,
	commandForShortcut,
	type SessionCommand,
} from "./session/commands";
import { SessionCore } from "./session/core";
import { DeepSearchPlay } from "./session/deep-search-play";
import { createSessionReporter, EffectsFeed } from "./session/effects-feed";
import { startOpponentExploration } from "./session/exploration";
import { FocusDiscipline } from "./session/focus-discipline";
import { HandArming } from "./session/hand-arming";
import { LobbyHold } from "./session/lobby-hold";
import { MaiaWarmup } from "./session/maia-warmup";
import { moveContextFor } from "./session/move-context";
import { MoveRecorder } from "./session/move-recorder";
import { boardKeyOf, motorTcClass, PLAYED_PAGES, positionFeedKey } from "./session/position-rules";
import { Prediction } from "./session/prediction";
import { PremoveArming } from "./session/premove";
import { QueuedPremove } from "./session/queued-premove";
import { Redelivery } from "./session/redelivery";
import { repaced, timingContextFor } from "./session/replan";
import { ResignFlow } from "./session/resign-flow";
import { ReviewAdmission } from "./session/review-admission";
import { ScrambleHold } from "./session/scramble-hold";
import { TimeControlProfile } from "./session/time-control";
import type { ExecutorFactory, GameSessionDeps } from "./session/types";
import { isLiveState, isMyTurnState } from "./transitions";

export type { ExecutorFactory, GameSessionDeps, SessionPipeline } from "./session/types";
export { COMMAND_NAMES, type SessionCommand };

export class GameSession implements SessionSource {
	private readonly core: SessionCore;
	private readonly offs: Array<() => void> = [];
	/**
	 * Board effects (owner's brief, 2026-09-13): what the move that just landed did, and how good
	 * it was. Both sides' moves; the rays gated on `Settings.automation.boardEffects`, the rating on
	 * `automation.moveQualityChips`, each on its own (owner, 2026-09-15).
	 */
	private readonly boardEffects: BoardEffectsReporter;
	private readonly admission: ReviewAdmission;
	private readonly effects: EffectsFeed;
	private readonly marks: BoardMarks;
	private readonly lobby: LobbyHold;
	private readonly hand: HandArming;
	private readonly resign: ResignFlow;
	private readonly redelivery: Redelivery;
	private readonly profile: TimeControlProfile;
	private readonly maia: MaiaWarmup;
	private readonly prediction: Prediction;
	private readonly recorder: MoveRecorder;
	private readonly arming: PremoveArming;
	private readonly queue: QueuedPremove;
	private readonly holds: ScrambleHold;
	private readonly deep: DeepSearchPlay;
	private readonly focusDiscipline: FocusDiscipline;

	private executorOffs: Array<() => void> = [];
	/** Feed dedupe (Task 21 replays `lastPosition` and the outbox on reconnect). */
	private lastPositionKey: string | null = null;
	private pipelineAc: AbortController | null = null;
	/** A `playNow` issued while the pipeline was still running. */
	private playWhenReady = false;
	private finishingGame: Promise<void> | null = null;
	/** `mayAct()` as of the last settings write this session saw (§4.4 flip detection). */
	private acting: boolean;

	constructor(deps: GameSessionDeps) {
		const core = new SessionCore(deps);
		this.core = core;
		this.acting = core.mayAct();
		this.hand = new HandArming(core, {
			reconsider: (reason) => this.reconsiderGuarded(reason),
			startOpponentExploration: () => this.startOpponentExploration(),
			cancelResign: () => this.resign.cancel(),
			forgetPremove: (reason) => this.forgetPremove(reason),
			updateReviewAdmission: () => this.admission.update(),
			pipelineRunning: () => this.pipelineAc !== null,
			hideCursor: () => this.marks.hideCursor(),
			lobbyHeld: () => this.lobby.held(),
		});
		this.boardEffects = createSessionReporter(core);
		this.admission = new ReviewAdmission(core, this.boardEffects);
		this.effects = new EffectsFeed(core, this.boardEffects, this.admission);
		this.marks = new BoardMarks(core);
		this.lobby = new LobbyHold(core, {
			confirmed: () => this.hand.releaseForLobby(),
			ended: (reason, verdict) => this.endLobbyHold(reason, verdict),
		});
		this.resign = new ResignFlow(core, {
			repaced: (rec) => repaced(core, rec),
			moveContext: (rec) => this.moveContext(rec),
		});
		this.redelivery = new Redelivery(core, (reason) => this.reconsiderGuarded(reason));
		this.profile = new TimeControlProfile(core, (snapshot) => this.runPipeline(snapshot));
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
			startOpponentExploration: () => this.startOpponentExploration(),
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
				takePlayWhenReady: () => {
					if (!this.playWhenReady) return false;
					this.playWhenReady = false;
					return true;
				},
				playNow: () => this.playNow(),
			}
		);
		this.focusDiscipline = new FocusDiscipline(core, {
			premoveWindow: () => this.queue.entry?.window ?? null,
			reconsider: (reason) => this.reconsiderGuarded(reason),
		});
		this.offs.push(
			deps.link.onMessage(deps.tabId, (msg) => this.onPortMessage(msg)),
			deps.focus.onEdge((tabId, hasFocus, at) => {
				if (tabId === deps.tabId) this.focusDiscipline.onEdge(hasFocus, at);
			}),
			deps.debugger.onDetached((tabId, reason) => {
				if (tabId !== deps.tabId || reason !== DEBUGGER_DETACH_REASONS.canceledByUser) return;
				void this.setAutoMove(false).catch((error: unknown) =>
					log.warn("game-session: could not persist the stopped auto-play switch", error)
				);
			})
			// Fix D once hid the mirror on `deps.debugger.onDetached` as well. It no longer does
			// (2026-09-13): the attachment comes and goes between games, and the arrow is the report
			// of where the pointer rests, which a detach does not move. See `BoardMarks.hideCursor`.
		);
	}

	/** The game the session follows (read by the behavioural tests through a cast). */
	private get game(): GameMeta | null {
		return this.core.game;
	}

	// ── SessionSource (the panel snapshot) ─────────────────────────────────

	view(): SessionGameView {
		const core = this.core;
		const s = core.snapshot;
		const game = this.game;
		const view: SessionGameView = {
			state: core.state,
			gameId: game?.gameId ?? null,
			site: core.site,
			pageKind: core.pageKind,
			myColor: s?.myColor ?? game?.myColor ?? null,
			sideToMove: s?.sideToMove ?? null,
			ply: s?.ply ?? 0,
			clocks: s?.clocks ?? null,
			canPlayNow: this.hasPlayableMove(),
			...(this.lobby.held() ? { lobbyHold: true } : {}),
			...(s ? { clocksAt: s.capturedAt } : {}),
		};
		const tc = s?.timeControl ?? game?.timeControl;
		const queue = core.deps.autoQueue.view(core.tabId);
		if (queue) view.autoQueue = queue;
		if (tc) view.timeControl = tc;
		if (s) {
			const liveLine = core.ponderer?.latestLines(s.fen)[0];
			const currentRec = core.rec?.fen === s.fen ? core.rec : null;
			const evaluation = liveLine?.score ?? currentRec?.eval;
			const wdl = liveLine ? liveLine.wdl : currentRec?.wdl;
			if (evaluation) view.evaluation = { fen: s.fen, eval: evaluation, ...(wdl ? { wdl } : {}) };
		}
		return view;
	}

	recommendation(): Recommendation | null {
		return this.core.rec;
	}

	opponent(): OpponentView | null {
		const o = this.core.opponentInfo;
		if (!o) return null;
		return {
			isBot: o.isBot,
			name: o.name,
			ratingEstimate: o.ratingEstimate,
			derivedTargetElo: this.targetElo(),
			...(o.title !== undefined ? { title: o.title } : {}),
		};
	}

	// ── accessors the registry / handlers use ─────────────────────────────

	currentState(): GameSessionState {
		return this.core.state;
	}

	executor(): MoveExecutor | null {
		return this.core.executor;
	}

	isLive(): boolean {
		return isLiveState(this.core.state);
	}

	/** §7.4a: the target the strength layer runs at (opponent-matched when enabled). */
	targetElo(): number {
		return this.core.targetElo();
	}

	// ── commands ───────────────────────────────────────────────────────────

	/** A `chrome.commands` shortcut aimed at this tab's session. */
	onCommand(command: string): Promise<void> {
		const mapped = commandForShortcut(command);
		if (!mapped) {
			log.debug("game-session: unknown command", { command });
			return Promise.resolve();
		}
		return this.command(mapped);
	}

	/** An in-page keybind action (`Keybinds` key). */
	onKeybind(action: string): Promise<void> {
		const mapped = commandForKeybind(action);
		if (!mapped) {
			log.debug("game-session: unknown keybind", { action });
			return Promise.resolve();
		}
		return this.command(mapped);
	}

	async command(cmd: SessionCommand): Promise<void> {
		if (this.core.disposed) return;
		switch (cmd) {
			case "playNow":
				await this.playNow();
				return;
			case "armAutoMove":
				if (this.core.mayAct()) await this.setAutoMove(true);
				return;
			case "toggleAutoMove":
				if (this.hand.switchedOn()) await this.setAutoMove(false);
				else if (this.core.mayAct()) await this.setAutoMove(true);
				return;
			case "disarm":
				await this.setAutoMove(false);
				return;
			case "disable":
				this.disable();
				return;
			case "speakMove":
				await this.speakRecommendation();
				return;
		}
	}

	/**
	 * The settings changed: re-send what the content script acts on (`highlightMoves`, the
	 * keybinds — §13.3 rule 4 keeps both off/default until the worker says otherwise), and act on
	 * `Settings.enabled` (§4.4) when *that* is what changed — off stops everything this session
	 * could still do to the page, on picks the live position back up.
	 */
	onSettingsChanged(): void {
		const core = this.core;
		const settings = core.settings();
		this.hand.settingsChanged(settings);
		const timing = timingSettingsFor(settings.timing, core.currentTimeControl());
		core.timing?.updateSettings(timing, {
			profile: settings.strength.persona,
			targetElo: core.targetElo(),
		});
		// A new target (or the human model switched on) may map to a different Maia size.
		this.maia.recommitOnSettings(settings);
		const selectionChanged = core.gamePendingOrLive() ? this.maia.warmFor(core.targetElo()) : false;
		core.executor?.updateSettings({
			persona: settings.strength.persona,
			...executorSettingsFor(settings.execution, settings.timing),
			verifyMoves: settings.execution.verifyMoves,
			inputMode: settings.execution.inputMode,
		});
		const on = core.mayAct();
		const flipped = on !== this.acting;
		this.acting = on;
		// Sent first either way: `highlightMoves` is reported as `enabled && highlightMoves`, so
		// this is also what clears a mark the content script has already drawn.
		this.marks.pushContentSettings();
		// Move ratings off: the review work stops now rather than at the next position, whatever
		// board effects say (the review engine itself is released by `game-stack`).
		this.effects.settingsChanged(on);
		// Fix D: the mirror is page DOM, so it goes the moment it is no longer allowed — which is
		// either the switch or `display.virtualCursor`, and only the switch makes `flipped` true.
		if (!this.marks.virtualCursorAllowed()) this.marks.hideCursor();
		if (!core.mayQueue()) core.deps.autoQueue.cancel(core.tabId);
		else if (core.game) this.cancelQueueForNewGame(core.game.gameId);
		// 2026-09-15: a held recommendation used to be retried here when the stored timing preset
		// stopped being `manual` mid-game. With the presets gone no setting can flip "may I
		// auto-play" — arming does, and `attachExecutor` / `autoArm` re-check the recommendation.
		if (!flipped) {
			if (on && selectionChanged) void this.resumeEnabled();
			return;
		}
		if (on) void this.resumeEnabled();
		else this.stopDisabled();
	}

	/**
	 * `Settings.enabled` went off mid-session (§4.4): the search in flight is aborted, the ponder
	 * stopped, the scheduled (or running) move cancelled, the auto-queue dropped, the board
	 * cleared, and the hand disarmed — with the debugger released, because §13.4 forbids the
	 * re-attach that would let it act again mid-game, so holding it would only keep the infobar.
	 * The state machine is left alone: the game on the page is still the game, and the panel's
	 * own `settings.enabled` projection is what greys the move card (Appendix F §5.6).
	 */
	private stopDisabled(): void {
		const core = this.core;
		this.cancelInFlight();
		core.deps.autoQueue.cancel(core.tabId);
		core.rec = null;
		this.forgetPremove("the assistant was turned off");
		const executor = core.executor;
		executor?.disarm();
		void this.releaseDebugger(executor);
		this.marks.clear();
		this.effects.clear();
		log.info("game-session: the assistant was turned off — nothing is analysed or played", {
			tabId: core.tabId,
			state: core.state,
		});
		core.notify();
	}

	/**
	 * Give the debugger back — but never while the hand is still winding down. `disarm()`'s abort
	 * needs several hops to reach the hand's release, and a detach that overtakes it leaves the page
	 * with a held mouse button and a piece stuck to the cursor, so the release is awaited first
	 * (`MoveExecutor.whenIdle`). A flip back on while waiting cancels the release: the hand is
	 * disarmed either way, and an attachment the user is about to re-arm is worth keeping.
	 */
	private async releaseDebugger(executor: MoveExecutor | null): Promise<void> {
		const core = this.core;
		try {
			await executor?.whenIdle();
			if (core.disposed || core.mayAct()) return;
			await core.deps.debugger.detach(core.tabId);
			core.notify();
		} catch (error) {
			log.debug("game-session: debugger not released", { error: errorMessage(error) });
		}
	}

	/**
	 * `Settings.enabled` came back on (§4.4): resume from the position the session is sitting on
	 * instead of waiting for the next one. The hand is *not* re-armed — that would attach the
	 * debugger mid-game (§13.4) — so an armed hand is the user's to ask for again, in the waiting
	 * view; until then this is panel-only mode (§7.5).
	 */
	private async resumeEnabled(): Promise<void> {
		const core = this.core;
		const snapshot = core.snapshot;
		log.info("game-session: the assistant was turned back on", {
			tabId: core.tabId,
			state: core.state,
			resumed: snapshot !== null && isLiveState(core.state),
		});
		if (core.disposed || !snapshot || !isLiveState(core.state)) return;
		// A search already in flight (or a recommendation already standing) for this position is the
		// resume: the worker's first settings read can land after the session was built, so "on"
		// is not always a transition from a stopped session.
		if (this.pipelineAc !== null || core.rec !== null) return;
		// The colour is its own hold (`mayActOn`): releasing the switch does not release a position
		// whose side we still do not know. The adapter republishes it once the bridge answers. Same
		// for a snapshot that contradicts itself — the switch coming back on is not new evidence
		// about whose move it is, so the resume holds exactly as `onPosition` did.
		if (!core.mayActOn(snapshot) || !core.selfConsistent(snapshot)) return;
		const myTurn = snapshot.sideToMove === snapshot.myColor;
		if (myTurn) await this.runPipeline(snapshot);
		else await this.onOpponentTurn(snapshot);
	}

	/** Stop a running ponder / panel / pre-analysis search (Task 13's `pendingOptions`, §6.4). */
	stopSearch(): Promise<void> {
		const core = this.core;
		core.workGeneration += 1;
		this.prediction.abortPolicy();
		this.prediction.forget();
		this.prediction.stopPreAnalysis();
		return core.ponderer?.stop() ?? Promise.resolve();
	}

	dispose(preserveAutoQueue = false): void {
		const core = this.core;
		if (core.disposed) return;
		core.disposed = true;
		for (const off of this.offs.splice(0)) off();
		// The executor goes first: `dispose()` → `cancel()` is what actually stops a premove that
		// has not been sent, and `forgetPremove` only gives up the arm and says so.
		core.executor?.disarm();
		this.resign.cancel();
		this.detachExecutor();
		this.forgetPremove("the session was disposed");
		this.pipelineAc?.abort();
		this.deep.abort();
		// Consistent with `cancelInFlight()` / `stopSearch()`: a disposed session leaves no search running.
		this.prediction.stopPreAnalysis();
		core.ponderer?.dispose();
		this.boardEffects.dispose();
		this.admission.update();
		this.effects.cancelClear();
		if (!preserveAutoQueue) core.deps.autoQueue.cancel(core.tabId);
		this.marks.hideCursor();
		core.window.discard();
		this.redelivery.clear();
		this.lobby.clearTimer();
		core.deps.onLivenessChanged?.();
	}

	// ── the port feed ──────────────────────────────────────────────────────

	onPortMessage(msg: GamePortMessage): void {
		const core = this.core;
		if (core.disposed) return;
		switch (msg.kind) {
			case "hello":
				this.onHello(msg.site, msg.pageKind, msg.lobby === true);
				return;
			case "gameStarted":
				this.onGameStarted(msg.game);
				return;
			case "position":
				void this.onPosition(msg.snapshot);
				return;
			case "gameEnded":
				void (
					msg.gameId && core.game && msg.gameId !== core.game.gameId
						? Promise.resolve()
						: this.onGameEnded(msg.result, msg.replayed === true)
				)
					.then(() => {
						if (msg.eventId)
							core.deps.link.post(core.tabId, { kind: "gameEndReceived", eventId: msg.eventId });
					})
					.catch((error: unknown) => log.warn("game-session: game-end handling failed", error));
				return;
			case "opponent":
				core.opponentInfo = {
					isBot: msg.isBot,
					name: msg.name,
					ratingEstimate: msg.ratingEstimate,
					...(msg.title !== undefined ? { title: msg.title } : {}),
				};
				// Both ratings determine the query, including when the target is fixed.
				if (core.gamePendingOrLive() && this.maia.warmFor(core.targetElo())) void this.resumeEnabled();
				// Re-read the clocks against the detector. The opponent itself proves nothing on the
				// queue screen — the card there is the *previous* opponent's after an auto-queue hop —
				// so only a running clock or a move ends the hold (`lobby.ts`).
				this.lobby.review("an opponent was read");
				core.notify();
				return;
			case "moveObserved":
				log.debug("game-session: move observed", {
					tabId: core.tabId,
					san: msg.san,
					byMe: msg.byMe,
					atMs: msg.atMs,
				});
				core.history.observed(msg.byMe, msg.atMs);
				return;
			case "selectorMiss":
				log.warn("game-session: adapter selector miss", {
					tabId: core.tabId,
					selector: msg.selector,
				});
				return;
			default:
				return;
		}
	}

	onHello(site: Site, pageKind: PageKind, lobby = false): void {
		const core = this.core;
		const wasPlayable = PLAYED_PAGES.has(core.pageKind);
		core.site = site;
		core.pageKind = pageKind;
		// Page admission now participates in mayAct; keep settings-edge detection in sync.
		this.acting = core.mayAct();
		if (!PLAYED_PAGES.has(pageKind)) {
			this.cancelInFlight();
			this.hand.releaseForLobby();
			if (!core.mayQueue()) core.deps.autoQueue.cancel(core.tabId);
			this.marks.clear();
		}
		// Before the executor exists: `attachExecutor` reads the flag to withhold the arm on the lobby.
		this.lobby.setPage(lobby);
		core.apply("hello");
		// §13.4: the hand must be armable *in the waiting view*, so the debugger's infobar (and
		// whatever it shifts) lands outside every move window. The executor therefore exists from
		// the moment the page says hello; `startGame` replaces it with the game's own profile and
		// carries the armed state (and the attachment) across.
		this.ensureExecutor(site);
		this.marks.pushContentSettings();
		if (PLAYED_PAGES.has(pageKind)) this.effects.warm();
		this.lobby.review("hello");
		if (!wasPlayable && core.mayAct() && core.executor && !this.lobby.held()) {
			if (this.hand.wantsAutoMove(this.hand.rearmAfterBreak))
				this.hand.autoArm(core.executor, "a playable game returned");
		}
		core.notify();
	}

	/** A pre-game executor so `arm()` works before the first position (§13.4). */
	private ensureExecutor(site: Site): void {
		const core = this.core;
		if (core.executor) return;
		this.attachExecutor({
			site,
			persona: core.settings().strength.persona,
			// No time control is known yet; the game's own class replaces this at `startGame`.
			tcClass: motorTcClass("untimed"),
			gameSeed: `${core.seed}:pregame`,
		});
	}

	/** The tab navigated away from the game (`navigated`) or was closed (`tabRemoved`). */
	onTabEvent(event: "navigated" | "tabRemoved", preserveAutoQueue = false): void {
		const core = this.core;
		this.cancelInFlight();
		if (!preserveAutoQueue) core.deps.autoQueue.cancel(core.tabId);
		core.rec = null;
		// The tab going away is one of the mirror's three hide reasons; a navigation is not — on
		// chess.com the route changes between every two games, and the arrow stays parked across it.
		if (event === "tabRemoved") this.marks.hideCursor();
		this.forgetPremove(event === "navigated" ? "the tab navigated away" : "the tab was closed");
		this.marks.clear();
		this.effects.clear();
		if (event === "navigated") core.game = null;
		core.apply(event);
		core.notify();
	}

	onGameStarted(meta: GameMeta): void {
		const core = this.core;
		if (core.game?.gameId === meta.gameId) return;
		// The URL flag travels as an optional `true` and is *omitted* when false, so an absent field
		// says "this message does not know", not "this is not the lobby" — `gameStarted` is posted
		// from `startSessionIfLive` the moment the page's game object has an id, which on the queue
		// screen can be before the debounced `redetect` has seen the new URL. Clearing the flag on an
		// omission therefore silently undid a `true` that `hello` had just set, and the hand armed on
		// the queue screen (owner, 2026-09-14). Only ever assert it here; `onHello` is what clears it,
		// and `redetect` re-announces `hello` precisely when the value changes, in either direction.
		if (meta.lobby === true) this.lobby.setPage(true);
		this.startGame(meta);
		// Nothing of the previous game belongs on this board.
		this.marks.clear();
		this.effects.clear();
		core.apply("gameStarted");
		this.lobby.review("gameStarted");
		core.notify();
	}

	onGameEnded(result: GameResult, replayed = false): Promise<void> {
		const core = this.core;
		// The mirror is deliberately *not* hidden here (2026-09-13): the game ending does not move
		// the pointer, and the next game's hand starts from the point the arrow is parked on —
		// `HandOwnership.position` survives the boundary, and so must the arrow that shows it.
		if (core.state === "game-over") return this.finishingGame ?? Promise.resolve();
		if (!core.apply("gameEnded")) return Promise.resolve();
		this.cancelInFlight();
		const executionSettled = core.executor?.whenIdle() ?? Promise.resolve();
		core.rec = null;
		this.forgetPremove("the game ended");
		this.marks.clear();
		this.effects.clearAfterGame();
		this.finishingGame = replayed ? Promise.resolve() : this.finishGame(result, executionSettled);
		core.notify();
		return this.finishingGame;
	}

	// ── the per-position pipeline (§3.2) ───────────────────────────────────

	async onPosition(snapshot: PositionSnapshot): Promise<void> {
		const core = this.core;
		if (core.disposed) return;
		const key = positionFeedKey(snapshot);
		if (key === this.lastPositionKey) {
			this.onRepeatedPosition(snapshot);
			return;
		}
		if (
			core.game?.gameId === snapshot.gameId &&
			core.snapshot !== null &&
			snapshot.ply < core.snapshot.ply
		) {
			log.debug("game-session: ignoring an older ply", {
				tabId: core.tabId,
				ply: snapshot.ply,
				have: core.snapshot.ply,
			});
			return;
		}
		if (this.ownHandsDoing(snapshot)) {
			this.salvageFromOwnHand(snapshot);
			log.debug("game-session: position ignored — our own hand is mid-move on this ply", {
				tabId: core.tabId,
				ply: snapshot.ply,
				uci: core.rec?.chosen.uci ?? null,
			});
			return;
		}
		this.lastPositionKey = key;
		if (core.game?.gameId !== snapshot.gameId) {
			this.startGame({
				gameId: snapshot.gameId,
				site: snapshot.site,
				pageKind: core.pageKind,
				myColor: snapshot.myColor,
				...(snapshot.timeControl ? { timeControl: snapshot.timeControl } : {}),
				startedAt: snapshot.capturedAt,
			});
			core.apply("gameStarted");
		}
		core.site = snapshot.site;
		// The colour can arrive after `gameStarted` did (the bridge answers `getPlayingAs()` a moment
		// after the board appears), and the panel reads the game's copy when the snapshot has none.
		// …and it can arrive *wrong* and be corrected later, or be **withdrawn** (`AdapterBase.apply`
		// republishes an authoritative correction on an unmoved position, and withholds the colour
		// altogether once a game has spent its corrections), so this tracks the snapshot exactly rather
		// than filling a blank once.
		//
		// Withdrawal included, which is the whole point of having no `!== null` test here: `view()`
		// falls back to this copy, so keeping the old colour through a withdrawal left the panel
		// telling the owner "Your move · white" — the very colour the site had just contradicted —
		// beside an assistant that had gone silent. A confident wrong statement next to an unexplained
		// silence is the worst of the two, and the refusal only being in the log is no answer: the log
		// is not what the owner reads (review R2-1).
		if (core.game && core.game.myColor !== snapshot.myColor)
			core.game = { ...core.game, myColor: snapshot.myColor };
		// The scramble hold is decided *before* anything is cancelled: a cancel would abandon it.
		const held = this.holds.settle(
			snapshot,
			snapshot.myColor !== null && snapshot.sideToMove === snapshot.myColor
		);
		// H7.3: the pre-inferred answer survives the cancel exactly when this is the position it was
		// inferred for — the whole point of inferring it early. Any other position drops it.
		const carried = this.prediction.policy;
		this.cancelInFlight(held !== null);
		this.prediction.policy = carried;
		const previous = core.snapshot;
		// The same board, republished: an exact FEN replacing an approximate one, the time control
		// arriving, a clock tick whose FEN string differs in a counter. The pipeline runs again (the
		// profile or the budget may have changed), but the mark already on the board is left where it
		// is rather than cleared and redrawn: the clear reset the page overlay's dedupe, so even an
		// unchanged move replayed its fade-in. A changed move still replaces it when it is posted.
		const sameBoard =
			previous !== null &&
			core.rec !== null &&
			core.game?.gameId === snapshot.gameId &&
			previous.ply === snapshot.ply &&
			previous.myColor === snapshot.myColor &&
			boardKeyOf(previous.fen) === boardKeyOf(snapshot.fen);
		core.history.priorFen = previous?.fen ?? null;
		core.snapshot = snapshot;
		if (
			core.positionArrivedAt === null ||
			!previous ||
			previous.gameId !== snapshot.gameId ||
			previous.ply !== snapshot.ply ||
			boardKeyOf(previous.fen) !== boardKeyOf(snapshot.fen)
		)
			core.positionArrivedAt = Math.min(snapshot.capturedAt, core.now());
		// Fix F: a premove we entered on the site is settled by *this* position — before the move
		// history, the profile or anything that plans reads either of them.
		this.queue.reconcile(snapshot);
		this.profile.reprofile(snapshot);
		// The lobby hold reads the ply and the clocks of the position the session now holds.
		this.lobby.review("a position");
		// Whatever was marked belonged to the position that has just been superseded: erase it
		// before anything new is drawn, so the board never carries two recommendations at once.
		core.rec = null;
		if (!sameBoard) this.marks.clear();
		const myTurn = snapshot.myColor !== null && snapshot.sideToMove === snapshot.myColor;
		const at = core.now();
		core.deps.focus.positionArrived(core.tabId, at);
		core.window.open(at, myTurn);
		// Read before `track`, which advances the history: the board-effect verdict searches the
		// position *before* the move, and it wants the root the next ply's search will also use.
		const beforeHistory = previous ? core.historyFor(previous.fen) : null;
		core.history.track(previous, snapshot);
		this.prediction.policy = this.prediction.currentPolicyFor(snapshot, carried);
		if (!core.apply("positionChanged", { myTurn })) return;
		// After the transition, before the §4.4 gate: the effect layer reports what *happened* on the
		// board, which is true whether or not the colour is known and whether or not it is our turn —
		// but a position the state machine refused (a game already over) is not a move to report.
		this.effects.report(previous, snapshot, beforeHistory);
		core.notify();
		if (!core.mayActOn(snapshot)) {
			// §4.4: everything above is bookkeeping the panel reads and a resume needs (the ply, the
			// clocks, the move list, the focus gate's window). Nothing below it runs while the
			// switch is off — or while the *colour* is unknown: no `go`, no ponder, no premove, no
			// recommendation, no schedule. A colourless position cannot even say whose turn it is,
			// so "not my turn ⇒ ponder" would be a guess too.
			log.debug("game-session: position held", {
				tabId: core.tabId,
				ply: snapshot.ply,
				reason: core.mayAct() ? "colour not known yet" : "the assistant is off",
			});
			return;
		}
		// A snapshot that contradicts itself is held before the branch, so the hold is symmetric
		// (`selfConsistent`). The adapter settles this as it reads (`AdapterBase.reading`); this is the
		// second layer, for a snapshot that reached the worker some other way.
		if (!core.selfConsistent(snapshot)) {
			log.warn("game-session: position held — its sideToMove contradicts its own FEN", {
				tabId: core.tabId,
				ply: snapshot.ply,
				myColor: snapshot.myColor,
				sideToMove: snapshot.sideToMove,
				fenTurn: turnFieldOf(snapshot.fen),
			});
			return;
		}
		if (!myTurn) {
			await this.onOpponentTurn(snapshot);
			return;
		}
		if (held) {
			// The hand is letting go of the held piece right now: that is this position's move. No
			// search, no fast reply — the whole point of the hold is that the decision was made
			// while the opponent was thinking.
			core.rec = held;
			core.apply("recommended");
			core.notify();
			return;
		}
		if (await this.arming.fireOnReply(snapshot)) return;
		if (this.profile.holdForTimeControl(snapshot)) return;
		await this.runPipeline(snapshot);
	}

	/**
	 * The reading the session already holds, again (`positionFeedKey` matched). The exact board can
	 * arrive before its move-list/bridge metadata, and a clock can tick on an unmoved board; take
	 * what is new without restarting preparation or input.
	 */
	private onRepeatedPosition(snapshot: PositionSnapshot): void {
		const core = this.core;
		// Recover only the missing effects report; a metadata correction must not restart
		// preparation or input.
		this.effects.recover(snapshot);
		const current = core.snapshot;
		// Move history may catch up without a board/clock change, including after game over.
		// Recover log reviews without restarting the playing pipeline or replaying effects.
		if (
			current &&
			snapshot.moveHistory &&
			snapshot.moveHistory.join(" ") !== current.moveHistory?.join(" ")
		) {
			const restored = historyFromSan(snapshot.moveHistory, snapshot.fen);
			if (restored) {
				current.moveHistory = [...snapshot.moveHistory];
				core.history.restore(restored);
				this.effects.historyRestored(snapshot, restored);
			}
		}
		if (current && snapshot.capturedAt > current.capturedAt) {
			// Keep the same object so a clock tick cannot invalidate an in-flight search.
			current.clocks = snapshot.clocks;
			current.capturedAt = snapshot.capturedAt;
			core.history.update(snapshot);
			// A clock tick on an unmoved board is exactly the lobby hold's evidence.
			this.lobby.review("a clock reading");
			core.notify();
		}
	}

	/**
	 * Is this reading our own hand, caught mid-move, rather than a position that moved on?
	 *
	 * chess.com's DOM renderer mutates the `.piece` elements while a piece is off its square. When
	 * the markup marks that with `.piece.dragging` the adapter reads nothing (`ChessComAdapter.read`);
	 * when it does not, the placement no longer corroborates the bridge FEN, so the hybrid reading
	 * falls through to an **approximate** FEN with the mover missing and the adapter publishes it —
	 * measured against `test/fixtures/chesscom-computer.html`: one extra position, same ply, the
	 * rook gone from the placement. Treating that as a real change cancelled the execution mid-drag
	 * (`cancelInFlight`) and erased the mark for the move being played (`BoardMarks.clear`), which is
	 * the mark disappearing "when the mouse starts its action" on the DOM renderer.
	 *
	 * A position that genuinely moved on advances the ply — the move list is what `ply` is read from
	 * — so *same game, same ply, same side to move, while the hand is running the move the board is
	 * marked for* is our own hand and nothing else. Everything that means the recommendation is
	 * genuinely dead — the switch, `Shift+X`, game end, the tab navigating, a ply that actually
	 * advanced — runs exactly as before.
	 *
	 * **Nothing the dropped reading carried is lost.** There is no position poll in the adapter —
	 * `AdapterBase.apply` records `lastKey` / `lastColor` / `lastTimeControl` before it decides to
	 * publish, and the adapter's only interval runs `probe()` — so a dropped reading is never
	 * re-offered and "the next reading will carry it" is not an argument. Field by field:
	 *
	 * - `site`, `gameId`, `ply`, `sideToMove` — identical to the snapshot we are on, by the guard.
	 * - `fen` — the artefact itself (a piece missing from the board). Discarding it is the point.
	 * - `myColor` — cannot be new: the guard needs a recommendation, and a recommendation needs
	 *   `mayActOn`, which needs a known colour.
	 * - `lastMove` — the same ply means the same last move.
	 * - `clocks`, `capturedAt` — newer, and deliberately not taken: they belong to a position the
	 *   session is not on. They are superseded by the next real reading, one move later at most,
	 *   and nothing between now and then reads them (the plan in flight is already made).
	 * - `timeControl` — **the one thing that can be new**, because §4.3's one-shot republish
	 *   (`AdapterBase.apply`'s `timeControlLearned`) is timed to land in exactly this window: the
	 *   re-ask runs every `TIMINGS.adapterTimeControlRetryMs` and the hand's action is seconds
	 *   long. `salvageFromOwnHand` takes it before the rest of the reading is dropped.
	 *
	 * `lastPositionKey` is left alone as well, so a republish of this very reading after the hand
	 * stops is still considered rather than deduped away.
	 *
	 * This is a question and nothing else: the salvage is a separate call at the one call site, so
	 * that short-circuiting or reordering the `if` cannot silently lose it.
	 */
	private ownHandsDoing(snapshot: PositionSnapshot): boolean {
		const core = this.core;
		const current = core.snapshot;
		const rec = core.rec;
		if (!current || !rec || core.game?.gameId !== snapshot.gameId) return false;
		if (snapshot.ply !== current.ply || snapshot.sideToMove !== current.sideToMove) return false;
		return core.executor?.runningMove()?.rec === rec;
	}

	/**
	 * What a reading `ownHandsDoing` is about to drop still has to deliver: §4.3's time control.
	 * The site answers `timeControl.get()` only once the game has actually started, the adapter
	 * republishes the unmoved position to deliver it exactly once, and the re-ask runs on a 1 s
	 * timer — so its arrival lands inside the seconds the hand's action takes. `reprofile` is the
	 * same call `onPosition` would have made: idempotent (once per game), and safe while a move is
	 * in flight for the same documented reason `MoveExecutor.setTimeControlClass` is — the running
	 * move keeps the plan it was given and the new profile is read by the next one.
	 */
	private salvageFromOwnHand(snapshot: PositionSnapshot): void {
		this.profile.reprofile(snapshot);
	}

	/** Opponent's turn: ponder (§6.4) and prepare a premove candidate (§7.4). */
	private async onOpponentTurn(snapshot: PositionSnapshot): Promise<void> {
		const core = this.core;
		this.startOpponentExploration();
		const ponderer = core.ponderer;
		if (!ponderer) return;
		const history = core.historyFor(snapshot.fen);
		await ponderer.start("opponent", history.fen, history.moves);
		// §4.4: starting the ponder is an await, so the switch can go off *inside* it — and
		// `stopDisabled`'s own stop then ran before this search existed, which would leave a
		// `go infinite` running with the assistant off. Stop what we just started, and search
		// nothing more for this position.
		if (!core.mayAct() || core.snapshot !== snapshot) {
			await ponderer.stop();
			return;
		}
		await this.arming.arm(snapshot);
		// Selection has already made the premove probability draw. Queue a safe candidate now,
		// with the queue's own reaction delay, before optional holds can occupy the hand.
		this.queue.enter(snapshot);
		if (this.queue.entry === null) this.holds.scheduleDecision(snapshot, 0, false);
		await this.prediction.preAnalyse(snapshot, ponderer);
	}

	private startOpponentExploration(): void {
		startOpponentExploration(this.core, {
			armedPremove: () => this.arming.armed,
			entered: () => this.queue.entry !== null,
			holding: () => this.holds.holding(),
		});
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
	private async runPipeline(snapshot: PositionSnapshot): Promise<void> {
		if (!this.core.pipeline || !this.core.timing) return;
		const ac = new AbortController();
		this.pipelineAc = ac;
		const prepared = this.admission.beginPreparation(ac.signal);
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
		const maiaSize = this.maia.lockForDecision();
		const policyAnswer = this.prediction.currentPolicyFor(snapshot);
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
			this.redelivery.whenReady("the engine produced no line for this position");
			return;
		}
		core.rec = outcome.rec;
		this.recorder.noteQuality(outcome.rec.chosen, qualityContext);
		this.recorder.notePosition(outcome.rec.chosen, snapshot.gameId, snapshot.ply);
		core.recNReasonable = outcome.nReasonable;
		// Board effects (2026-09-14): open our planned move's rating now, so the review engine
		// searches the position it will produce while the hand waits out the think time.
		this.effects.preparePlanned(snapshot, outcome.rec.chosen.uci, settings, outcome.fromBook);
		core.apply("recommended");
		this.marks.highlight(outcome.rec);
		core.notify();
		// Scheduling publishes the input budget synchronously before preparation reopens review.
		const acting = this.actOnRecommendation(outcome.rec);
		prepared();
		await acting;
	}

	/** §3.2 step 5 / §8.5: schedule, play at once, or leave the plan on display. */
	private async actOnRecommendation(rec: Recommendation): Promise<void> {
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
		if (this.resign.shouldResign(rec.lines)) {
			this.resign.schedule(rec);
			return;
		}
		if (isMaxStrength(core.targetElo())) {
			await this.deep.play(rec);
			return;
		}
		executor.schedule(rec, rec.plan, this.moveContext(rec));
	}

	private moveContext(rec: Recommendation): MoveContext {
		return moveContextFor(this.core, rec, {
			premovePending: this.queue.entry !== null || this.holds.holding(),
			requirePositionCheck: this.redelivery.isGuarded(rec.chosen),
			queuedPremove: this.queue.isEntry(rec),
		});
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
	private async reconsider(reason: string): Promise<void> {
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
		if (this.deep.running()) return;
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
	private async reconsiderGuarded(reason: string): Promise<void> {
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
	 * `SessionSource`: the hand was armed from outside the session — the panel's auto-move toggle
	 * (`PANEL_SET_AUTO_MOVE`). One gate, one `MoveContext`, one definition: the handler must not
	 * schedule for itself.
	 */
	async handArmed(): Promise<void> {
		await this.reconsiderGuarded("the hand was armed");
		this.startOpponentExploration();
	}

	/**
	 * Will `playNow()` reach the hand if called right now? Every condition `playNow` itself checks —
	 * §4.4's switch, §13.4's armed hand, and something to play — because `playNowRequested` answers
	 * the panel `true` on the strength of this and nothing may fall between the two: they run in one
	 * synchronous step, and `playNow` is synchronous up to its own `await`.
	 */
	private hasPlayableMove(): boolean {
		const core = this.core;
		const executor = core.executor;
		if (!executor || !core.mayAct() || !executor.isArmed() || !isMyTurnState(core.state))
			return false;
		const pending = executor.pendingMove();
		if (pending && pending.rec === this.queue.entry?.rec) return false;
		return (
			executor.canFastForward() &&
			(pending !== null ||
				core.rec !== null ||
				(this.pipelineAc !== null && !this.pipelineAc.signal.aborted))
		);
	}

	/**
	 * `SessionSource`: the panel's `PANEL_PLAY_NOW`. Same reason as `handArmed()` — the
	 * `MoveContext` and the §8.5 re-plan are the session's, and the handler used to pass neither.
	 *
	 * The run is started and deliberately **not** awaited: the panel's reply must not wait for the
	 * hand (the outcome reaches it through the broadcaster), which is the shape the handler had.
	 * `playNow()` is synchronous up to its own `await`, so the §3.3 transition and the notify have
	 * both happened by the time this resolves. `false` means no current move can be fast-forwarded.
	 * An active analysis can also be fast-forwarded: its result is handed to the mouse as soon as
	 * the search finishes, through the same `playWhenReady` path as the keyboard command.
	 */
	playNowRequested(): Promise<boolean> {
		if (!this.hasPlayableMove()) return Promise.resolve(false);
		void this.playNow().catch((error: unknown) =>
			log.warn("game-session: playNow failed", {
				tabId: this.core.tabId,
				error: errorMessage(error),
			})
		);
		return Promise.resolve(true);
	}

	/** Give up the premove — the arm, and (the site's, Fix F) the entry — and say why. */
	private forgetPremove(reason: string): void {
		this.arming.drop();
		this.queue.abandon(reason);
	}

	// ── user commands ──────────────────────────────────────────────────────

	/** The one user switch owns both the current hand and the next game's preference. */
	setAutoMove(armed: boolean): Promise<void> {
		return this.hand.setAutoMove(armed);
	}

	/** `Shift+X`: stop everything on this tab — highlights cleared, executor cancelled. */
	private disable(): void {
		const core = this.core;
		this.cancelInFlight();
		core.executor?.disarm();
		this.hand.rearmAfterBreak = false;
		core.deps.autoQueue.cancel(core.tabId);
		// The arrow first, the board marks second: `BoardMarks.clear()` stays the last thing every
		// stop path posts, which is what `test/behavioral/game/keybinds.test.ts` reads.
		this.marks.hideCursor();
		this.marks.clear();
		this.effects.clear();
		core.rec = null;
		this.forgetPremove("Shift+X — the assistant was stopped on this tab");
		core.apply("disable");
		core.notify();
	}

	/** §8.5 manual path: the pending move (else the current recommendation) plays now. */
	private async playNow(): Promise<void> {
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
		if (pending && this.queue.isEntry(pending.rec)) {
			log.info("game-session: playNow ignored — the pending move is a premove", {
				tabId: core.tabId,
				uci: pending.rec.chosen.uci,
			});
			return;
		}
		if (pending) {
			core.apply("playNow");
			core.notify();
			await executor.playNow(pending.rec, pending.rec.plan, this.moveContext(pending.rec));
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
		const harvested = this.deep.harvestFor(rec, () => {
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
		await executor.playNow(rec, plan, this.moveContext(rec));
	}

	private async speakRecommendation(): Promise<void> {
		const rec = this.core.rec;
		if (!rec) return;
		const text = sanToSpeech(rec.chosen.san);
		if (text === "") return;
		try {
			await this.core.deps.speak(text);
		} catch (error) {
			log.debug("game-session: tts failed", { error: errorMessage(error) });
		}
	}

	// ── game lifecycle ─────────────────────────────────────────────────────

	private startGame(meta: GameMeta): void {
		const core = this.core;
		this.cancelInFlight();
		this.effects.forgetArrival();
		this.cancelQueueForNewGame(meta.gameId);
		this.finishingGame = null;
		core.game = meta;
		core.site = meta.site;
		core.snapshot = null;
		core.positionArrivedAt = null;
		core.rec = null;
		this.arming.drop();
		this.queue.resetForGame();
		this.recorder.resetForGame();
		this.resign.resetForGame();
		core.history.reset();
		this.lastPositionKey = null;
		core.selection = createSelectionState();
		const gameSeed = `${core.seed}:${meta.gameId}`;
		core.gameSeed = gameSeed;
		core.rng = createRng(`${gameSeed}:session`);
		core.form = createFormLatent(createRng(`${gameSeed}:form`));
		core.window.discard();
		// A new board: the lobby's clock stillness starts over (the URL flag is the caller's).
		this.lobby.resetStillness();

		const settings = core.settings();
		const targetElo = core.targetElo();
		const { tc, timing } = this.profile.beginGame(meta, settings, targetElo);
		// §4.4: with the switch off nothing will search, so nothing is pre-warmed either.
		if (core.mayAct()) core.deps.warmTiming?.(targetElo);
		// H6.3: the size this game plays with, from the target as it stands at game start.
		this.maia.commitForGame(targetElo, settings);
		this.prediction.policy = null;
		this.prediction.abortPolicy();
		this.maia.warmFor(targetElo, true);
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
		core.pipeline = this.profile.pipelineFor(timing);

		this.attachExecutor({
			site: meta.site,
			persona: settings.strength.persona,
			tcClass: motorTcClass(tc),
			gameSeed,
		});
		this.marks.pushContentSettings();
		this.effects.warm();
		log.info("game-session: game started", {
			tabId: core.tabId,
			gameId: meta.gameId,
			site: meta.site,
			targetElo,
			tc,
		});
	}

	private async finishGame(result: GameResult, executionSettled: Promise<void>): Promise<void> {
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
		if (core.deps.autoQueue.view(core.tabId)?.status === "break") this.hand.releaseForBreak();
		// Statistics must not delay queuing or enqueue an obsolete game after a slow storage write.
		// Cancellation may be verifying a move that already landed. Its terminal event records
		// the final sample before the serialized game fold; matchmaking need not wait for it.
		await executionSettled;
		await this.recorder.recordGame(finishedGameId);
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
		this.hand.releaseForBreak();
	}

	/** The lobby hold ended: a game is on the board — arm as a fresh game start would, if asked. */
	private endLobbyHold(reason: string, verdict: LobbyVerdict): void {
		const core = this.core;
		this.lobby.clearTimer();
		// Waiting for a pairing is outside the first move's clock.
		if (core.snapshot?.ply === 0) {
			core.positionArrivedAt = core.now();
			// A recommendation computed while waiting carries that old timing epoch. Reuse engine
			// caches through the normal pipeline, but sample the first real turn afresh.
			this.pipelineAc?.abort();
			this.pipelineAc = null;
			core.rec = null;
		}
		log.info("game-session: lobby over — a game is on the board", {
			tabId: core.tabId,
			reason,
			verdict,
		});
		const executor = core.executor;
		if (!executor || !core.mayAct()) return;
		if (!this.hand.wantsAutoMove(this.hand.rearmAfterBreak)) {
			void this.reconsiderGuarded("the lobby hold ended");
			return;
		}
		this.hand.autoArm(executor, "the lobby hold ended");
	}

	private cancelQueueForNewGame(gameId: string): void {
		const core = this.core;
		// Clear only the finished game's queue; the playing session spans consecutive games.
		const settings = core.settings();
		void core.deps.autoQueue.observedGame(
			core.tabId,
			gameId,
			core.mayAct() && settings.automation.autoQueue ? settings.automation : undefined
		);
	}

	// ── executor plumbing ──────────────────────────────────────────────────

	private attachExecutor(config: Parameters<ExecutorFactory>[0]): void {
		const core = this.core;
		const previous = core.executor;
		// A hand released for a session break counts as armed here: the break is over.
		const wasArmed = this.hand.takeCarriedArm(previous);
		const executor = core.deps.createExecutor(config);
		for (const off of this.executorOffs.splice(0)) off();
		// A factory may legitimately hand the same executor back (one hand for the whole tab);
		// only a *replacement* retires the old one.
		if (previous && previous !== executor) {
			previous.dispose();
			this.admission.retire(previous);
		}
		core.executor = executor;
		this.executorOffs = [
			executor.on("inputCritical", (update) => this.admission.onInputCritical(executor, update)),
			executor.on("executed", (report) => this.onExecuted(report)),
			// Fix F: the premove gesture went out. Nothing has been played — and nothing can tell
			// whether the site kept it — so it is not `executed` and none of `onExecuted`'s
			// accounting runs on it.
			executor.on("dispatched", (report) => void this.queue.settleDrag(report)),
			executor.on("failed", (report) => this.onFailed(report)),
			executor.on("aborted", (report) => this.onNotExecuted(report, "aborted")),
			executor.on("skipped", (report) => this.onNotExecuted(report, "skipped")),
			executor.on("hand", (hand) => {
				if (hand === "rest") {
					return;
				}
				// Fix F: the hand also leaves rest during the *opponent's* turn now, to send a premove,
				// and §3.3 has no `handStarted` edge there on purpose — the move is not ours to make yet.
				// The gate changes no state (the table already rejects that edge); what it removes is one
				// `log.warn("no transition")` per hand phase per premove.
				//
				// It gates the redraw below as well, and that part is not cosmetic. `markForExecution`
				// inserts an overlay `<svg>` on the board; doing that for a premove would insert it during
				// the *opponent's* turn, which is a different §13.3 window from the one Fix A measured and
				// neither lane tested. Whether a premove's mark should be ours too is a separate question,
				// left open deliberately — a premove keeps the native mark it was drawn with.
				if (!isMyTurnState(core.state)) return;
				core.apply("handStarted");
				// The hand is acting: the mark must now be one the site cannot take away.
				this.marks.markForExecution();
			}),
			executor.on("pointer", (p) => this.marks.cursorTo(p)),
		];
		// A game that follows an armed one keeps the hand armed (the debugger stays attached), and
		// `Settings.automation.autoMove` is the stored "arm me" default.
		// Fix G: and the arm is awaited for its *result*, not fired and forgotten. `arm()` attaches
		// the debugger, which is slow enough to lose the race with the first position — and the
		// manual arm (Shift+A) has always re-checked the recommendation it may have raced, while
		// this path did not. At ply 0 as white that re-check is the only one there will ever be.
		this.hand.armNewExecutor(executor, wasArmed);
	}

	private detachExecutor(): void {
		const core = this.core;
		for (const off of this.executorOffs.splice(0)) off();
		if (core.executor) {
			core.executor.dispose();
			this.admission.retire(core.executor);
		}
		core.executor = null;
	}

	private onExecuted(report: ExecutionReport): void {
		const core = this.core;
		// A premove's report settles the fork and stops here, so it never reaches the clear below —
		// deliberately. The mark of a queued premove is not a spent prediction, it is the move that is
		// about to play, and it stays on the board for exactly as long as that is true: the opponent
		// moving brings a new position, and `onPosition`'s own clear erases it there. This is the one
		// mark that outlives its own action, and it outlives it by design.
		if (this.queue.settleDrag(report)) return;
		if (report.rec.chosen.source === "premove") this.queue.notePlayed();
		const current = report.rec === core.rec;
		if (current) this.admission.update();
		// The position feed can reach us before the confirmation. It already opened
		// the next window, which this older receipt must not transition or clear.
		if (current) core.apply("executed");
		// The move is on the board: the prediction has been spent, and the site's own last-move
		// marking is what belongs there now.
		if (current) this.marks.clear();
		this.recorder.recordMove(report, current);
		core.notify();
	}

	private onFailed(report: ExecutionReport): void {
		if (this.queue.settleDrag(report)) return;
		log.warn("game-session: execution failed", {
			tabId: this.core.tabId,
			uci: report.rec.chosen.uci,
			reason: report.result.reason ?? null,
		});
		this.onNotExecuted(report, "failed");
	}

	/**
	 * Every outcome that is not `executed` is a `failed` edge for §3.3: the hand has stopped and
	 * the move did not land, so `live:my-turn:executing` must fall back to `recommended` rather
	 * than sit in a state whose hand is at rest. This is the path a §13.4 blur cancel takes
	 * (`aborted`), as well as the position guard (`skipped`) and a genuine failure.
	 *
	 * **The mark goes too — but only if it is still this attempt's mark.** An attempt that finally
	 * failed is the action being complete, so it is a clear point exactly as `executed` is. There is
	 * no retry left that could want it: `MoveExecutor.runOne` emits `failed` / `aborted` / `skipped`
	 * only after `dispatch()` has returned, and `dispatch()` is where `runWithRetry` exhausts every
	 * tier. Leaving it drawn stranded an overlay `<svg>` for a move that will never be played — and
	 * the overlay is ours, so unlike the native marking it used to be, nothing on the page ever
	 * wipes it (the known promotion gap, QA B0.7, reaches this path on every live game).
	 *
	 * The `report.rec === core.rec` test is not belt-and-braces, it is the correctness condition.
	 * `cancelInFlight()` does not await `MoveExecutor.cancel()`, and the hand's wind-down (the
	 * release, `recover()`, the hops back) is slower than producing the next recommendation — so
	 * when a position arrives on our turn mid-action the **default** ordering is: the run is
	 * cancelled, the new position is analysed, the new recommendation's mark is drawn, and only
	 * *then* does the cancelled run emit `aborted`. An unconditional clear there erased the mark of
	 * a recommendation that is live, leaving the panel recommending a move and the board blank —
	 * this lane's own bug, reintroduced from the other end. Three more emit sites reach here for a
	 * recommendation that may no longer be current: `droppedReplacement` and `landedReplacement`
	 * (`move-executor/index.ts`) both fire for a parked move the session has already moved past.
	 */
	private onNotExecuted(report: ExecutionReport, outcome: "aborted" | "skipped" | "failed"): void {
		const core = this.core;
		if (this.queue.settleDrag(report)) return;
		if (report.rec === core.rec) {
			this.admission.update();
			core.apply("failed");
			core.window.discard();
			this.marks.clear();
			const reason = report.result.reason;
			const noPress =
				report.result.attempts === 0 &&
				report.result.pressed !== true &&
				report.result.pressedAny !== true;
			if (
				noPress &&
				(reason === EXECUTOR.reasons.noGeometry || reason === EXECUTOR.reasons.verificationUnavailable)
			)
				this.redelivery.heldRecommendation(report.rec, `pre-dispatch hold: ${reason}`);
		}
		log.debug("game-session: move did not land", {
			tabId: core.tabId,
			outcome,
			uci: report.rec.chosen.uci,
			reason: report.result.reason ?? null,
			state: core.state,
		});
		core.notify();
	}

	// ── cancellation ───────────────────────────────────────────────────────

	private cancelInFlight(keepHand = false): void {
		const core = this.core;
		core.workGeneration += 1;
		this.pipelineAc?.abort();
		this.pipelineAc = null;
		this.deep.abort();
		this.playWhenReady = false;
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
