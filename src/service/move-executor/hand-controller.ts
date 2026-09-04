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
 *
 * V2 gates: the `FocusGate` is consulted before the first dispatch and before
 * every subsequent one — a failing verdict skips the move with nothing (more)
 * sent, releasing a held preview first (§13.4). Real pointer input is never
 * consulted (§13.5). An abort mid-drag releases at the current point at once.
 * There is no tab-activation pre-flight of any kind.
 */

import { fileOf, rankOf } from "@core/chess/squares";
import { CDP, EXECUTOR } from "@core/constants/cdp";
import type { BoardGeometryReply } from "@core/constants/messages";
import { log } from "@core/logger";
import { CLICK, EXPLORATION, PATH, PROMOTION_LOOK_DELAY_MS, SAMPLING } from "@core/motor/constants";
import { type ExplorationOptions, ExplorationPlanner } from "@core/motor/exploration";
import { inRect, lastPoint, pathMs, sampleRange } from "@core/motor/geometry";
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
import type { FocusVerdict } from "@service/focus-gate";
import type { PromoPiece, Square } from "@typedefs/game";
import type { TimingPlan } from "@typedefs/timing";

/** Reads board / square / promotion rects on demand (the content adapter over the game port). */
export interface GeometryProvider {
	read(tabId: number, promotion?: PromoPiece): Promise<BoardGeometryReply | null>;
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
	rng: Rng;
	now?: () => number;
	scheduler?: Scheduler;
	onState?: (state: HandState) => void;
}

/** Task 16 extends `TimingPlan` with the phase window; read it defensively until it lands. */
export interface TimingWindow {
	orientationMs: number;
	scanMs: number;
	previewMs: number;
	decisionMs: number;
	approachMs: number;
}
type WindowedTimingPlan = TimingPlan & { window?: TimingWindow };

export function preTouchMsOf(timing: TimingPlan): number {
	const w = (timing as WindowedTimingPlan).window;
	if (w) return Math.max(0, w.orientationMs + w.scanMs + w.previewMs + w.decisionMs);
	return Math.max(0, timing.preMoveHoverMs);
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

const sameRect = (a: Rect, b: Rect): boolean =>
	a.left === b.left && a.top === b.top && a.width === b.width && a.height === b.height;

export class HandController {
	private readonly backend: InputBackend;
	private readonly focus: FocusSource;
	private readonly ownership: OwnershipSink;
	private readonly geometry: GeometryProvider | null;
	private readonly rng: Rng;
	private readonly now: () => number;
	private readonly scheduler: Scheduler;
	private readonly onState: ((state: HandState) => void) | null;
	private readonly planner = new ExplorationPlanner();
	private current: HandState = "rest";
	private tabId = -1;
	private signal: AbortSignal | null = null;

	constructor(deps: HandControllerDeps) {
		this.backend = deps.backend;
		this.focus = deps.focus;
		this.ownership = deps.ownership;
		this.geometry = deps.geometry ?? null;
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
		const base = (): Pick<ExecutionResult, "tier" | "endPoint" | "elapsedMs" | "timeline"> => ({
			tier: plan.style,
			endPoint: this.backend.position(),
			elapsedMs: this.now() - t0,
			timeline: tl.entries,
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
			this.setState("rest");
			return { ok: true, outcome: "executed", attempts: 1, ...base() };
		} catch (error) {
			tl.end();
			await this.recover();
			this.setState("rest");
			if (error instanceof SkipError) {
				log.info("hand: skipped mid-window", { tabId: plan.tabId, reason: error.reason });
				return { ok: false, outcome: "skipped", reason: error.reason, attempts: 0, ...base() };
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
		let reply = await this.readGeometry(plan.tabId);
		let readAt = this.now();
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
		let rects = this.resolveRects(plan, reply);
		let touch = this.planTouch(plan, timing, rects, this.backend.position());
		const approachStartAt = Math.max(
			this.now(),
			t0 + timing.thinkMs - touch.approachMs - touch.touchMs
		);
		await this.decisionPause(approachStartAt, tail, m);

		// The pause may have been long: re-read once more and re-plan only if the board moved.
		if (this.geometry && this.now() - readAt > EXECUTOR.geometryFreshMs) {
			const again = await this.readGeometry(plan.tabId);
			if (again) {
				const next = this.resolveRects(plan, again);
				if (!sameRect(next.from, rects.from) || !sameRect(next.to, rects.to)) {
					log.debug("hand: geometry changed during the decision pause; re-planning the touch");
					rects = next;
					touch = this.planTouch(plan, timing, rects, this.backend.position());
				}
			}
		}

		this.gate();
		tl.begin("approach");
		this.setState("approaching");
		await this.travel(touch.approach);
		if (touch.kind === "drag") await this.drag(touch, rects, m, tl);
		else await this.clickClick(touch, m, tl);

		if (plan.promotion) await this.promote(plan, plan.promotion, m, tl);
		tl.begin("rest");
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

	private async perform(a: HandAction, m: MotorProfile): Promise<void> {
		if (a.kind === "preview" && a.preview) {
			const pv = a.preview;
			await this.travel(pv.approach);
			await this.pause(sampleRange(CLICK.prePressPauseMs, this.rng));
			await this.press(pv.press);
			await this.pause(pv.holdMs);
			if (pv.dragPath) {
				await this.pause(sampleRange(m.grabDelayMs, this.rng));
				await this.travel(pv.dragPath);
				await this.pause(sampleRange(m.releaseSettleMs, this.rng));
			}
			await this.release(pv.release);
			await this.travel(pv.hoverPath);
			await this.pause(pv.dwellMs);
			const d = pv.deselect;
			if (d) {
				await this.travel(d.path);
				await this.pause(sampleRange(CLICK.prePressPauseMs, this.rng));
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

	private planTouch(plan: ExecutionPlan, timing: TimingPlan, rects: Rects, cursor: Pt): Touch {
		const m = plan.motor;
		const rng = this.rng;
		const press = samplePointInRect(
			rects.from,
			SAMPLING.press.sigmaFrac,
			SAMPLING.press.innerFrac,
			rng
		);
		const approach = generatePath(cursor, press, rects.from, m, rng);
		const pressAt = lastPoint(approach, press);
		const approachMs = pathMs(approach);
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
			return {
				kind: "drag",
				approach,
				pressAt,
				preGrabMs,
				grabDelayMs,
				wobble,
				travel,
				drop,
				hesitate,
				settleMs,
				approachMs,
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
		return {
			kind: "click",
			approach,
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
			approachMs,
			touchMs,
		};
	}

	private async drag(t: DragTouch, rects: Rects, m: MotorProfile, tl: Timeline): Promise<void> {
		tl.begin("grab");
		this.setState("grabbing");
		await this.pause(t.preGrabMs);
		await this.press(t.pressAt);
		await this.pause(t.grabDelayMs);
		await this.travel(t.wobble);
		tl.begin("drag");
		this.setState("dragging");
		await this.travel(t.travel);
		if (t.hesitate.length > 0) await this.travel(t.hesitate);
		tl.begin("drop");
		this.setState("dropping");
		await this.pause(t.settleMs);
		if (!inRect(this.backend.position(), rects.to, PATH.targetPadPx)) {
			tl.begin("correct");
			this.setState("correcting");
			await this.travel(generatePath(this.backend.position(), t.drop, rects.to, m, this.rng));
			tl.begin("drop");
			this.setState("dropping");
		}
		await this.release(this.backend.position());
	}

	private async clickClick(t: ClickTouch, _m: MotorProfile, tl: Timeline): Promise<void> {
		tl.begin("grab");
		this.setState("grabbing");
		await this.pause(t.prePressMs);
		await this.press(t.pressAt);
		await this.pause(t.holdMs);
		await this.release(t.releaseAt);
		tl.begin("drag");
		this.setState("approaching");
		await this.pause(t.gapMs);
		await this.travel(t.approach2);
		tl.begin("drop");
		this.setState("dropping");
		await this.pause(t.prePress2Ms);
		await this.press(t.press2At);
		await this.pause(t.hold2Ms);
		await this.release(t.release2At);
	}

	private async promote(
		plan: ExecutionPlan,
		piece: PromoPiece,
		m: MotorProfile,
		tl: Timeline
	): Promise<void> {
		tl.begin("promote");
		this.setState("promoting");
		const look = m.lookDelayMs[1] > 0 ? m.lookDelayMs : PROMOTION_LOOK_DELAY_MS;
		await this.pause(sampleRange(look, this.rng));
		const reply = this.geometry ? await this.geometry.read(plan.tabId, piece) : null;
		const rect = reply?.promotion ?? null;
		if (!rect) {
			// The picker never appeared (auto-queen preference): the move is already complete.
			log.debug("hand: no promotion picker; assuming auto-promotion", { tabId: plan.tabId });
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

	// ── primitives ────────────────────────────────────────────────────────

	private async readGeometry(tabId: number): Promise<BoardGeometryReply | null> {
		if (!this.geometry) return null;
		try {
			return await this.geometry.read(tabId);
		} catch (error) {
			log.debug("hand: geometry read failed; using the plan's rects", {
				tabId,
				error: errorMessage(error),
			});
			return null;
		}
	}

	private resolveRects(plan: ExecutionPlan, reply: BoardGeometryReply | null): Rects {
		if (!reply) return { from: plan.from.rect, to: plan.to.rect };
		const geo = boardGeometryOf(reply);
		return { from: geo.squareRect(plan.from.square), to: geo.squareRect(plan.to.square) };
	}

	/** Absolute-time dispatch of a path; the gate is checked before every point (§9.6a). */
	private async travel(path: readonly PathPoint[]): Promise<void> {
		let due = this.now();
		for (const pt of path) {
			throwIfAborted(this.signal ?? undefined);
			this.gate();
			due += pt.dtMs;
			await this.backend.move(pt, due, this.signal ?? undefined);
			this.ownership.setPosition(this.tabId, this.backend.position());
			if (this.now() - due > CDP.stallResyncMs) due = this.now();
		}
	}

	private async press(p: Pt): Promise<void> {
		throwIfAborted(this.signal ?? undefined);
		this.gate();
		await this.backend.press(p, this.now(), this.signal ?? undefined);
		this.ownership.setPosition(this.tabId, this.backend.position());
	}

	private async release(p: Pt): Promise<void> {
		await this.backend.release(p, this.now());
		this.ownership.setPosition(this.tabId, this.backend.position());
	}

	private async pause(ms: number): Promise<void> {
		if (ms > 0) await sleep(ms, this.scheduler, this.signal ?? undefined);
		throwIfAborted(this.signal ?? undefined);
		this.gate();
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
