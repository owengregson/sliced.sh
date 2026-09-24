/**
 * Appendix D §5 re-plan rules, one per `ReplanReason`. A re-plan keeps the time already spent on
 * the position: the new plan starts where the old one did, so its deadline and phase budget are
 * measured from the same start.
 */
import type { Rng } from "@core/rng";
import { TIMING_CONSTANTS as C } from "../constants";
import { uniform } from "../distributions";
import { computeFeatures } from "../features";
import { createMoveBudget } from "../move-budget";
import { allocateWindow } from "../move-window";
import { boundByCap } from "../pressure";
import type {
	GameTimingState,
	MoveWindowBudget,
	Persona,
	ReplanReason,
	TimingContext,
	TimingPlan,
} from "../types";
import { floorFor } from "./normalise";

/** What a re-plan needs from the model that owns the game. */
export interface ReplanHost {
	readonly state: GameTimingState;
	readonly persona: Persona;
	readonly moveTimeScale: number;
	readonly rng: Rng;
	planMove(ctx: TimingContext): TimingPlan;
	/** Plan with premoves forbidden: no premove was entered for an unexpected reply. */
	planWithoutPremove(ctx: TimingContext): TimingPlan;
	observe(actualThinkMs: number, plan: TimingPlan): void;
}

const IDLE_WINDOW: MoveWindowBudget = {
	orientationMs: 0,
	scanMs: 0,
	previewMs: 0,
	decisionMs: 0,
	approachMs: 0,
};

/** Elapsed since the plan's start, rounded to µs so `(a + b) − b` round-trips. */
function elapsedMs(plan: TimingPlan, nowMs: number): number {
	return Math.max(0, Math.round((nowMs - (plan.deadlineMs - plan.thinkMs)) * 1000) / 1000);
}

/** A window that has already elapsed for `spentMs`, followed by an approach of `approachMs`. */
function spentThenApproach(
	plan: TimingPlan,
	spentMs: number,
	approachMs: number
): MoveWindowBudget {
	const orientationMs = Math.min(plan.orientationMs, spentMs);
	return { ...IDLE_WINDOW, orientationMs, scanMs: spentMs - orientationMs, approachMs };
}

function withElapsed(
	plan: TimingPlan,
	ctx: TimingContext,
	thinkMs: number,
	window: MoveWindowBudget,
	rationale: string
): TimingPlan {
	const spent = elapsedMs(plan, ctx.nowMs);
	return {
		...plan,
		thinkMs,
		preMoveHoverMs: Math.max(0, thinkMs - spent - window.approachMs),
		deadlineMs: ctx.nowMs - spent + thinkMs,
		rationale: [...plan.rationale, rationale],
		orientationMs: window.orientationMs,
		window,
	};
}

export function replan(
	host: ReplanHost,
	plan: TimingPlan,
	ctx: TimingContext,
	reason: ReplanReason
): TimingPlan {
	switch (reason) {
		case "manual-now":
			return manualNow(plan, ctx);
		case "withheld-then-released":
			return withheldThenReleased(plan, ctx);
		case "engine-changed":
			return engineChanged(host, plan, ctx);
		case "clock-jump":
			return clockJump(host, plan, ctx);
		case "opponent-moved":
			return opponentMoved(host, plan, ctx);
		case "blur":
			return blur(host, plan, ctx);
		case "emergency":
			return emergency(plan, ctx);
	}
}

function manualNow(plan: TimingPlan, ctx: TimingContext): TimingPlan {
	const spent = elapsedMs(plan, ctx.nowMs);
	const approach = plan.window.approachMs;
	const p = withElapsed(
		plan,
		ctx,
		spent + approach,
		spentThenApproach(plan, spent, approach),
		"manual-now: hover wait 0, drag kept"
	);
	p.preMoveHoverMs = 0;
	return p;
}

function withheldThenReleased(plan: TimingPlan, ctx: TimingContext): TimingPlan {
	const spent = elapsedMs(plan, ctx.nowMs);
	const thinkMs = Math.max(plan.thinkMs, spent + plan.window.approachMs);
	const extra = thinkMs - plan.thinkMs;
	return withElapsed(
		plan,
		ctx,
		thinkMs,
		{ ...plan.window, scanMs: plan.window.scanMs + extra },
		`withheld then released: extended by ${extra.toFixed(0)} ms`
	);
}

/** Re-plan the new move with the same residual, keeping the time already spent. */
function engineChanged(host: ReplanHost, plan: TimingPlan, ctx: TimingContext): TimingPlan {
	const spent = elapsedMs(plan, ctx.nowMs);
	const st = host.state;
	st.freezeEps = true;
	let fresh: TimingPlan;
	try {
		fresh = host.planMove(ctx);
	} finally {
		st.freezeEps = false;
	}
	st.plannedMs.pop();
	const thinkMs = Math.max(spent + fresh.window.approachMs, fresh.thinkMs);
	const extra = thinkMs - fresh.thinkMs;
	const p = withElapsed(
		{ ...fresh, deadlineMs: plan.deadlineMs - plan.thinkMs + fresh.thinkMs },
		ctx,
		thinkMs,
		{ ...fresh.window, scanMs: fresh.window.scanMs + extra },
		"re-planned: chosen move changed"
	);
	st.plannedMs.push(thinkMs);
	return p;
}

/** The clock jumped: keep the plan if it still fits the caps, else truncate it. */
function clockJump(host: ReplanHost, plan: TimingPlan, ctx: TimingContext): TimingPlan {
	const spent = elapsedMs(plan, ctx.nowMs);
	const approach = plan.window.approachMs;
	const f = computeFeatures(ctx, host.state);
	const budget = createMoveBudget(f, host.persona, host.moveTimeScale);
	const capSec = plan.features.executionIncluded ? budget.distributionCapSec : budget.capSec;
	if (plan.thinkMs / 1000 <= capSec)
		return withElapsed(plan, ctx, plan.thinkMs, plan.window, "clock-jump: within caps");
	const clockEmergency = f.tc !== "untimed" && ctx.myClockMs < C.replan.emergencyClockMs;
	const b = boundByCap(plan.thinkMs / 1000, capSec, floorFor(plan.mode), clockEmergency, host.rng);
	// A committed approach may exceed the cap: once the drag is in flight the executor
	// never aborts a mousedown, so the truncation keeps `spent + approach` at least.
	const thinkMs = Math.min(plan.thinkMs, Math.max(spent + approach, b.totalSec * 1000));
	const window = allocateWindow(
		{
			thinkMs,
			mode: plan.mode,
			orientationMs: plan.orientationMs,
			motorMs: Math.min(approach, thinkMs),
			previewCount: plan.window.previewMs > 0 ? 1 : 0,
			emergency: b.emergency,
		},
		host.rng
	);
	return withElapsed(
		plan,
		ctx,
		thinkMs,
		window,
		`clock-jump: truncated to ${thinkMs.toFixed(0)} ms`
	);
}

/** The expected reply fires the premove; any other reply is planned afresh, without one. */
function opponentMoved(host: ReplanHost, plan: TimingPlan, ctx: TimingContext): TimingPlan {
	const spent = elapsedMs(plan, ctx.nowMs);
	const last = ctx.moves.length ? ctx.moves[ctx.moves.length - 1] : undefined;
	if (plan.mode === "premove" && last !== undefined && last === ctx.expectedOppReply) {
		const fire = uniform(host.rng, 0, C.premove.maxS * 1000);
		return withElapsed(
			plan,
			ctx,
			spent + fire,
			{ ...IDLE_WINDOW, approachMs: spent + fire },
			"opponent moved as expected: premove fires"
		);
	}
	return host.planWithoutPremove({ ...ctx, expectedOppReply: null });
}

/** The tab lost focus: the move is cancelled for this position and the time spent observed. */
function blur(host: ReplanHost, plan: TimingPlan, ctx: TimingContext): TimingPlan {
	const spent = elapsedMs(plan, ctx.nowMs);
	host.observe(spent, plan);
	return {
		...plan,
		thinkMs: spent,
		preMoveHoverMs: 0,
		dragDurationMs: 0,
		deadlineMs: ctx.nowMs,
		rationale: [...plan.rationale, "blur: move cancelled for this position"],
		orientationMs: Math.min(plan.orientationMs, spent),
		window: spentThenApproach(plan, spent, 0),
	};
}

function emergency(plan: TimingPlan, ctx: TimingContext): TimingPlan {
	const spent = elapsedMs(plan, ctx.nowMs);
	const motor = C.motor.minMotorMs;
	const p = withElapsed(
		plan,
		ctx,
		spent + motor,
		spentThenApproach(plan, spent, motor),
		"emergency: every wait 0, minimal motor"
	);
	p.preMoveHoverMs = 0;
	p.dragDurationMs = motor;
	delete p.fakeout;
	delete p.promotionDelayMs;
	return p;
}
