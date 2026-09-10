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
 */

import { sideToMove as turnOfFen } from "@core/chess/fen";
import { applyMoves, legalMoves, uciToSan } from "@core/chess/san";
import { sanToSpeech } from "@core/chess/san-speech";
import { isSquare } from "@core/chess/squares";
import { chromeLocalGet, chromeLocalSet } from "@core/chrome/storage";
import { LIMITS } from "@core/constants/limits";
import type { GamePortCommand, GamePortMessage } from "@core/constants/messages";
import { LOCAL_KEYS } from "@core/constants/storage-keys";
import { TELEMETRY_BANDS } from "@core/constants/telemetry";
import type { TimingProfile } from "@core/constants/timings";
import type { AnalysisHandle, AnalysisRequest } from "@core/engine/types";
import { log } from "@core/logger";
import type { TimeControlClass } from "@core/motor/types";
import { createRng, type Rng } from "@core/rng";
import type { BookPolicy } from "@core/strength/book/book-policy";
import { createSelectionState } from "@core/strength/move-selector";
import { createFormLatent, type FormLatent } from "@core/strength/persona";
import { isPremoveSpeed, premoveCandidate } from "@core/strength/premove";
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
import { ownMoveBudget, RecommendationPipeline } from "./recommendation";
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
	/**
	 * Whether `getSettings()` is the *stored* settings yet, rather than `DEFAULT_SETTINGS` standing
	 * in until the first `chrome.storage.local` read answers (§4.4 / the MV3 cold start). Omitted
	 * by a caller that hands the session real settings synchronously, which is every harness.
	 */
	settingsKnown?: (() => boolean) | undefined;
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
	/** Appendix E §4.5: the in-flight pre-analysis of the position the expected reply leads to. */
	private preAnalysis: AnalysisHandle | null = null;
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
	/** `mayAct()` as of the last settings write this session saw (§4.4 flip detection). */
	private acting: boolean;

	constructor(deps: GameSessionDeps) {
		this.deps = deps;
		this.acting = this.mayAct();
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
		const on = this.mayAct();
		const flipped = on !== this.acting;
		this.acting = on;
		// Sent first either way: `highlightMoves` is reported as `enabled && highlightMoves`, so
		// this is also what clears a mark the content script has already drawn.
		this.pushContentSettings();
		if (!flipped) return;
		if (on) void this.resumeEnabled();
		else this.stopDisabled();
	}

	/**
	 * §4.4: may this session act on the page at all right now? The master switch, plus the
	 * cold-start rule that an *unknown* switch holds rather than guesses — `DEFAULT_SETTINGS` is
	 * not the user's answer, in either direction, so nothing is analysed, drawn, armed or played
	 * until the stored settings have actually been read.
	 */
	private mayAct(): boolean {
		return this.settingsKnown() && this.deps.getSettings().enabled;
	}

	/** Whether `getSettings()` is the stored settings yet (a caller that omits the seam knows them). */
	private settingsKnown(): boolean {
		return this.deps.settingsKnown?.() ?? true;
	}

	/**
	 * May this session act on `snapshot`? The master switch, plus the second three-valued reading
	 * the page gives us: **which side the owner is playing**. It is mine, theirs, or *not known
	 * yet* — the MAIN-world bridge answers `getPlayingAs()` a moment after the board appears, and
	 * until then a live game carries no colour evidence at all (owner's live test, 2026-09-09:
	 * the adapter guessed white, the owner was black, and every recommendation, highlight and
	 * scheduled move was for the *opponent*).
	 *
	 * So unknown holds, exactly as an unknown switch does: the position is still followed — ply,
	 * clocks, move list, state machine, panel — and nothing is analysed, pondered, recommended,
	 * highlighted, scheduled or played. The adapter republishes the same position the moment it
	 * learns the colour (`AdapterBase.apply`), and that reading is the resume.
	 */
	private mayActOn(snapshot: PositionSnapshot): boolean {
		return this.mayAct() && snapshot.myColor !== null;
	}

	/**
	 * Is the side to move in this position's **own FEN** the side we are playing?
	 *
	 * `myTurn` is `snapshot.sideToMove === snapshot.myColor`, and the adapter builds `sideToMove` on a
	 * different ladder from the FEN it publishes beside it (bridge → clock → move-list parity against
	 * bridge → replay → DOM). Everything downstream of here — the `go`, the selection, the plan, the
	 * mark, the hand — is for whoever the **FEN** says is to move, so the two disagreeing is not a
	 * cosmetic inconsistency: it makes the assistant recommend, draw and play the *opponent's* move
	 * and present it as ours (owner's live game, 2026-09-10: white's first move shown while the owner
	 * was black, white's clock ticking).
	 *
	 * A recommendation for the wrong colour is strictly worse than no recommendation, so a position
	 * that cannot prove the turn is ours is held exactly as a colourless one is (`mayActOn`).
	 */
	private fenTurnIsMine(snapshot: PositionSnapshot): boolean {
		return snapshot.myColor !== null && turnOfFen(snapshot.fen) === snapshot.myColor;
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
		this.clearBoardMarks();
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
			if (this.disposed || this.mayAct()) return;
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
		// The colour is its own hold (`mayActOn`): releasing the switch does not release a position
		// whose side we still do not know. The adapter republishes it once the bridge answers.
		if (!this.mayActOn(snapshot)) return;
		const myTurn = snapshot.sideToMove === snapshot.myColor;
		if (myTurn) await this.runPipeline(snapshot);
		else await this.onOpponentTurn(snapshot);
	}

	/** Stop a running ponder / panel / pre-analysis search (Task 13's `pendingOptions`, §6.4). */
	stopSearch(): Promise<void> {
		const pre = this.preAnalysis;
		this.preAnalysis = null;
		if (pre) void pre.stop();
		return this.ponderer?.stop() ?? Promise.resolve();
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		for (const off of this.offs.splice(0)) off();
		this.detachExecutor();
		this.pipelineAc?.abort();
		// Consistent with `cancelInFlight()` / `stopSearch()`: a disposed session leaves no search running.
		const inFlight = this.preAnalysis;
		this.preAnalysis = null;
		if (inFlight) void inFlight.stop();
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
		this.clearBoardMarks();
		if (event === "navigated") this.game = null;
		this.apply(event);
		this.deps.notify();
	}

	onGameStarted(meta: GameMeta): void {
		if (this.game?.gameId === meta.gameId) return;
		this.startGame(meta);
		// Nothing of the previous game belongs on this board.
		this.clearBoardMarks();
		this.apply("gameStarted");
		this.deps.notify();
	}

	onGameEnded(result: GameResult): void {
		if (!this.apply("gameEnded")) return;
		this.cancelInFlight();
		this.rec = null;
		this.premove = null;
		this.clearBoardMarks();
		void this.finishGame(result);
		this.deps.notify();
	}

	// ── the per-position pipeline (§3.2) ───────────────────────────────────

	async onPosition(snapshot: PositionSnapshot): Promise<void> {
		if (this.disposed) return;
		// `myColor` belongs in the key, not just in the position: the colour of a live game arrives
		// *after* its first reading, the position has not moved by then, and the real content script
		// posts `gameStarted` before that first `position` — so `startGame()` has already reset
		// `lastPositionKey` and the republished ply is the first this key has seen. Without the colour
		// the republish is indistinguishable from the reconnect replay and is dropped here, and
		// nothing else can release the hold: as white the position cannot change until the owner
		// moves by hand (owner's live test, 2026-09-09).
		// The time control belongs in the key for exactly the same reason as the colour, and it is
		// the same live game that proved it: the site answers `timeControl.get()` only once the game
		// has actually *started*, on a position that has not moved (as white it cannot move until
		// the owner plays). Without it the republish carrying the clock is indistinguishable from
		// the reconnect replay, is dropped here, and the whole first move is planned `untimed` —
		// classical motor, no premoves, a 7.5 s think in a 1+0 game.
		const tc = snapshot.timeControl;
		const key = `${snapshot.gameId}|${snapshot.ply}|${snapshot.fen}|${snapshot.myColor ?? "?"}|${
			tc ? `${tc.baseMs}+${tc.incMs}` : "?"
		}`;
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
		// The colour can arrive after `gameStarted` did (the bridge answers `getPlayingAs()` a moment
		// after the board appears), and the panel reads the game's copy when the snapshot has none.
		if (this.game && this.game.myColor === null && snapshot.myColor !== null)
			this.game = { ...this.game, myColor: snapshot.myColor };
		this.cancelInFlight();
		const previous = this.snapshot;
		this.priorFen = previous?.fen ?? null;
		this.snapshot = snapshot;
		this.reprofile(snapshot);
		// Whatever was marked belonged to the position that has just been superseded: erase it
		// before anything new is drawn, so the board never carries two recommendations at once.
		this.rec = null;
		this.clearBoardMarks();
		const myTurn = snapshot.myColor !== null && snapshot.sideToMove === snapshot.myColor;
		const at = this.now();
		this.deps.focus.positionArrived(this.deps.tabId, at);
		this.window.open(at, myTurn);
		this.trackMove(previous, snapshot);
		if (!this.apply("positionChanged", { myTurn })) return;
		this.deps.notify();
		if (!this.mayActOn(snapshot)) {
			// §4.4: everything above is bookkeeping the panel reads and a resume needs (the ply, the
			// clocks, the move list, the focus gate's window). Nothing below it runs while the
			// switch is off — or while the *colour* is unknown: no `go`, no ponder, no premove, no
			// recommendation, no schedule. A colourless position cannot even say whose turn it is,
			// so "not my turn ⇒ ponder" would be a guess too.
			log.debug("game-session: position held", {
				tabId: this.deps.tabId,
				ply: snapshot.ply,
				reason: this.mayAct() ? "colour not known yet" : "the assistant is off",
			});
			return;
		}
		if (!myTurn) {
			await this.onOpponentTurn(snapshot);
			return;
		}
		// `myTurn` said ours; the FEN the engine would actually be given says otherwise. Hold the
		// position rather than answer for the other side (`fenTurnIsMine`) — no go, no premove, no
		// recommendation, no mark, nothing scheduled. The adapter reconciles the two as it reads them,
		// so this is the second layer: it also covers a snapshot that reached the worker some other
		// way, and a colour the page later corrects.
		if (!this.fenTurnIsMine(snapshot)) {
			log.warn("game-session: position held — the FEN's side to move is not our colour", {
				tabId: this.deps.tabId,
				ply: snapshot.ply,
				myColor: snapshot.myColor,
				sideToMove: snapshot.sideToMove,
				fenTurn: turnOfFen(snapshot.fen),
			});
			return;
		}
		if (await this.tryPremove(snapshot)) return;
		await this.runPipeline(snapshot);
	}

	/**
	 * §4.3 / §4.6: the time control arrives on a `position`, not on `gameStarted`.
	 *
	 * This is the load-bearing path, not a fallback. chess.com answers
	 * `board.game.timeControl.get()` only once the game has actually started, and the content
	 * script starts its session from the first readable snapshot — taken before the MAIN-world
	 * bridge has answered anything — so `GameMeta.timeControl` is normally absent and `startGame`
	 * has already built the model, the pipeline and the hand for a clockless game. Everything the
	 * clock drives hangs off this one call: the features' `tcClass` (and with it the compression
	 * factor, the hard caps and the §8.5 emergency regime, all of which the `untimed` branch
	 * bypasses), the §4.6 preset, the §7.4 premove gate (bullet/blitz only) and the hand's own
	 * motor class — a bullet game otherwise keeps a classical hand for its whole length.
	 *
	 * Once per game (`profiledTimeControl`), at whatever ply it lands: a game whose clock arrives
	 * after our first move must not keep planning as untimed for the rest of its length, so the
	 * rebuilt model *adopts* the previous one's per-game history rather than starting fresh.
	 */
	private reprofile(snapshot: PositionSnapshot): void {
		const tc = snapshot.timeControl;
		const timing = this.timing;
		if (!tc || !timing || this.profiledTimeControl !== null) return;
		const meta = this.game;
		if (!meta) return;
		this.game = { ...meta, timeControl: tc };
		this.profiledTimeControl = tc;
		const settings = this.deps.getSettings();
		const next = timingSettingsFor(settings.timing, tc);
		this.profile = next.profile;
		const [baseSec, incSec] = this.timeControlSeconds(this.game);
		const tcClassOf = tcClass(baseSec, incSec);
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
		this.timing.adoptHistory(timing.state);
		this.pipeline = this.deps.createPipeline
			? this.deps.createPipeline(this.timing)
			: this.deps.engine
				? new RecommendationPipeline({
						engine: this.deps.engine,
						timing: this.timing,
						book: this.deps.book,
					})
				: null;
		// The hand's class too, in place: replacing the executor would dispose an armed hand and
		// re-arm it, and a re-arm attaches the debugger — Chrome's infobar, a reflow and a board
		// that moves, mid-game (§13.4 arms in the waiting view precisely to keep that out of a move
		// window). `MoveExecutor.setTimeControlClass` changes the profile the next execution reads.
		this.executorHandle?.setTimeControlClass(motorTcClass(tcClassOf));
		log.info("game-session: time control learned from a position", {
			tabId: this.deps.tabId,
			baseMs: tc.baseMs,
			incMs: tc.incMs,
			tc: tcClassOf,
			profile: next.profile,
			ply: snapshot.ply,
		});
	}

	/** Opponent's turn: ponder (§6.4) and prepare a premove candidate (§7.4). */
	private async onOpponentTurn(snapshot: PositionSnapshot): Promise<void> {
		const ponderer = this.ponderer;
		if (!ponderer) return;
		await ponderer.start("opponent", snapshot.fen);
		// §4.4: starting the ponder is an await, so the switch can go off *inside* it — and
		// `stopDisabled`'s own stop then ran before this search existed, which would leave a
		// `go infinite` running with the assistant off. Stop what we just started, and search
		// nothing more for this position.
		if (!this.mayAct()) {
			await ponderer.stop();
			return;
		}
		await this.armPremove(snapshot);
		await this.preAnalysePredicted(snapshot, ponderer);
	}

	/**
	 * Appendix E §4.5: "a hit … common when the opponent plays the predicted move: the ponder result
	 * for that FEN is already there". It never was. The opponent-turn ponder is keyed under the
	 * *opponent's* position, and §7.4's own `m r` gate search is MultiPV 2 at 120 ms — below the
	 * own-move `K` (3–8) and far below the cache's `depthCap − 2` gate — so nothing this session
	 * produced could ever answer its next own-move search, and every move paid the full search again.
	 *
	 * This is that search, run early: the position we will face if the opponent plays the reply we
	 * expect, analysed at **exactly the budget the own-move search will ask for** (`ownMoveBudget`),
	 * which is what puts its depth inside the slack. Engine time on the opponent's clock is free, and
	 * the own-move search supersedes it by priority if the reply comes first.
	 *
	 * Raising `PREMOVE.replyMultiPv` instead would not have worked: the MultiPV is only one of the
	 * two gates, and a 120 ms search cannot reach `depthCap − 2` on any machine. Those constants are
	 * Appendix E §3.1 normative and sized for a *gate decision*, so they stand.
	 *
	 * A prediction already in hand is used at any speed, but *harvesting* one — stopping the
	 * `go infinite` so it settles — happens only at a **premove speed** (`isPremoveSpeed`, i.e.
	 * bullet / blitz), because at rapid and classical that trades §7.5's continuous ponder for a head
	 * start on a depth-0 guess at speeds where the own-move search already fits inside the planned
	 * think. `dispose()` / `cancelInFlight()` / `stopSearch()` all stop the search this issues.
	 */
	private async preAnalysePredicted(
		snapshot: PositionSnapshot,
		ponderer: PonderController
	): Promise<void> {
		const engine = this.deps.engine;
		const timing = this.timing;
		const myColor = snapshot.myColor;
		if (!engine || !timing || myColor === null || !this.mayAct()) return;
		// The prediction. §7.4 produces one on the classes it runs on, and only when its own draw
		// came up; otherwise the `go infinite` ponder is still running and is *holding* the answer —
		// it settles on `stop`. Stopping it early costs depth on the opponent's position, which is
		// only ever read for this prediction; the pre-analysis then spends the rest of that time on
		// the position we are actually about to face, and the ponder is restarted underneath it.
		let reply = this.premove?.reply ?? ponderer.expectedReply(snapshot.fen);
		if (reply === null) {
			// Harvesting means stopping the `go infinite` to make it settle, and that is only worth
			// doing where the prediction buys something. At a premove speed §7.4 has usually already
			// interrupted the ponder for its own 150 ms MultiPV-3 prediction, so the harvest costs
			// little and the latency it saves is the whole point. At rapid and classical it would cut
			// §7.5's continuous ponder off after a couple of round trips and spend 1.0–1.5 s on a
			// position predicted by an essentially depth-0 search — while the own-move search there
			// (1000–1500 ms) already fits inside a 4–16 s planned think, so there is no latency to
			// win. Measured on the wire before this gate: `go infinite → go depth 22 movetime 1000 →
			// go infinite` on every rapid opponent turn.
			if (!isPremoveSpeed(this.currentTimeControl())) return;
			await ponderer.stop();
			if (this.disposed || this.snapshot !== snapshot) return;
			reply = ponderer.expectedReply(snapshot.fen);
		}
		if (reply === null) {
			await this.resumePonder(snapshot, ponderer);
			return;
		}
		const predicted = applyMoves(snapshot.fen, [reply]);
		if (predicted === null) {
			await this.resumePonder(snapshot, ponderer);
			return;
		}
		const budget = ownMoveBudget(
			{
				fen: predicted,
				ply: snapshot.ply + 1,
				myClockMs: snapshot.clocks[myColor].ms,
				timeControl: this.currentTimeControl(),
				tau: timing.persona.tau,
				budgetUsedRatio: this.budgetUsedRatio(snapshot),
			},
			this.deps.getSettings()
		);
		const request: AnalysisRequest = {
			id: `${this.deps.tabId}-predicted-${this.now()}`,
			fen: snapshot.fen,
			moves: [reply],
			multiPv: budget.multiPv,
			limit: { movetimeMs: Math.round(budget.movetimeMs), depth: budget.depthCap },
			priority: "ponder",
		};
		const elo = engine.engineElo();
		if (elo !== undefined) request.elo = elo;
		try {
			const handle = engine.analyse(request);
			this.preAnalysis = handle;
			const result = await handle.result;
			log.debug("game-session: pre-analysed the predicted position", {
				tabId: this.deps.tabId,
				reply,
				depth: result.final.depth,
				status: result.status,
			});
		} catch (error) {
			log.debug("game-session: pre-analysis unavailable", { error: errorMessage(error) });
		} finally {
			this.preAnalysis = null;
		}
		// §6.4: the rest of the opponent's clock goes back to pondering their position — the engine
		// must not sit idle for the remainder of a long turn.
		await this.resumePonder(snapshot, ponderer);
	}

	/** Put the opponent-turn ponder back, unless the position (or the switch) has moved on. */
	private async resumePonder(snapshot: PositionSnapshot, ponderer: PonderController): Promise<void> {
		if (this.disposed || this.snapshot !== snapshot || !this.mayAct()) return;
		if (ponderer.isRunning()) return;
		await ponderer.start("opponent", snapshot.fen);
	}

	/** §3.2 steps 1–5 for the current position. */
	private async runPipeline(snapshot: PositionSnapshot): Promise<void> {
		const pipeline = this.pipeline;
		const timing = this.timing;
		if (!pipeline || !timing) return;
		// The invariant at its own door, so no caller can get round it (`onPosition` holds before it
		// reaches here; `resumeEnabled` resumes a stored position that may predate a colour
		// correction). The pipeline answers for the FEN's side to move, so it runs only when that
		// side is ours.
		if (!this.fenTurnIsMine(snapshot)) {
			log.warn("game-session: no recommendation — the FEN's side to move is not our colour", {
				tabId: this.deps.tabId,
				ply: snapshot.ply,
				myColor: snapshot.myColor,
				fenTurn: turnOfFen(snapshot.fen),
			});
			return;
		}
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
			// Mirror of the opponent-turn re-check above: `start` can await, so a flip-off landing
			// inside it would have run `stopDisabled`'s stop before this search existed, leaving a
			// `go infinite` running with the assistant off.
			if (!this.mayAct()) await this.ponderer?.stop();
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
		// checked here too (unknown holds, like everywhere else).
		if (!this.mayAct()) return;
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
						const request: AnalysisRequest = {
							id: `${this.deps.tabId}-premove-${this.now()}`,
							fen,
							moves: [...moves],
							multiPv: opts.multiPv,
							limit: { movetimeMs: opts.movetimeMs },
							priority: "ponder",
						};
						// The same strength as every other search this session issues (the ponder sets
						// it too). Without it these results are keyed at a different strength from the
						// own-move search that would reuse them, so they could never be a cache hit.
						const elo = engine.engineElo();
						if (elo !== undefined) request.elo = elo;
						const handle = engine.analyse(request);
						const result = await handle.result;
						return result.final.lines;
					},
				}
			);
			// The search above is an await: a flip-off inside it already nulled `this.premove`, so a
			// candidate must not be published over the top of that (§4.4).
			if (!candidate || this.disposed || this.snapshot !== snapshot || !this.mayAct()) return;
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
		if (!this.mayAct()) {
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
		this.clearBoardMarks();
		this.rec = null;
		this.premove = null;
		this.apply("disable");
		this.deps.notify();
	}

	/** §8.5 manual path: the pending move (else the current recommendation) plays now. */
	private async playNow(): Promise<void> {
		const executor = this.executorHandle;
		if (!executor) return;
		if (!this.mayAct()) {
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
		const ctx = timing ? this.timingContextFor(rec) : null;
		const plan = timing && ctx ? timing.replan(rec.plan, ctx, "manual-now") : rec.plan;
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
		if (this.mayAct()) this.deps.warmTiming?.(targetElo);

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
		if (this.mayAct() && settings.automation.autoQueue) this.deps.autoQueue.schedule(this.deps.tabId);
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
		if (this.mayAct() && (wasArmed || this.deps.getSettings().automation.autoMove))
			void executor.arm().catch((error: unknown) => log.warn("game-session: re-arm failed", error));
	}

	private detachExecutor(): void {
		for (const off of this.executorOffs.splice(0)) off();
		this.executorHandle?.dispose();
		this.executorHandle = null;
	}

	private onExecuted(report: ExecutionReport): void {
		this.apply("executed");
		// The move is on the board: the prediction has been spent, and the site's own last-move
		// marking is what belongs there now.
		this.clearBoardMarks();
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
		const ctx = rec && timing ? this.timingContextFor(rec) : null;
		if (rec && timing && ctx) timing.replan(rec.plan, ctx, "blur");
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
		// The prediction it was preparing for is no longer the live one (§4.4 stops it too).
		const pre = this.preAnalysis;
		this.preAnalysis = null;
		if (pre) void pre.stop();
	}

	/** Content-script settings that gate what it may draw (§13.3 rule 4). */
	private pushContentSettings(): void {
		const settings = this.deps.getSettings();
		const commands: GamePortCommand[] = [
			// §4.4: the master switch gates the board marks too — and because the content script
			// clears what it has drawn the moment this turns off, this is also the clear.
			{ kind: "settings", highlightMoves: this.mayAct() && settings.automation.highlightMoves },
			{ kind: "keybinds", keybinds: settings.keybinds },
		];
		for (const cmd of commands) this.deps.link.post(this.deps.tabId, cmd);
	}

	private postHighlight(rec: Recommendation): void {
		const settings = this.deps.getSettings();
		if (!this.mayAct() || !settings.automation.highlightMoves) return;
		// The mark is the most visible half of the defect this guards (the owner saw it on the board
		// and in the panel), so the check is repeated at the point of drawing rather than trusted from
		// the caller: a move for the side we are not playing is never marked on the page.
		const myColor = this.snapshot?.myColor ?? this.game?.myColor ?? null;
		if (myColor === null || turnOfFen(rec.fen) !== myColor) {
			log.warn("game-session: mark withheld — the move is not for the colour we are playing", {
				tabId: this.deps.tabId,
				myColor,
				fenTurn: turnOfFen(rec.fen),
			});
			return;
		}
		this.deps.link.post(this.deps.tabId, {
			kind: "highlight",
			from: rec.chosen.from,
			to: rec.chosen.to,
			style: settings.automation.highlightStyle,
		});
	}

	/**
	 * Erase whatever is marked on the board. The invariant is that a mark belongs to the
	 * recommendation that is current *now*, so this runs at every point one stops being current:
	 * the move was played (by the hand or by the owner), the position moved on, the colour is not
	 * known yet, the game started or ended, the tab navigated, the switch went off, `Shift+X`.
	 *
	 * Before this existed the only two callers were the switch and `Shift+X`, so the mark for the
	 * move just played sat on the board for the whole of the opponent's turn — and on a board that
	 * draws through native markings a second `highlight` *stacked* on top of it rather than
	 * replacing it (owner's live test, 2026-09-09: "old move highlights are not erased").
	 */
	private clearBoardMarks(): void {
		this.deps.link.post(this.deps.tabId, { kind: "clearHighlight" });
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

	/**
	 * The timing model's view of the current move, or `null` when there is no position to build it
	 * from — including the one that matters: a position whose colour is not known. There is no
	 * default side here. Defaulting to white is what made the model plan, and the hand play, for
	 * the opponent (owner's live test, 2026-09-09); a caller that cannot build a context does not
	 * replan, which leaves the standing plan exactly as it was.
	 */
	private timingContextFor(rec: Recommendation): TimingContext | null {
		const snapshot = this.snapshot;
		const settings = this.deps.getSettings();
		const myColor = snapshot?.myColor ?? null;
		if (myColor === null) return null;
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
