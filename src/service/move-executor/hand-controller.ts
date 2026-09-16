/**
 * The virtual hand (§9.3–§9.5): one execution =
 * `rest → orientation → [scan hovers …] → [preview-select …] → decision pause
 * → approach(from) → press → grabWobble → travel(to) → [hesitate] → settle →
 * release → [promotion: look-delay → approach(picker) → click] → post-drop rest`.
 * A committed move is a drag, or — `Settings.execution.inputMode`, the owner's 2026-09-11
 * reversal of the drag-only ruling — a click-click (`clickClick`): click the piece, carry the
 * pointer over with the button up, click the square. Premoves and holds are drags regardless.
 *
 * Everything runs on one absolute schedule anchored at `t0`: the exploration
 * planner fills the pre-touch window (`plan.window` phases when the timing
 * model supplies them, else `preMoveHoverMs`), the touch (approach + grab +
 * travel rescaled to `dragDurationMs` + settle) is planned right before the
 * decision pause from a fresh geometry read (§9.5), and the approach starts
 * at `t0 + thinkMs − approach − touch`, reserving a promotion picker first when needed.
 * `ExecutionResult.elapsedMs` is the time to the pawn/piece drop; `submittedAt` records the
 * final submitting release, including promotion. Post-drop rest follows outside that budget.
 *
 * Geometry is re-read and the touch re-planned right before the press, and the
 * board's rect is then watched for the whole of the held leg (`BoardRectSource`,
 * fed by the content script's `boardRect` reports): a page that reflows under a
 * drag — the debugger's infobar appearing when the user arms mid-game — would
 * otherwise leave every remaining path point in the old coordinate space and drop
 * the piece on whatever square the stale path ends over. The hand instead travels
 * back to the *origin* square in the new geometry and releases there, which
 * submits nothing, and reports `aborted: board-moved`.
 *
 * V2 gates: the `FocusGate` is consulted before the first dispatch and before
 * every subsequent one — a failing verdict skips the move with nothing (more)
 * sent, releasing a held preview first (§13.4). Real pointer input is never
 * consulted (§13.5). An abort mid-drag releases at the current point at once;
 * `pressed` tells the caller that a release may still have landed the move.
 * There is no tab-activation pre-flight of any kind.
 */

import { ALL_SQUARES, fileOf, rankOf } from "@core/chess/squares";
import { CDP, EXECUTOR } from "@core/constants/cdp";
import { SCRAMBLE_HOLD } from "@core/constants/hold";
import type { BoardGeometryReply } from "@core/constants/messages";
import { log } from "@core/logger";
import {
	CLICK,
	CLICK_MOVE,
	EXPLORATION,
	FAST_TOUCH,
	PATH,
	PROMOTION_LOOK_DELAY_MS,
	PROMOTION_PICKER_TRAVEL_SQUARES,
	SAMPLING,
} from "@core/motor/constants";
import {
	actionDurationMs,
	type ExplorationOptions,
	ExplorationPlanner,
} from "@core/motor/exploration";
import { inRect, lastPoint, pathMs, rectShiftPx, sampleRange } from "@core/motor/geometry";
import type { InputBackend } from "@core/motor/input-backend";
import { boundedMotorSpeed, withMotorSpeed } from "@core/motor/motor-profile";
import type { OpponentExplorationAction } from "@core/motor/opponent-exploration";
import {
	fastPath,
	fittsMs,
	generatePath,
	grabWobble,
	idleTremor,
} from "@core/motor/path-generator";
import { clickReleasePoint, samplePointInRect } from "@core/motor/sampling";
import type {
	BoardGeometry,
	ExecutionPlan,
	ExecutionResult,
	HandAction,
	HandState,
	HoldDirective,
	LinePreviewPlan,
	MotorProfile,
	Occupancy,
	PathPoint,
	Pt,
	Rect,
} from "@core/motor/types";
import { createRng, type Rng } from "@core/rng";
import { errorMessage } from "@core/util/errors";
import {
	AbortedError,
	defaultNow,
	defaultScheduler,
	isAbortedError,
	type Scheduler,
	sleep,
	throwIfAborted,
} from "@core/util/scheduler";
import { type BoardRectSource, boardShift } from "@service/board-watch";
import type { FocusVerdict } from "@service/focus-gate";
import type { PromoPiece, Square } from "@typedefs/game";
import type { MoveWindowBudget, TimingPlan } from "@typedefs/timing";

/** Reads board / square / promotion rects on demand (the content adapter over the game port). */
export interface GeometryProvider {
	read(
		tabId: number,
		/** Ask the adapter to wait for the promotion picker on `to` and report its rect. */
		promotion?: { piece: PromoPiece; to: Square },
		signal?: AbortSignal
	): Promise<BoardGeometryReply | null>;
}

/**
 * The from-square must still hold our piece when the adapter reports occupancy
 * (§9.3 "never double-move"): a reply that says otherwise vetoes the touch.
 */
export function positionIntact(
	reply: BoardGeometryReply | null,
	from: Square,
	to?: Square
): boolean {
	const occ = reply?.occupancy;
	if (!occ) return true;
	if (occ[from] !== "own") return false;
	return to === undefined || occ[to] !== "own";
}

export interface FocusSource {
	canExecute(tabId: number): FocusVerdict;
}

export interface OwnershipSink {
	position(tabId: number): Pt | null;
	setPosition(tabId: number, p: Pt): void;
}

export interface HandControllerDeps {
	backend: InputBackend;
	/** Shared for this game so attention can persist across moves. */
	planner?: ExplorationPlanner;
	focus: FocusSource;
	ownership: OwnershipSink;
	geometry?: GeometryProvider;
	/**
	 * The board's rect as the page last reported it (§9.5). Omitted: the hand cannot notice a
	 * reflow and behaves exactly as it did before — the press-time re-read is then the only guard.
	 */
	board?: BoardRectSource;
	rng: Rng;
	now?: () => number;
	scheduler?: Scheduler;
	onState?: (state: HandState) => void;
	/** Absolute approach start, refined from actual geometry; null once input has finished. */
	onInputDeadline?: (atMs: number | null) => void;
	/** Synchronous classification must yield, but independent review search may continue. */
	onCriticalInput?: (busy: boolean) => void;
	/** Runs after the final admission guard, immediately before the committed mouse-down. */
	onCommittedPress?: () => void;
}

/** The §8.4b phase window of a plan (Task 16's `MoveWindowBudget`). */
export type TimingWindow = MoveWindowBudget;

/** Pre-touch budget: every window phase before the approach (§8.4b item 3). */
export function preTouchMsOf(timing: TimingPlan): number {
	const w = timing.window;
	return Math.max(0, w.orientationMs + w.scanMs + w.previewMs + w.decisionMs);
}

export function fastTouch(timing: TimingPlan): boolean {
	return (
		timing.mode === "premove" ||
		(timing.features.clockRace ?? 0) > 0 ||
		(timing.features.loneKing ?? 0) > 0
	);
}

/** Square rects from the adapter's reply, derived from the board rect when it sent none. */
export function boardGeometryOf(reply: BoardGeometryReply): BoardGeometry {
	const b = reply.boardRect;
	const w = b.width / 8;
	const h = b.height / 8;
	return {
		boardRect: b,
		squareRect(sq: Square): Rect {
			const own = reply.squares?.[sq];
			if (own) return own;
			const f = reply.flipped ? 7 - fileOf(sq) : fileOf(sq);
			const r = reply.flipped ? rankOf(sq) : 7 - rankOf(sq);
			return { left: b.left + f * w, top: b.top + r * h, width: w, height: h };
		},
	};
}

function occupancyOf(reply: BoardGeometryReply): ((sq: Square) => Occupancy) | undefined {
	const occ = reply.occupancy;
	if (!occ) return undefined;
	return (sq) => occ[sq] ?? "empty";
}

/** Uniformly re-time a path to `targetMs`, never faster than the profile's speed cap. */
export function rescalePath(
	path: PathPoint[],
	targetMs: number,
	m: MotorProfile,
	from: Pt
): PathPoint[] {
	const total = pathMs(path);
	if (total <= 0 || path.length === 0) return path;
	const k = Math.min(
		EXECUTOR.travelScaleClamp[1],
		Math.max(EXECUTOR.travelScaleClamp[0], targetMs / total)
	);
	let prev = from;
	return path.map((p) => {
		const step = Math.hypot(p.x - prev.x, p.y - prev.y);
		prev = p;
		const capMs = (step / m.peakSpeedCapPxPerS) * 1000;
		return { x: p.x, y: p.y, dtMs: Math.max(p.dtMs * k, capMs) };
	});
}

/** Thrown to unwind an execution the focus gate vetoed (§13.4). */
class SkipError extends Error {
	constructor(readonly reason: string) {
		super(reason);
	}
}

/**
 * Thrown when the board's rect moved out from under a touch already in progress
 * (§9.5). Carries the rect the page reports *now*, which is what the escape
 * release is aimed with.
 */
class BoardMovedError extends Error {
	constructor(readonly live: Rect) {
		super(EXECUTOR.reasons.boardMoved);
	}
}

/**
 * Thrown when a scramble hold was given up: the piece has already been carried back to its origin
 * square and released there, so nothing was submitted.
 */
class HoldAbandonedError extends Error {
	constructor() {
		super(EXECUTOR.reasons.holdAbandoned);
	}
}

interface Phase {
	phase: string;
	startMs: number;
	endMs: number;
}

class Timeline {
	readonly entries: Phase[] = [];
	private open: { phase: string; startMs: number } | null = null;
	constructor(
		private readonly t0: number,
		private readonly now: () => number
	) {}
	begin(phase: string): void {
		this.end();
		this.open = { phase, startMs: this.now() - this.t0 };
	}
	/** A zero-length annotation that does not interrupt the open phase. */
	note(phase: string): void {
		const at = this.now() - this.t0;
		this.entries.push({ phase, startMs: at, endMs: at });
	}
	end(): void {
		if (!this.open) return;
		this.entries.push({ ...this.open, endMs: this.now() - this.t0 });
		this.open = null;
	}
}

interface Rects {
	from: Rect;
	to: Rect;
}

interface DragTouch {
	approach: PathPoint[];
	pressAt: Pt;
	preGrabMs: number;
	grabDelayMs: number;
	wobble: PathPoint[];
	travel: PathPoint[];
	drop: Pt;
	hesitate: PathPoint[];
	settleMs: number;
}

/** The committed touch: a drag, always, plus the budgets it was fitted to. */
type Touch = DragTouch & { approachMs: number; touchMs: number };

interface PromotionBudget {
	lookMs: number;
	travelMs: number;
	prePressMs: number;
	holdMs: number;
	totalMs: number;
}

/** The coordinate space a touch was planned in: what the board-reflow guard compares against. */
interface PlannedGeometry {
	board: Rect;
	flipped: boolean;
}

/** The per-point reflow check for a touch planned in `planned`, or nothing when there is no geometry. */
function guardOf(
	planned: PlannedGeometry | null,
	check: (planned: Rect) => void
): (() => void) | undefined {
	if (!planned) return undefined;
	return () => check(planned.board);
}

const sameRect = (a: Rect, b: Rect): boolean =>
	a.left === b.left && a.top === b.top && a.width === b.width && a.height === b.height;

export class HandController {
	private readonly backend: InputBackend;
	private readonly focus: FocusSource;
	private readonly ownership: OwnershipSink;
	private readonly geometry: GeometryProvider | null;
	private readonly board: BoardRectSource | null;
	private readonly rng: Rng;
	private readonly now: () => number;
	private readonly scheduler: Scheduler;
	private readonly onState: ((state: HandState) => void) | null;
	private readonly onInputDeadline: ((atMs: number | null) => void) | null;
	private readonly onCriticalInput: ((busy: boolean) => void) | null;
	private committedInput = false;
	private pressedInput = false;
	private travellingInput = false;
	private criticalInput = false;
	private inputDeadline: number | null = null;
	private readonly onCommittedPress: (() => void) | null;
	private readonly planner: ExplorationPlanner;
	private current: HandState = "rest";
	private tabId = -1;
	private signal: AbortSignal | null = null;
	/** The committed press went out (a release may land the move even on abort/skip). */
	private pressedCommitted = false;
	/** Any press went out, preview selections included (§13.2 / the retry policy's board re-check). */
	private pressedAny = false;
	/** Squares pressed in this execution besides the committed from-square (§13.2). */
	private previewed: Square[] = [];
	/** Right-button drags (line-preview arrows) dispatched in this execution — never a §13.2 press. */
	private annotations = 0;
	/** Clock time of the drop (second click / release); `null` until then. */
	private dropAt: number | null = null;
	private submittedAt: number | null = null;
	/**
	 * A scramble hold: when the hold was told to let go. The result's `startedAt` / `elapsedMs` are
	 * measured from here rather than from the run's start — the page measures its own hold time from
	 * the position's arrival, and that is the moment the release was decided on.
	 */
	private holdReleasedAt: number | null = null;

	constructor(deps: HandControllerDeps) {
		this.backend = deps.backend;
		this.planner = deps.planner ?? new ExplorationPlanner();
		this.focus = deps.focus;
		this.ownership = deps.ownership;
		this.geometry = deps.geometry ?? null;
		this.board = deps.board ?? null;
		this.rng = deps.rng;
		this.now = deps.now ?? defaultNow;
		this.scheduler = deps.scheduler ?? defaultScheduler;
		this.onState = deps.onState ?? null;
		this.onInputDeadline = deps.onInputDeadline ?? null;
		this.onCriticalInput = deps.onCriticalInput ?? null;
		this.onCommittedPress = deps.onCommittedPress ?? null;
	}

	state(): HandState {
		return this.current;
	}

	/** Run one cancellable opponent-turn bout. This path never presses or releases a button. */
	async explore(
		tabId: number,
		actions: readonly OpponentExplorationAction[],
		signal: AbortSignal,
		boardRect: Rect,
		keepGoing?: () => boolean
	): Promise<Pt> {
		if (this.signal !== null || this.backend.pressed()) throw new SkipError(EXECUTOR.reasons.dropped);
		this.tabId = tabId;
		this.signal = signal;
		const guard = () => {
			if (keepGoing && !keepGoing()) throw new AbortedError();
			this.guardBoard(boardRect);
		};
		try {
			throwIfAborted(signal);
			this.gate();
			guard();
			for (const action of actions) {
				this.setState(action.kind === "rest" || action.kind === "drift" ? "rest" : "exploring");
				if (action.path) await this.travel(action.path, guard);
				await this.pause(action.dwellMs, guard);
			}
			return this.backend.position();
		} finally {
			this.ownership.setPosition(tabId, this.backend.position());
			this.finishInput();
			this.signal = null;
			this.setState("rest");
		}
	}

	async execute(
		inputPlan: ExecutionPlan,
		timing: TimingPlan,
		signal: AbortSignal
	): Promise<ExecutionResult> {
		const plan = {
			...inputPlan,
			motorSpeed: boundedMotorSpeed(inputPlan.motorSpeed),
			motor: withMotorSpeed(inputPlan.motor, inputPlan.motorSpeed),
		};
		const t0 = this.now();
		const tl = new Timeline(t0, this.now);
		this.tabId = plan.tabId;
		this.signal = signal;
		this.pressedCommitted = false;
		this.pressedAny = false;
		this.dropAt = null;
		this.submittedAt = null;
		this.holdReleasedAt = null;
		const startedPx = this.backend.travelledPx?.() ?? 0;
		this.previewed = [];
		this.annotations = 0;
		const base = (): Pick<
			ExecutionResult,
			| "tier"
			| "endPoint"
			| "elapsedMs"
			| "startedAt"
			| "submittedAt"
			| "timeline"
			| "pressed"
			| "san"
			| "pointerOffsetPx"
			| "previewedSquares"
			| "pressedAny"
			| "annotations"
		> => ({
			tier: plan.style ?? EXECUTOR.committedTier,
			endPoint: this.backend.position(),
			elapsedMs: (this.dropAt ?? this.now()) - (this.holdReleasedAt ?? t0),
			startedAt: this.holdReleasedAt ?? t0,
			...(this.submittedAt === null ? {} : { submittedAt: this.submittedAt }),
			...(this.annotations > 0 ? { annotations: this.annotations } : {}),
			timeline: tl.entries,
			pressed: this.pressedCommitted,
			pressedAny: this.pressedAny,
			san: plan.expected.san ?? plan.expected.uci,
			pointerOffsetPx: (this.backend.travelledPx?.() ?? 0) - startedPx,
			previewedSquares: [...this.previewed],
		});
		const verdict = this.focus.canExecute(plan.tabId);
		if (!verdict.ok) {
			log.info("hand: skipped before the first dispatch", {
				tabId: plan.tabId,
				reason: verdict.reason,
			});
			this.finishInput();
			this.signal = null;
			return { ok: false, outcome: "skipped", reason: verdict.reason, attempts: 0, ...base() };
		}
		try {
			await this.run(plan, timing, t0, tl);
			tl.end();
			this.ownership.setPosition(this.tabId, this.backend.position());
			this.setState("rest");
			return { ok: true, outcome: "executed", attempts: 1, ...base() };
		} catch (error) {
			tl.end();
			await this.recover();
			this.ownership.setPosition(this.tabId, this.backend.position());
			this.setState("rest");
			const attempts = this.pressedCommitted ? 1 : 0;
			if (error instanceof SkipError) {
				log.info("hand: skipped mid-window", { tabId: plan.tabId, reason: error.reason });
				return { ok: false, outcome: "skipped", reason: error.reason, attempts, ...base() };
			}
			if (error instanceof BoardMovedError) {
				// The piece was put back on its origin square (or never pressed a second time), so
				// nothing was submitted. An abort with its own reason lets the executor's re-check
				// confirm that truthfully and the session fall back to `recommended`.
				log.warn("hand: the board moved under the touch; nothing was submitted", {
					tabId: plan.tabId,
					live: error.live,
				});
				return {
					ok: false,
					outcome: "aborted",
					reason: EXECUTOR.reasons.boardMoved,
					attempts,
					...base(),
				};
			}
			if (error instanceof HoldAbandonedError) {
				// The piece is back on its square: the abandon leg released it there before throwing.
				log.info("hand: the scramble hold was given up; the piece went back", { tabId: plan.tabId });
				return {
					ok: false,
					outcome: "aborted",
					reason: EXECUTOR.reasons.holdAbandoned,
					attempts,
					...base(),
				};
			}
			if (isAbortedError(error) || signal.aborted) {
				return {
					ok: false,
					outcome: "aborted",
					reason: EXECUTOR.reasons.aborted,
					attempts: 1,
					...base(),
				};
			}
			const message = errorMessage(error);
			log.warn("hand: execution failed", { tabId: plan.tabId, error: message });
			return {
				ok: false,
				outcome: "failed",
				reason: EXECUTOR.reasons.dispatchFailed,
				attempts: 1,
				error: message,
				...base(),
			};
		} finally {
			this.finishInput();
			this.signal = null;
		}
	}

	// ── the sequence ───────────────────────────────────────────────────────

	private async run(
		plan: ExecutionPlan,
		timing: TimingPlan,
		t0: number,
		tl: Timeline
	): Promise<void> {
		const m = plan.motor;
		let reply = plan.geometry?.reply ?? (await this.readGeometry(plan.tabId));
		let readAt = plan.geometry?.readAt ?? this.now();
		const preTouchMs = preTouchMsOf(timing);
		const promotion = plan.promotion
			? this.planPromotion(timing, m, this.resolveRects(plan, reply).to, plan.expected.premove)
			: null;
		const autoQueen = plan.promotion === "q" && timing.promotionPickerExpected === false;
		const promotionReserveMs = autoQueen ? 0 : (promotion?.totalMs ?? 0);
		// The model's motor reserve includes promotion. Spend it once: the pawn must land
		// early enough for the picker release to fit the same, immutable turn deadline.
		const touchTiming =
			promotionReserveMs > 0
				? {
						...timing,
						window: {
							...timing.window,
							approachMs: Math.max(0, timing.window.approachMs - promotionReserveMs),
						},
					}
				: timing;

		// A line preview (`LINE_PREVIEW`) is drawn inside the decision phase, so its reserve comes
		// off the exploration budget: a previewed move hovers less and annotates instead. Only on the
		// plan it was decided for — an instant retry or an urgent plan never draws.
		const linePreview =
			plan.linePreview && !fastTouch(timing) && timing.mode !== "instant" ? plan.linePreview : null;
		const exploreMs = Math.max(0, preTouchMs - (linePreview?.reserveMs ?? 0));
		const releaseAt = Math.min(timing.deadlineMs, t0 + timing.thinkMs);
		const pawnReleaseAt = releaseAt - promotionReserveMs;
		const reservedApproachAt = pawnReleaseAt - touchTiming.window.approachMs;
		this.setInputDeadline(reservedApproachAt);
		const exploreUntil = reservedApproachAt - (linePreview?.reserveMs ?? 0);

		// Exploration inside the pre-touch window (§9.3 / §9.3a); the trailing decision
		// pause is executed by the controller itself so it can absorb the touch budget.
		const actions = fastTouch(timing) ? [] : this.planExploration(plan, timing, exploreMs, reply);
		let tail = actions[actions.length - 1]?.kind === "rest" ? actions.pop() : undefined;
		// The coordinate space the exploration was planned in: a preview **presses** a real square,
		// so its legs need the same reflow guard the committed touch has (below).
		const explored = reply !== null ? { board: reply.boardRect, flipped: reply.flipped } : null;
		this.setState("orientation");
		tl.begin("orientation");
		let first = true;
		for (const a of actions) {
			this.gate();
			// Geometry reads and dispatched events consume this same move window. Optional
			// browsing must yield before it steals the reserved approach/grab/drag/release time.
			// Never start a preview we cannot finish; a held preview must always return safely.
			if (this.now() + actionDurationMs(a) > exploreUntil) break;
			if (!first) {
				this.setState("exploring");
				tl.begin(a.kind === "preview" ? "preview" : "scan");
			}
			first = false;
			await this.perform(a, m, explored, tl);
		}

		// Plan the touch from fresh geometry (§9.5) so its duration is known exactly.
		tl.begin("decision");
		if (reply === null || this.now() - readAt > EXECUTOR.geometryFreshMs) {
			reply = await this.readGeometry(plan.tabId);
			readAt = this.now();
		}
		this.guardPosition(plan, reply);
		let rects = this.resolveRects(plan, reply);
		if (linePreview && reply !== null) {
			// The arrows go out before the touch is planned, bounded by where the approach must start
			// (the approach is fitted into `window.approachMs`, so that is the provisional start), so
			// the touch is planned from wherever the last arrow left the hand.
			const moved = await this.previewLine(
				plan,
				linePreview,
				reply,
				m,
				tl,
				reservedApproachAt - linePreview.restBeforeApproachMs
			);
			// The planned rest was a path from the exploration's end point; the hand is elsewhere now.
			if (moved) tail = undefined;
		}
		let touch = this.planTouch(plan, touchTiming, rects, this.backend.position());
		const approachStartAt = Math.max(this.now(), pawnReleaseAt - touch.approachMs - touch.touchMs);
		this.setInputDeadline(approachStartAt);
		await this.decisionPause(approachStartAt, tail, m);

		// The pause may have been long, or the page may have moved the board while it ran (the
		// debugger's infobar): re-read once more and re-plan only if the geometry really changed.
		// Nothing is committed yet, so re-planning here is free and there is no continuity to break.
		const movedInPause =
			reply !== null && boardShift(this.board, plan.tabId, reply.boardRect) !== null;
		if (this.geometry && (movedInPause || this.now() - readAt > EXECUTOR.geometryFreshMs)) {
			const again = await this.readGeometry(plan.tabId);
			if (again) {
				this.guardPosition(plan, again);
				const next = this.resolveRects(plan, again);
				readAt = this.now();
				reply = again;
				if (!sameRect(next.from, rects.from) || !sameRect(next.to, rects.to)) {
					log.debug("hand: geometry changed before the press; re-planning the touch", {
						movedInPause,
					});
					rects = next;
					touch = this.planTouch(plan, touchTiming, rects, this.backend.position());
				}
			}
		}

		this.gate();
		tl.begin("approach");
		this.committedInput = true;
		this.updateCriticalInput();
		this.setState("approaching");
		// The coordinate space the rest of this touch is committed to.
		const planned = reply !== null ? { board: reply.boardRect, flipped: reply.flipped } : null;
		if (planned && this.board && this.board.rect(plan.tabId) === null)
			log.debug("hand: no board rect reported for this tab — the reflow guard is inert", {
				tabId: plan.tabId,
			});
		// The approach is ~`window.approachMs` of travel *after* the geometry re-read and before the
		// committed press. A reflow landing there would press a point that is a different square in
		// the new layout, and the escape release on the origin would then read as a drag from that
		// wrong square — a wrong move, submitted. Nothing is committed yet, so the guard here simply
		// ends the execution with nothing dispatched.
		await this.travel(
			touch.approach,
			guardOf(planned, (r) => this.guardBoard(r))
		);
		if (plan.style === "click") await this.clickClick(touch, rects, reply, m, tl, plan, planned);
		else await this.drag(touch, rects, m, tl, plan, planned);

		if (plan.promotion && promotion)
			await this.promote(
				plan,
				timing,
				plan.promotion,
				m,
				tl,
				autoQueen ? { ...promotion, lookMs: 0 } : promotion,
				releaseAt
			);
		this.finishInput();
		if (!fastTouch(timing)) await this.postDropRest(plan, reply, m, tl);
	}

	private planExploration(
		plan: ExecutionPlan,
		timing: TimingPlan,
		preTouchMs: number,
		reply: BoardGeometryReply | null
	): HandAction[] {
		const ex = plan.exploration;
		if (!ex || !reply || preTouchMs <= 0) return [{ kind: "rest", dwellMs: 0 }];
		const geo = boardGeometryOf(reply);
		const opts: ExplorationOptions = {
			...(ex.repertoire ? { repertoire: ex.repertoire } : {}),
			thinkMs: timing.thinkMs,
			mode: timing.mode,
			nReasonable: ex.nReasonable,
			myClockMs: ex.myClockMs,
			persona: ex.persona,
			previewScale: ex.previewScale,
			committed: { from: plan.from.square, to: plan.to.square },
			legalDestinations: ex.legalDestinations,
			cursor: this.backend.position(),
		};
		const occupancy = occupancyOf(reply);
		if (occupancy) opts.occupancy = occupancy;
		return this.planner.plan(preTouchMs, ex.candidates, geo, plan.motor, this.rng, opts);
	}

	/**
	 * Every pause of a preview was sampled by the planner (its budget already counts them).
	 *
	 * §9.5: a preview **presses** a real square, so its legs carry the same board-reflow guard as
	 * the committed touch. The planner guarantees that no press lands on a legal destination of
	 * whatever is selected at that moment — but only in the geometry it planned in: after a reflow
	 * the same coordinates are different squares, the press/deselect pair can become a legal move,
	 * and a held preview press released where a stale path ended is a `mousedown` on one square and
	 * a `mouseup` on another — a submitted move. Worse than the committed case, because
	 * `pressedCommitted` stays false, so nothing re-checks the board afterwards and `guardPosition`
	 * would report a *skip* while a move had in fact been played.
	 *
	 * A plain hover is deliberately left unguarded: nothing is pressed, so the worst a stale path
	 * can do is hover over the wrong squares, and the touch is re-planned from fresh geometry
	 * immediately afterwards — aborting there would throw away a move window for a cosmetic loss.
	 */
	private async perform(
		a: HandAction,
		m: MotorProfile,
		planned: PlannedGeometry | null,
		tl: Timeline
	): Promise<void> {
		if (a.kind === "preview" && a.preview) {
			const pv = a.preview;
			const guard = guardOf(planned, (r) => this.guardBoard(r));
			// Outside the try: nothing is held yet, so a reflow caught here needs no escape.
			await this.travel(pv.approach, guard);
			await this.pause(pv.prePressMs, guard);
			await this.press(pv.press, false, guard);
			// §13.2 counts *pieces* the page saw selected, so the record is written once the press is
			// out — not before, where an aborted approach would claim a selection that never happened.
			this.previewed.push(pv.piece);
			try {
				await this.pause(pv.holdMs, guard);
				if (pv.dragPath) {
					await this.pause(pv.grabDelayMs ?? sampleRange(m.grabDelayMs, this.rng), guard);
					await this.travel(pv.dragPath, guard);
					await this.pause(pv.settleMs ?? sampleRange(m.releaseSettleMs, this.rng), guard);
				}
				// The last look before the button comes up.
				guard?.();
			} catch (error) {
				if (error instanceof BoardMovedError)
					await this.releaseOnSquare(pv.piece, pv.pieceRect, error.live, planned, m, tl);
				throw error;
			}
			await this.release(pv.release);
			await this.travel(pv.hoverPath, guard);
			await this.pause(pv.dwellMs, guard);
			const d = pv.deselect;
			if (d) {
				await this.travel(d.path, guard);
				await this.pause(d.prePressMs, guard);
				await this.press(d.press, false, guard);
				// The resolving click counts as a selection only in the `switch-to-idle` form, where
				// the square it clicks is an own piece (an empty / enemy square only clears one).
				if (d.occupancy === "own") this.previewed.push(d.square);
				try {
					await this.pause(d.holdMs, guard);
					guard?.();
				} catch (error) {
					if (error instanceof BoardMovedError)
						await this.releaseOnSquare(d.square, null, error.live, planned, m, tl);
					throw error;
				}
				await this.release(d.release);
			}
			return;
		}
		if (a.path) await this.travel(a.path);
		if (a.dwellMs > 0) await this.pause(a.dwellMs);
	}

	private async decisionPause(
		untilAt: number,
		tail: HandAction | undefined,
		m: MotorProfile
	): Promise<void> {
		const restMs = untilAt - this.now();
		if (restMs <= 0) return;
		const tremor =
			tail?.path && pathMs(tail.path) <= restMs
				? tail.path
				: idleTremor(this.backend.position(), restMs * EXPLORATION.restTremorFrac, m, this.rng);
		await this.travel(tremor);
		await this.sleepUntil(untilAt);
	}

	/**
	 * Fit the approach into what is left of `window.approachMs` after the touch
	 * itself (§8.4b item 3), exactly the way the drag leg is fitted to
	 * `dragDurationMs`: `rescalePath` re-times the path uniformly, clamped to
	 * `EXECUTOR.travelScaleClamp` and never faster than the profile's peak-speed
	 * cap. Where the cap makes the budget unreachable the move still overruns —
	 * the hand is never made to teleport — and that is logged.
	 */
	private fitApproach(
		approach: PathPoint[],
		touchMs: number,
		timing: TimingPlan,
		m: MotorProfile,
		cursor: Pt
	): { path: PathPoint[]; ms: number } {
		const natural = pathMs(approach);
		const budget = timing.window.approachMs - touchMs;
		if (!(budget > 0)) {
			// No room at all: run the approach as fast as the profile allows and accept the overrun.
			const path = rescalePath(approach, 0, m, cursor);
			const ms = pathMs(path);
			log.debug("hand: approach budget exhausted by the touch", {
				approachMs: timing.window.approachMs,
				touchMs,
				naturalMs: natural,
				fittedMs: ms,
			});
			return { path, ms };
		}
		const path = rescalePath(approach, budget, m, cursor);
		const ms = pathMs(path);
		if (ms > budget + EXECUTOR.approachFitToleranceMs)
			log.debug("hand: approach cannot be compressed to its budget (speed cap)", {
				budgetMs: budget,
				naturalMs: natural,
				fittedMs: ms,
			});
		return { path, ms };
	}

	private planTouch(plan: ExecutionPlan, timing: TimingPlan, rects: Rects, cursor: Pt): Touch {
		const m = plan.motor;
		const rng = this.rng;
		const press = samplePointInRect(
			rects.from,
			SAMPLING.press.sigmaFrac,
			SAMPLING.press.innerFrac,
			rng
		);
		// Premove timing describes reaction/queue latency, not a license to compress pointer travel.
		// Entry and reactive fallback both use the normal generated approach and held drag below.
		if (fastTouch(timing) && timing.mode !== "premove" && !plan.expected.premove) {
			const drop = samplePointInRect(
				rects.to,
				SAMPLING.release.sigmaFrac,
				SAMPLING.release.innerFrac,
				rng
			);
			const available =
				timing.window.approachMs > 0 ? timing.window.approachMs : FAST_TOUCH.minBudgetMs;
			// Comfortable own clock: spend the sampled reply window on motion, rather than
			// waiting before an identical 300 ms gesture. Our clock emergencies keep their cap.
			const budget = Math.max(
				FAST_TOUCH.gestureFloorMs,
				(timing.features.opponentOnlyRace ?? 0) > 0
					? available
					: Math.min(FAST_TOUCH.maxBudgetMs, available)
			);
			const approachDistance = Math.hypot(press.x - cursor.x, press.y - cursor.y);
			const dragDistance = Math.hypot(drop.x - press.x, drop.y - press.y);
			const fraction = Math.max(
				FAST_TOUCH.minLegFrac,
				Math.min(FAST_TOUCH.maxLegFrac, approachDistance / (approachDistance + dragDistance || 1))
			);
			const approach = fastPath(cursor, press, budget * fraction);
			const pressAt = lastPoint(approach, press);
			const travel = fastPath(pressAt, drop, budget * (1 - fraction));
			return {
				approach,
				pressAt,
				preGrabMs: 0,
				grabDelayMs: 0,
				wobble: [],
				travel,
				drop,
				hesitate: [],
				settleMs: 0,
				approachMs: pathMs(approach),
				touchMs: pathMs(travel),
			};
		}
		const speed = plan.motorSpeed ?? 1;
		const motorTiming = {
			...timing,
			dragDurationMs: timing.dragDurationMs / speed,
			window: { ...timing.window, approachMs: timing.window.approachMs / speed },
		};
		const approachRaw = generatePath(cursor, press, rects.from, m, rng);
		const pressAt = lastPoint(approachRaw, press);
		const preGrabMs = sampleRange(CLICK.preGrabPauseMs, rng);
		const grabDelayMs = sampleRange(m.grabDelayMs, rng);
		const wobble = grabWobble(pressAt, m, rng);
		const wobbleEnd = lastPoint(wobble, pressAt);
		const drop = samplePointInRect(
			rects.to,
			SAMPLING.release.sigmaFrac,
			SAMPLING.release.innerFrac,
			rng
		);
		const raw = generatePath(wobbleEnd, drop, rects.to, m, rng);
		const travel = rescalePath(
			raw,
			Math.max(EXECUTOR.minTravelMs, motorTiming.dragDurationMs),
			m,
			wobbleEnd
		);
		const travelEnd = lastPoint(travel, drop);
		const hesitate = rng.chance(m.hesitationProb)
			? grabWobble(travelEnd, m, rng).map((p) => ({
					...p,
					dtMs: sampleRange(PATH.hesitationWobbleDtMs, rng),
				}))
			: [];
		const settleMs = sampleRange(m.releaseSettleMs, rng);
		const touchMs =
			preGrabMs + grabDelayMs + pathMs(wobble) + pathMs(travel) + pathMs(hesitate) + settleMs;
		const fitted = this.fitApproach(approachRaw, touchMs, motorTiming, m, cursor);
		return {
			approach: fitted.path,
			pressAt,
			preGrabMs,
			grabDelayMs,
			wobble,
			travel,
			drop,
			hesitate,
			settleMs,
			approachMs: fitted.ms,
			touchMs,
		};
	}

	private async drag(
		t: DragTouch,
		rects: Rects,
		m: MotorProfile,
		tl: Timeline,
		plan: ExecutionPlan,
		planned: PlannedGeometry | null
	): Promise<void> {
		const guard = guardOf(planned, (r) => this.guardBoard(r));
		tl.begin("grab");
		this.setState("grabbing");
		// Still outside the `try`: nothing is committed until the press, so a reflow caught here needs
		// no escape release — it ends the execution with `pressed: false`.
		await this.pause(t.preGrabMs, guard);
		await this.press(t.pressAt, true, guard);
		try {
			await this.pause(t.grabDelayMs, guard);
			await this.travel(t.wobble, guard);
			tl.begin("drag");
			this.setState("dragging");
			await this.travel(t.travel, guard);
			if (t.hesitate.length > 0) await this.travel(t.hesitate, guard);
			tl.begin("drop");
			this.setState("dropping");
			await this.pause(t.settleMs, guard);
			if (!inRect(this.backend.position(), rects.to, PATH.targetPadPx)) {
				tl.begin("correct");
				this.setState("correcting");
				await this.travel(generatePath(this.backend.position(), t.drop, rects.to, m, this.rng), guard);
				tl.begin("drop");
				this.setState("dropping");
			}
			// The last look before the move is submitted: a reflow between the settle and the release
			// is the one that would drop the piece on the wrong square with nothing else noticing.
			guard?.();
			if (plan.hold) {
				// The scramble hold: the piece stays over its destination, button down, until the
				// opponent's move decides its fate. No focus gate and no abort inside the wait itself —
				// both are answered by *abandon*, which carries the piece home before anything else can
				// release it where it is (`recover()` would, and that is the drop this exists to avoid).
				tl.begin("hold");
				this.setState("holding");
				const decision = await this.holdUntil(plan.hold);
				if (decision === "abandon") {
					await this.returnToOrigin(plan, planned, m, tl);
					throw new HoldAbandonedError();
				}
				this.holdReleasedAt = this.now();
				tl.begin("drop");
				this.setState("dropping");
				// Seeing their move and letting go are two events, even for a hand already holding the
				// piece over its square. Ungated and unsignalled like the abandon leg: a cancel landing
				// in this pause must not release the piece where it is through `recover()`.
				const [reactMin, reactMax] = SCRAMBLE_HOLD.releaseReactionMs;
				const skew = this.rng.next() ** 2;
				await sleep(reactMin + (reactMax - reactMin) * skew, this.scheduler);
			}
		} catch (error) {
			if (error instanceof BoardMovedError) {
				await this.releaseOnOrigin(plan, error.live, planned?.flipped ?? false, m, tl);
			}
			throw error;
		}
		await this.release(this.backend.position());
		this.dropAt = this.now();
		this.submittedAt = this.dropAt;
	}

	/** The hold's wait: the directive's decision, or `abandon` the moment the run is cancelled. */
	private holdUntil(hold: HoldDirective): Promise<"release" | "abandon"> {
		const signal = this.signal;
		if (!signal) return hold.decide();
		if (signal.aborted) return Promise.resolve("abandon");
		return new Promise((resolve) => {
			const onAbort = (): void => resolve("abandon");
			signal.addEventListener("abort", onAbort, { once: true });
			hold.decide().then(
				(decision) => {
					signal.removeEventListener("abort", onAbort);
					resolve(decision);
				},
				() => {
					signal.removeEventListener("abort", onAbort);
					resolve("abandon");
				}
			);
		});
	}

	/**
	 * The abandon leg of a scramble hold: carry the held piece back to its origin square in the
	 * geometry the page has now and let go there. Same primitive as the reflow escape — ungated,
	 * unsignalled, a generated path — for the same reason: the button is down and this must finish.
	 */
	private async returnToOrigin(
		plan: ExecutionPlan,
		planned: PlannedGeometry | null,
		m: MotorProfile,
		tl: Timeline
	): Promise<void> {
		if (planned) {
			const live = boardShift(this.board, this.tabId, planned.board) ?? planned.board;
			await this.releaseOnSquare(
				plan.from.square,
				plan.from.rect,
				live,
				{ board: live, flipped: planned.flipped },
				m,
				tl,
				EXECUTOR.timelineNotes.holdAbandoned
			);
			return;
		}
		tl.note(EXECUTOR.timelineNotes.holdAbandoned);
		tl.begin("correct");
		this.setState("correcting");
		const target = { x: plan.from.x, y: plan.from.y };
		const path = generatePath(this.backend.position(), target, plan.from.rect, m, this.rng);
		await this.escapeTravel(path);
		await this.release(lastPoint(path, target));
	}

	/**
	 * Click-to-move (`Settings.execution.inputMode`): click the piece, let go, carry the pointer over
	 * with the button up, click the square. The first click is the committed press — it selects the
	 * piece on the site — and the second is what submits, so between the two a selection is
	 * *standing*, which §13.7 item 3 forbids leaving behind: any exit from that stretch (a veto, an
	 * abort, a reflow) first clicks an idle square to clear it, ungated and unsignalled like the drag's
	 * escape release, and only then unwinds. The same touch plan as the drag (approach, press point,
	 * travel, drop point, hesitation, settle) so the timing model's window fits it unchanged.
	 */
	private async clickClick(
		t: DragTouch,
		rects: Rects,
		reply: BoardGeometryReply | null,
		m: MotorProfile,
		tl: Timeline,
		plan: ExecutionPlan,
		planned: PlannedGeometry | null
	): Promise<void> {
		const guard = guardOf(planned, (r) => this.guardBoard(r));
		tl.begin("grab");
		this.setState("grabbing");
		await this.pause(t.preGrabMs, guard);
		await this.press(t.pressAt, true, guard);
		await this.pause(sampleRange(m.pressHoldMs, this.rng));
		await this.release(clickReleasePoint(t.pressAt, this.rng));
		try {
			await this.pause(sampleRange(CLICK_MOVE.interClickGapMs, this.rng), guard);
			tl.begin("drag");
			this.setState("dragging");
			await this.travel(t.travel, guard);
			if (t.hesitate.length > 0) await this.travel(t.hesitate, guard);
			tl.begin("drop");
			this.setState("dropping");
			await this.pause(t.settleMs, guard);
			if (!inRect(this.backend.position(), rects.to, PATH.targetPadPx)) {
				tl.begin("correct");
				this.setState("correcting");
				await this.travel(generatePath(this.backend.position(), t.drop, rects.to, m, this.rng), guard);
				tl.begin("drop");
				this.setState("dropping");
			}
			guard?.();
			await this.pause(sampleRange(CLICK.prePressPauseMs, this.rng), guard);
		} catch (error) {
			await this.clearSelection(plan, reply, m, tl);
			throw error;
		}
		// The submitting click: from here the move is the site's, exactly as a drag's release is.
		const at = this.backend.position();
		await this.press(at, false);
		this.dropAt = this.now();
		this.submittedAt = this.dropAt;
		await sleep(sampleRange(m.pressHoldMs, this.rng), this.scheduler);
		await this.release(clickReleasePoint(at, this.rng));
	}

	/**
	 * A click-click that could not reach its second click has left the piece selected on the site.
	 * Click an idle square — empty, and not a legal destination of the selected piece, so the click
	 * can submit nothing (the §9.3a preview's own deselect) — in the geometry the page has now.
	 * Without occupancy to choose by, the origin square itself is clicked, which the site reads as
	 * toggling the selection off.
	 */
	private async clearSelection(
		plan: ExecutionPlan,
		reply: BoardGeometryReply | null,
		m: MotorProfile,
		tl: Timeline
	): Promise<void> {
		tl.note(EXECUTOR.timelineNotes.selectionCleared);
		tl.begin("correct");
		this.setState("correcting");
		let live = reply;
		try {
			live = (await this.readGeometry(plan.tabId)) ?? reply;
		} catch {
			// The geometry read failing is no reason to leave the selection standing.
		}
		const geo = live ? boardGeometryOf(live) : null;
		const occupancy = live?.occupancy;
		const legal = new Set(plan.exploration?.legalDestinations(plan.from.square) ?? []);
		let square: Square = plan.from.square;
		if (occupancy && geo) {
			const idle = ALL_SQUARES.filter(
				(sq) => occupancy[sq] === "empty" && !legal.has(sq) && sq !== plan.to.square
			);
			const pick = idle[this.rng.int(0, Math.max(0, idle.length - 1))];
			if (pick !== undefined) square = pick;
		}
		const rect = geo ? geo.squareRect(square) : plan.from.rect;
		const target = samplePointInRect(
			rect,
			SAMPLING.press.sigmaFrac,
			SAMPLING.press.innerFrac,
			this.rng
		);
		const path = generatePath(this.backend.position(), target, rect, m, this.rng);
		await this.escapeTravel(path);
		const at = lastPoint(path, target);
		log.info("hand: clearing the standing selection after an interrupted click-click", {
			tabId: this.tabId,
			square,
		});
		await this.backend.press(at, this.now());
		this.pressedAny = true;
		await sleep(sampleRange(m.pressHoldMs, this.rng), this.scheduler);
		await this.release(clickReleasePoint(at, this.rng));
	}

	/**
	 * The square of a random piece — ours or theirs, never the one just moved — weighted toward the
	 * centre (`EXECUTOR.postDropCentreBias`), in the geometry the page reported. `null` without
	 * occupancy or with no other piece on the board.
	 */
	private restPiece(reply: BoardGeometryReply, avoid: Square): Rect | null {
		const occupancy = reply.occupancy;
		if (!occupancy) return null;
		const squares: Square[] = [];
		const weights: number[] = [];
		for (const sq of ALL_SQUARES) {
			const occ = occupancy[sq];
			if (sq === avoid || (occ !== "own" && occ !== "enemy")) continue;
			// Chebyshev distance from the board's centre: 0.5 for the four middle squares, 3.5 at the rim.
			const fromCentre = Math.max(Math.abs(fileOf(sq) - 3.5), Math.abs(rankOf(sq) - 3.5));
			squares.push(sq);
			weights.push((4 - fromCentre) ** EXECUTOR.postDropCentreBias);
		}
		if (squares.length === 0) return null;
		return boardGeometryOf(reply).squareRect(this.rng.weighted(squares, weights));
	}

	/**
	 * §9.5: has the page moved the board since the touch was planned? A shift beyond
	 * `EXECUTOR.boardMoveTolerancePx` means every remaining point of the path — and the release
	 * above all — is in a coordinate space the page has left behind.
	 */
	private guardBoard(planned: Rect): void {
		const live = boardShift(this.board, this.tabId, planned);
		if (live === null) return;
		throw new BoardMovedError(live);
	}

	/**
	 * Put the held piece back where it came from, in the geometry the page has *now*, and let go
	 * there: a release on the origin square submits no move on either renderer, which is always
	 * better than a move to the wrong square. The return leg is a generated path, so §13.5's
	 * pointer continuity and the profile's peak-speed cap both still hold — the hand never
	 * teleports. It is deliberately ungated and unsignalled: a focus veto or a cancel arriving now
	 * would leave the button held over whatever square the stale path reached, which is the very
	 * outcome this exists to prevent.
	 */
	private async releaseOnOrigin(
		plan: ExecutionPlan,
		live: Rect,
		flipped: boolean,
		m: MotorProfile,
		tl: Timeline
	): Promise<void> {
		await this.releaseOnSquare(
			plan.from.square,
			plan.from.rect,
			live,
			{ board: live, flipped },
			m,
			tl
		);
	}

	/**
	 * The escape above, for whichever square the held press landed on — the committed origin or a
	 * preview's own piece. `plannedRect` is only for the log line.
	 */
	private async releaseOnSquare(
		square: Square,
		plannedRect: Rect | null,
		live: Rect,
		planned: PlannedGeometry | null,
		m: MotorProfile,
		tl: Timeline,
		note: string = EXECUTOR.timelineNotes.boardMoved
	): Promise<void> {
		tl.note(note);
		tl.begin("correct");
		this.setState("correcting");
		const origin = boardGeometryOf({
			boardRect: live,
			flipped: planned?.flipped ?? false,
		}).squareRect(square);
		const target = samplePointInRect(
			origin,
			SAMPLING.release.sigmaFrac,
			SAMPLING.release.innerFrac,
			this.rng
		);
		const path = generatePath(this.backend.position(), target, origin, m, this.rng);
		log.info("hand: releasing on the pressed square after a reflow", {
			tabId: this.tabId,
			square,
			shiftPx: plannedRect ? Math.round(rectShiftPx(plannedRect, origin)) : null,
		});
		await this.escapeTravel(path);
		await this.release(lastPoint(path, target));
	}

	/** Reserve the picker before scheduling the pawn drop; sample its pauses only once. */
	private planPromotion(
		timing: TimingPlan,
		m: MotorProfile,
		to: Rect,
		premove: boolean
	): PromotionBudget {
		const urgent = fastTouch(timing);
		const lookMs = urgent
			? 0
			: (timing.promotionDelayMs ??
				sampleRange(m.lookDelayMs[1] > 0 ? m.lookDelayMs : PROMOTION_LOOK_DELAY_MS, this.rng));
		const travelMs =
			urgent && timing.mode !== "premove" && !premove
				? sampleRange(FAST_TOUCH.promotionTravelMs, this.rng)
				: fittsMs(
						Math.max(to.width, to.height) * PROMOTION_PICKER_TRAVEL_SQUARES,
						Math.min(to.width, to.height),
						m,
						this.rng
					);
		const prePressMs = urgent ? 0 : sampleRange(CLICK.prePressPauseMs, this.rng);
		const holdMs = urgent ? 0 : sampleRange(m.pressHoldMs, this.rng);
		return { lookMs, travelMs, prePressMs, holdMs, totalMs: lookMs + travelMs + prePressMs + holdMs };
	}

	/**
	 * Promotion (§9.5): look at the picker, then click the piece. The picker rect
	 * is read through the same guarded geometry path as the board; when the read
	 * fails or the picker never appears (auto-queen) the drag stands as it is and
	 * verification decides the outcome — a failed read is never a failed move.
	 */
	private async promote(
		plan: ExecutionPlan,
		timing: TimingPlan,
		piece: PromoPiece,
		m: MotorProfile,
		tl: Timeline,
		budget: PromotionBudget,
		releaseAt: number
	): Promise<void> {
		tl.begin("promote");
		this.setState("promoting");
		await this.pause(budget.lookMs);
		const reply = await this.readGeometry(plan.tabId, { piece, to: plan.to.square });
		if (reply === null) tl.note(EXECUTOR.timelineNotes.promotionGeometryUnavailable);
		const rect = reply?.promotion ?? null;
		if (!rect) {
			// The picker never appeared (auto-queen preference) or could not be read.
			log.debug("hand: no promotion picker rect; leaving the drop as it is", {
				tabId: plan.tabId,
				read: reply !== null,
			});
			return;
		}
		this.gate();
		const target = samplePointInRect(
			rect,
			SAMPLING.promotion.sigmaFrac,
			SAMPLING.promotion.innerFrac,
			this.rng
		);
		const urgent = fastTouch(timing);
		const from = this.backend.position();
		const raw =
			urgent && timing.mode !== "premove" && !plan.expected.premove
				? fastPath(from, target, budget.travelMs)
				: generatePath(from, target, rect, m, this.rng);
		const available = Math.max(0, releaseAt - this.now() - budget.prePressMs - budget.holdMs);
		const path = rescalePath(raw, Math.min(pathMs(raw), available), m, from);
		const planned = reply ? { board: reply.boardRect, flipped: reply.flipped } : null;
		const guard = guardOf(planned, (r) => this.guardBoard(r));
		await this.travel(path, guard);
		// Consume spare reserved time here. A late geometry read never moves the deadline;
		// mandatory physical motion may overrun, and submittedAt records that actual release.
		await this.pause(Math.max(budget.prePressMs, releaseAt - this.now() - budget.holdMs), guard);
		const pressAt = lastPoint(path, target);
		await this.press(pressAt, false, guard);
		await this.pause(budget.holdMs, guard);
		await this.release(clickReleasePoint(pressAt, this.rng));
		this.submittedAt = this.now();
	}

	/**
	 * Post-drop rest (§9.4, owner 2026-09-11): a moment on the dropped piece, then a quick decision.
	 * Either the hand goes straight to pondering — the execution ends and the opponent-turn
	 * exploration takes over — or it first walks to a random piece, either colour, drawn toward the
	 * centre of the board, and rests there briefly. The move is complete by now, so a gate veto or an
	 * abort here merely ends the walk where it is. Without occupancy there is no piece to rest on and
	 * the decision is "ponder".
	 */
	private async postDropRest(
		plan: ExecutionPlan,
		reply: BoardGeometryReply | null,
		m: MotorProfile,
		tl: Timeline
	): Promise<void> {
		tl.begin("rest");
		this.setState("rest");
		try {
			await this.pause(sampleRange(EXECUTOR.postDropLingerMs, this.rng));
			if (!this.rng.chance(EXECUTOR.postDropRestProb)) return;
			const rest = reply ? this.restPiece(reply, plan.to.square) : null;
			if (!rest) return;
			const target = samplePointInRect(
				rest,
				SAMPLING.press.sigmaFrac,
				SAMPLING.press.innerFrac,
				this.rng
			);
			await this.travel(generatePath(this.backend.position(), target, rest, m, this.rng));
			const restMs = sampleRange(EXECUTOR.postDropRestMs, this.rng);
			const untilAt = this.now() + restMs;
			const drift = idleTremor(this.backend.position(), restMs, m, this.rng);
			await this.travel(drift);
			await this.sleepUntil(untilAt);
		} catch (error) {
			// Whatever was dispatched before the cut is where the hand is now.
			this.ownership.setPosition(this.tabId, this.backend.position());
			if (error instanceof SkipError || isAbortedError(error)) {
				log.debug("hand: post-drop rest cut short", { reason: errorMessage(error) });
				return;
			}
			throw error;
		}
	}

	// ── primitives ────────────────────────────────────────────────────────

	private async readGeometry(
		tabId: number,
		promotion?: { piece: PromoPiece; to: Square }
	): Promise<BoardGeometryReply | null> {
		if (!this.geometry) return null;
		try {
			return await this.geometry.read(tabId, promotion, this.signal ?? undefined);
		} catch (error) {
			log.debug("hand: geometry read failed", {
				tabId,
				promotion: promotion?.piece ?? null,
				error: errorMessage(error),
			});
			return null;
		}
	}

	/** Skip (never dispatch) when the adapter's occupancy says the piece is no longer on `from`. */
	private guardPosition(plan: ExecutionPlan, reply: BoardGeometryReply | null): void {
		// Fix F: `expected.premove` means the move is being *entered as a premove*, in the position
		// before the opponent's reply — where its destination is routinely still ours (a recapture
		// is aimed at the piece they are about to take). The from-square is still guarded.
		const to = plan.expected.premove ? undefined : plan.to.square;
		if (positionIntact(reply, plan.from.square, to)) return;
		log.info("hand: from-square no longer holds our piece; skipping", {
			tabId: plan.tabId,
			from: plan.from.square,
		});
		throw new SkipError(EXECUTOR.reasons.positionChanged);
	}

	private resolveRects(plan: ExecutionPlan, reply: BoardGeometryReply | null): Rects {
		if (!reply) return { from: plan.from.rect, to: plan.to.rect };
		const geo = boardGeometryOf(reply);
		return { from: geo.squareRect(plan.from.square), to: geo.squareRect(plan.to.square) };
	}

	/** The backend's absolute-time travel; the gate (and `guard`, if any) runs before every point (§9.6a). */
	private async travel(path: readonly PathPoint[], guard?: () => void): Promise<void> {
		if (path.length === 0) return;
		this.travellingInput = true;
		this.updateCriticalInput();
		try {
			await this.backend.travel(path, this.signal ?? undefined, () => {
				this.gate();
				guard?.();
			});
		} finally {
			this.ownership.setPosition(this.tabId, this.backend.position());
			this.travellingInput = false;
			this.updateCriticalInput();
		}
	}

	/**
	 * The return leg of a reflow escape: no gate, no abort signal. The button is held, so this
	 * travel must finish and be followed by the release whatever else has happened.
	 */
	private async escapeTravel(path: readonly PathPoint[]): Promise<void> {
		if (path.length === 0) return;
		this.travellingInput = true;
		this.updateCriticalInput();
		try {
			await this.backend.travel(path);
		} finally {
			this.ownership.setPosition(this.tabId, this.backend.position());
			this.travellingInput = false;
			this.updateCriticalInput();
		}
	}

	private async press(p: Pt, committed = false, guard?: () => void): Promise<void> {
		throwIfAborted(this.signal ?? undefined);
		this.gate();
		this.pressedInput = true;
		this.updateCriticalInput();
		await this.backend.press(p, this.now(), this.signal ?? undefined, () => {
			this.gate();
			guard?.();
			if (committed) this.onCommittedPress?.();
		});
		this.pressedAny = true;
		if (committed) this.pressedCommitted = true;
		this.ownership.setPosition(this.tabId, this.backend.position());
	}

	private async release(p: Pt): Promise<void> {
		await this.backend.release(p, this.now());
		this.pressedInput = false;
		this.updateCriticalInput();
		this.ownership.setPosition(this.tabId, this.backend.position());
	}

	private async pause(ms: number, guard?: () => void): Promise<void> {
		if (ms > 0) {
			// A stationary wait is usable only until the next action's input lead. Keep the
			// original committed-approach boundary if it is earlier than this local pause.
			this.onInputDeadline?.(Math.min(this.inputDeadline ?? Infinity, this.now() + ms));
			try {
				await sleep(ms, this.scheduler, this.signal ?? undefined);
			} finally {
				this.onInputDeadline?.(this.inputDeadline);
			}
		}
		throwIfAborted(this.signal ?? undefined);
		this.gate();
		guard?.();
	}

	private async sleepUntil(atMs: number): Promise<void> {
		await this.pause(atMs - this.now());
	}

	private gate(): void {
		const verdict = this.focus.canExecute(this.tabId);
		if (!verdict.ok) throw new SkipError(verdict.reason);
	}

	/**
	 * The line preview (`LINE_PREVIEW`, `src/core/motor/line-preview.ts`): for each ply of the
	 * planned line, travel to the from-square, press the **right** button, drag to the to-square on
	 * the same humanised path a left drag uses, release, pause; chess.com draws an arrow per drag
	 * and clears them all on the move's own left press. Every travel and pause is gated and guarded
	 * exactly like the rest of the execution. `untilAt` bounds the gesture: an arrow whose estimate
	 * would run past it is not started, so the approach starts on time whatever the paths came to.
	 *
	 * Nothing here can move a piece, so the exits are gentle: a reflow (`BoardMovedError`) or the
	 * time bound simply ends the preview and the move proceeds (the touch is planned afterwards,
	 * from fresh geometry when the board moved); a focus veto or a cancel releases the right button
	 * where the pointer is — an arrow to nowhere is harmless — and unwinds the execution as it
	 * would anywhere else. The right button is released in a `finally`, so it is never left held.
	 *
	 * Returns whether the hand moved at all (the planned rest path is stale if it did).
	 */
	private async previewLine(
		plan: ExecutionPlan,
		preview: LinePreviewPlan,
		reply: BoardGeometryReply,
		m: MotorProfile,
		tl: Timeline,
		untilAt: number
	): Promise<boolean> {
		const rng = createRng(preview.seed);
		const geo = boardGeometryOf(reply);
		const planned: PlannedGeometry = { board: reply.boardRect, flipped: reply.flipped };
		const guard = guardOf(planned, (r) => this.guardBoard(r));
		let moved = false;
		tl.begin(EXECUTOR.timelinePhases.linePreview);
		this.setState("exploring");
		try {
			lines: for (const line of preview.lines) {
				if (this.now() + line.estimateMs > untilAt) break;
				if (line.beforeMs > 0) await this.pause(line.beforeMs, guard);
				for (const arrow of line.arrows) {
					if (this.now() + arrow.estimateMs > untilAt) break lines;
					const fromRect = geo.squareRect(arrow.from);
					const toRect = geo.squareRect(arrow.to);
					const press = samplePointInRect(
						fromRect,
						SAMPLING.press.sigmaFrac,
						SAMPLING.press.innerFrac,
						rng
					);
					const approach = generatePath(this.backend.position(), press, fromRect, m, rng);
					await this.travel(approach, guard);
					moved = true;
					await this.pause(arrow.prePressMs, guard);
					const pressAt = lastPoint(approach, press);
					await this.pressRight(pressAt, guard);
					try {
						await this.pause(arrow.pressToDragMs, guard);
						const release = samplePointInRect(
							toRect,
							SAMPLING.release.sigmaFrac,
							SAMPLING.release.innerFrac,
							rng
						);
						await this.travel(generatePath(pressAt, release, toRect, m, rng), guard);
						await this.pause(arrow.settleMs, guard);
						guard?.();
					} finally {
						await this.releaseRight(this.backend.position());
					}
					this.annotations += 1;
					tl.note(EXECUTOR.timelineNotes.arrow);
					await this.pause(Math.min(arrow.afterMs, Math.max(0, untilAt - this.now())), guard);
				}
			}
		} catch (error) {
			if (!(error instanceof BoardMovedError)) throw error;
			// The board moved under an arrow: the arrow (if any) is already released, nothing was
			// submitted, and the touch is re-planned from the geometry the page has now.
			log.debug("hand: the board moved during the line preview; the move proceeds", {
				tabId: plan.tabId,
				arrows: this.annotations,
			});
		} finally {
			tl.begin("decision");
		}
		return moved;
	}

	/** A right-button press: a line-preview arrow's start. Gated like every press, never a §13.2 press. */
	private async pressRight(p: Pt, guard?: () => void): Promise<void> {
		throwIfAborted(this.signal ?? undefined);
		this.gate();
		this.pressedInput = true;
		this.updateCriticalInput();
		await this.backend.press(
			p,
			this.now(),
			this.signal ?? undefined,
			() => {
				this.gate();
				guard?.();
			},
			"right"
		);
		this.ownership.setPosition(this.tabId, this.backend.position());
	}

	private async releaseRight(p: Pt): Promise<void> {
		await this.backend.release(p, this.now(), "right");
		this.pressedInput = false;
		this.updateCriticalInput();
		this.ownership.setPosition(this.tabId, this.backend.position());
	}

	/** Every button the backend still holds (`CDP.mouse` bits). */
	private heldButtons(): number {
		const mask = this.backend.pressedButtons?.();
		if (mask !== undefined) return mask;
		return this.backend.pressed() ? CDP.mouse.leftButtons : CDP.mouse.noButtons;
	}

	/** Never leave a button held: an abort or skip mid-drag drops the piece where it is. */
	private async recover(): Promise<void> {
		const held = this.heldButtons();
		if ((held & CDP.mouse.rightButtons) !== 0) {
			// A line-preview arrow cut short: let go where the pointer is (an arrow to nowhere).
			try {
				await this.releaseRight(this.backend.position());
			} catch (error) {
				log.warn("hand: right-button release after abort failed", {
					tabId: this.tabId,
					error: errorMessage(error),
				});
			}
		}
		if (!this.backend.pressed()) return;
		try {
			await this.release(this.backend.position());
			// This release can complete a drag or a held promotion-picker click. Only a
			// subsequent successful verification turns this timestamp into an observation.
			if (this.pressedCommitted) this.submittedAt = this.now();
		} catch (error) {
			log.warn("hand: release after abort failed", { tabId: this.tabId, error: errorMessage(error) });
		}
	}

	private updateCriticalInput(): void {
		const busy = this.committedInput || this.pressedInput || this.travellingInput;
		if (busy === this.criticalInput) return;
		this.criticalInput = busy;
		this.onCriticalInput?.(busy);
	}

	private finishInput(): void {
		// Clear the future guard before reopening classification. Recovery has already settled.
		this.setInputDeadline(null);
		this.committedInput = false;
		this.pressedInput = false;
		this.travellingInput = false;
		this.updateCriticalInput();
	}

	private setInputDeadline(atMs: number | null): void {
		this.inputDeadline = atMs;
		this.onInputDeadline?.(atMs);
	}

	private setState(s: HandState): void {
		if (this.current === s) return;
		this.current = s;
		this.onState?.(s);
	}
}
