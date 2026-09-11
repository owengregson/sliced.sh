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
 *
 * **One exception, and it is not ours to fix** (Fix F): a premove already sent to the site during
 * the opponent's turn is the *site's* state. Switching off stops everything above and sends nothing
 * more, but it cannot retract a gesture the page has already had — chess.com fires or drops it when
 * the opponent moves, whenever that is. `forgetPremove` says so in the log; the lane report says
 * what it would take to do better.
 */

import { type FenParts, parseFen, plyOf, turnFieldOf } from "@core/chess/fen";
import { historyFromSan, matchingHistory, type PositionHistory } from "@core/chess/history";
import { applyMoves, legalMoves, uciToSan } from "@core/chess/san";
import { sanToSpeech } from "@core/chess/san-speech";
import { isSquare } from "@core/chess/squares";
import { chromeLocalGet, chromeLocalSet } from "@core/chrome/storage";
import { PREMOVE } from "@core/constants/books";
import { EXECUTOR } from "@core/constants/cdp";
import { CHESS_START_FEN } from "@core/constants/chess";
import { LIMITS } from "@core/constants/limits";
import type { GamePortCommand, GamePortMessage } from "@core/constants/messages";
import { LOCAL_KEYS } from "@core/constants/storage-keys";
import { TELEMETRY_BANDS } from "@core/constants/telemetry";
import { TIMINGS, type TimingProfile } from "@core/constants/timings";
import type { AnalysisHandle, AnalysisRequest } from "@core/engine/types";
import { log } from "@core/logger";
import type { TimeControlClass } from "@core/motor/types";
import { createRng, type Rng } from "@core/rng";
import type { BookPolicy } from "@core/strength/book/book-policy";
import { createSelectionState } from "@core/strength/move-selector";
import { createFormLatent, type FormLatent } from "@core/strength/persona";
import type { PremoveReason } from "@core/strength/premove";
import { isPremoveSpeed, isQueueableCandidate, premoveCandidate } from "@core/strength/premove";
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
	ExecutionResult,
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
import type { MoveTelemetryRecord } from "@typedefs/telemetry";
import type { TimingPlan } from "@typedefs/timing";
import { PonderController } from "./ponder";
import { autoPlayAllowed, effectiveTimingProfile, timingSettingsFor } from "./presets";
import type { RecommendationInput, RecommendationOutcome } from "./recommendation";
import { ownMoveBudget, RecommendationPipeline } from "./recommendation";
import { EMPTY_STATS, foldGame, foldMove } from "./stats";
import { MoveWindow, selectedMultiplePieces } from "./telemetry";
import { type GameSessionEvent, isLiveState, isMyTurnState, nextState } from "./transitions";

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

/**
 * The game's first move: ply 0 playing white, ply 1 playing black. The scope of the owner's
 * 2026-09-10 §13.4 ruling (`docs/qa/focus-discipline.md` §4) and the only move where no later
 * position can arrive to carry a second chance — as white the board cannot change until we play.
 *
 * Counted from the **FEN's own move counters** (`plyOf`), never from `PositionSnapshot.ply`. That
 * field is `plyOf(readMoveList(document))`, a read of chess.com's move-list DOM, and it is **0**
 * whenever the list element cannot be found — which on `/play/online` (no URL game id) also bumps
 * the adapter's game serial, so the session starts a "new game" holding a *mid-game* position that
 * claims `ply: 0`. Scoping the ruling on that would hand every remaining move of such a game the
 * first-move relaxation the owner explicitly declined. The FEN comes from the MAIN-world bridge and
 * cannot claim fullmove 1 on a mid-game board; the adapter guards the FEN against exactly this
 * confusion (`chesscom.ts`, "an empty list must not 'prove' the start position") and `ply` never got
 * the same cross-check.
 */
const FIRST_MOVE_LAST_PLY = 1;

/** Placement field of the start position — the only one a fullmove-1 white-to-move FEN can carry. */
const START_PLACEMENT = CHESS_START_FEN.split(" ")[0];

/**
 * Does this FEN's **placement** agree with its claim to be the game's first move? The counters say
 * fullmove 1; the pieces have to say so too.
 *
 * This is deliberately independent of where the FEN came from. `PositionSnapshot.approximate` is a
 * *provenance* claim — "the page gave us this" — and the predicate's safety would otherwise be the
 * conjunction of three adapter code paths staying honest, one of which is already weaker than it
 * reads: the SAN-replay source is uncorroborated on a canvas board (its only test there is
 * `ply > 0`), so one parseable move-list node on a mid-game board can publish fullmove 1 with
 * `approximate: false`. A placement check cannot be fooled by any of that: at fullmove 1 the board is
 * either untouched (white to move) or one legal white move from untouched (black to move).
 */
function isFirstMovePlacement(parts: FenParts): boolean {
	if (parts.turn === "w") return parts.placement === START_PLACEMENT;
	for (const uci of legalMoves(CHESS_START_FEN)) {
		const after = applyMoves(CHESS_START_FEN, [uci]);
		if (after !== null && after.split(" ")[0] === parts.placement) return true;
	}
	return false;
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
	debugger: Pick<DebuggerManager, "isAttached" | "detach" | "onDetached">;
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

/**
 * Placement plus side to move — the part of a FEN that says which position is on the board. The
 * halfmove and fullmove counters (and an en-passant square the adapter had to approximate) are not
 * identity, so comparing whole FENs would reject a position that *is* the one we expect.
 */
function boardKeyOf(fen: string): string {
	return fen.split(" ").slice(0, 2).join(" ");
}

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
	/** Why the policy accepted it — `PREMOVE.queueReasons` decides which may be *queued* (Fix F). */
	reason: PremoveReason;
}

/**
 * Fix F: a premove **entered on the site** during the opponent's turn, waiting for their move to
 * resolve it. It is not a played move and is never accounted as one until the next position proves
 * it: `reconcilePremove` compares that position with `fromFen + reply + uci` and only then writes
 * the §8.6 row, the §13.2 record and the §13.6 fold.
 */
interface PremoveEntry {
	/** The reply the premove is conditioned on. */
	reply: string;
	chosen: ChosenMove;
	/** The position the drag was dispatched in — the opponent is to move in it. */
	fromFen: string;
	/** Ply of the position the premove belongs to: the one after `reply`. */
	ply: number;
	/** Our clock in `fromFen` (the §8.6 row's `clockMs`). */
	clockMs: number;
	plan: TimingPlan;
	/** The recommendation handed to the executor; its identity is how its report is recognised. */
	rec: Recommendation;
	/** The drag's own result, once it finished; `null` while it is still pending or running. */
	result: ExecutionResult | null;
	/**
	 * The §13.2 window the drag happens in — a *fork* of the opponent-turn window, never the
	 * session's own. `onPosition` opens a fresh window for every position, and a premove report can
	 * arrive after that has happened (the deferred settle below), so a premove that closed the
	 * session's window would both mis-describe itself and steal the next move's record.
	 */
	window: MoveWindow;
	/** The §13.2 record of that window (built when the drag finished). */
	record: MoveTelemetryRecord | null;
	/** Set when a cancel path gave the premove up while it was already out of our hands. */
	abandoned: string | null;
	/**
	 * The position waiting to settle this premove because the drag had not reported yet when it
	 * arrived. At bullet the opponent can easily reply inside the drag's own wind-down, so the
	 * report and the position race; whichever is second does the reconciliation.
	 */
	settleWith: PositionSnapshot | null;
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
	/**
	 * The recommendation whose mark is currently drawn through the bridge's own SVG overlay
	 * (`markForExecution`), so the re-post happens once per mark and not on every hand-state
	 * change. Reset by `clearBoardMarks` — after a clear there is no mark of ours at all — and by
	 * any ordinary `postHighlight`.
	 */
	private markedOverlayFor: Recommendation | null = null;
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
	/**
	 * The position a blur landed on while the session was holding it (§13.4). The
	 * companion guard to `isGameFirstMove`, and **not** `FocusGate`'s own `blurSeenThisMove`: that
	 * flag is per move *window*, and `positionArrived` reopens the window on every accepted position
	 * — including the republish of an unmoved ply-0 position that carries the colour or the time
	 * control, which `onPosition` documents as the normal case at move one. A §13.4 permission must
	 * not be cleared by the thing that always happens, so the blur is remembered against the ply.
	 *
	 * What it records is every *transition* to unfocused that happens while this position is the one
	 * the session holds — which is the only kind of blur a human, or chess.com's own per-move window,
	 * would count against the move. It deliberately does not record a repeated "still not focused"
	 * report (a `visibilitychange` while already blurred sets `FocusGate.blurSeen` but fires no edge):
	 * that is the same blur, and if it predates the position then the owner was already in the side
	 * panel when the move came up, which is exactly the case the ruling releases.
	 */
	private blurredPositionKey: string | null = null;
	/** The position before the current one — what the §7.4 premove policy replays our move from. */
	private priorFen: string | null = null;
	/** The timing profile in force this game (§4.6); `null` until a game starts. */
	private profile: TimingProfile | null = null;
	/** The time control that profile was derived from (`null` = none was known yet). */
	private profiledTimeControl: TimeControl | null = null;
	private pipelineAc: AbortController | null = null;
	private moves: string[] = [];
	private positionHistory: PositionHistory | null = null;
	private oppThinkMs: number[] = [];
	private myThinkMs: number[] = [];
	private lastOppMoveAt: number | null = null;
	private lastMyMoveAt: number | null = null;
	private premove: PremoveArm | null = null;
	/** Fix F: the premove this session has entered on the site, until the next position settles it. */
	private premoveEntry: PremoveEntry | null = null;
	/**
	 * Fix F: whether the *site* keeps the premoves we send. chess.com's own premove setting is not
	 * readable, so this is learned from the one observation that answers it: a **completed** gesture,
	 * the predicted reply, and our move not on the board. `null` = not known yet (try), `false` =
	 * fall back to §7.4's fast reply, `true` = a premove of ours has fired.
	 *
	 * Deliberately **per tab, not per game**: every attempt on a board that refuses them costs a
	 * visible snap-back and a real press outside any move window, so the lesson is worth keeping for
	 * as long as the page is. A reload re-tests it, which is also what a player who changed the
	 * setting would do.
	 */
	private premoveQueueing: boolean | null = null;
	/**
	 * Fix F / §13.2: the from-square of a premove the site **dropped**, after the page had already
	 * seen the press. The site's move window does not end when our drag does — it ends at the next
	 * submission — so that press is one of the pieces it counts as selected for the *next* move, and
	 * our own record of that move has to say so or the export understates the preview rate by
	 * exactly the premoves that were dropped. Consumed by the next move recorded.
	 */
	private droppedPremoveFrom: Square | null = null;
	private startClockMs = 0;
	/** A `playNow` issued while the pipeline was still running. */
	private playWhenReady = false;
	/** The one pending re-delivery of a withheld position (`reconsider`), and its attempt count. */
	private retryTimer: unknown = null;
	private retryAttempts = 0;
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
			}),
			// Fix D: the attachment went away — the owner clicked Cancel on the infobar, the tab
			// closed, the idle timer fired, or the panel detached. §13.4 forbids the mid-game
			// re-attach, and `MoveExecutor.isArmed()` is `armed && isAttached`, so from here the hand
			// owns no pointer for the rest of this game and the mirror can never move again. An arrow
			// left parked there is a fossil, not a report of where the pointer is.
			deps.debugger.onDetached((tabId) => {
				if (tabId === deps.tabId) this.hideVirtualCursor();
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
		// Fix D: the mirror is page DOM, so it goes the moment it is no longer allowed — which is
		// either the switch or `display.virtualCursor`, and only the switch makes `flipped` true.
		if (!this.virtualCursorAllowed()) this.hideVirtualCursor();
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
	 * Does the snapshot agree with itself about whose move it is?
	 *
	 * `sideToMove` and the turn field of the `fen` beside it come from different ladders in the
	 * adapter, and they drive different halves of this class: `myTurn` (hence which branch runs) from
	 * the first, every search, plan and mark from the second. When they disagree one of them is wrong
	 * and nothing here can tell which, so the position is held — in **either** direction. Answering
	 * `myTurn` would recommend the opponent's move as ours (the owner's live game, 2026-09-10);
	 * answering `!myTurn` would ponder our own position and arm a premove conditioned on one of *our*
	 * moves as if it were the opponent's reply.
	 *
	 * `turnFieldOf`, not `sideToMove`, is the read: whose move it is does not depend on chess.js
	 * accepting the rest of the position, and a strict parse would answer `null` for a FEN with one
	 * malformed field — turning "I could not validate this position" into "hold every position of
	 * this game". A FEN that states no turn at all contradicts nothing and is not held: the adapter's
	 * own `sideToMove` is then the best evidence there is, and `MoveSelector` and the engine reject an
	 * unusable FEN on their own.
	 */
	private selfConsistent(snapshot: PositionSnapshot): boolean {
		const fenTurn = turnFieldOf(snapshot.fen);
		return fenTurn === null || fenTurn === snapshot.sideToMove;
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
	 * (`cancelInFlight`) and erased the mark for the move being played (`clearBoardMarks`), which is
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
	 * - `myColor` — cannot be new: the guard needs `this.rec`, and a recommendation needs
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
		const current = this.snapshot;
		const rec = this.rec;
		if (!current || !rec || this.game?.gameId !== snapshot.gameId) return false;
		if (snapshot.ply !== current.ply || snapshot.sideToMove !== current.sideToMove) return false;
		return this.executorHandle?.runningMove()?.rec === rec;
	}

	/**
	 * What a reading `ownHandsDoing` is about to drop still has to deliver: §4.3's time control.
	 * The site answers `timeControl.get()` only once the game has actually started, the adapter
	 * republishes the unmoved position to deliver it exactly once, and the re-ask runs on a 1 s
	 * timer — so its arrival lands inside the seconds the hand's action takes. `reprofile` is the
	 * same call `onPosition` would have made: idempotent (`profiledTimeControl`), and safe while a
	 * move is in flight for the same documented reason `MoveExecutor.setTimeControlClass` is — the
	 * running move keeps the plan it was given and the new profile is read by the next one.
	 */
	private salvageFromOwnHand(snapshot: PositionSnapshot): void {
		this.reprofile(snapshot);
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
		this.forgetPremove("the assistant was turned off");
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
		// whose side we still do not know. The adapter republishes it once the bridge answers. Same
		// for a snapshot that contradicts itself — the switch coming back on is not new evidence
		// about whose move it is, so the resume holds exactly as `onPosition` did.
		if (!this.mayActOn(snapshot) || !this.selfConsistent(snapshot)) return;
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
		// The executor goes first: `dispose()` → `cancel()` is what actually stops a premove that
		// has not been sent, and `forgetPremove` only gives up the arm and says so.
		this.executorHandle?.disarm();
		this.detachExecutor();
		this.forgetPremove("the session was disposed");
		this.pipelineAc?.abort();
		// Consistent with `cancelInFlight()` / `stopSearch()`: a disposed session leaves no search running.
		const inFlight = this.preAnalysis;
		this.preAnalysis = null;
		if (inFlight) void inFlight.stop();
		this.ponderer?.dispose();
		this.deps.autoQueue.cancel(this.deps.tabId);
		this.hideVirtualCursor();
		this.window.discard();
		this.clearRetry();
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
		this.hideVirtualCursor();
		this.forgetPremove(event === "navigated" ? "the tab navigated away" : "the tab was closed");
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
		// Fix D: above the guard on purpose. `gameEnded` is refused from `idle` only, which a
		// reconnect cannot produce (`FeedPort` replays `hello` before the outbox, which moves the
		// session to `waiting-for-game`) — but the arrow does not self-heal the way a board mark
		// does, so it costs one line not to depend on that reasoning.
		this.hideVirtualCursor();
		if (!this.apply("gameEnded")) return;
		this.cancelInFlight();
		this.rec = null;
		this.forgetPremove("the game ended");
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
		// `approximate` belongs in the key for the same reason the colour and the time control do: it is
		// information about the position that can arrive *after* the first reading of it (the bridge
		// answers and the adapter republishes an exact FEN for the same ply), and it now gates a §13.4
		// permission. Without it the republish is indistinguishable from the reconnect replay, is
		// dropped here, and the first reading's provenance sticks for the whole position.
		const key = `${snapshot.gameId}|${snapshot.ply}|${snapshot.fen}|${snapshot.myColor ?? "?"}|${
			tc ? `${tc.baseMs}+${tc.incMs}` : "?"
		}|${snapshot.approximate === true ? "~" : "="}`;
		if (key === this.lastPositionKey) {
			const current = this.snapshot;
			if (current && snapshot.capturedAt > current.capturedAt) {
				// Keep the same object so a clock tick cannot invalidate an in-flight search.
				current.clocks = snapshot.clocks;
				current.capturedAt = snapshot.capturedAt;
				this.updateHistory(snapshot);
				this.deps.notify();
			}
			return;
		}
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
		if (this.ownHandsDoing(snapshot)) {
			this.salvageFromOwnHand(snapshot);
			log.debug("game-session: position ignored — our own hand is mid-move on this ply", {
				tabId: this.deps.tabId,
				ply: snapshot.ply,
				uci: this.rec?.chosen.uci ?? null,
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
		if (this.game && this.game.myColor !== snapshot.myColor)
			this.game = { ...this.game, myColor: snapshot.myColor };
		this.cancelInFlight();
		const previous = this.snapshot;
		this.priorFen = previous?.fen ?? null;
		this.snapshot = snapshot;
		// Fix F: a premove we entered on the site is settled by *this* position — before the move
		// history, the profile or anything that plans reads either of them.
		this.reconcilePremove(snapshot);
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
		// A snapshot that contradicts itself is held before the branch, so the hold is symmetric
		// (`selfConsistent`). The adapter settles this as it reads (`AdapterBase.reading`); this is the
		// second layer, for a snapshot that reached the worker some other way.
		if (!this.selfConsistent(snapshot)) {
			log.warn("game-session: position held — its sideToMove contradicts its own FEN", {
				tabId: this.deps.tabId,
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
		const history = this.historyFor(snapshot.fen);
		await ponderer.start("opponent", history.fen, history.moves);
		// §4.4: starting the ponder is an await, so the switch can go off *inside* it — and
		// `stopDisabled`'s own stop then ran before this search existed, which would leave a
		// `go infinite` running with the assistant off. Stop what we just started, and search
		// nothing more for this position.
		if (!this.mayAct() || this.snapshot !== snapshot) {
			await ponderer.stop();
			return;
		}
		await this.armPremove(snapshot);
		// Fix F: a premove is a *premove* — entered on the site now, while the opponent is still to
		// move, so their move fires it. Scheduling only; the engine work below is not held up.
		this.enterPremove(snapshot);
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
			fen: this.historyFor(snapshot.fen).fen,
			moves: [...this.historyFor(snapshot.fen).moves, reply],
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
		const history = this.historyFor(snapshot.fen);
		await ponderer.start("opponent", history.fen, history.moves);
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
		const pipeline = this.pipeline;
		const timing = this.timing;
		// Fix G looked at this return first — "the engine is not ready yet" — and it is *not* the
		// silent hold that loses the first move. Both halves are decided once, for good, before any
		// position arrives: `SessionRegistry` always hands the session its `EngineController`
		// (non-null from worker boot), and `this.pipeline` / `this.timing` are written only by
		// `startGame` and `reprofile`. Nothing here becomes true a moment later, so there is nothing
		// to re-deliver. The engine being slow reaches us further down, at `!outcome`.
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
				history: this.historyFor(snapshot.fen),
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
				inputMethod: EXECUTOR.committedTier,
			});
		} catch (error) {
			log.warn("game-session: pipeline failed", { error: errorMessage(error) });
		}
		if (this.disposed || ac.signal.aborted || this.snapshot !== snapshot) return;
		this.pipelineAc = null;
		if (!outcome) {
			log.info("game-session: no recommendation for this position", { fen: snapshot.fen });
			// Fix G: the engine produced no usable line and the book had nothing — a search that
			// failed, crashed or answered `bestmove (none)` while Stockfish was still coming up. A
			// moment later it would have. Every move but the first gets that moment from the
			// opponent's reply; the first move as white has to ask again itself.
			this.retryWhenReady("the engine produced no line for this position");
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
			const history = this.historyFor(rec.fen);
			await this.ponderer?.start("panel", history.fen, history.moves);
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
		// Fix F: the flag travels with the *recommendation*, not with the call, so every route to
		// the executor carries it — `schedule` here and `playNow`'s re-built context alike.
		if (this.premoveEntry !== null && rec === this.premoveEntry.rec) ctx.queuedPremove = true;
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
	 * is released: the automatic `executor.arm()` resolving (`attachExecutor` — the manual `arm()`
	 * has always re-checked, this is the same re-check for the path that did not), and the
	 * `retryWhenReady` timer armed where `runPipeline` gives up on a search that answered nothing.
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
		if (this.disposed) return;
		const snapshot = this.snapshot;
		// §4.4: the switch and the colour hold here exactly as they do on the position path.
		if (!snapshot || !this.mayActOn(snapshot)) return;
		const executor = this.executorHandle;
		if (executor && (executor.pendingMove() !== null || executor.isRunning())) return;
		if (this.state !== "live:my-turn:analysing" && this.state !== "live:my-turn:recommended") return;
		const rec = this.rec;
		if (rec) {
			const paced = this.repaced(rec);
			log.info("game-session: acting on the recommendation that was held back", {
				tabId: this.deps.tabId,
				ply: snapshot.ply,
				uci: paced.chosen.uci,
				thinkMs: Math.round(paced.plan.thinkMs),
				reason,
			});
			this.rec = paced;
			await this.actOnRecommendation(paced, this.deps.getSettings());
			return;
		}
		// A search already running for this position is itself the second chance.
		if (this.pipelineAc !== null) return;
		log.info("game-session: running the pipeline again for the held position", {
			tabId: this.deps.tabId,
			ply: snapshot.ply,
			reason,
		});
		await this.runPipeline(snapshot);
	}

	/**
	 * The withheld recommendation with its plan re-planned for the wait (see `reconsider`). The
	 * recommendation itself is unchanged — the move the panel is showing is the move that gets played
	 * — and the session adopts the result so the panel's plan line and §8.6's row agree with what the
	 * hand was actually given. Unchanged when there is no timing model or no usable context.
	 */
	private repaced(rec: Recommendation): Recommendation {
		const timing = this.timing;
		const ctx = timing ? this.timingContextFor(rec) : null;
		if (!timing || !ctx) return rec;
		// `withheld-then-released` folds `now - <the position's arrival>` into the think and applies no clock
		// cap of its own (unlike `clock-jump`), so a long enough wait would record a `plannedMs` longer
		// than the clock the move started with — a malformed §8.6 row, and the same number
		// `report.py`'s think-time bands read. The clock in the snapshot is frozen at the moment the
		// position was read, so it *is* the bound; clamp the elapsed time the model is told about
		// rather than the plan it returns, and every window the plan carries stays consistent.
		//
		// `affordable` is deliberately not floored at 0. A clock shorter than the approach makes it
		// negative, which tells the model the move started *after* now — and that cannot change the
		// answer, because `withheld-then-released` returns `max(plan.thinkMs, spent + approach)` and
		// `approachMs <= thinkMs` by construction, so the `plan.thinkMs` term wins for any negative
		// `spent`. Measured identical (think and window sum, to the millisecond) with and without a
		// floor at clocks of 200 ms and 50 ms against a 20 s wait. A floor here would be a line no
		// mutation could kill.
		// An untimed game has no clock to exceed, so nothing is clamped and the whole wait folds in.
		const startedAt = rec.plan.deadlineMs - rec.plan.thinkMs;
		const affordable = ctx.myClockMs - rec.plan.window.approachMs;
		// Epoch timestamps lose sub-millisecond precision; round the ceiling down so
		// adding the sampled approach cannot put the result just above the clock.
		const nowMs =
			ctx.myClockMs > 0 ? Math.min(ctx.nowMs, Math.floor(startedAt + affordable)) : ctx.nowMs;
		return { ...rec, plan: timing.replan(rec.plan, { ...ctx, nowMs }, "withheld-then-released") };
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
				tabId: this.deps.tabId,
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
	handArmed(): Promise<void> {
		return this.reconsiderGuarded("the hand was armed");
	}

	/**
	 * Will `playNow()` reach the hand if called right now? Every condition `playNow` itself checks —
	 * §4.4's switch, §13.4's armed hand, and something to play — because `playNowRequested` answers
	 * the panel `true` on the strength of this and nothing may fall between the two: they run in one
	 * synchronous step, and `playNow` is synchronous up to its own `await`.
	 */
	private hasPlayableMove(): boolean {
		const executor = this.executorHandle;
		if (!executor || !this.mayAct() || !executor.isArmed() || !isMyTurnState(this.state))
			return false;
		return executor.pendingMove() !== null || this.rec !== null;
	}

	/**
	 * `SessionSource`: the panel's `PANEL_PLAY_NOW`. Same reason as `handArmed()` — the
	 * `MoveContext` and the §8.5 re-plan are the session's, and the handler used to pass neither.
	 *
	 * The run is started and deliberately **not** awaited: the panel's reply must not wait for the
	 * hand (the outcome reaches it through the broadcaster), which is the shape the handler had.
	 * `playNow()` is synchronous up to its own `await`, so the §3.3 transition and the notify have
	 * both happened by the time this resolves. `false` means there was nothing to play — and unlike
	 * the keybind path it does not queue `playWhenReady`, because a command the panel is waiting on
	 * answers now or says why not.
	 */
	playNowRequested(): Promise<boolean> {
		if (!this.hasPlayableMove()) return Promise.resolve(false);
		void this.playNow().catch((error: unknown) =>
			log.warn("game-session: playNow failed", {
				tabId: this.deps.tabId,
				error: errorMessage(error),
			})
		);
		return Promise.resolve(true);
	}

	/**
	 * Arm the one re-delivery above, `TIMINGS.sessionRetryMs` from now. The budget
	 * (`TIMINGS.sessionRetryMax`) is per position — `cancelInFlight` resets it — and when it is
	 * spent the session says so at `warn` rather than sitting silently: the service worker's own
	 * `log.*` calls reach the panel's log stream, where `warn` is already a rendered kind
	 * (`COPY.engine.logKinds.warn`).
	 */
	private retryWhenReady(reason: string): void {
		if (this.disposed || this.retryTimer !== null) return;
		if (this.retryAttempts >= TIMINGS.sessionRetryMax) {
			log.warn("game-session: nothing became ready — this position cannot be played", {
				tabId: this.deps.tabId,
				ply: this.snapshot?.ply ?? null,
				attempts: this.retryAttempts,
				reason,
			});
			return;
		}
		this.retryAttempts += 1;
		this.retryTimer = this.scheduler.setTimeout(() => {
			this.retryTimer = null;
			void this.reconsiderGuarded(reason);
		}, TIMINGS.sessionRetryMs);
	}

	/** Drop the pending re-delivery and its budget (the position it belonged to is over). */
	private clearRetry(): void {
		if (this.retryTimer !== null) this.scheduler.clearTimeout(this.retryTimer);
		this.retryTimer = null;
		this.retryAttempts = 0;
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
					historyAfterMove: this.historyFor(snapshot.fen),
					targetElo: this.targetElo(),
					timeControl: snapshot.timeControl,
					ponder: this.ponderer?.expectedReply(snapshot.fen) ?? undefined,
					rng: this.rng,
					// `Persona.pi_p` is in logit units; the policy takes a probability in [0, 1].
					piP: 1 / (1 + Math.exp(-timing.persona.pi_p)),
				},
				{
					analyseAfter: async (_fen, moves, opts) => {
						const root = this.historyFor(snapshot.fen);
						const request: AnalysisRequest = {
							id: `${this.deps.tabId}-premove-${this.now()}`,
							fen: root.fen,
							moves: [...root.moves, ...moves.slice(1)],
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
			this.premove = {
				reply: candidate.reply,
				chosen,
				fen: snapshot.fen,
				reason: candidate.reason,
			};
			log.info("game-session: premove armed", {
				tabId: this.deps.tabId,
				reply: candidate.reply,
				premove: candidate.premove,
				reason: candidate.reason,
			});
		} catch (error) {
			log.debug("game-session: premove unavailable", { error: errorMessage(error) });
		}
	}

	/**
	 * The **fallback** path (Fix F): the opponent played the reply the premove was conditioned on
	 * and the premove is not already on the board, so the site was holding nothing — premoves are
	 * off in the player's own chess.com settings, the queue was never entered (their think was
	 * shorter than the entry delay), or `reconcilePremove` has just learned the site drops them.
	 * Play it at once instead (`t_premove ~ U(0, PREMOVE.maxS)`, §7.4) without a fresh search.
	 *
	 * This is reached only on *our* turn, which a fired premove never produces (the site plays it
	 * in the same position the reply arrives in, so the next position we see is the opponent's
	 * again). The two paths therefore cannot both play: the queued premove and this one are the
	 * same move, and the executor's own position guard vetoes the second of them.
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

	// ── a queued premove (Fix F) ───────────────────────────────────────────

	/**
	 * Enter the armed premove on the site, during the opponent's turn, the way the site's own
	 * premove works: you make the move while it is their turn and the site fires it the instant
	 * they move. Everything about it is deliberately narrow.
	 *
	 *   - **Only a self-invalidating reason** (`isQueueableReason`). A queued move fires whether or
	 *     not the prediction held, so the gate cannot be "the prediction is likely" — it has to be
	 *     "an unexpected reply makes this illegal", which a recapture and the only legal move are
	 *     and a clear-best quiet move is not.
	 *   - **Only once per opponent turn**, and never while one is already outstanding.
	 *   - **Only while the site is still holding them** (`premoveQueueing`).
	 *   - **The human moment**, not the instant the position appeared and not the end of their
	 *     think: `U(PREMOVE.queueDelayMinMs, queueDelayMaxMs)` after it, with the drag itself given
	 *     the §7.4 window. A think shorter than the delay simply never reaches the drag, and the
	 *     arm is still there for the fast reply instead.
	 *
	 * The §3.2 recommendation is *not* published for it: the live position is the opponent's, and a
	 * premove is not a recommendation for it. Nothing is logged as planned or played here either —
	 * the next position is what decides that (`reconcilePremove`).
	 */
	private enterPremove(snapshot: PositionSnapshot): void {
		const armed = this.premove;
		const executor = this.executorHandle;
		if (!armed || !executor || this.disposed) return;
		if (this.premoveEntry !== null) return;
		if (
			this.premoveQueueing === false ||
			!isQueueableCandidate(snapshot.fen, {
				reply: armed.reply,
				premove: armed.chosen.uci,
				reason: armed.reason,
			})
		)
			return;
		if (!this.mayAct() || !executor.isArmed()) return;
		if (!this.autoMoveAllowed(this.deps.getSettings())) return;
		const myColor = snapshot.myColor;
		if (myColor === null || snapshot.sideToMove === myColor) return;
		if (this.snapshot !== snapshot) return;
		// The SAN only exists in the position the premove is played in — it is not a legal move in
		// the one we are entering it from, which is the whole point of a premove.
		const afterReply = applyMoves(snapshot.fen, [armed.reply]);
		const san = afterReply === null ? null : uciToSan(afterReply, armed.chosen.uci);
		if (afterReply === null || san === null) {
			log.debug("game-session: premove not enterable (the predicted position does not hold it)", {
				tabId: this.deps.tabId,
				reply: armed.reply,
				uci: armed.chosen.uci,
			});
			return;
		}
		const chosen: ChosenMove = { ...armed.chosen, san };
		const now = this.now();
		const delayMs =
			PREMOVE.queueDelayMinMs + this.rng.next() * (PREMOVE.queueDelayMaxMs - PREMOVE.queueDelayMinMs);
		const windowMs = this.rng.next() * PREMOVE_WINDOW_MS;
		const plan: TimingPlan = {
			thinkMs: windowMs,
			mode: "premove",
			preMoveHoverMs: 0,
			dragDurationMs: 0,
			deadlineMs: now + delayMs + windowMs,
			rationale: [...chosen.rationale],
			features: {},
			orientationMs: 0,
			window: {
				orientationMs: 0,
				scanMs: 0,
				previewMs: 0,
				decisionMs: 0,
				approachMs: windowMs,
			},
		};
		const rec: Recommendation = {
			chosen,
			lines: [],
			eval: { cp: 0 },
			depth: 0,
			nps: 0,
			plan,
			computedAt: now,
			// The position it will be played in, which is what seeds the hand and what the §8.6 row
			// belongs to — not the one it is entered from.
			fen: afterReply,
		};
		this.premoveEntry = {
			reply: armed.reply,
			chosen,
			fromFen: snapshot.fen,
			ply: snapshot.ply + 1,
			clockMs: snapshot.clocks[myColor].ms,
			plan,
			rec,
			// The fork is the window the drag happens in; `now` is what it opens at if the session's
			// own window has already been closed by a late report for the previous move.
			window: this.window.fork(now),
			result: null,
			record: null,
			abandoned: null,
			settleWith: null,
		};
		executor.schedule(rec, plan, this.moveContext(rec));
		log.info("game-session: entering a premove on the site during the opponent's turn", {
			tabId: this.deps.tabId,
			uci: chosen.uci,
			reply: armed.reply,
			reason: armed.reason,
			inMs: Math.round(delayMs),
		});
	}

	/**
	 * A terminal executor report that belongs to the premove drag rather than to a move of our own
	 * (`true` when it was handled here). A `dispatched` report means the gesture went out and
	 * nothing was played — acceptance by the site is unknown — so none of `onExecuted`'s accounting
	 * may run; the §13.2 record of the window the drag happened in (a fork of the *opponent's*
	 * window, which is where the input really was) is built now and attached only if the next
	 * position shows the move.
	 *
	 * An outcome that is not `dispatched` is a drag the hand did not finish. The entry is kept when a
	 * press had already gone out, because the page may have seen a press on one square and a
	 * release on another and be holding something; it is forgotten when nothing was pressed.
	 */
	private settlePremoveDrag(report: ExecutionReport): boolean {
		const entry = this.premoveEntry;
		if (!entry || report.rec !== entry.rec) return false;
		const result = report.result;
		const pressed = result.pressed === true || result.pressedAny === true;
		if (result.outcome === "dispatched" || pressed) {
			entry.result = result;
			// `??=`, not `=`: one terminal report per execution is the rule, but closing the fork a
			// second time would replace a good record with `null` (a closed window produces none), so
			// the footgun is removed rather than relied on.
			entry.record ??= entry.window.close({
				elapsedMs: result.elapsedMs,
				pointerOffsetPx: result.pointerOffsetPx ?? 0,
				multiplePieces: selectedMultiplePieces(result, entry.chosen.from),
				orientationMs: entry.plan.orientationMs,
				// §13.2: a premove is never "non-trivial" — a premove press is a committed move
				// attempt, not a §9.3a preview touch, so it must never enter the preview-rate band
				// (`report.py` takes that denominator from this very field).
				multiSelectEligible: false,
				nReasonable: 1,
				// §13.6: a premove is decided before its position exists and carries no evaluation.
				quality: undefined,
				// The window is the opponent's turn, a period the owner owns: a focus edge in it is his
				// behaviour, and the §13.2 conduct rules are told so explicitly rather than inferring
				// it from the mode.
				ownerOwnsWindow: true,
				at: result.at ?? this.now(),
			});
		}
		if (result.outcome === "dispatched") {
			// Deliberately not "the site is holding our premove": all that is known here is that the
			// drag went out. chess.com exposes no premove state the extension can read, so acceptance
			// is unconfirmed until the next position either contains the move or does not.
			log.info("game-session: premove dispatched, acceptance unconfirmed", {
				tabId: this.deps.tabId,
				uci: entry.chosen.uci,
				ply: entry.ply,
				abandoned: entry.abandoned,
			});
		} else if (pressed) {
			log.warn("game-session: the premove drag was interrupted after a press; the site may have it", {
				tabId: this.deps.tabId,
				uci: entry.chosen.uci,
				outcome: result.outcome,
				reason: result.reason ?? null,
			});
		} else {
			this.premoveEntry = null;
			log.info("game-session: no premove was entered", {
				tabId: this.deps.tabId,
				uci: entry.chosen.uci,
				outcome: result.outcome,
				reason: result.reason ?? null,
			});
		}
		// The position that was waiting for this report (the race above) settles the premove now.
		const waiting = entry.settleWith;
		if (waiting !== null && this.premoveEntry === entry) this.reconcilePremove(waiting);
		this.deps.notify();
		return true;
	}

	/**
	 * Settle the premove against the position that has just arrived — the only signal there is.
	 * Nothing observable says whether the site *accepted* the gesture; what proves it was **played**
	 * is the position itself containing the move, read from `board.game`'s own FEN (or the move
	 * list's replay), never from a marking or an animation. Three outcomes, and the fourth
	 * that tells us the site is not holding them at all:
	 *
	 *   1. the predicted reply, our premove on the board — the happy path;
	 *   2. another reply, our premove gone — the site dropped it as illegal: a normal turn, planned
	 *      normally by the caller;
	 *   3. another reply, our premove on the board anyway — it is still our move and is recorded as
	 *      one, even though no search ever chose it for that position (§13.6 scores it as a premove,
	 *      i.e. not at all, and `buildTimingLogEntry` writes its `mode: "premove"` row);
	 *   4. the predicted reply, our premove gone — the prediction was right and the site played
	 *      nothing, so it is not holding our premoves: fall back to §7.4's fast reply from here on.
	 */
	private reconcilePremove(snapshot: PositionSnapshot): void {
		const entry = this.premoveEntry;
		if (!entry) return;
		if (entry.result === null && this.premoveDragInFlight(entry)) {
			// The drag is still winding down. Settling now would report "never entered" for a premove
			// the site may already be holding, so the drag's own report finishes this instead.
			entry.settleWith = snapshot;
			log.debug("game-session: the premove drag has not reported yet; settling on its report", {
				tabId: this.deps.tabId,
				uci: entry.chosen.uci,
			});
			return;
		}
		this.premoveEntry = null;
		const result = entry.result;
		if (result === null) {
			log.info("game-session: the premove was never entered", {
				tabId: this.deps.tabId,
				uci: entry.chosen.uci,
				reason: entry.abandoned ?? "the opponent moved first",
			});
			return;
		}
		const played = this.premoveLanded(entry, snapshot);
		if (played !== null) {
			this.premoveQueueing = true;
			this.premove = null;
			this.notePremovePlies(entry, played, snapshot);
			this.recordQueuedPremove(entry, result);
			if (played === entry.reply)
				log.info("game-session: the premove fired — the opponent played the predicted reply", {
					tabId: this.deps.tabId,
					uci: entry.chosen.uci,
					reply: played,
					ply: entry.ply,
					abandoned: entry.abandoned,
				});
			else
				log.warn("game-session: the premove fired after an unexpected reply — recorded as ours", {
					tabId: this.deps.tabId,
					uci: entry.chosen.uci,
					expected: entry.reply,
					played,
					ply: entry.ply,
				});
			return;
		}
		// The page saw the press even though the site kept nothing: §13.2 charges it to the *next*
		// move's window, so the next move's record has to carry it (see `droppedPremoveFrom`).
		if (result.pressed === true || result.pressedAny === true)
			this.droppedPremoveFrom = entry.chosen.from;
		const afterReply = applyMoves(entry.fromFen, [entry.reply]);
		const predicted = afterReply !== null && boardKeyOf(afterReply) === boardKeyOf(snapshot.fen);
		if (predicted) {
			// Only a *completed* gesture is evidence about the site. A drag the arriving position
			// aborted mid-flight still carries `pressed`, and treating that as "the site does not
			// hold premoves" switched the feature off for the rest of the game on the commonest
			// path at bullet — one attempt per game, blamed on chess.com (found in review).
			if (result.outcome === "dispatched") {
				this.premoveQueueing = false;
				log.warn(
					"game-session: the predicted reply arrived and the premove was not played — the site is not holding our premoves; the fast reply takes over",
					{ tabId: this.deps.tabId, uci: entry.chosen.uci, reply: entry.reply }
				);
				return;
			}
			log.info("game-session: the premove drag never finished; nothing was learned about the site", {
				tabId: this.deps.tabId,
				uci: entry.chosen.uci,
				outcome: result.outcome,
				reason: result.reason ?? null,
			});
			return;
		}
		// "Dropped" is what the site does with an illegal premove, but we cannot see whether it ever
		// held this one, so the line says only what the board shows.
		log.info("game-session: the premove is not on the board after an unexpected reply", {
			tabId: this.deps.tabId,
			uci: entry.chosen.uci,
			expected: entry.reply,
			dispatched: result.outcome === "dispatched",
		});
	}

	/**
	 * Is the premove's drag still going to report? `cancel()` (which every path that reaches here
	 * has already run) clears a drag that was merely *scheduled* and nothing more will be heard of
	 * it, but a drag already running winds down through the hand's release and reports afterwards.
	 */
	private premoveDragInFlight(entry: PremoveEntry): boolean {
		const executor = this.executorHandle;
		if (!executor) return false;
		return executor.isRunning() || executor.pendingMove()?.rec === entry.rec;
	}

	/**
	 * The opponent reply after which our premove is on `snapshot`'s board, or `null` when it is not
	 * there. Placement plus side to move is the comparison (`boardKeyOf`), so a reading the adapter
	 * had to approximate still answers, and the predicted reply is tried first because it is both
	 * the common case and the cheap one.
	 */
	private premoveLanded(entry: PremoveEntry, snapshot: PositionSnapshot): string | null {
		const want = boardKeyOf(snapshot.fen);
		const others = legalMoves(entry.fromFen).filter((m) => m !== entry.reply);
		for (const reply of [entry.reply, ...others]) {
			const after = applyMoves(entry.fromFen, [reply]);
			if (after === null) continue;
			const both = applyMoves(after, [entry.chosen.uci]);
			if (both !== null && boardKeyOf(both) === want) return reply;
		}
		return null;
	}

	/**
	 * Two plies landed in one position, so `trackMove` — which reads `lastMove` alone — can only see
	 * the second. Record both in order, and point `priorFen` at the position our premove was
	 * actually played from, which is what the *next* premove replays our move from.
	 */
	private notePremovePlies(entry: PremoveEntry, reply: string, snapshot: PositionSnapshot): void {
		if (this.moves[this.moves.length - 1] !== reply) this.moves.push(reply);
		if (this.moves[this.moves.length - 1] !== entry.chosen.uci) this.moves.push(entry.chosen.uci);
		this.updateHistory(snapshot, [reply, entry.chosen.uci]);
		const afterReply = applyMoves(entry.fromFen, [reply]);
		if (afterReply !== null) this.priorFen = afterReply;
		const at = snapshot.capturedAt;
		// `> 0` because `trackMove` may already have run for this position (the deferred settle
		// above), which moves `lastMyMoveAt` to the premove itself and leaves nothing to measure.
		const think = this.lastMyMoveAt === null ? 0 : at - this.lastMyMoveAt;
		if (think > 0) this.oppThinkMs.push(think);
		this.lastOppMoveAt = at;
	}

	/**
	 * §8.6 + §13.2 + §13.6 for a premove the next position confirmed. The row is written *here*,
	 * not when the drag went out: a row written at entry time would say a premove was played in a
	 * position the site may have dropped it in. `markActual` and `attachTelemetry` then find it
	 * under the ply the premove belongs to — the position after the reply, which this session never
	 * saw, because the site played our move in it.
	 */
	private recordQueuedPremove(entry: PremoveEntry, result: ExecutionResult): void {
		// `TimingModel.observe` is deliberately *not* called. It writes `actualMs` onto the entry it
		// keyed under its own `state.ply` — the ply of the last `planMove` — and a premove's plan is
		// hand-built and never went through `planMove`, so the ply is still our previous *searched*
		// move's and the write lands on that row. Measured by the review: a scored row's `actualMs`
		// overwritten with the premove drag's elapsed. The session's own `myThinkMs` (below) is what
		// the features read, so nothing is lost. (`recordMove` has the same shape on the reactive
		// premove path — pre-existing, and fixing it properly needs `src/core/timing/**`.)
		this.myThinkMs.push(result.elapsedMs);
		const gameId = this.game?.gameId ?? "";
		this.deps.timingLog.append(
			buildTimingLogEntry({
				gameId,
				ply: entry.ply,
				mode: "premove",
				plannedMs: entry.plan.thinkMs,
				alloc: 0,
				clockMs: entry.clockMs,
				comp: 1,
				eps: 0,
				terms: [],
				persona: this.deps.getSettings().strength.persona,
			})
		);
		this.deps.timingLog.markActual(gameId, entry.ply, result.elapsedMs);
		if (entry.record) this.deps.timingLog.attachTelemetry(gameId, entry.ply, entry.record);
		void this.updateStats((stats) =>
			foldMove(stats, {
				thinkMs: result.elapsedMs,
				scored: isScoredMove(entry.chosen),
				top1: entry.chosen.rankInLines === TOP_LINE_RANK,
				cpLoss: entry.chosen.cpLoss,
			})
		);
	}

	/**
	 * Give up the premove: `Shift+X`, the master switch, a disarm, a game end, a tab navigation, a
	 * disposed session. Every one of those paths cancels the hand first, so a premove still waiting
	 * for its moment is simply never entered — which is the only cancellation that is wholly ours.
	 *
	 * One already entered is the **site's** state, and we cannot take it back: retracting a premove
	 * on chess.com is another press on the board, and §13.7 item 3 allows the hand only the presses
	 * the §9.3a model generates (and the gesture itself is one we have never verified on a real
	 * board — dispatching the wrong one could leave a piece selected, which that rule forbids
	 * outright). So the entry is *kept*, not dropped: it is never reported as played unless the
	 * board shows it, and if the site does fire it the move was still ours and is accounted as ours.
	 * What bounds the exposure is the policy, not us: a queued premove is a recapture or the only
	 * legal move, so an opponent who plays anything else makes it illegal and the site drops it.
	 */
	private forgetPremove(reason: string): void {
		this.premove = null;
		const entry = this.premoveEntry;
		if (entry === null || entry.abandoned !== null) return;
		entry.abandoned = reason;
		if (entry.result === null) {
			log.info("game-session: a premove was given up before it was entered", {
				tabId: this.deps.tabId,
				reason,
				uci: entry.chosen.uci,
			});
			return;
		}
		log.warn(
			"game-session: a premove had already been entered on the site and cannot be taken back",
			{ tabId: this.deps.tabId, reason, uci: entry.chosen.uci, reply: entry.reply }
		);
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
		// The recommendation this arm may have raced is acted on through the one re-delivery path, not
		// a copy of it here: the gate, the `MoveContext` and the §3.3 answer all live in one place,
		// so the manual arm, the automatic arm and the panel's toggle cannot drift apart.
		await this.reconsiderGuarded("the hand was armed");
		this.deps.notify();
	}

	private disarm(): void {
		// `disarm()` cancels whatever the hand had pending first, so a premove that has not been
		// entered yet never is; `forgetPremove` then gives up the arm as well (an unarmed hand must
		// not fire a premove on the next position either).
		this.executorHandle?.disarm();
		// The hand no longer owns a pointer on this tab, so nothing of ours belongs on the page.
		this.hideVirtualCursor();
		this.forgetPremove("the hand was disarmed");
		this.apply("disarm");
		this.deps.notify();
	}

	/** `Shift+X`: stop everything on this tab — highlights cleared, executor cancelled. */
	private disable(): void {
		this.cancelInFlight();
		this.executorHandle?.disarm();
		this.deps.autoQueue.cancel(this.deps.tabId);
		// The arrow first, the board marks second: `clearBoardMarks()` stays the last thing every
		// stop path posts, which is what `test/behavioral/game/keybinds.test.ts` reads.
		this.hideVirtualCursor();
		this.clearBoardMarks();
		this.rec = null;
		this.forgetPremove("Shift+X — the assistant was stopped on this tab");
		this.apply("disable");
		this.deps.notify();
	}

	/** §8.5 manual path: the pending move (else the current recommendation) plays now. */
	private async playNow(): Promise<void> {
		const executor = this.executorHandle;
		if (!executor) return;
		if (!isMyTurnState(this.state)) return;
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
		// Fix F: the only thing pending during the opponent's turn is a premove waiting for its
		// human moment. "Play the best move" is about *our* move, so it neither commits that premove
		// early nor falls through to a recommendation for the opponent's position.
		if (pending && this.premoveEntry !== null && pending.rec === this.premoveEntry.rec) {
			log.info("game-session: playNow ignored — the pending move is a premove", {
				tabId: this.deps.tabId,
				uci: pending.rec.chosen.uci,
			});
			return;
		}
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
		this.premoveEntry = null;
		// `premoveQueueing` is *not* reset here: it is a fact about the page, not about the game.
		this.droppedPremoveFrom = null;
		this.moves = [];
		this.positionHistory = null;
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
			// Fix F: the premove gesture went out. Nothing has been played — and nothing can tell
			// whether the site kept it — so it is not `executed` and none of `onExecuted`'s
			// accounting runs on it.
			executor.on("dispatched", (report) => void this.settlePremoveDrag(report)),
			executor.on("failed", (report) => this.onFailed(report)),
			executor.on("aborted", (report) => this.onNotExecuted(report, "aborted")),
			executor.on("skipped", (report) => this.onNotExecuted(report, "skipped")),
			executor.on("hand", (hand) => {
				if (hand === "rest") return;
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
				if (!isMyTurnState(this.state)) return;
				this.apply("handStarted");
				// The hand is acting: the mark must now be one the site cannot take away.
				this.markForExecution();
			}),
			executor.on("pointer", (p) => this.onHandPointer(p)),
		];
		// A game that follows an armed one keeps the hand armed (the debugger stays attached), and
		// `Settings.automation.autoMove` is the stored "arm me" default. Either way the attach
		// happens here — before the first position of the game, i.e. outside every move window
		// (§13.4) — never once a move is due.
		// §4.4: neither default arms anything while the assistant is off.
		// Fix G: and the arm is awaited for its *result*, not fired and forgotten. `arm()` attaches
		// the debugger, which is slow enough to lose the race with the first position — and the
		// manual arm (Shift+A) has always re-checked the recommendation it may have raced, while
		// this path did not. At ply 0 as white that re-check is the only one there will ever be.
		if (this.mayAct() && (wasArmed || this.deps.getSettings().automation.autoMove))
			void executor.arm().then(
				() => this.reconsiderGuarded("the hand finished arming"),
				(error: unknown) => log.warn("game-session: re-arm failed", error)
			);
	}

	private detachExecutor(): void {
		for (const off of this.executorOffs.splice(0)) off();
		this.executorHandle?.dispose();
		this.executorHandle = null;
	}

	private onExecuted(report: ExecutionReport): void {
		// A premove's report settles the fork and stops here, so it never reaches the clear below —
		// deliberately. The mark of a queued premove is not a spent prediction, it is the move that is
		// about to play, and it stays on the board for exactly as long as that is true: the opponent
		// moving brings a new position, and `onPosition`'s own clear erases it there. This is the one
		// mark that outlives its own action, and it outlives it by design.
		if (this.settlePremoveDrag(report)) return;
		this.apply("executed");
		// The move is on the board: the prediction has been spent, and the site's own last-move
		// marking is what belongs there now.
		this.clearBoardMarks();
		this.recordMove(report);
		this.deps.notify();
	}

	private onFailed(report: ExecutionReport): void {
		if (this.settlePremoveDrag(report)) return;
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
	 *
	 * **The mark goes too — but only if it is still this attempt's mark.** An attempt that finally
	 * failed is the action being complete, so it is a clear point exactly as `executed` is. There is
	 * no retry left that could want it: `MoveExecutor.runOne` emits `failed` / `aborted` / `skipped`
	 * only after `dispatch()` has returned, and `dispatch()` is where `runWithRetry` exhausts every
	 * tier. Leaving it drawn stranded an overlay `<svg>` for a move that will never be played — and
	 * the overlay is ours, so unlike the native marking it used to be, nothing on the page ever
	 * wipes it (the known promotion gap, QA B0.7, reaches this path on every live game).
	 *
	 * The `report.rec === this.rec` test is not belt-and-braces, it is the correctness condition.
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
		if (this.settlePremoveDrag(report)) return;
		this.apply("failed");
		this.window.discard();
		if (report.rec === this.rec) this.clearBoardMarks();
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
		// §13.2: a premove the site dropped leaves its press inside the window the *site* closes with
		// this move, so it is one of the pieces it saw selected (Fix F).
		const alsoPressed = this.droppedPremoveFrom;
		this.droppedPremoveFrom = null;
		if (timing) timing.observe(result.elapsedMs, rec.plan);
		this.myThinkMs.push(result.elapsedMs);
		if (snapshot && this.game) {
			this.deps.timingLog.markActual(this.game.gameId, snapshot.ply, result.elapsedMs);
			const record = this.window.close({
				elapsedMs: result.elapsedMs,
				pointerOffsetPx: result.pointerOffsetPx ?? 0,
				multiplePieces:
					selectedMultiplePieces(result, rec.chosen.from) ||
					(alsoPressed !== null && alsoPressed !== rec.chosen.from),
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
		// Fix F: a premove's drag runs in a fork of the opponent-turn window, and §13.2 wants the
		// edges of the window the input was actually in.
		this.premoveEntry?.window.edge(hasFocus, at);
		if (hasFocus) {
			this.onFocusRegained();
			return;
		}
		// Remember which position the blur landed on, before anything else: §13.4's permission to
		// play the first move after a refocus hangs off this, and it has to outlive a republish of
		// the same ply (see `blurredPositionKey`).
		const blurred = this.snapshot;
		if (blurred) this.blurredPositionKey = this.positionIdentity(blurred);
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

	/**
	 * Is this the game's first move? The scope of the relaxation below, named rather than compared
	 * inline so that the ruling's boundary is visible at the call site and cannot quietly widen to
	 * every move — which is the version the owner explicitly did not choose.
	 */
	private isGameFirstMove(snapshot: PositionSnapshot): boolean {
		// Provenance, and it fails **closed**: only an explicit `false` counts. An approximate FEN is
		// the adapter's own reconstruction from the DOM placement, and its fullmove counter is
		// `Math.floor(ply / 2) + 1` — the very field this predicate stopped trusting — so a mid-game
		// placement with an unreadable move list can be published as fullmove 1. A snapshot that does
		// not state its provenance at all is not evidence either: absent must not mean trusted on a
		// §13.4 permission, or a future producer inherits the relaxation by omission.
		if (snapshot.approximate !== false) return false;
		const parts = parseFen(snapshot.fen);
		// A FEN we cannot parse is not evidence of anything: refuse rather than widen.
		if (parts === null || plyOf(parts) > FIRST_MOVE_LAST_PLY) return false;
		// And the counters have to be corroborated by the pieces (`isFirstMovePlacement`): provenance
		// is a claim about the source, not a consistency check on the position.
		return isFirstMovePlacement(parts);
	}

	/**
	 * The page got focus back (the owner clicked into the board). §13.4's rule is that a move which
	 * could not run because the page was not focused *waits for the next position* — and at the
	 * game's first move there is no next position, so it waits for ever (owner's report, 2026-09-10:
	 * "it sometimes doesnt make the first move (if youre on white)").
	 *
	 * The owner ruled on 2026-09-10 that the first move may be played when focus comes back, and
	 * **only** the first move: a real player's first move usually does carry a focus change, because
	 * they have just clicked to start the game, so spending the focus-discipline margin there is
	 * defensible in a way that spending it on every move is not. He explicitly did not take the
	 * every-move relaxation. `docs/qa/focus-discipline.md` §4 records the decision, its scope and the
	 * evidence that would change it.
	 *
	 * Two conditions, neither optional:
	 *   - `isGameFirstMove` — the whole scope of the ruling;
	 *   - no blur landed *inside* this move's window. That is `FocusGate`'s own per-window
	 *     bookkeeping (`blurSeen`, set on the blur and cleared only by `positionArrived`), and it is
	 *     exactly what chess.com counts against the move: a blur followed by a focus inside one
	 *     window is §13.2's `DidToggle`, the strongest client signal the corpus documents. Such a
	 *     move is spent, and its second chance is the next position, not this click.
	 *
	 * This is a reaction to the owner's own focus change, never a focus change of ours: §13.4's
	 * absolute rule — nothing here raises a notification, activates a tab or calls
	 * `Page.bringToFront` — is untouched. The hand still asks `FocusGate.canExecute` for itself when
	 * the re-delivered move is dispatched, so this only gives the move a second chance; it does not
	 * grant it permission.
	 */
	private onFocusRegained(): void {
		const snapshot = this.snapshot;
		if (!snapshot || !this.isGameFirstMove(snapshot)) return;
		if (this.blurredPositionKey === this.positionIdentity(snapshot)) return;
		void this.reconsiderGuarded("the page regained focus on the game's first move");
	}

	/**
	 * The identity a blur is remembered against: the game and the **FEN**, never `snapshot.ply`. The
	 * ply is the adapter's move-list read and can be 0 — or simply wrong — on a board that has moved
	 * (the same reason `isGameFirstMove` reads the FEN), and a lying ply on a republished position
	 * would make the remembered blur stop matching and release a move it should hold. The FEN comes
	 * from the bridge and is identical across the republish that carries the colour or the clock.
	 * A repeated position later in the game cannot collide with this: the only release this gates is
	 * the game's first move, whose FEN cannot recur. Including the `gameId` is what makes a reset on
	 * `startGame` unnecessary — a key from the previous game can never match this one's.
	 */
	private positionIdentity(snapshot: PositionSnapshot): string {
		return `${snapshot.gameId}|${snapshot.fen}`;
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
		// Fix G: whatever the held position was waiting for, it is not this session's business any
		// more — and the per-position retry budget starts fresh with the next one.
		this.clearRetry();
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

	private postHighlight(rec: Recommendation, overlay = false): void {
		const settings = this.deps.getSettings();
		if (!this.mayAct() || !settings.automation.highlightMoves) return;
		// No colour check of its own. `runPipeline` is the only caller (and re-checks
		// `this.snapshot !== snapshot` before getting here), every `Recommendation` carries the
		// snapshot's own `fen` (`recommendation.ts`), and `runPipeline`'s precondition is already that
		// that FEN's turn is our colour — so a check here could only ever differ from the one above by
		// reading a *different* colour source, and the only other source is the game's own copy of it.
		// A guard that cannot catch anything its caller misses is a guard nothing can test, so the
		// properties it would have rested on are asserted instead
		// (`test/behavioral/game/wrong-colour-guard.test.ts`): the mark is withdrawn when a correction
		// lands, and `rec.fen` is the snapshot's own FEN.
		this.markedOverlayFor = overlay ? rec : null;
		this.deps.link.post(this.deps.tabId, {
			kind: "highlight",
			from: rec.chosen.from,
			to: rec.chosen.to,
			style: settings.automation.highlightStyle,
			...(overlay ? { overlay: true as const } : {}),
		});
	}

	/**
	 * The hand has started acting on `rec`: redraw its mark as *ours* before the first press.
	 *
	 * The owner's report of 2026-09-10 is that the mark vanishes "when the mouse starts its
	 * action ... rather than when it finishes it". Nothing of ours clears there any more — the one
	 * clear in the execution path, the content script's pre-`observeMove` clear, is gone (§13.3
	 * rule 4 is overruled for this mark) and completion is the only clear. What is left is the
	 * site: chess.com clears its own user markings on a left press on the board, and the hand's
	 * action is a sequence of presses — each preview touch of another piece is one, which is
	 * exactly the "even if its going to touch other pieces" detail. That is site behaviour and
	 * cannot be proved from this repository, so the fix does not depend on it: an overlay mark is
	 * an `<svg>` the bridge owns, so nothing the site does to *its* markings can reach it, and if
	 * the overlay turns out not to render on the live canvas board the result is exactly today's
	 * behaviour and nothing else changes.
	 *
	 * Two conditions, and neither carries correctness on its own any more:
	 *
	 * - `markedOverlayFor === rec` keeps this to **one** page round trip per mark rather than one
	 *   per hand-state change (the hand changes state a dozen times per move). It is safe across a
	 *   retry tier only because nothing clears the mark between tiers; when something does clear
	 *   it — `clearBoardMarks` — that field is reset, so the next hand start redraws.
	 * - `runningMove()?.rec !== rec` keeps the redraw to the recommendation actually being
	 *   executed. `this.rec` and the running move **do** diverge in practice — `cancelInFlight()`
	 *   does not await `MoveExecutor.cancel()`, so while a cancelled run winds down the session has
	 *   already analysed the next position and replaced `this.rec` (measured: hundreds of
	 *   milliseconds). What keeps this branch unreachable today is a `HandController` invariant
	 *   instead: after an abort the only state it emits is `rest` (`hand-controller.ts`'s catch path
	 *   and `recover()`, which calls no `setState`), and `rest` is filtered out by the session's
	 *   `hand` listener before this function is reached. So the guard does no work today and is
	 *   deliberately untested — but it is load-bearing on that invariant, not on the two
	 *   recommendations never differing. A change that made the abort path emit, say, `dropping`
	 *   would put it straight to work.
	 */
	private markForExecution(): void {
		const rec = this.rec;
		const executor = this.executorHandle;
		if (!rec || !executor || this.markedOverlayFor === rec) return;
		if (executor.runningMove()?.rec !== rec) return;
		this.postHighlight(rec, true);
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
		this.markedOverlayFor = null;
		this.deps.link.post(this.deps.tabId, { kind: "clearHighlight" });
	}

	/**
	 * Fix D: the hand dispatched a point, so the mirror on the page moves to it. Called for every
	 * acknowledged point — what the page was told, not what was planned — which is why the mirror
	 * is the truth about where the pointer is rather than an animation of a route.
	 *
	 * **Cadence, measured in the simulator** (ten runs, five seeds x preview on/off, gaps pooled
	 * rather than per-run medians): 86-153 points per ~3 s move, 33-53/s, gap p50 **7 ms**, p90
	 * **33 ms**, p99 ~580 ms, and **83%** of gaps inside one 16.7 ms frame. The long tail is the
	 * hand's own deliberate pauses, not a transport problem. An independent re-measurement got
	 * p50 7.7 / p90 24.3 over 1228 gaps, so treat ~7 ms median and a tens-of-ms p90 as the figures.
	 *
	 * **Why every point is posted rather than coalesced onto a frame.** Not because of load — the
	 * port is nowhere near strained, which is the only test the brief set. The §13.3 question is
	 * the real one, and frame coalescing would genuinely reduce page-observable surface: fewer
	 * `postMessage` envelopes and, since a `MutationObserver` queues one record per changed-property
	 * write, proportionally fewer `style` records during the bursts. Two reasons it is still not
	 * worth doing:
	 *
	 *  1. The coordinates are not new information to the page. Every mirrored point corresponds to a
	 *     *trusted* `pointermove` / `pointerdown` / `pointerup` the page already received from CDP at
	 *     that same cadence, so chess.com has the stream and its timing with or without us. What an
	 *     envelope adds is the conjunction "whatever posts these knows the pointer stream" — and a
	 *     visible arrow that tracks the pointer already discloses exactly that, at any sample rate.
	 *  2. The brief ruled on load ("coalesce only if a measurement shows the port or the bridge
	 *     cannot keep up"), and it does keep up.
	 *
	 * If that trade is ever revisited, the place to do it is the ISOLATED relay
	 * (`src/content/virtual-cursor.ts`), which already owns a `dispose()` and whose
	 * `requestAnimationFrame` is not the page's function and so cannot be counted or intercepted by
	 * a page script — not the MAIN-world program, where a loop would be page-realm surface of its
	 * own. That buys ≤1 frame of latency and `docs/qa-checklist.md` §B5.9 is the measurement.
	 *
	 * Between moves no point arrives, so the mirror simply stays where the pointer is.
	 */
	private onHandPointer(p: { x: number; y: number; pressed: boolean }): void {
		if (!this.virtualCursorAllowed()) return;
		this.deps.link.post(this.deps.tabId, {
			kind: "cursorTo",
			x: p.x,
			y: p.y,
			down: p.pressed,
		});
	}

	/** §4.4 and `Settings.display.virtualCursor`: may the mirror be on the page at all? */
	private virtualCursorAllowed(): boolean {
		return this.mayAct() && this.deps.getSettings().display.virtualCursor;
	}

	/**
	 * Erase the mirror. Unconditional and idempotent, like `clearBoardMarks()` beside it, and that
	 * is deliberate: the element lives in the *page*, so nothing this worker remembers is evidence
	 * about whether it is there. Chrome does not call `dispose()` when it suspends a worker — the
	 * session object simply vanishes and a new one is built on wake, while the content script
	 * reconnects rather than reboots and still holds the element. A guard on worker-local state
	 * would make every stop path (disarm, `Shift+X`, the switch, the setting, game over, a
	 * navigation, a detach, dispose) a no-op from then on and strand the arrow on a live game for
	 * good. Removing an element that is not there is already a no-op on the page side, and the
	 * deduplication lives one layer down in `src/content/virtual-cursor.ts`, where the flag and the
	 * element share a lifetime.
	 */
	private hideVirtualCursor(): void {
		this.deps.link.post(this.deps.tabId, { kind: "cursorHide" });
	}

	private historyFor(fen: string): PositionHistory {
		return matchingHistory(this.positionHistory, fen) ?? { fen, moves: [] };
	}

	private updateHistory(snapshot: PositionSnapshot, newMoves: string[] = []): void {
		const restored = snapshot.moveHistory ? historyFromSan(snapshot.moveHistory, snapshot.fen) : null;
		if (restored) {
			this.positionHistory = restored;
			this.moves = [...restored.moves];
			return;
		}
		if (matchingHistory(this.positionHistory, snapshot.fen)) return;
		const current = this.positionHistory;
		const advanced =
			current &&
			matchingHistory({ fen: current.fen, moves: [...current.moves, ...newMoves] }, snapshot.fen);
		this.positionHistory = advanced ?? { fen: snapshot.fen, moves: [] };
	}

	/** Record the move that produced `snapshot` and the pace it was played at. */
	private trackMove(previous: PositionSnapshot | null, snapshot: PositionSnapshot): void {
		const last = snapshot.lastMove;
		if (!last || !previous) {
			this.updateHistory(snapshot);
			return;
		}
		const uci = this.uciOf(previous.fen, last.from, last.to);
		if (uci !== null && this.moves[this.moves.length - 1] !== uci) this.moves.push(uci);
		this.updateHistory(snapshot, uci === null ? [] : [uci]);
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
			inputMethod: EXECUTOR.committedTier,
			autoQueen: true,
			nowMs: this.now(),
		};
	}

	private updateStats(fold: (stats: SessionStats) => SessionStats): Promise<void> {
		return queueStatsWrite(fold);
	}
}
