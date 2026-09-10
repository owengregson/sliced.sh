/**
 * The virtual hand (§9.3–§9.5): one execution =
 * `rest → orientation → [scan hovers …] → [preview-select …] → decision pause
 * → approach(from) → press → grabWobble → travel(to) → [hesitate] → settle →
 * release → [promotion: look-delay → approach(picker) → click] → post-drop rest`
 * (click-click: approach → press/hold/release on from → inter-click gap →
 * approach → press/hold/release on to).
 *
 * Everything runs on one absolute schedule anchored at `t0`: the exploration
 * planner fills the pre-touch window (`plan.window` phases when the timing
 * model supplies them, else `preMoveHoverMs`), the touch (approach + grab +
 * travel rescaled to `dragDurationMs` + settle) is planned right before the
 * decision pause from a fresh geometry read (§9.5), and the approach starts
 * at `t0 + thinkMs − approach − touch` so the drop lands on `thinkMs`.
 * `ExecutionResult.elapsedMs` is the time to the drop (the move-hold time);
 * the promotion click and the post-drop rest follow it in the timeline.
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

import { fileOf, rankOf } from "@core/chess/squares";
import { EXECUTOR } from "@core/constants/cdp";
import type { BoardGeometryReply } from "@core/constants/messages";
import { log } from "@core/logger";
import { CLICK, EXPLORATION, PATH, PROMOTION_LOOK_DELAY_MS, SAMPLING } from "@core/motor/constants";
import { type ExplorationOptions, ExplorationPlanner } from "@core/motor/exploration";
import { inRect, lastPoint, pathMs, rectShiftPx, sampleRange } from "@core/motor/geometry";
import type { InputBackend } from "@core/motor/input-backend";
import { generatePath, grabWobble, idleTremor } from "@core/motor/path-generator";
import { clickReleasePoint, samplePointInRect } from "@core/motor/sampling";
import type {
	BoardGeometry,
	ExecutionPlan,
	ExecutionResult,
	HandAction,
	HandState,
	MotorProfile,
	Occupancy,
	PathPoint,
	Pt,
	Rect,
} from "@core/motor/types";
import type { Rng } from "@core/rng";
import { errorMessage } from "@core/util/errors";
import {
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
}

/** The §8.4b phase window of a plan (Task 16's `MoveWindowBudget`). */
export type TimingWindow = MoveWindowBudget;

/** Pre-touch budget: every window phase before the approach (§8.4b item 3). */
export function preTouchMsOf(timing: TimingPlan): number {
	const w = timing.window;
	return Math.max(0, w.orientationMs + w.scanMs + w.previewMs + w.decisionMs);
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
	kind: "drag";
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

interface ClickTouch {
	kind: "click";
	approach: PathPoint[];
	pressAt: Pt;
	prePressMs: number;
	holdMs: number;
	releaseAt: Pt;
	gapMs: number;
	approach2: PathPoint[];
	press2At: Pt;
	prePress2Ms: number;
	hold2Ms: number;
	release2At: Pt;
}

type Touch = (DragTouch | ClickTouch) & { approachMs: number; touchMs: number };

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
	private readonly planner = new ExplorationPlanner();
	private current: HandState = "rest";
	private tabId = -1;
	private signal: AbortSignal | null = null;
	/** The committed press went out (a release may land the move even on abort/skip). */
	private pressedCommitted = false;
	/** Squares pressed in this execution besides the committed from-square (§13.2). */
	private previewed: Square[] = [];
	/** Clock time of the drop (second click / release); `null` until then. */
	private dropAt: number | null = null;

	constructor(deps: HandControllerDeps) {
		this.backend = deps.backend;
		this.focus = deps.focus;
		this.ownership = deps.ownership;
		this.geometry = deps.geometry ?? null;
		this.board = deps.board ?? null;
		this.rng = deps.rng;
		this.now = deps.now ?? defaultNow;
		this.scheduler = deps.scheduler ?? defaultScheduler;
		this.onState = deps.onState ?? null;
	}

	state(): HandState {
		return this.current;
	}

	async execute(
		plan: ExecutionPlan,
		timing: TimingPlan,
		signal: AbortSignal
	): Promise<ExecutionResult> {
		const t0 = this.now();
		const tl = new Timeline(t0, this.now);
		this.tabId = plan.tabId;
		this.signal = signal;
		this.pressedCommitted = false;
		this.dropAt = null;
		const startedPx = this.backend.travelledPx?.() ?? 0;
		this.previewed = [];
		const base = (): Pick<
			ExecutionResult,
			| "tier"
			| "endPoint"
			| "elapsedMs"
			| "timeline"
			| "pressed"
			| "san"
			| "pointerOffsetPx"
			| "previewedSquares"
		> => ({
			tier: plan.style,
			endPoint: this.backend.position(),
			elapsedMs: (this.dropAt ?? this.now()) - t0,
			timeline: tl.entries,
			pressed: this.pressedCommitted,
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

		// Exploration inside the pre-touch window (§9.3 / §9.3a); the trailing decision
		// pause is executed by the controller itself so it can absorb the touch budget.
		const actions = this.planExploration(plan, timing, preTouchMs, reply);
		const tail = actions[actions.length - 1]?.kind === "rest" ? actions.pop() : undefined;
		this.setState("orientation");
		tl.begin("orientation");
		let first = true;
		for (const a of actions) {
			this.gate();
			if (!first) {
				this.setState("exploring");
				tl.begin(a.kind === "preview" ? "preview" : "scan");
			}
			first = false;
			await this.perform(a, m);
		}

		// Plan the touch from fresh geometry (§9.5) so its duration is known exactly.
		tl.begin("decision");
		if (reply === null || this.now() - readAt > EXECUTOR.geometryFreshMs) {
			reply = await this.readGeometry(plan.tabId);
			readAt = this.now();
		}
		this.guardPosition(plan, reply);
		let rects = this.resolveRects(plan, reply);
		let touch = this.planTouch(plan, timing, rects, this.backend.position());
		const approachStartAt = Math.max(
			this.now(),
			t0 + timing.thinkMs - touch.approachMs - touch.touchMs
		);
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
					touch = this.planTouch(plan, timing, rects, this.backend.position());
				}
			}
		}

		this.gate();
		tl.begin("approach");
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
		if (touch.kind === "drag") await this.drag(touch, rects, m, tl, plan, planned);
		else await this.clickClick(touch, tl, planned);

		if (plan.promotion) await this.promote(plan, timing, plan.promotion, m, tl);
		await this.postDropRest(m, tl);
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

	/** Every pause of a preview was sampled by the planner (its budget already counts them). */
	private async perform(a: HandAction, m: MotorProfile): Promise<void> {
		if (a.kind === "preview" && a.preview) {
			const pv = a.preview;
			// §13.2 counts *pieces* the page saw selected: the previewed piece always, and the
			// resolving click only in the `switch-to-idle` form, where the square it clicks is an
			// own piece (an empty / enemy square only clears the selection, it never makes one).
			this.previewed.push(pv.piece);
			if (pv.deselect?.occupancy === "own") this.previewed.push(pv.deselect.square);
			await this.travel(pv.approach);
			await this.pause(pv.prePressMs);
			await this.press(pv.press);
			await this.pause(pv.holdMs);
			if (pv.dragPath) {
				await this.pause(pv.grabDelayMs ?? sampleRange(m.grabDelayMs, this.rng));
				await this.travel(pv.dragPath);
				await this.pause(pv.settleMs ?? sampleRange(m.releaseSettleMs, this.rng));
			}
			await this.release(pv.release);
			await this.travel(pv.hoverPath);
			await this.pause(pv.dwellMs);
			const d = pv.deselect;
			if (d) {
				await this.travel(d.path);
				await this.pause(d.prePressMs);
				await this.press(d.press);
				await this.pause(d.holdMs);
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
		const approachRaw = generatePath(cursor, press, rects.from, m, rng);
		const pressAt = lastPoint(approachRaw, press);
		if (plan.style === "drag") {
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
				Math.max(EXECUTOR.minTravelMs, timing.dragDurationMs),
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
			const fitted = this.fitApproach(approachRaw, touchMs, timing, m, cursor);
			return {
				kind: "drag",
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
		const prePressMs = sampleRange(CLICK.prePressPauseMs, rng);
		const holdMs = sampleRange(m.pressHoldMs, rng);
		const releaseAt = clickReleasePoint(pressAt, rng);
		const gapMs = sampleRange(CLICK.interClickGapMs, rng);
		const press2 = samplePointInRect(
			rects.to,
			SAMPLING.press.sigmaFrac,
			SAMPLING.press.innerFrac,
			rng
		);
		const approach2 = generatePath(releaseAt, press2, rects.to, m, rng);
		const press2At = lastPoint(approach2, press2);
		const prePress2Ms = sampleRange(CLICK.prePressPauseMs, rng);
		const hold2Ms = sampleRange(m.pressHoldMs, rng);
		const release2At = clickReleasePoint(press2At, rng);
		const touchMs = prePressMs + holdMs + gapMs + pathMs(approach2) + prePress2Ms + hold2Ms;
		const fitted = this.fitApproach(approachRaw, touchMs, timing, m, cursor);
		return {
			kind: "click",
			approach: fitted.path,
			pressAt,
			prePressMs,
			holdMs,
			releaseAt,
			gapMs,
			approach2,
			press2At,
			prePress2Ms,
			hold2Ms,
			release2At,
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
		await this.press(t.pressAt, true);
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
		} catch (error) {
			if (error instanceof BoardMovedError) {
				await this.releaseOnOrigin(plan, error.live, planned?.flipped ?? false, m, tl);
			}
			throw error;
		}
		await this.release(this.backend.position());
		this.dropAt = this.now();
	}

	private async clickClick(
		t: ClickTouch,
		tl: Timeline,
		planned: PlannedGeometry | null
	): Promise<void> {
		const guard = guardOf(planned, (r) => this.guardBoard(r));
		tl.begin("grab");
		this.setState("grabbing");
		await this.pause(t.prePressMs, guard);
		await this.press(t.pressAt, true);
		await this.pause(t.holdMs);
		await this.release(t.releaseAt);
		tl.begin("drag");
		this.setState("approaching");
		await this.pause(t.gapMs, guard);
		await this.travel(t.approach2, guard);
		tl.begin("drop");
		this.setState("dropping");
		await this.pause(t.prePress2Ms, guard);
		// Nothing is held between the two clicks: a board that has moved needs no escape release,
		// only the second press withheld. The piece stays selected and no move is submitted.
		guard?.();
		await this.press(t.press2At, true);
		await this.pause(t.hold2Ms);
		await this.release(t.release2At);
		this.dropAt = this.now();
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
		tl.note(EXECUTOR.timelineNotes.boardMoved);
		tl.begin("correct");
		this.setState("correcting");
		const origin = boardGeometryOf({ boardRect: live, flipped }).squareRect(plan.from.square);
		const target = samplePointInRect(
			origin,
			SAMPLING.release.sigmaFrac,
			SAMPLING.release.innerFrac,
			this.rng
		);
		const path = generatePath(this.backend.position(), target, origin, m, this.rng);
		log.info("hand: releasing on the origin square after a reflow", {
			tabId: this.tabId,
			from: plan.from.square,
			shiftPx: Math.round(rectShiftPx(plan.from.rect, origin)),
		});
		await this.escapeTravel(path);
		await this.release(lastPoint(path, target));
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
		tl: Timeline
	): Promise<void> {
		tl.begin("promote");
		this.setState("promoting");
		const lookMs =
			timing.promotionDelayMs !== undefined
				? timing.promotionDelayMs
				: sampleRange(m.lookDelayMs[1] > 0 ? m.lookDelayMs : PROMOTION_LOOK_DELAY_MS, this.rng);
		await this.pause(lookMs);
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
		const path = generatePath(this.backend.position(), target, rect, m, this.rng);
		await this.travel(path);
		await this.pause(sampleRange(CLICK.prePressPauseMs, this.rng));
		const pressAt = lastPoint(path, target);
		await this.press(pressAt);
		await this.pause(sampleRange(m.pressHoldMs, this.rng));
		await this.release(clickReleasePoint(pressAt, this.rng));
	}

	/**
	 * Post-drop rest (§9.4): slow idle drift on the dropped piece. The move is
	 * complete by now, so a gate veto or an abort here merely ends the drift.
	 */
	private async postDropRest(m: MotorProfile, tl: Timeline): Promise<void> {
		tl.begin("rest");
		this.setState("rest");
		try {
			const drift = idleTremor(
				this.backend.position(),
				sampleRange(EXECUTOR.postDropRestMs, this.rng),
				m,
				this.rng
			);
			await this.travel(drift);
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
		if (positionIntact(reply, plan.from.square, plan.to.square)) return;
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
		await this.backend.travel(path, this.signal ?? undefined, () => {
			this.gate();
			guard?.();
		});
		this.ownership.setPosition(this.tabId, this.backend.position());
	}

	/**
	 * The return leg of a reflow escape: no gate, no abort signal. The button is held, so this
	 * travel must finish and be followed by the release whatever else has happened.
	 */
	private async escapeTravel(path: readonly PathPoint[]): Promise<void> {
		if (path.length === 0) return;
		await this.backend.travel(path);
		this.ownership.setPosition(this.tabId, this.backend.position());
	}

	private async press(p: Pt, committed = false): Promise<void> {
		throwIfAborted(this.signal ?? undefined);
		this.gate();
		await this.backend.press(p, this.now(), this.signal ?? undefined);
		if (committed) this.pressedCommitted = true;
		this.ownership.setPosition(this.tabId, this.backend.position());
	}

	private async release(p: Pt): Promise<void> {
		await this.backend.release(p, this.now());
		this.ownership.setPosition(this.tabId, this.backend.position());
	}

	private async pause(ms: number, guard?: () => void): Promise<void> {
		if (ms > 0) await sleep(ms, this.scheduler, this.signal ?? undefined);
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

	/** Never leave a button held: an abort or skip mid-drag drops the piece where it is. */
	private async recover(): Promise<void> {
		if (!this.backend.pressed()) return;
		try {
			await this.release(this.backend.position());
		} catch (error) {
			log.warn("hand: release after abort failed", { tabId: this.tabId, error: errorMessage(error) });
		}
	}

	private setState(s: HandState): void {
		if (this.current === s) return;
		this.current = s;
		this.onState?.(s);
	}
}
