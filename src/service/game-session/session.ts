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

import { sanToSpeech } from "@core/chess/san-speech";
import { DEBUGGER_DETACH_REASONS } from "@core/constants/cdp";
import type { GamePortMessage } from "@core/constants/messages";
import { log } from "@core/logger";
import { errorMessage } from "@core/util/errors";
import type { MoveExecutor } from "@service/move-executor";
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
import { AssistantSwitch } from "./session/assistant-switch";
import {
	COMMAND_NAMES,
	commandForKeybind,
	commandForShortcut,
	type SessionCommand,
} from "./session/commands";
import { SessionCore } from "./session/core";
import { GameLifecycle } from "./session/lifecycle";
import { PageEvents } from "./session/page-events";
import { SessionParts } from "./session/parts";
import { PositionArrival } from "./session/position-arrival";
import type { GameSessionDeps } from "./session/types";
import { isLiveState } from "./transitions";

export type { ExecutorFactory, GameSessionDeps, SessionPipeline } from "./session/types";
export { COMMAND_NAMES, type SessionCommand };

export class GameSession implements SessionSource {
	private readonly core: SessionCore;
	private readonly offs: Array<() => void> = [];
	private readonly parts: SessionParts;
	private readonly lifecycle: GameLifecycle;
	private readonly assistant: AssistantSwitch;
	private readonly arrival: PositionArrival;
	private readonly page: PageEvents;

	constructor(deps: GameSessionDeps) {
		const core = new SessionCore(deps);
		this.core = core;
		this.parts = new SessionParts(core, {
			lobbyEnded: (reason, verdict) => this.lifecycle.endLobbyHold(reason, verdict),
		});
		this.lifecycle = new GameLifecycle(core, this.parts);
		this.assistant = new AssistantSwitch(core, this.parts, this.lifecycle);
		this.arrival = new PositionArrival(core, this.parts, this.lifecycle);
		this.page = new PageEvents(core, this.parts, this.lifecycle, this.assistant, (snapshot) =>
			this.onPosition(snapshot)
		);
		const { focusDiscipline } = this.parts;
		this.offs.push(
			deps.link.onMessage(deps.tabId, (msg) => this.onPortMessage(msg)),
			deps.focus.onEdge((tabId, hasFocus, at) => {
				if (tabId === deps.tabId) focusDiscipline.onEdge(hasFocus, at);
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

	/** The board-effects reporter (read by the behavioural tests through a cast). */
	private get boardEffects(): BoardEffectsReporter {
		return this.parts.boardEffects;
	}

	/** The pipeline run in flight (read by the behavioural tests through a cast). */
	private get pipelineAc(): AbortController | null {
		return this.parts.delivery.pipelineAc;
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
			canPlayNow: this.parts.delivery.hasPlayableMove(),
			...(this.parts.lobby.held() ? { lobbyHold: true } : {}),
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
				await this.parts.delivery.playNow();
				return;
			case "armAutoMove":
				if (this.core.mayAct()) await this.setAutoMove(true);
				return;
			case "toggleAutoMove":
				if (this.parts.hand.switchedOn()) await this.setAutoMove(false);
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

	/** Stop a running ponder / panel / pre-analysis search (Task 13's `pendingOptions`, §6.4). */
	stopSearch(): Promise<void> {
		const core = this.core;
		core.workGeneration += 1;
		this.parts.prediction.abortPolicy();
		this.parts.prediction.forget();
		this.parts.prediction.stopPreAnalysis();
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
		this.parts.resign.cancel();
		this.parts.executors.detach();
		this.parts.forgetPremove("the session was disposed");
		this.parts.delivery.pipelineAc?.abort();
		this.parts.deep.abort();
		// Consistent with `cancelInFlight()` / `stopSearch()`: a disposed session leaves no search running.
		this.parts.prediction.stopPreAnalysis();
		core.ponderer?.dispose();
		this.boardEffects.dispose();
		this.parts.admission.update();
		this.parts.effects.cancelClear();
		if (!preserveAutoQueue) core.deps.autoQueue.cancel(core.tabId);
		this.parts.marks.hideCursor();
		core.window.discard();
		this.parts.redelivery.clear();
		this.parts.lobby.clearTimer();
		core.deps.onLivenessChanged?.();
	}

	// ── the port feed (`PageEvents`) and the settings (`AssistantSwitch`) ──

	/**
	 * The settings changed: re-send what the content script acts on, and act on `Settings.enabled`
	 * (§4.4) when *that* is what changed (`AssistantSwitch`).
	 */
	onSettingsChanged(): void {
		this.assistant.onSettingsChanged();
	}

	onPortMessage(msg: GamePortMessage): void {
		this.page.onPortMessage(msg);
	}

	onHello(site: Site, pageKind: PageKind, lobby = false): void {
		this.page.onHello(site, pageKind, lobby);
	}

	/** The tab navigated away from the game (`navigated`) or was closed (`tabRemoved`). */
	onTabEvent(event: "navigated" | "tabRemoved", preserveAutoQueue = false): void {
		this.page.onTabEvent(event, preserveAutoQueue);
	}

	onGameStarted(meta: GameMeta): void {
		this.page.onGameStarted(meta);
	}

	onGameEnded(result: GameResult, replayed = false): Promise<void> {
		return this.page.onGameEnded(result, replayed);
	}

	/** §3.2 for one reading of the board (`PositionFeed` admits, `PositionArrival` acts). */
	onPosition(snapshot: PositionSnapshot): Promise<void> {
		// Not `async`: the admitted reading's own promise is returned as is, and a throw before it
		// still reaches the caller as a rejection, exactly as when this was one async method.
		try {
			if (this.core.disposed || !this.parts.feed.admit(snapshot)) return Promise.resolve();
			return this.arrival.arrive(snapshot);
		} catch (error) {
			return Promise.reject(error);
		}
	}

	/**
	 * The auto-queue moved this tab into its session break after the game ended (2026-09-13: a
	 * rematch step that was not taken while the break was due).
	 */
	takeQueueBreak(): void {
		this.lifecycle.takeQueueBreak();
	}

	/**
	 * `SessionSource`: the hand was armed from outside the session — the panel's auto-move toggle
	 * (`PANEL_SET_AUTO_MOVE`). One gate, one `MoveContext`, one definition: the handler must not
	 * schedule for itself.
	 */
	async handArmed(): Promise<void> {
		await this.parts.delivery.reconsiderGuarded("the hand was armed");
		this.parts.opponentTurn.explore();
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
		if (!this.parts.delivery.hasPlayableMove()) return Promise.resolve(false);
		void this.parts.delivery.playNow().catch((error: unknown) =>
			log.warn("game-session: playNow failed", {
				tabId: this.core.tabId,
				error: errorMessage(error),
			})
		);
		return Promise.resolve(true);
	}

	// ── user commands ──────────────────────────────────────────────────────

	/** The one user switch owns both the current hand and the next game's preference. */
	setAutoMove(armed: boolean): Promise<void> {
		return this.parts.hand.setAutoMove(armed);
	}

	/** `Shift+X`: stop everything on this tab — highlights cleared, executor cancelled. */
	private disable(): void {
		const core = this.core;
		this.parts.cancelInFlight();
		core.executor?.disarm();
		this.parts.hand.rearmAfterBreak = false;
		core.deps.autoQueue.cancel(core.tabId);
		// The arrow first, the board marks second: `BoardMarks.clear()` stays the last thing every
		// stop path posts, which is what `test/behavioral/game/keybinds.test.ts` reads.
		this.parts.marks.hideCursor();
		this.parts.marks.clear();
		this.parts.effects.clear();
		core.rec = null;
		this.parts.forgetPremove("Shift+X — the assistant was stopped on this tab");
		core.apply("disable");
		core.notify();
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
}
