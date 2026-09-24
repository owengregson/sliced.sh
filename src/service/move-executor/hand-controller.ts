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
 *
 * This file is the hand's public entry. Its parts live in `hand/`: the primitives every gesture
 * is written in (`motor.ts`), the touch and promotion planning (`touch-plan.ts`), the absolute
 * schedule (`move-window.ts`), the choreography (`sequence.ts`), the gestures themselves
 * (`gestures/*`) and the result reporting (`result.ts`).
 */

import { EXECUTOR } from "@core/constants/cdp";
import { log } from "@core/logger";
import { ExplorationPlanner } from "@core/motor/exploration";
import type { InputBackend } from "@core/motor/input-backend";
import { boundedMotorSpeed, withMotorSpeed } from "@core/motor/motor-profile";
import type { OpponentExplorationAction } from "@core/motor/opponent-exploration";
import type { ExecutionPlan, ExecutionResult, HandState, Pt, Rect } from "@core/motor/types";
import type { Rng } from "@core/rng";
import {
	AbortedError,
	defaultNow,
	defaultScheduler,
	type Scheduler,
	throwIfAborted,
} from "@core/util/scheduler";
import type { BoardRectSource } from "@service/board-watch";
import type { TimingPlan } from "@typedefs/timing";
import { SkipError } from "./hand/errors";
import type { GeometryProvider } from "./hand/geometry";
import { InputCriticality } from "./hand/input-criticality";
import { type FocusSource, HandMotor, type OwnershipSink } from "./hand/motor";
import { ExecutionRecord } from "./hand/record";
import { resultBaseOf, unwoundResult } from "./hand/result";
import { runSequence } from "./hand/sequence";
import { Timeline } from "./hand/timeline";

export { boardGeometryOf, type GeometryProvider, positionIntact } from "./hand/geometry";
export type { FocusSource, OwnershipSink } from "./hand/motor";
export { fastTouch, preTouchMsOf, type TimingWindow } from "./hand/timing";
export { rescalePath } from "./hand/touch-plan";

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

export class HandController {
	private readonly hand: HandMotor;
	private readonly planner: ExplorationPlanner;

	constructor(deps: HandControllerDeps) {
		this.planner = deps.planner ?? new ExplorationPlanner();
		this.hand = new HandMotor({
			backend: deps.backend,
			focus: deps.focus,
			ownership: deps.ownership,
			geometry: deps.geometry ?? null,
			board: deps.board ?? null,
			rng: deps.rng,
			now: deps.now ?? defaultNow,
			scheduler: deps.scheduler ?? defaultScheduler,
			onState: deps.onState ?? null,
			onCommittedPress: deps.onCommittedPress ?? null,
			input: new InputCriticality(deps.onInputDeadline ?? null, deps.onCriticalInput ?? null),
			record: new ExecutionRecord(),
		});
	}

	state(): HandState {
		return this.hand.state();
	}

	/** Run one cancellable opponent-turn bout. This path never presses or releases a button. */
	async explore(
		tabId: number,
		actions: readonly OpponentExplorationAction[],
		signal: AbortSignal,
		boardRect: Rect,
		keepGoing?: () => boolean
	): Promise<Pt> {
		const hand = this.hand;
		if (hand.busy()) throw new SkipError(EXECUTOR.reasons.dropped);
		hand.begin(tabId, signal);
		const guard = () => {
			if (keepGoing && !keepGoing()) throw new AbortedError();
			hand.guardBoard(boardRect);
		};
		try {
			throwIfAborted(signal);
			hand.gate();
			guard();
			for (const action of actions) {
				hand.setState(action.kind === "rest" || action.kind === "drift" ? "rest" : "exploring");
				if (action.path) await hand.travel(action.path, guard);
				await hand.pause(action.dwellMs, guard);
			}
			return hand.position();
		} finally {
			hand.syncPosition(tabId);
			hand.input.finish();
			hand.end();
			hand.setState("rest");
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
		const hand = this.hand;
		const t0 = hand.now();
		const tl = new Timeline(t0, hand.now);
		hand.begin(plan.tabId, signal);
		hand.record.reset();
		const startedPx = hand.backend.travelledPx?.() ?? 0;
		const base = resultBaseOf(hand, plan, t0, tl, startedPx);
		const verdict = hand.verdict();
		if (!verdict.ok) {
			log.info("hand: skipped before the first dispatch", {
				tabId: plan.tabId,
				reason: verdict.reason,
			});
			hand.input.finish();
			hand.end();
			return { ok: false, outcome: "skipped", reason: verdict.reason, attempts: 0, ...base() };
		}
		try {
			await runSequence(hand, this.planner, plan, timing, t0, tl);
			tl.end();
			hand.syncPosition();
			hand.setState("rest");
			return { ok: true, outcome: "executed", attempts: 1, ...base() };
		} catch (error) {
			tl.end();
			await hand.recover();
			hand.syncPosition();
			hand.setState("rest");
			const attempts = hand.record.pressedCommitted ? 1 : 0;
			return unwoundResult(error, signal, plan, attempts, base);
		} finally {
			hand.input.finish();
			hand.end();
		}
	}
}
