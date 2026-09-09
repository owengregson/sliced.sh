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
 */

import { legalMoves, parseUci, uciToSan } from "@core/chess/san";
import { sanToSpeech } from "@core/chess/san-speech";
import { isSquare } from "@core/chess/squares";
import { chromeLocalGet, chromeLocalSet } from "@core/chrome/storage";
import { LIMITS } from "@core/constants/limits";
import type { GamePortCommand, GamePortMessage } from "@core/constants/messages";
import { LOCAL_KEYS } from "@core/constants/storage-keys";
import { TELEMETRY_BANDS } from "@core/constants/telemetry";
import {
	MANUAL_TIMING_PROFILE,
	PROFILE_FOR_TC_CLASS,
	TIMING_PROFILE_KNOBS,
} from "@core/constants/timings";
import { log } from "@core/logger";
import type { MoveCandidate, TimeControlClass } from "@core/motor/types";
import { createRng, type Rng } from "@core/rng";
import type { BookPolicy } from "@core/strength/book/book-policy";
import { createSelectionState } from "@core/strength/move-selector";
import { createFormLatent, type FormLatent } from "@core/strength/persona";
import { premoveCandidate } from "@core/strength/premove";
import type { SelectionState } from "@core/strength/types";
import { TIMING_CONSTANTS } from "@core/timing/constants";
import { tcClass } from "@core/timing/features";
import type { TimingLogWriter } from "@core/timing/timing-log";
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
} from "@typedefs/game";
import type { PersonaId, Settings } from "@typedefs/settings";
import { PonderController } from "./ponder";
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
	debugger: Pick<DebuggerManager, "isAttached">;
	focus: Pick<FocusGate, "positionArrived" | "onEdge" | "snapshot">;
	ownership: Pick<HandOwnership, "realPointerCount">;
	timingLog: Pick<TimingLogWriter, "append" | "markActual" | "attachTelemetry">;
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

	constructor(deps: GameSessionDeps) {
		this.deps = deps;
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
		this.pushContentSettings();
		this.deps.notify();
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
		this.rec = null;
		const myTurn = snapshot.myColor !== null && snapshot.sideToMove === snapshot.myColor;
		const at = this.now();
		this.deps.focus.positionArrived(this.deps.tabId, at);
		this.window.open(at, myTurn);
		this.trackMove(previous, snapshot);
		if (!this.apply("positionChanged", { myTurn })) return;
		this.deps.notify();
		if (!myTurn) {
			await this.onOpponentTurn(snapshot);
			return;
		}
		if (await this.tryPremove(snapshot)) return;
		await this.runPipeline(snapshot);
	}

	/** Opponent's turn: ponder (§6.4) and prepare a premove candidate (§7.4). */
	private async onOpponentTurn(snapshot: PositionSnapshot): Promise<void> {
		const ponderer = this.ponderer;
		if (!ponderer) return;
		await ponderer.start("opponent", snapshot.fen);
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
		return this.effectiveProfile(settings) !== MANUAL_TIMING_PROFILE;
	}

	private moveContext(rec: Recommendation): MoveContext {
		const snapshot = this.snapshot;
		const candidates: MoveCandidate[] = [];
		rec.lines.forEach((line, i) => {
			const uci = line.pvUci[0];
			const parts = uci === undefined ? null : parseUci(uci);
			if (!uci || !parts) return;
			candidates.push({ from: parts.from, to: parts.to, uci, probability: 1 / (i + 1) });
		});
		const ctx: MoveContext = {
			nReasonable: this.recNReasonable,
			candidates,
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
			if (!candidate || this.disposed || this.snapshot !== snapshot) return;
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

		this.timing = new TimingModel(
			this.deps.head,
			this.timingSettings(settings, tc),
			createRng(`${gameSeed}:timing`),
			{ onEntry: (entry) => this.deps.timingLog.append(entry) }
		);
		this.timing.startGame({
			targetElo,
			profile: settings.strength.persona,
			baseSec,
			incSec,
			site: meta.site,
			gameId: meta.gameId,
		});
		this.deps.warmTiming?.(targetElo);

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
		if (settings.automation.autoQueue) this.deps.autoQueue.schedule(this.deps.tabId);
		log.info("game-session: game over", { tabId: this.deps.tabId, result });
	}

	// ── executor plumbing ──────────────────────────────────────────────────

	private attachExecutor(config: Parameters<ExecutorFactory>[0]): void {
		const wasArmed = this.executorHandle?.isArmed() ?? false;
		this.detachExecutor();
		const executor = this.deps.createExecutor(config);
		this.executorHandle = executor;
		this.executorOffs = [
			executor.on("executed", (report) => this.onExecuted(report)),
			executor.on("failed", (report) => this.onFailed(report)),
			executor.on("aborted", () => this.window.discard()),
			executor.on("skipped", () => this.window.discard()),
			executor.on("hand", (hand) => {
				if (hand !== "rest") this.apply("handStarted");
			}),
		];
		// A game that follows an armed one keeps the hand armed (the debugger stays attached), and
		// `Settings.automation.autoMove` is the stored "arm me" default. Either way the attach
		// happens here — before the first position of the game, i.e. outside every move window
		// (§13.4) — never once a move is due.
		if (wasArmed || this.deps.getSettings().automation.autoMove)
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
		this.apply("failed");
		log.warn("game-session: execution failed", {
			tabId: this.deps.tabId,
			uci: report.rec.chosen.uci,
			reason: report.result.reason ?? null,
		});
		this.window.discard();
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
				top1: rec.chosen.rankInLines === TOP_LINE_RANK,
				cpLoss: rec.chosen.cpLoss,
				at: result.at ?? this.now(),
			});
			if (record) this.deps.timingLog.attachTelemetry(this.game.gameId, snapshot.ply, record);
		}
		void this.updateStats((stats) =>
			foldMove(stats, {
				thinkMs: result.elapsedMs,
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
			{ kind: "settings", highlightMoves: settings.automation.highlightMoves },
			{ kind: "keybinds", keybinds: settings.keybinds },
		];
		for (const cmd of commands) this.deps.link.post(this.deps.tabId, cmd);
	}

	private postHighlight(rec: Recommendation): void {
		const settings = this.deps.getSettings();
		if (!settings.automation.highlightMoves) return;
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
	 * §4.6: a *detected* preset wins over a stored preset, exactly as the Settings
	 * view's chips display it; `manual` and `custom` are the user's own choice and
	 * are never overridden.
	 */
	private effectiveProfile(settings: Settings): Settings["timing"]["profile"] {
		const stored = settings.timing.profile;
		if (stored === MANUAL_TIMING_PROFILE || stored === "custom") return stored;
		const snapshot = this.snapshot ?? null;
		const tc = snapshot?.timeControl ?? this.game?.timeControl;
		if (!tc) return stored;
		const cls = tcClass(tc.baseMs / MS_PER_S, tc.incMs / MS_PER_S);
		return cls === "untimed" ? stored : PROFILE_FOR_TC_CLASS[cls];
	}

	/** The timing knobs the model runs with: the sliders scaled by the effective preset. */
	private timingSettings(settings: Settings, _tc: TcClass): Settings["timing"] {
		const profile = this.effectiveProfile(settings);
		const knobs =
			profile === "fast" || profile === "natural" || profile === "slow"
				? TIMING_PROFILE_KNOBS[profile]
				: null;
		if (!knobs) return settings.timing;
		return {
			...settings.timing,
			profile,
			speedScale: settings.timing.speedScale * knobs.speedScale,
		};
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
			site: this.site ?? "lichess",
			targetElo: this.targetElo(),
			profile: settings.strength.persona,
			engineReady: this.deps.engine !== null,
			inputMethod: settings.execution.style === "click" ? "click" : "drag",
			autoQueen: true,
			nowMs: this.now(),
		};
	}

	private async updateStats(fold: (stats: SessionStats) => SessionStats): Promise<void> {
		try {
			const stored = (await chromeLocalGet(LOCAL_KEYS.sessionStats)) as SessionStats | undefined;
			const next = fold(stored ?? { ...EMPTY_STATS });
			await chromeLocalSet(LOCAL_KEYS.sessionStats, next);
		} catch (error) {
			log.debug("game-session: session stats not written", { error: errorMessage(error) });
		}
	}
}
