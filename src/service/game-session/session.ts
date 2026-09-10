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
 * Focus discipline (§13.4) is absolute here: nothing in this file changes the
 * active tab or window, raises a notification or calls `Page.bringToFront`; a
 * move that cannot run because the page is not focused *waits* for the next
 * position instead.
 *
 * `Settings.enabled` (§4.4) is the master switch and it is enforced *here*,
 * because this is the only place that asks the engine for anything, draws on
 * the board or hands a move to the hand. While it is off the session still
 * follows the game — positions, clocks, the move list, the state machine — so
 * the panel stays truthful and a flip back on resumes from the live position,
 * but nothing is analysed, pondered, recommended, highlighted, scheduled,
 * played or queued, and the hand is neither armed nor left armed (the
 * debugger is released with it: §13.4 forbids a mid-game attach, so keeping it
 * attached while the switch is off buys nothing and only leaves the infobar).
 */

import { legalMoves, uciToSan } from "@core/chess/san";
import { sanToSpeech } from "@core/chess/san-speech";
import { isSquare } from "@core/chess/squares";
import { chromeLocalGet, chromeLocalSet } from "@core/chrome/storage";
import { LIMITS } from "@core/constants/limits";
import type { GamePortCommand, GamePortMessage } from "@core/constants/messages";
import { LOCAL_KEYS } from "@core/constants/storage-keys";
import { TELEMETRY_BANDS } from "@core/constants/telemetry";
import type { TimingProfile } from "@core/constants/timings";
import { log } from "@core/logger";
import type { TimeControlClass } from "@core/motor/types";
import { createRng, type Rng } from "@core/rng";
import type { BookPolicy } from "@core/strength/book/book-policy";
import { createSelectionState } from "@core/strength/move-selector";
import { createFormLatent, type FormLatent } from "@core/strength/persona";
import { premoveCandidate } from "@core/strength/premove";
import type { SelectionState } from "@core/strength/types";
import { TIMING_CONSTANTS } from "@core/timing/constants";
import { tcClass } from "@core/timing/features";
import type { TimingLogWriter } from "@core/timing/timing-log";
import { buildTimingLogEntry } from "@core/timing/timing-log";
import { TimingModel } from "@core/timing/timing-model";
import type { DistributionHead, TcClass, TimingContext } from "@core/timing/types";
import { clamp } from "@core/util/clamp";
import { errorMessage } from "@core/util/errors";
import { defaultNow, defaultScheduler, type Scheduler } from "@core/util/scheduler";
import type { AutoQueue } from "@service/auto-queue";
import type { ContentLink } from "@service/content-link";
import type { DebuggerManager } from "@service/debugger-manager";
import type { EngineController } from "@service/engine-controller";
import type { FocusGate } from "@service/focus-gate";
import type { HandOwnership } from "@service/hand-ownership";
import type { ExecutionReport, MoveContext, MoveExecutor } from "@service/move-executor";
import { candidatesFromLines } from "@service/move-executor";
import type { OpponentView, SessionGameView, SessionSource } from "@service/panel-broadcaster";
import type {
	ChosenMove,
	Color,
	GameMeta,
	GameResult,
	GameSessionState,
	PageKind,
	PositionSnapshot,
	Recommendation,
	SessionStats,
	Site,
	Square,
	TimeControl,
} from "@typedefs/game";
import type { PersonaId, Settings } from "@typedefs/settings";
import { PonderController } from "./ponder";
import { autoPlayAllowed, effectiveTimingProfile, timingSettingsFor } from "./presets";
import type { RecommendationInput, RecommendationOutcome } from "./recommendation";
import { RecommendationPipeline } from "./recommendation";
import { EMPTY_STATS, foldGame, foldMove } from "./stats";
import { MoveWindow, selectedMultiplePieces } from "./telemetry";
import { type GameSessionEvent, isLiveState, nextState } from "./transitions";

const MS_PER_S = 1000;

/**
 * `ChosenMove.rankInLines` is 1-based (`selectMove` numbers the best line `1`); `0` means the
 * move was not among the engine's lines at all — what the opening book and a premove report.
 */
const TOP_LINE_RANK = 1;

/**
 * `LOCAL_KEYS.sessionStats` is one key for the whole worker, and every fold is a
 * read-modify-write: a `recordMove` racing a `finishGame` (or a second tab's session) would
 * otherwise drop one of them. Every fold in the worker goes through this one chain.
 */
let statsChain: Promise<void> = Promise.resolve();

function queueStatsWrite(fold: (stats: SessionStats) => SessionStats): Promise<void> {
	statsChain = statsChain.then(async () => {
		try {
			const stored = (await chromeLocalGet(LOCAL_KEYS.sessionStats)) as SessionStats | undefined;
			await chromeLocalSet(LOCAL_KEYS.sessionStats, fold(stored ?? { ...EMPTY_STATS }));
		} catch (error) {
			log.debug("game-session: session stats not written", { error: errorMessage(error) });
		}
	});
	return statsChain;
}

/**
 * §13.6: a move the quality pair may be computed over. A premove is decided before the position
 * it is played in exists, and a book move the engine's lines never ranked has neither a rank nor a
 * loss — both report `rankInLines: 0` and `cpLoss: 0`, which would score as a zero-loss non-top-1
 * move and pull `top1Pct` *and* `acpl` down in exactly the speed classes §7.4 premoves in.
 */
function isScoredMove(chosen: ChosenMove): boolean {
	return chosen.source !== "premove" && chosen.rankInLines >= TOP_LINE_RANK;
}

/** `t_premove ~ U(0, maxS)` — §7.4 / Appendix D §3a.5 (120 ms). */
const PREMOVE_WINDOW_MS = TIMING_CONSTANTS.premove.maxS * MS_PER_S;

/** The §3.2 pipeline as the session uses it (`RecommendationPipeline` satisfies it). */
export interface SessionPipeline {
	run(input: RecommendationInput): Promise<RecommendationOutcome | null>;
}

/** What the session asks the registry to build when a game starts. */
export type ExecutorFactory = (config: {
	site: Site;
	persona: PersonaId;
	tcClass: TimeControlClass;
	gameSeed: string;
}) => MoveExecutor;

export interface GameSessionDeps {
	tabId: number;
	link: Pick<ContentLink, "post" | "request" | "onMessage" | "isConnected">;
	engine: EngineController | null;
	book: BookPolicy | null;
	/** Shared timing head (ChessMimic with the v1 fallback); one per service worker. */
	head: DistributionHead;
	debugger: Pick<DebuggerManager, "isAttached" | "detach">;
	focus: Pick<FocusGate, "positionArrived" | "onEdge" | "snapshot">;
	ownership: Pick<HandOwnership, "realPointerCount">;
	timingLog: Pick<TimingLogWriter, "append" | "upsert" | "markActual" | "attachTelemetry">;
	autoQueue: Pick<AutoQueue, "schedule" | "cancel">;
	createExecutor: ExecutorFactory;
	/**
	 * Overrides how the §3.2 pipeline is built for a game (default:
	 * `new RecommendationPipeline({ engine, timing, book })`). The seam exists so a harness can
	 * drive the whole orchestrator with a scripted recommendation — Task 33's conformance
	 * harness plugs in here — without stubbing the engine at the UCI level.
	 */
	createPipeline?: ((timing: TimingModel) => SessionPipeline) | undefined;
	/** The latest settings the registry has read. */
	getSettings(): Settings;
	/** Something the panel snapshot reflects changed. */
	notify(): void;
	/** `chrome.tts.speak` through the service's wrapper. */
	speak(text: string): Promise<void>;
	/** Task 34: pre-load the ChessMimic band for a target Elo before the first move. */
	warmTiming?: ((targetElo: number) => void) | undefined;
	/** The session became live / stopped being live (the registry holds `Keepalive`). */
	onLivenessChanged?: (() => void) | undefined;
	now?: () => number;
	scheduler?: Scheduler;
	/** Per-tab base seed; every per-game seed is derived from it. */
	seed?: string;
}

/** Commands the panel, the keybinds and `chrome.commands` all funnel into. */
export type SessionCommand =
	| "playNow"
	| "armAutoMove"
	| "toggleAutoMove"
	| "disarm"
	| "disable"
	| "speakMove";

/** Manifest `commands` names → session commands. */
export const COMMAND_NAMES = {
	playBestMove: "play-best-move",
	toggleAutoMove: "toggle-auto-move",
	disableAssistant: "disable-assistant",
} as const;

const COMMAND_MAP: Readonly<Record<string, SessionCommand>> = {
	[COMMAND_NAMES.playBestMove]: "playNow",
	[COMMAND_NAMES.toggleAutoMove]: "toggleAutoMove",
	[COMMAND_NAMES.disableAssistant]: "disable",
};

/** In-page keybind actions (`Keybinds` minus `global`) → session commands. */
const KEYBIND_MAP: Readonly<Record<string, SessionCommand>> = {
	playMove: "playNow",
	toggleAutoMove: "toggleAutoMove",
	disable: "disable",
	speakMove: "speakMove",
};

/** The motor's four-way class (it has no untimed profile; an untimed game moves like classical). */
function motorTcClass(tc: TcClass): TimeControlClass {
	return tc === "untimed" ? "classical" : tc;
}

interface PremoveArm {
	/** The opponent reply the premove is conditioned on. */
	reply: string;
	chosen: ChosenMove;
	/** Position the premove is played from (after our move and the expected reply). */
	fen: string;
}

export class GameSession implements SessionSource {
	private readonly deps: GameSessionDeps;
	private readonly now: () => number;
	private readonly scheduler: Scheduler;
	private readonly seed: string;
	private readonly offs: Array<() => void> = [];
	private readonly window = new MoveWindow();

	private state: GameSessionState = "idle";
	private site: Site | null = null;
	private pageKind: PageKind = "other";
	private game: GameMeta | null = null;
	private snapshot: PositionSnapshot | null = null;
	private rec: Recommendation | null = null;
	private recNReasonable = 1;
	private opponentInfo: { isBot: boolean; name: string; ratingEstimate: number | null } | null =
		null;

	private timing: TimingModel | null = null;
	private ponderer: PonderController | null = null;
	private pipeline: SessionPipeline | null = null;
	private executorHandle: MoveExecutor | null = null;
	private executorOffs: Array<() => void> = [];
	private selection: SelectionState = createSelectionState();
	private form: FormLatent = createFormLatent(createRng("form"));
	private rng: Rng;

	/** Feed dedupe (Task 21 replays `lastPosition` and the outbox on reconnect). */
	private lastPositionKey: string | null = null;
	/** The position before the current one — what the §7.4 premove policy replays our move from. */
	private priorFen: string | null = null;
	/** The timing profile in force this game (§4.6); `null` until a game starts. */
	private profile: TimingProfile | null = null;
	/** The time control that profile was derived from (`null` = none was known yet). */
	private profiledTimeControl: TimeControl | null = null;
	private pipelineAc: AbortController | null = null;
	private moves: string[] = [];
	private oppThinkMs: number[] = [];
	private myThinkMs: number[] = [];
	private lastOppMoveAt: number | null = null;
	private lastMyMoveAt: number | null = null;
	private premove: PremoveArm | null = null;
	private startClockMs = 0;
	/** A `playNow` issued while the pipeline was still running. */
	private playWhenReady = false;
	private disposed = false;
	/** `Settings.enabled` as of the last settings write this session saw (§4.4 flip detection). */
	private assistantOn: boolean;

	constructor(deps: GameSessionDeps) {
		this.deps = deps;
		this.assistantOn = deps.getSettings().enabled;
		this.now = deps.now ?? defaultNow;
		this.scheduler = deps.scheduler ?? defaultScheduler;
		this.seed = deps.seed ?? `tab-${deps.tabId}`;
		this.rng = createRng(`${this.seed}:session`);
		this.offs.push(
			deps.link.onMessage(deps.tabId, (msg) => this.onPortMessage(msg)),
			deps.focus.onEdge((tabId, hasFocus, at) => {
				if (tabId === deps.tabId) this.onFocusEdge(hasFocus, at);
			})
		);
	}

	// ── SessionSource (the panel snapshot) ─────────────────────────────────

	view(): SessionGameView {
		const s = this.snapshot;
		const view: SessionGameView = {
			state: this.state,
			gameId: this.game?.gameId ?? null,
			site: this.site,
			pageKind: this.pageKind,
			myColor: s?.myColor ?? this.game?.myColor ?? null,
			sideToMove: s?.sideToMove ?? null,
			ply: s?.ply ?? 0,
			clocks: s?.clocks ?? null,
		};
		const tc = s?.timeControl ?? this.game?.timeControl;
		if (tc) view.timeControl = tc;
		return view;
	}

	recommendation(): Recommendation | null {
		return this.rec;
	}

	opponent(): OpponentView | null {
		const o = this.opponentInfo;
		if (!o) return null;
		return {
			isBot: o.isBot,
			name: o.name,
			ratingEstimate: o.ratingEstimate,
			derivedTargetElo: this.targetElo(),
		};
	}

	// ── accessors the registry / handlers use ─────────────────────────────

	currentState(): GameSessionState {
		return this.state;
	}

	executor(): MoveExecutor | null {
		return this.executorHandle;
	}

	isLive(): boolean {
		return isLiveState(this.state);
	}

	/** §7.4a: the target the strength layer runs at (opponent-matched when enabled). */
	targetElo(): number {
		const s = this.deps.getSettings().strength;
		const rating = this.opponentInfo?.ratingEstimate ?? null;
		if (!s.matchOpponentRating || rating === null) return s.targetElo;
		return clamp(rating + s.personaEloOffset, LIMITS.eloMin, LIMITS.eloMax);
	}

	// ── commands ───────────────────────────────────────────────────────────

	/** A `chrome.commands` shortcut aimed at this tab's session. */
	onCommand(command: string): Promise<void> {
		const mapped = COMMAND_MAP[command];
		if (!mapped) {
			log.debug("game-session: unknown command", { command });
			return Promise.resolve();
		}
		return this.command(mapped);
	}

	/** An in-page keybind action (`Keybinds` key). */
	onKeybind(action: string): Promise<void> {
		const mapped = KEYBIND_MAP[action];
		if (!mapped) {
			log.debug("game-session: unknown keybind", { action });
			return Promise.resolve();
		}
		return this.command(mapped);
	}

	async command(cmd: SessionCommand): Promise<void> {
		if (this.disposed) return;
		switch (cmd) {
			case "playNow":
				await this.playNow();
				return;
			case "armAutoMove":
				await this.arm();
				return;
			case "toggleAutoMove":
				if (this.executorHandle?.isArmed()) this.disarm();
				else await this.arm();
				return;
			case "disarm":
				this.disarm();
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
		const on = this.assistantEnabled();
		const flipped = on !== this.assistantOn;
		this.assistantOn = on;
		// Sent first either way: `highlightMoves` is reported as `enabled && highlightMoves`, so
		// this is also what clears a mark the content script has already drawn.
		this.pushContentSettings();
		if (!flipped) return;
		if (on) void this.resumeEnabled();
		else this.stopDisabled();
	}

	/** §4.4: the master switch, as every acting path in this file reads it. */
	private assistantEnabled(): boolean {
		return this.deps.getSettings().enabled;
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
		this.cancelInFlight();
		this.deps.autoQueue.cancel(this.deps.tabId);
		this.rec = null;
		this.premove = null;
		const executor = this.executorHandle;
		executor?.disarm();
		void this.releaseDebugger(executor);
		this.deps.link.post(this.deps.tabId, { kind: "clearHighlight" });
		log.info("game-session: the assistant was turned off — nothing is analysed or played", {
			tabId: this.deps.tabId,
			state: this.state,
		});
		this.deps.notify();
	}

	/**
	 * Give the debugger back — but never while the hand is still winding down. `disarm()`'s abort
	 * needs several hops to reach the hand's release, and a detach that overtakes it leaves the page
	 * with a held mouse button and a piece stuck to the cursor, so the release is awaited first
	 * (`MoveExecutor.whenIdle`). A flip back on while waiting cancels the release: the hand is
	 * disarmed either way, and an attachment the user is about to re-arm is worth keeping.
	 */
	private async releaseDebugger(executor: MoveExecutor | null): Promise<void> {
		try {
			await executor?.whenIdle();
			if (this.disposed || this.assistantEnabled()) return;
			await this.deps.debugger.detach(this.deps.tabId);
			this.deps.notify();
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
		const snapshot = this.snapshot;
		log.info("game-session: the assistant was turned back on", {
			tabId: this.deps.tabId,
			state: this.state,
			resumed: snapshot !== null && isLiveState(this.state),
		});
		if (this.disposed || !snapshot || !isLiveState(this.state)) return;
		// A search already in flight (or a recommendation already standing) for this position is the
		// resume: the worker's first settings read can land after the session was built, so "on"
		// is not always a transition from a stopped session.
		if (this.pipelineAc !== null || this.rec !== null) return;
		const myTurn = snapshot.myColor !== null && snapshot.sideToMove === snapshot.myColor;
		if (myTurn) await this.runPipeline(snapshot);
		else await this.onOpponentTurn(snapshot);
	}

	/** Stop a running ponder / panel search (Task 13's `pendingOptions`, §6.4). */
	stopSearch(): Promise<void> {
		return this.ponderer?.stop() ?? Promise.resolve();
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		for (const off of this.offs.splice(0)) off();
		this.detachExecutor();
		this.pipelineAc?.abort();
		this.ponderer?.dispose();
		this.deps.autoQueue.cancel(this.deps.tabId);
		this.window.discard();
		this.deps.onLivenessChanged?.();
	}

	// ── the port feed ──────────────────────────────────────────────────────

	onPortMessage(msg: GamePortMessage): void {
		if (this.disposed) return;
		switch (msg.kind) {
			case "hello":
				this.onHello(msg.site, msg.pageKind);
				return;
			case "gameStarted":
				this.onGameStarted(msg.game);
				return;
			case "position":
				void this.onPosition(msg.snapshot);
				return;
			case "gameEnded":
				this.onGameEnded(msg.result);
				return;
			case "opponent":
				this.opponentInfo = {
					isBot: msg.isBot,
					name: msg.name,
					ratingEstimate: msg.ratingEstimate,
				};
				this.deps.notify();
				return;
			case "moveObserved":
				this.onMoveObserved(msg.san, msg.byMe, msg.atMs);
				return;
			case "selectorMiss":
				log.warn("game-session: adapter selector miss", {
					tabId: this.deps.tabId,
					selector: msg.selector,
				});
				return;
			default:
				return;
		}
	}

	onHello(site: Site, pageKind: PageKind): void {
		this.site = site;
		this.pageKind = pageKind;
		this.apply("hello");
		// §13.4: the hand must be armable *in the waiting view*, so the debugger's infobar (and
		// whatever it shifts) lands outside every move window. The executor therefore exists from
		// the moment the page says hello; `startGame` replaces it with the game's own profile and
		// carries the armed state (and the attachment) across.
		this.ensureExecutor(site);
		this.pushContentSettings();
		this.deps.notify();
	}

	/** A pre-game executor so `arm()` works before the first position (§13.4). */
	private ensureExecutor(site: Site): void {
		if (this.executorHandle) return;
		this.attachExecutor({
			site,
			persona: this.deps.getSettings().strength.persona,
			// No time control is known yet; the game's own class replaces this at `startGame`.
			tcClass: motorTcClass("untimed"),
			gameSeed: `${this.seed}:pregame`,
		});
	}

	/** The tab navigated away from the game (`navigated`) or was closed (`tabRemoved`). */
	onTabEvent(event: "navigated" | "tabRemoved"): void {
		this.cancelInFlight();
		this.deps.autoQueue.cancel(this.deps.tabId);
		this.rec = null;
		if (event === "navigated") this.game = null;
		this.apply(event);
		this.deps.notify();
	}

	onGameStarted(meta: GameMeta): void {
		if (this.game?.gameId === meta.gameId) return;
		this.startGame(meta);
		this.apply("gameStarted");
		this.deps.notify();
	}

	onGameEnded(result: GameResult): void {
		if (!this.apply("gameEnded")) return;
		this.cancelInFlight();
		this.rec = null;
		this.premove = null;
		void this.finishGame(result);
		this.deps.notify();
	}

	// ── the per-position pipeline (§3.2) ───────────────────────────────────

	async onPosition(snapshot: PositionSnapshot): Promise<void> {
		if (this.disposed) return;
		const key = `${snapshot.gameId}|${snapshot.ply}|${snapshot.fen}`;
		if (key === this.lastPositionKey) return; // the reconnect replay (Task 21)
		if (
			this.game?.gameId === snapshot.gameId &&
			this.snapshot !== null &&
			snapshot.ply < this.snapshot.ply
		) {
			log.debug("game-session: ignoring an older ply", {
				tabId: this.deps.tabId,
				ply: snapshot.ply,
				have: this.snapshot.ply,
			});
			return;
		}
		this.lastPositionKey = key;
		if (this.game?.gameId !== snapshot.gameId) {
			this.startGame({
				gameId: snapshot.gameId,
				site: snapshot.site,
				pageKind: this.pageKind,
				myColor: snapshot.myColor,
				...(snapshot.timeControl ? { timeControl: snapshot.timeControl } : {}),
				startedAt: snapshot.capturedAt,
			});
			this.apply("gameStarted");
		}
		this.site = snapshot.site;
		this.cancelInFlight();
		const previous = this.snapshot;
		this.priorFen = previous?.fen ?? null;
		this.snapshot = snapshot;
		this.reprofile(snapshot);
		this.rec = null;
		const myTurn = snapshot.myColor !== null && snapshot.sideToMove === snapshot.myColor;
		const at = this.now();
		this.deps.focus.positionArrived(this.deps.tabId, at);
		this.window.open(at, myTurn);
		this.trackMove(previous, snapshot);
		if (!this.apply("positionChanged", { myTurn })) return;
		this.deps.notify();
		if (!this.assistantEnabled()) {
			// §4.4: everything above is bookkeeping the panel reads and a resume needs (the ply, the
			// clocks, the move list, the focus gate's window). Nothing below it runs while the
			// switch is off: no `go`, no ponder, no premove, no recommendation, no schedule.
			log.debug("game-session: position ignored — the assistant is off", {
				tabId: this.deps.tabId,
				ply: snapshot.ply,
			});
			return;
		}
		if (!myTurn) {
			await this.onOpponentTurn(snapshot);
			return;
		}
		if (await this.tryPremove(snapshot)) return;
		await this.runPipeline(snapshot);
	}

	/**
	 * §4.6: an adapter that reports the time control on the first `position` rather than on
	 * `gameStarted` must still get its preset. The model is rebuilt once, before anything has
	 * been planned this game, so no per-game state is lost; afterwards the profile is frozen.
	 */
	private reprofile(snapshot: PositionSnapshot): void {
		const tc = snapshot.timeControl;
		const timing = this.timing;
		if (!tc || !timing || this.profiledTimeControl !== null || this.myThinkMs.length > 0) return;
		const meta = this.game;
		if (!meta) return;
		this.game = { ...meta, timeControl: tc };
		this.profiledTimeControl = tc;
		const settings = this.deps.getSettings();
		const next = timingSettingsFor(settings.timing, tc);
		this.profile = next.profile;
		const [baseSec, incSec] = this.timeControlSeconds(this.game);
		this.startClockMs = baseSec * MS_PER_S;
		this.timing = new TimingModel(
			this.deps.head,
			next,
			createRng(`${this.seed}:${meta.gameId}:timing`),
			{ onEntry: (entry) => this.deps.timingLog.upsert(entry) }
		);
		this.timing.startGame({
			targetElo: this.targetElo(),
			profile: settings.strength.persona,
			baseSec,
			incSec,
			site: meta.site,
			gameId: meta.gameId,
		});
		this.pipeline = this.deps.createPipeline
			? this.deps.createPipeline(this.timing)
			: this.deps.engine
				? new RecommendationPipeline({
						engine: this.deps.engine,
						timing: this.timing,
						book: this.deps.book,
					})
				: null;
		log.debug("game-session: time control learned from the first position", {
			tabId: this.deps.tabId,
			profile: next.profile,
		});
	}

	/** Opponent's turn: ponder (§6.4) and prepare a premove candidate (§7.4). */
	private async onOpponentTurn(snapshot: PositionSnapshot): Promise<void> {
		const ponderer = this.ponderer;
		if (!ponderer) return;
		await ponderer.start("opponent", snapshot.fen);
		// §4.4: starting the ponder is an await, so the switch may have gone off inside it — and
		// `stopDisabled` stopped that ponder. Nothing more is searched for this position.
		if (!this.assistantEnabled()) return;
		await this.armPremove(snapshot);
	}

	/** §3.2 steps 1–5 for the current position. */
	private async runPipeline(snapshot: PositionSnapshot): Promise<void> {
		const pipeline = this.pipeline;
		const timing = this.timing;
		if (!pipeline || !timing) return;
		const ac = new AbortController();
		this.pipelineAc = ac;
		// Appendix E §4.4 rule 1 + Task 13: never issue a `position`/`go` while a ponder is live,
		// and never leave the engine busy while an options change is pending.
		await this.ponderer?.stop();
		const settings = this.deps.getSettings();
		const expected = this.ponderer?.expectedReply(snapshot.fen) ?? null;
		let outcome: RecommendationOutcome | null = null;
		try {
			outcome = await pipeline.run({
				snapshot,
				settings,
				targetElo: this.targetElo(),
				persona: settings.strength.persona,
				form: this.form.value,
				tau: timing.persona.tau,
				moves: this.moves,
				expectedOppReply: expected,
				oppThinkMsHistory: this.oppThinkMs,
				myThinkMsHistory: this.myThinkMs,
				selectionState: this.selection,
				budgetUsedRatio: this.budgetUsedRatio(snapshot),
				rng: this.rng,
				signal: ac.signal,
				nowMs: this.now(),
				engineReady: this.deps.engine !== null,
				autoQueen: true,
				inputMethod: settings.execution.style === "click" ? "click" : "drag",
			});
		} catch (error) {
			log.warn("game-session: pipeline failed", { error: errorMessage(error) });
		}
		if (this.disposed || ac.signal.aborted || this.snapshot !== snapshot) return;
		this.pipelineAc = null;
		if (!outcome) {
			log.info("game-session: no recommendation for this position", { fen: snapshot.fen });
			return;
		}
		this.rec = outcome.rec;
		this.recNReasonable = outcome.nReasonable;
		this.apply("recommended");
		this.postHighlight(outcome.rec);
		this.deps.notify();
		if (settings.display.tts) void this.speakRecommendation();
		await this.actOnRecommendation(outcome.rec, settings);
	}

	/** §3.2 step 5 / §8.5: schedule, play at once, or leave the plan on display. */
	private async actOnRecommendation(rec: Recommendation, settings: Settings): Promise<void> {
		const executor = this.executorHandle;
		if (this.playWhenReady) {
			this.playWhenReady = false;
			await this.playNow();
			return;
		}
		if (!executor?.isArmed() || !this.autoMoveAllowed(settings)) {
			// Panel-only mode (§7.5): keep deepening the eval on our own position.
			await this.ponderer?.start("panel", rec.fen);
			return;
		}
		executor.schedule(rec, rec.plan, this.moveContext(rec));
	}

	/** `manual` never auto-plays ("Never auto-plays; shows recommendations only.", §4.6). */
	private autoMoveAllowed(settings: Settings): boolean {
		return autoPlayAllowed(
			this.profile ?? effectiveTimingProfile(settings.timing.profile, this.currentTimeControl())
		);
	}

	private moveContext(rec: Recommendation): MoveContext {
		const snapshot = this.snapshot;
		const ctx: MoveContext = {
			nReasonable: this.recNReasonable,
			// The executor's own rank-weighted derivation (Task 18) — one definition, not two.
			candidates: candidatesFromLines(rec),
			legalDestinations: (sq: Square) => this.legalDestinations(sq),
		};
		if (snapshot?.myColor) ctx.myClockMs = snapshot.clocks[snapshot.myColor].ms;
		return ctx;
	}

	private legalDestinations(from: Square): Square[] {
		const fen = this.snapshot?.fen;
		if (!fen) return [];
		const out: Square[] = [];
		for (const uci of legalMoves(fen)) {
			if (!uci.startsWith(from)) continue;
			const to = uci.slice(2, 4);
			if (isSquare(to)) out.push(to);
		}
		return out;
	}

	// ── premove (§7.4) ─────────────────────────────────────────────────────

	/** After our move: pre-compute the premove for the opponent's expected reply. */
	private async armPremove(snapshot: PositionSnapshot): Promise<void> {
		this.premove = null;
		const engine = this.deps.engine;
		const timing = this.timing;
		const settings = this.deps.getSettings();
		const last = this.moves[this.moves.length - 1];
		// §4.4: `premoveCandidate` issues its own `analyse` at `ponder` priority, so the switch is
		// checked here too — `settings.enabled` is read from the same snapshot as `autoMoveAllowed`.
		if (!settings.enabled) return;
		if (!engine || !timing || last === undefined || !this.autoMoveAllowed(settings)) return;
		const previous = this.priorFen;
		if (previous === null) return;
		try {
			const candidate = await premoveCandidate(
				{
					fen: previous,
					move: last,
					targetElo: this.targetElo(),
					timeControl: snapshot.timeControl,
					ponder: this.ponderer?.expectedReply(snapshot.fen) ?? undefined,
					rng: this.rng,
					// `Persona.pi_p` is in logit units; the policy takes a probability in [0, 1].
					piP: 1 / (1 + Math.exp(-timing.persona.pi_p)),
				},
				{
					analyseAfter: async (fen, moves, opts) => {
						const handle = engine.analyse({
							id: `${this.deps.tabId}-premove-${this.now()}`,
							fen,
							moves: [...moves],
							multiPv: opts.multiPv,
							limit: { movetimeMs: opts.movetimeMs },
							priority: "ponder",
						});
						const result = await handle.result;
						return result.final.lines;
					},
				}
			);
			// The search above is an await: a flip-off inside it already nulled `this.premove`, so a
			// candidate must not be published over the top of that (§4.4).
			if (!candidate || this.disposed || this.snapshot !== snapshot || !this.assistantEnabled())
				return;
			const chosen: ChosenMove = {
				uci: candidate.premove,
				san: candidate.premove,
				from: candidate.from,
				to: candidate.to,
				source: "premove",
				rankInLines: 0,
				cpLoss: 0,
				rationale: [`premove: ${candidate.reason} (p(reply)=${candidate.replyProbability.toFixed(2)})`],
			};
			if (candidate.promotion) chosen.promotion = candidate.promotion;
			this.premove = { reply: candidate.reply, chosen, fen: snapshot.fen };
			log.info("game-session: premove armed", {
				tabId: this.deps.tabId,
				reply: candidate.reply,
				premove: candidate.premove,
			});
		} catch (error) {
			log.debug("game-session: premove unavailable", { error: errorMessage(error) });
		}
	}

	/**
	 * The opponent played the reply the premove was conditioned on: play it at
	 * once (`t_premove ~ U(0, PREMOVE.maxS)`, §7.4) without a fresh search.
	 */
	private async tryPremove(snapshot: PositionSnapshot): Promise<boolean> {
		const armed = this.premove;
		this.premove = null;
		const executor = this.executorHandle;
		const timing = this.timing;
		if (!armed || !executor || !timing || !executor.isArmed()) return false;
		const last = this.moves[this.moves.length - 1];
		if (last !== armed.reply) return false;
		const settings = this.deps.getSettings();
		if (!this.autoMoveAllowed(settings)) return false;
		const san = uciToSan(snapshot.fen, armed.chosen.uci);
		if (san === null) return false;
		const chosen: ChosenMove = { ...armed.chosen, san };
		const fireInMs = this.rng.next() * PREMOVE_WINDOW_MS;
		const now = this.now();
		const rec: Recommendation = {
			chosen,
			lines: [],
			eval: { cp: 0 },
			depth: 0,
			nps: 0,
			plan: {
				thinkMs: fireInMs,
				mode: "premove",
				preMoveHoverMs: 0,
				dragDurationMs: 0,
				deadlineMs: now + fireInMs,
				rationale: [...chosen.rationale],
				features: {},
				orientationMs: 0,
				window: {
					orientationMs: 0,
					scanMs: 0,
					previewMs: 0,
					decisionMs: 0,
					approachMs: fireInMs,
				},
			},
			computedAt: now,
			fen: snapshot.fen,
		};
		this.rec = rec;
		this.recNReasonable = 1;
		// §8.6 wants a row per *played* move, and a premove never goes through `planMove` (it was
		// decided during the opponent's turn), so the session writes its row itself — otherwise
		// `markActual` / `attachTelemetry` would have nothing to attach to and the move would be
		// missing from the export entirely.
		this.deps.timingLog.append(
			buildTimingLogEntry({
				gameId: this.game?.gameId ?? "",
				ply: snapshot.ply,
				mode: "premove",
				plannedMs: fireInMs,
				alloc: 0,
				clockMs: snapshot.myColor ? snapshot.clocks[snapshot.myColor].ms : 0,
				comp: 1,
				eps: 0,
				terms: [],
				persona: settings.strength.persona,
			})
		);
		this.apply("recommended");
		this.deps.notify();
		executor.schedule(rec, rec.plan, this.moveContext(rec));
		log.info("game-session: premove fired", { tabId: this.deps.tabId, uci: chosen.uci, fireInMs });
		return true;
	}

	// ── user commands ──────────────────────────────────────────────────────

	private async arm(): Promise<void> {
		const executor = this.executorHandle;
		if (!executor) {
			log.info("game-session: nothing to arm (no game on this tab)", { tabId: this.deps.tabId });
			return;
		}
		if (!this.assistantEnabled()) {
			// §4.4: an armed hand with nothing to play is a promise the switch says is off.
			log.info("game-session: arm refused — the assistant is off", { tabId: this.deps.tabId });
			return;
		}
		this.apply("armAutoMove");
		try {
			await executor.arm();
		} catch (error) {
			log.warn("game-session: arm failed", { error: errorMessage(error) });
			this.deps.notify();
			return;
		}
		const rec = this.rec;
		if (rec && this.state === "live:my-turn:recommended" && !executor.pendingMove())
			executor.schedule(rec, rec.plan, this.moveContext(rec));
		this.deps.notify();
	}

	private disarm(): void {
		this.executorHandle?.disarm();
		this.apply("disarm");
		this.deps.notify();
	}

	/** `Shift+X`: stop everything on this tab — highlights cleared, executor cancelled. */
	private disable(): void {
		this.cancelInFlight();
		this.executorHandle?.disarm();
		this.deps.autoQueue.cancel(this.deps.tabId);
		this.deps.link.post(this.deps.tabId, { kind: "clearHighlight" });
		this.rec = null;
		this.premove = null;
		this.apply("disable");
		this.deps.notify();
	}

	/** §8.5 manual path: the pending move (else the current recommendation) plays now. */
	private async playNow(): Promise<void> {
		const executor = this.executorHandle;
		if (!executor) return;
		if (!this.assistantEnabled()) {
			log.info("game-session: playNow refused — the assistant is off", { tabId: this.deps.tabId });
			return;
		}
		if (!executor.isArmed()) {
			log.info("game-session: playNow ignored — the hand is not armed (§13.4)", {
				tabId: this.deps.tabId,
			});
			return;
		}
		const pending = executor.pendingMove();
		if (pending) {
			this.apply("playNow");
			this.deps.notify();
			await executor.playNow(pending.rec, pending.rec.plan, this.moveContext(pending.rec));
			return;
		}
		const rec = this.rec;
		if (!rec) {
			// The search is still running: play it the moment it answers.
			this.playWhenReady = true;
			this.apply("playNow");
			return;
		}
		const timing = this.timing;
		const plan = timing
			? timing.replan(rec.plan, this.timingContextFor(rec), "manual-now")
			: rec.plan;
		this.apply("playNow");
		this.deps.notify();
		await executor.playNow(rec, plan, this.moveContext(rec));
	}

	private async speakRecommendation(): Promise<void> {
		const rec = this.rec;
		if (!rec) return;
		const text = sanToSpeech(rec.chosen.san);
		if (text === "") return;
		try {
			await this.deps.speak(text);
		} catch (error) {
			log.debug("game-session: tts failed", { error: errorMessage(error) });
		}
	}

	// ── game lifecycle ─────────────────────────────────────────────────────

	private startGame(meta: GameMeta): void {
		this.game = meta;
		this.site = meta.site;
		this.snapshot = null;
		this.rec = null;
		this.premove = null;
		this.moves = [];
		this.oppThinkMs = [];
		this.myThinkMs = [];
		this.lastOppMoveAt = null;
		this.lastMyMoveAt = null;
		this.lastPositionKey = null;
		this.priorFen = null;
		this.selection = createSelectionState();
		const gameSeed = `${this.seed}:${meta.gameId}`;
		this.rng = createRng(`${gameSeed}:session`);
		this.form = createFormLatent(createRng(`${gameSeed}:form`));
		this.window.discard();

		const settings = this.deps.getSettings();
		const [baseSec, incSec] = this.timeControlSeconds(meta);
		const tc = tcClass(baseSec, incSec);
		this.startClockMs = baseSec * MS_PER_S;
		const targetElo = this.targetElo();
		const timing = timingSettingsFor(settings.timing, meta.timeControl);
		this.profile = timing.profile;
		this.profiledTimeControl = meta.timeControl ?? null;

		this.timing = new TimingModel(this.deps.head, timing, createRng(`${gameSeed}:timing`), {
			onEntry: (entry) => this.deps.timingLog.upsert(entry),
		});
		this.timing.startGame({
			targetElo,
			profile: settings.strength.persona,
			baseSec,
			incSec,
			site: meta.site,
			gameId: meta.gameId,
		});
		// §4.4: with the switch off nothing will search, so nothing is pre-warmed either.
		if (this.assistantEnabled()) this.deps.warmTiming?.(targetElo);

		const engine = this.deps.engine;
		if (engine) {
			void engine
				.newGame(meta.gameId)
				.catch((error: unknown) => log.warn("game-session: ucinewgame failed", error));
			this.ponderer?.dispose();
			this.ponderer = new PonderController({
				engine,
				scheduler: this.scheduler,
				now: this.now,
			});
		}
		this.pipeline = this.deps.createPipeline
			? this.deps.createPipeline(this.timing)
			: engine
				? new RecommendationPipeline({ engine, timing: this.timing, book: this.deps.book })
				: null;

		this.attachExecutor({
			site: meta.site,
			persona: settings.strength.persona,
			tcClass: motorTcClass(tc),
			gameSeed,
		});
		this.pushContentSettings();
		log.info("game-session: game started", {
			tabId: this.deps.tabId,
			gameId: meta.gameId,
			site: meta.site,
			targetElo,
			tc,
		});
	}

	private async finishGame(result: GameResult): Promise<void> {
		await this.updateStats((stats) => foldGame(stats, this.targetElo()));
		const settings = this.deps.getSettings();
		// §4.4: the auto-queue asks the *page* for a new game, so the switch gates it like the rest.
		if (settings.enabled && settings.automation.autoQueue)
			this.deps.autoQueue.schedule(this.deps.tabId);
		log.info("game-session: game over", { tabId: this.deps.tabId, result });
	}

	// ── executor plumbing ──────────────────────────────────────────────────

	private attachExecutor(config: Parameters<ExecutorFactory>[0]): void {
		const previous = this.executorHandle;
		const wasArmed = previous?.isArmed() ?? false;
		const executor = this.deps.createExecutor(config);
		for (const off of this.executorOffs.splice(0)) off();
		// A factory may legitimately hand the same executor back (one hand for the whole tab);
		// only a *replacement* retires the old one.
		if (previous && previous !== executor) previous.dispose();
		this.executorHandle = executor;
		this.executorOffs = [
			executor.on("executed", (report) => this.onExecuted(report)),
			executor.on("failed", (report) => this.onFailed(report)),
			executor.on("aborted", (report) => this.onNotExecuted(report, "aborted")),
			executor.on("skipped", (report) => this.onNotExecuted(report, "skipped")),
			executor.on("hand", (hand) => {
				if (hand !== "rest") this.apply("handStarted");
			}),
		];
		// A game that follows an armed one keeps the hand armed (the debugger stays attached), and
		// `Settings.automation.autoMove` is the stored "arm me" default. Either way the attach
		// happens here — before the first position of the game, i.e. outside every move window
		// (§13.4) — never once a move is due.
		// §4.4: neither default arms anything while the assistant is off.
		if (this.assistantEnabled() && (wasArmed || this.deps.getSettings().automation.autoMove))
			void executor.arm().catch((error: unknown) => log.warn("game-session: re-arm failed", error));
	}

	private detachExecutor(): void {
		for (const off of this.executorOffs.splice(0)) off();
		this.executorHandle?.dispose();
		this.executorHandle = null;
	}

	private onExecuted(report: ExecutionReport): void {
		this.apply("executed");
		this.recordMove(report);
		this.deps.notify();
	}

	private onFailed(report: ExecutionReport): void {
		log.warn("game-session: execution failed", {
			tabId: this.deps.tabId,
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
	 */
	private onNotExecuted(report: ExecutionReport, outcome: "aborted" | "skipped" | "failed"): void {
		this.apply("failed");
		this.window.discard();
		log.debug("game-session: move did not land", {
			tabId: this.deps.tabId,
			outcome,
			uci: report.rec.chosen.uci,
			reason: report.result.reason ?? null,
			state: this.state,
		});
		this.deps.notify();
	}

	/** §8.6 + §13.2: the realised think time and the move's telemetry record. */
	private recordMove(report: ExecutionReport): void {
		const { rec, result } = report;
		const snapshot = this.snapshot;
		const timing = this.timing;
		if (timing) timing.observe(result.elapsedMs, rec.plan);
		this.myThinkMs.push(result.elapsedMs);
		if (snapshot && this.game) {
			this.deps.timingLog.markActual(this.game.gameId, snapshot.ply, result.elapsedMs);
			const record = this.window.close({
				elapsedMs: result.elapsedMs,
				pointerOffsetPx: result.pointerOffsetPx ?? 0,
				multiplePieces: selectedMultiplePieces(result, rec.chosen.from),
				orientationMs: rec.plan.orientationMs,
				multiSelectEligible: this.multiSelectEligible(rec, snapshot),
				nReasonable: this.recNReasonable,
				// §13.6: only a move the engine actually ranked carries a quality pair.
				quality: isScoredMove(rec.chosen)
					? { top1: rec.chosen.rankInLines === TOP_LINE_RANK, cpLoss: rec.chosen.cpLoss }
					: undefined,
				at: result.at ?? this.now(),
			});
			if (record) this.deps.timingLog.attachTelemetry(this.game.gameId, snapshot.ply, record);
		}
		void this.updateStats((stats) =>
			foldMove(stats, {
				thinkMs: result.elapsedMs,
				scored: isScoredMove(rec.chosen),
				top1: rec.chosen.rankInLines === TOP_LINE_RANK,
				cpLoss: rec.chosen.cpLoss,
			})
		);
	}

	/** §13.2 / §9.3a: a move where a preview selection is plausible at all. */
	private multiSelectEligible(rec: Recommendation, snapshot: PositionSnapshot): boolean {
		const b = TELEMETRY_BANDS.multiSelect;
		const mode = rec.plan.mode;
		const clockMs = snapshot.myColor ? snapshot.clocks[snapshot.myColor].ms : 0;
		return (
			(mode === "normal" || mode === "long") &&
			rec.plan.thinkMs >= b.minThinkMs &&
			clockMs >= b.minClockMs
		);
	}

	// ── focus discipline (§13.4) ───────────────────────────────────────────

	/**
	 * A blur inside the current move window cancels the scheduled execution for
	 * this move (the move is played only after a fresh position) and the timing
	 * model observes the elapsed time. The extension never takes focus back.
	 */
	private onFocusEdge(hasFocus: boolean, at: number): void {
		this.window.edge(hasFocus, at);
		if (hasFocus) return;
		const executor = this.executorHandle;
		const pending = executor?.pendingMove() ?? null;
		if (!executor || (!pending && !executor.isRunning())) {
			this.deps.notify();
			return;
		}
		log.info("game-session: blur inside the move window — execution cancelled (§13.4)", {
			tabId: this.deps.tabId,
			at,
		});
		executor.cancel();
		const rec = this.rec;
		const timing = this.timing;
		if (rec && timing) timing.replan(rec.plan, this.timingContextFor(rec), "blur");
		this.deps.notify();
	}

	// ── helpers ────────────────────────────────────────────────────────────

	private apply(event: GameSessionEvent, input: { myTurn?: boolean } = {}): boolean {
		const previous = this.state;
		const next = nextState(previous, event, input);
		if (next === null) return false;
		if (next === previous) return true;
		this.state = next;
		log.debug("game-session: state", { tabId: this.deps.tabId, previous, event, next });
		if (isLiveState(previous) !== isLiveState(next)) this.deps.onLivenessChanged?.();
		return true;
	}

	private cancelInFlight(): void {
		this.pipelineAc?.abort();
		this.pipelineAc = null;
		this.playWhenReady = false;
		this.executorHandle?.cancel();
		void this.ponderer?.stop();
	}

	/** Content-script settings that gate what it may draw (§13.3 rule 4). */
	private pushContentSettings(): void {
		const settings = this.deps.getSettings();
		const commands: GamePortCommand[] = [
			// §4.4: the master switch gates the board marks too — and because the content script
			// clears what it has drawn the moment this turns off, this is also the clear.
			{ kind: "settings", highlightMoves: settings.enabled && settings.automation.highlightMoves },
			{ kind: "keybinds", keybinds: settings.keybinds },
		];
		for (const cmd of commands) this.deps.link.post(this.deps.tabId, cmd);
	}

	private postHighlight(rec: Recommendation): void {
		const settings = this.deps.getSettings();
		if (!settings.enabled || !settings.automation.highlightMoves) return;
		this.deps.link.post(this.deps.tabId, {
			kind: "highlight",
			from: rec.chosen.from,
			to: rec.chosen.to,
			style: settings.automation.highlightStyle,
		});
	}

	/** Record the move that produced `snapshot` and the pace it was played at. */
	private trackMove(previous: PositionSnapshot | null, snapshot: PositionSnapshot): void {
		const last = snapshot.lastMove;
		if (!last || !previous) return;
		const uci = this.uciOf(previous.fen, last.from, last.to);
		if (uci !== null && this.moves[this.moves.length - 1] !== uci) this.moves.push(uci);
		const at = snapshot.capturedAt;
		const byMe = snapshot.myColor !== null && snapshot.sideToMove !== snapshot.myColor;
		if (byMe) this.lastMyMoveAt = at;
		else {
			if (this.lastMyMoveAt !== null) this.oppThinkMs.push(Math.max(0, at - this.lastMyMoveAt));
			this.lastOppMoveAt = at;
		}
	}

	private onMoveObserved(san: string, byMe: boolean, atMs: number): void {
		log.debug("game-session: move observed", { tabId: this.deps.tabId, san, byMe, atMs });
		if (!byMe && this.lastOppMoveAt === null) this.lastOppMoveAt = atMs;
	}

	private uciOf(fen: string, from: Square, to: Square): string | null {
		const base = `${from}${to}`;
		const legal = legalMoves(fen);
		if (legal.includes(base)) return base;
		const promotion = legal.find((m) => m.startsWith(base));
		return promotion ?? null;
	}

	private budgetUsedRatio(snapshot: PositionSnapshot): number {
		if (this.startClockMs <= 0 || snapshot.myColor === null) return 0;
		const left = snapshot.clocks[snapshot.myColor].ms;
		return clamp(1 - left / this.startClockMs, 0, 1);
	}

	private timeControlSeconds(meta: GameMeta): [number, number] {
		const tc = meta.timeControl;
		if (!tc) return [0, 0];
		return [tc.baseMs / MS_PER_S, tc.incMs / MS_PER_S];
	}

	/**
	 * The time control the presets are keyed on — the game's, else the one the first position
	 * brought. `startGame` freezes the profile it derives from this into `profile`, and
	 * `autoMoveAllowed` reads the frozen value, so the model's knobs and the "may I auto-play"
	 * answer can never disagree mid-game.
	 */
	private currentTimeControl(): TimeControl | undefined {
		return this.game?.timeControl ?? this.snapshot?.timeControl;
	}

	private timingContextFor(rec: Recommendation): TimingContext {
		const snapshot = this.snapshot;
		const settings = this.deps.getSettings();
		const myColor: Color = snapshot?.myColor ?? "w";
		const [baseSec, incSec] = this.game ? this.timeControlSeconds(this.game) : [0, 0];
		return {
			fen: rec.fen,
			ply: snapshot?.ply ?? 0,
			moves: [...this.moves],
			myColor,
			chosenMove: rec.chosen.uci,
			lines: rec.lines,
			evalBeforeOppMove: this.timing?.state.lastEvalOurPov ?? null,
			expectedOppReply: this.ponderer?.expectedReply() ?? null,
			myClockMs: snapshot ? snapshot.clocks[myColor].ms : 0,
			oppClockMs: snapshot ? snapshot.clocks[myColor === "w" ? "b" : "w"].ms : 0,
			baseSec,
			incSec,
			oppThinkMsHistory: [...this.oppThinkMs],
			myThinkMsHistory: [...this.myThinkMs],
			site: this.site ?? "chesscom",
			targetElo: this.targetElo(),
			profile: settings.strength.persona,
			engineReady: this.deps.engine !== null,
			inputMethod: settings.execution.style === "click" ? "click" : "drag",
			autoQueen: true,
			nowMs: this.now(),
		};
	}

	private updateStats(fold: (stats: SessionStats) => SessionStats): Promise<void> {
		return queueStatsWrite(fold);
	}
}
