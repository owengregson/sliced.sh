/**
 * The state every part of a `GameSession` reads: which page and game the tab is on, the position
 * the session holds and its recommendation, the §3.3 state, the per-game models (timing, pipeline,
 * ponder, selection, form, RNG), the hand — and the questions asked of them all (§4.4's
 * `mayAct`, the colour hold, the target, the clocks). Each collaborator owns its own state on top
 * of this; only what two or more of them share lives here.
 *
 * Collaborators read these fields at the moment they need them and never keep a copy: `startGame`
 * replaces the per-game objects (`rng`, `timing`, `pipeline`, …) wholesale.
 */

import { turnFieldOf } from "@core/chess/fen";
import type { PositionHistory } from "@core/chess/history";
import { isLoneKing } from "@core/chess/material";
import { LIMITS } from "@core/constants/limits";
import { log } from "@core/logger";
import { createRng, type Rng } from "@core/rng";
import { createSelectionState } from "@core/strength/move-selector";
import { createFormLatent, type FormLatent } from "@core/strength/persona";
import type { SelectionState } from "@core/strength/types";
import { clockRacePolicy } from "@core/timing/opponent-pressure";
import type { TimingModel } from "@core/timing/timing-model";
import { clamp } from "@core/util/clamp";
import { defaultNow, defaultScheduler, type Scheduler } from "@core/util/scheduler";
import type { MoveExecutor } from "@service/move-executor";
import type {
	GameMeta,
	GameSessionState,
	PageKind,
	PositionSnapshot,
	Recommendation,
	Site,
	TimeControl,
} from "@typedefs/game";
import type { Settings } from "@typedefs/settings";
import { remainingClockMs } from "../clock";
import type { PonderController } from "../ponder";
import { MoveWindow } from "../telemetry";
import { type GameSessionEvent, isLiveState, nextState } from "../transitions";
import { MoveHistory } from "./move-history";
import { PLAYED_PAGES } from "./position-rules";
import type { GameSessionDeps, OpponentInfo, SessionPipeline } from "./types";

export class SessionCore {
	readonly deps: GameSessionDeps;
	readonly tabId: number;
	readonly now: () => number;
	readonly scheduler: Scheduler;
	/** Per-tab base seed; every per-game seed is derived from it. */
	readonly seed: string;
	/** The §13.2 window of the move the current position is judged on. */
	readonly window = new MoveWindow();
	readonly history = new MoveHistory();

	state: GameSessionState = "idle";
	site: Site | null = null;
	pageKind: PageKind = "other";
	game: GameMeta | null = null;
	snapshot: PositionSnapshot | null = null;
	/** First arrival of this position; later clock snapshots must not restart the turn. */
	positionArrivedAt: number | null = null;
	rec: Recommendation | null = null;
	recNReasonable = 1;
	opponentInfo: OpponentInfo | null = null;
	/** Bumped by every cancel: asynchronous work started under an older generation is stale. */
	workGeneration = 0;
	disposed = false;

	executor: MoveExecutor | null = null;
	timing: TimingModel | null = null;
	pipeline: SessionPipeline | null = null;
	ponderer: PonderController | null = null;
	selection: SelectionState = createSelectionState();
	form: FormLatent = createFormLatent(createRng("form"));
	rng: Rng;
	/** The per-game seed every per-position draw derives from (`startGame`). */
	gameSeed: string;
	/** The game's starting clock, what `budgetUsedRatio` measures against. */
	startClockMs = 0;

	constructor(deps: GameSessionDeps) {
		this.deps = deps;
		this.tabId = deps.tabId;
		this.now = deps.now ?? defaultNow;
		this.scheduler = deps.scheduler ?? defaultScheduler;
		this.seed = deps.seed ?? `tab-${deps.tabId}`;
		this.gameSeed = `${this.seed}:pregame`;
		this.rng = createRng(`${this.seed}:session`);
	}

	settings(): Settings {
		return this.deps.getSettings();
	}

	notify(): void {
		this.deps.notify();
	}

	/** Take the §3.3 edge `event`; `false` when the table refuses it (the state is kept). */
	apply(event: GameSessionEvent, input: { myTurn?: boolean } = {}): boolean {
		const previous = this.state;
		const next = nextState(previous, event, input);
		if (next === null) return false;
		if (next === previous) return true;
		this.state = next;
		log.debug("game-session: state", { tabId: this.tabId, previous, event, next });
		if (isLiveState(previous) !== isLiveState(next)) this.deps.onLivenessChanged?.();
		return true;
	}

	/** Whether `getSettings()` is the stored settings yet (a caller that omits the seam knows them). */
	settingsKnown(): boolean {
		return this.deps.settingsKnown?.() ?? true;
	}

	/**
	 * §4.4: may this session act on the page at all right now? The master switch, plus the
	 * cold-start rule that an *unknown* switch holds rather than guesses — `DEFAULT_SETTINGS` is
	 * not the user's answer, in either direction, so nothing is analysed, drawn, armed or played
	 * until the stored settings have actually been read.
	 */
	mayAct(): boolean {
		return PLAYED_PAGES.has(this.pageKind) && this.settingsKnown() && this.deps.getSettings().enabled;
	}

	/** Post-game controls admit matchmaking only; the move executor remains disarmed. */
	mayQueue(): boolean {
		const settings = this.deps.getSettings();
		return (
			this.settingsKnown() &&
			settings.enabled &&
			settings.automation.autoQueue &&
			(PLAYED_PAGES.has(this.pageKind) ||
				this.pageKind === "live-postgame" ||
				(this.pageKind === "live-spectate" && this.state === "game-over"))
		);
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
	mayActOn(snapshot: PositionSnapshot): boolean {
		return this.mayAct() && snapshot.myColor !== null;
	}

	/**
	 * Does the snapshot agree with itself about whose move it is?
	 *
	 * `sideToMove` and the turn field of the `fen` beside it come from different ladders in the
	 * adapter, and they drive different halves of the session: `myTurn` (hence which branch runs)
	 * from the first, every search, plan and mark from the second. When they disagree one of them
	 * is wrong and nothing here can tell which, so the position is held — in **either** direction.
	 * Answering `myTurn` would recommend the opponent's move as ours (the owner's live game,
	 * 2026-09-10); answering `!myTurn` would ponder our own position and arm a premove conditioned on
	 * one of *our* moves as if it were the opponent's reply.
	 *
	 * `turnFieldOf`, not `sideToMove`, is the read: whose move it is does not depend on chess.js
	 * accepting the rest of the position, and a strict parse would answer `null` for a FEN with one
	 * malformed field — turning "I could not validate this position" into "hold every position of
	 * this game". A FEN that states no turn at all contradicts nothing and is not held: the adapter's
	 * own `sideToMove` is then the best evidence there is, and `MoveSelector` and the engine reject an
	 * unusable FEN on their own.
	 */
	selfConsistent(snapshot: PositionSnapshot): boolean {
		const fenTurn = turnFieldOf(snapshot.fen);
		return fenTurn === null || fenTurn === snapshot.sideToMove;
	}

	/** A game is on the board or about to be: the only time a target change is worth a warm. */
	gamePendingOrLive(): boolean {
		return this.state === "waiting-for-game" || isLiveState(this.state);
	}

	/** §7.4a: the target the strength layer runs at (opponent-matched when enabled). */
	targetElo(): number {
		const s = this.deps.getSettings().strength;
		const rating = this.opponentInfo?.ratingEstimate ?? null;
		if (!s.matchOpponentRating || rating === null) return s.targetElo;
		return clamp(rating + s.personaEloOffset, LIMITS.eloMin, LIMITS.eloMax);
	}

	/**
	 * The time control the per-class timing gain is keyed on — the game's, else the one the first
	 * position brought. `startGame` and `reprofile` are the only places the model's knobs are
	 * derived from it, so the pace a game is planned at cannot shift under it mid-move.
	 */
	currentTimeControl(): TimeControl | undefined {
		return this.game?.timeControl ?? this.snapshot?.timeControl;
	}

	/** Clock snapshots may precede a long opponent think; use the running clock at this instant. */
	remainingClockMs(snapshot: PositionSnapshot, color: "w" | "b"): number {
		return remainingClockMs(snapshot, color, this.now());
	}

	racePolicyFor(snapshot: PositionSnapshot): ReturnType<typeof clockRacePolicy> {
		const color = snapshot.myColor;
		if (color === null) return null;
		const tc = this.currentTimeControl();
		return clockRacePolicy({
			ownClockMs: this.remainingClockMs(snapshot, color),
			opponentClockMs: this.remainingClockMs(snapshot, color === "w" ? "b" : "w"),
			baseMs: tc?.baseMs ?? 0,
			incrementMs: tc?.incMs ?? 0,
			loneKing: isLoneKing(snapshot.fen, color),
		});
	}

	budgetUsedRatio(snapshot: PositionSnapshot): number {
		if (this.startClockMs <= 0 || snapshot.myColor === null) return 0;
		const left = snapshot.clocks[snapshot.myColor].ms;
		return clamp(1 - left / this.startClockMs, 0, 1);
	}

	historyFor(fen: string): PositionHistory {
		return this.history.historyFor(fen);
	}
}
