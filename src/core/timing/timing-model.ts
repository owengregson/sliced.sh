/**
 * `TimingModel` (§8.3, §8.4a, §8.4b, §8.5, Appendix D §5): per game the
 * persona is sampled fresh from the per-game seed and every piece of state is
 * discarded; per move `features → budget → head.sample → pressure caps →
 * orientation → motor split → window allocation → TimingPlan`. Runs in the
 * service worker; the ChessMimic head's inference is prepared asynchronously
 * through `prepare()`.
 */

import { parseUci } from "@core/chess/san";
import type { Rng } from "@core/rng";
import { clamp } from "@core/util/clamp";
import type { Square } from "@typedefs/game";
import type { Settings } from "@typedefs/settings";
import { budgetController, scheduleAlloc } from "./budget";
import { TIMING_CONSTANTS } from "./constants";
import { uniform } from "./distributions";
import { computeFeatures, featuresToRecord, isBotPace } from "./features";
import { allocateWindow, type MotorTimes, motorModel } from "./move-window";
import { sampleOrientationMs } from "./orientation";
import { samplePersona } from "./persona-latents";
import { boundByCap, hardCapSec, paceFactor } from "./pressure";
import { buildTimingLogEntry } from "./timing-log";
import type {
	DistributionHead,
	Features,
	GameMeta,
	GameTimingState,
	HeadSample,
	MoveWindowBudget,
	Persona,
	ReplanReason,
	TimingContext,
	TimingKnobs,
	TimingLogEntry,
	TimingMode,
	TimingPlan,
} from "./types";

const C = TIMING_CONSTANTS;

/** Orientation floor + motor floor: the physical minimum of every non-premove window. */
const PHYSICAL_FLOOR_S = (C.orientation.minMs + C.motor.minMotorMs) / 1000;

/** The floor a bound total must respect: `minNormalMs` for normal/long moves, physical otherwise. */
function floorFor(mode: TimingMode): number {
	return mode === "normal" || mode === "long"
		? Math.max(C.minNormalMs / 1000, PHYSICAL_FLOOR_S)
		: PHYSICAL_FLOOR_S;
}

export type TimingSettings = Settings["timing"];

export { isBotPace };

export interface TimingModelOptions {
	/** Receives every `TimingLogEntry` (creation and `observe()` updates re-send the same object). */
	onEntry?: (entry: TimingLogEntry) => void;
}

export function knobsFromSettings(settings: TimingSettings): TimingKnobs {
	return {
		sigmaScale: Math.max(0, settings.varianceScale),
		piOffset: (settings.premoveTendency - C.knobs.premoveNeutral) * C.knobs.premoveLogitSpan,
		lambdaScale: Math.max(0, settings.longThinkFrequency),
	};
}

export function freshState(gameId: string, knobs?: TimingKnobs): GameTimingState {
	return {
		gameId,
		fen: "",
		ply: 0,
		eps: 0,
		freezeEps: false,
		tilt: 0,
		oppThinkMs: [],
		myThinkMs: [],
		plannedMs: [],
		fastAdded: 0,
		paceResiduals: [],
		lastEvalOurPov: null,
		lastPlan: null,
		knobs: knobs ? { ...knobs } : { sigmaScale: 1, piOffset: 0, lambdaScale: 1 },
	};
}

function cv(xs: readonly number[]): number {
	if (xs.length === 0) return 0;
	let m = 0;
	for (const x of xs) m += x;
	m /= xs.length;
	if (m <= 0) return 0;
	let v = 0;
	for (const x of xs) v += (x - m) ** 2;
	return Math.sqrt(v / xs.length) / m;
}

/** §8.4a: after 12 moves the per-game CV of `thinkMs` must stay ≥ 0.5. */
export function needsResample(plannedMs: readonly number[], candidateMs: number): boolean {
	if (plannedMs.length < C.cvGuard.afterMoves) return false;
	return cv([...plannedMs, candidateMs]) < C.cvGuard.minCv;
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

export class TimingModel {
	private readonly head: DistributionHead;
	private readonly settings: TimingSettings;
	private readonly rng: Rng;
	private readonly onEntry: ((entry: TimingLogEntry) => void) | undefined;
	private meta: GameMeta | null = null;
	private _persona: Persona;
	private _state: GameTimingState;
	private readonly entries = new Map<string, TimingLogEntry>();
	/** Set while re-planning after an unexpected reply: no premove was entered for it. */
	private forbidPremove = false;

	constructor(
		head: DistributionHead,
		settings: TimingSettings,
		rng: Rng,
		options: TimingModelOptions = {}
	) {
		this.head = head;
		this.settings = settings;
		this.rng = rng;
		this.onEntry = options.onEntry;
		this._state = freshState("", knobsFromSettings(settings));
		this._persona = samplePersona("", "balanced", C.features.eloCentre);
	}

	get persona(): Persona {
		return this._persona;
	}

	get state(): GameTimingState {
		return this._state;
	}

	/** Discard all state and sample the persona fresh from the per-game seed (§8.4b item 4). */
	startGame(meta: GameMeta): void {
		this.meta = meta;
		this._state = freshState(meta.gameId, knobsFromSettings(this.settings));
		this._persona = samplePersona(meta.gameId, meta.profile, meta.targetElo);
		this.entries.clear();
		this.head.reset?.();
	}

	/**
	 * §4.6: the time control arrived *after* the game started, so the session rebuilt this model
	 * with the preset the clock selects — but the **game** has not restarted. Adopt the previous
	 * model's per-game history so the rebuild is a change of knobs, not a new game: the AR(1)
	 * residual, the tilt counter, both pace histories, the CV guard's population and the eval the
	 * tilt trigger compares against. The persona is not copied: it is sampled from the game id, so
	 * the rebuild already produced the same one.
	 */
	adoptHistory(previous: GameTimingState): void {
		const st = this._state;
		st.eps = previous.eps;
		st.tilt = previous.tilt;
		st.oppThinkMs = [...previous.oppThinkMs];
		st.myThinkMs = [...previous.myThinkMs];
		st.plannedMs = [...previous.plannedMs];
		st.fastAdded = previous.fastAdded;
		st.paceResiduals = [...previous.paceResiduals];
		st.lastEvalOurPov = previous.lastEvalOurPov;
		st.lastPlan = previous.lastPlan;
	}

	/** Kick off head-side inference for the position (no-op for the v1 head). */
	prepare(ctx: TimingContext): Promise<void> {
		return this.head.prepare?.(ctx) ?? Promise.resolve();
	}

	private allocFor(f: Features): number {
		return this.settings.respectBudget ? budgetController(f, this._persona) : scheduleAlloc(f);
	}

	/** Head sample with the per-game CV guard (§8.4a). */
	private sampleGuarded(f: Features, alloc: number): HeadSample {
		const st = this._state;
		let s = this.head.sample(f, this._persona, st, this.rng, alloc);
		for (let k = 0; k < C.cvGuard.maxResamples; k++) {
			if (s.mode === "premove" || s.mode === "instant") break;
			if (!needsResample(st.plannedMs, s.tSec * 1000)) break;
			s = this.head.sample(f, this._persona, st, this.rng, alloc);
			s.why.push("re-sampled: per-game CV < 0.5");
		}
		return s;
	}

	private motorFor(
		f: Features,
		ctx: TimingContext,
		mode: TimingMode
	): MotorTimes & {
		fakeout?: TimingPlan["fakeout"];
	} {
		const motor = motorModel(f, ctx, this._persona, this.rng);
		if (mode !== "normal" || (f.tc !== "untimed" && f.clock_s <= C.fakeout.minClockS)) return motor;
		const pFake = C.fakeout.pBase + C.fakeout.pElo * (1 - f.elo_z);
		if (this.rng.next() >= pFake) return motor;
		const alt =
			f.n_reasonable >= 2 ? ctx.lines.find((l) => l.pvUci[0] !== ctx.chosenMove) : undefined;
		const piece: Square = (alt && parseUci(alt.pvUci[0] ?? "")?.from) || f.from;
		const holdMs = uniform(this.rng, C.fakeout.holdMs[0], C.fakeout.holdMs[1]);
		const gapMs = uniform(this.rng, C.fakeout.gapMs[0], C.fakeout.gapMs[1]);
		return {
			...motor,
			totalS: motor.totalS + (holdMs + gapMs) / 1000,
			fakeout: { piece, holdMs, gapMs },
		};
	}

	planMove(ctx: TimingContext): TimingPlan {
		const st = this._state;
		st.fen = ctx.fen;
		st.ply = ctx.ply;
		const f = computeFeatures(ctx, st);
		if (st.lastEvalOurPov !== null && f.eval_cp <= st.lastEvalOurPov - C.tilt.dropCp && st.tilt === 0)
			st.tilt = C.tilt.moves;
		const alloc = this.allocFor(f);
		const sample = this.sampleGuarded(f, alloc);
		let { tSec, mode } = sample;
		const why = [...sample.why];
		// `min(§3a.3 compression, relative-clock urgency)` — NOT the compression alone. The shipped
		// ChessMimic head never reads `alloc`, so without this the budget controller has no effect on
		// the plan at all and a 3+0 game is paced the same at 1:00 as at 3:00 (the owner's live
		// report, 2026-09-10; the measured curves are in fixC-report.md). It is a `min`, so no move is
		// ever planned slower than it is today and the last seconds stay exactly as §13.2 measures
		// them.
		const comp = paceFactor(f);
		const capSec = hardCapSec(f);
		tSec *= comp;
		// `premove` mode skips `boundByCap` and the physical floor below, because the hand is supposed to
		// be on the piece already: pre-positioned during the opponent's think, leaving only press and
		// release. `allocateWindow` then hands the plan `approachMs = thinkMs` with zero orientation.
		//
		// Nothing actually pre-positions the hand from this mode. Checked: the only readers of
		// `plan.mode === "premove"` are `move-window.ts` (the window split), `preview-select.ts` (no
		// previews) and the panel's copy — the executor's premove path is keyed on
		// `rec.chosen.source === "premove"`, a different quantity. So the mode on its own produces a
		// **100–220 ms whole move from a cold start** (measured p50 157 ms at ply 0 on the real bands)
		// unless we really were waiting on this position with the move already entered, and no hand can
		// deliver that — the brief's own figure for approach + press + drag + release is 400–900 ms.
		//
		// The condition for "we really were waiting" is `ponder_hit`: we predicted the opponent's reply
		// and they played it. `premove_eligible`'s other three predictors (recapture, in book, only legal
		// move) say a premove would have been *reasonable to enter*, not that one *was* entered — at ply 0
		// `in_book` alone made the flick reachable, and at ply 2 with no prediction at all it made one
		// reachable again. Appendix D §3a.5's premove logit is untouched; what is gated is whether the
		// resulting mode is physically honourable.
		const noPreEntry = f.ponder_hit === 0;
		if (mode === "premove" && (!f.premove_eligible || this.forbidPremove || noPreEntry)) {
			mode = "instant";
			tSec = Math.max(tSec, C.instant.minS + C.instant.rangeS);
			why.push(
				this.forbidPremove
					? "no premove entered → instant"
					: !f.premove_eligible
						? "premove not eligible → instant"
						: "nothing was pre-entered for this position (no ponder hit) → instant"
			);
		}
		if (mode !== "premove") tSec *= this.settings.speedScale;
		const median = this.head.median(f, this._persona, st, alloc) * comp;
		if (f.opp_is_bot && mode !== "premove") why.push("bot opponent: mirror coefficient floored");
		if (mode === "premove") tSec += C.premove.penaltyS;

		const motor = this.motorFor(f, ctx, mode);
		const orientationMs = mode === "premove" ? 0 : sampleOrientationMs(f, this.rng);
		const physicalS = orientationMs / 1000 + motor.totalS;
		const clockEmergency = f.tc !== "untimed" && ctx.myClockMs < C.replan.emergencyClockMs;
		let totalS: number;
		let emergency = false;
		// A premove plan still has to be physically deliverable. `ponder_hit` (above) says we predicted
		// the reply, not that a move was *entered*: the only thing that enters one is the session's own
		// §7.4 path, which sets `chosen.source = "premove"` and builds its own plan in `session.ts` —
		// it never reaches here. So a premove-mode plan out of `planMove` is a hand that has hovered
		// (the previous plan's `preMoveHoverMs`) but has not pressed, and the press, drag and release
		// still cost `PHYSICAL_FLOOR_S`. Without this floor the plan was a 100–209 ms whole move
		// (measured p50 154 ms), which is the same non-human signature the ponder-hit gate removed for
		// the no-prediction case. `replan("opponent-moved")` computes the fire time itself and is
		// unaffected.
		if (mode === "premove") totalS = Math.max(tSec, PHYSICAL_FLOOR_S);
		else {
			// Instant: orientation + motor + the head's U(0.05, 0.25). Normal/long: Appendix D §5's
			// `max(tSec, motor.total)` with the §8.4b item 2 orientation inside the window. A
			// binding hard cap (§3a.3) wins over that physical floor, sampled in `cap · U(lo, 1)`
			// with every floor folded into `lo` (never a clamp after jittering); `lo ≥ 1` or the
			// §8.5 clock threshold is the emergency regime (`boundByCap`).
			const value = mode === "instant" ? physicalS + tSec : Math.max(tSec, physicalS);
			const b = boundByCap(value, capSec, floorFor(mode), clockEmergency, this.rng);
			totalS = b.totalSec;
			emergency = b.emergency;
			if (b.bound) why.push(`cap ${capSec.toFixed(2)} s binds (lo ${b.lo.toFixed(2)})`);
		}
		if (emergency) why.push("emergency regime: no floors, minimal motor");
		const thinkMs = totalS * 1000;
		const motorMs = mode === "premove" ? thinkMs : Math.min(motor.totalS * 1000, thinkMs);
		const window = allocateWindow(
			{ thinkMs, mode, orientationMs, motorMs, previewCount: mode === "long" ? 1 : 0, emergency },
			this.rng
		);
		const dragDurationMs =
			mode === "premove" ? 0 : Math.max(0, Math.min(motor.dragS * 1000, window.approachMs));
		const features: Record<string, number> = {
			...featuresToRecord(f),
			alloc,
			comp,
			capSec,
			emergency: emergency ? 1 : 0,
			eps: st.eps,
			bodyMedianMs: median * 1000,
		};
		const plan: TimingPlan = {
			thinkMs,
			mode,
			preMoveHoverMs: mode === "premove" ? 0 : thinkMs - window.approachMs,
			dragDurationMs,
			deadlineMs: ctx.nowMs + thinkMs,
			rationale: why,
			features,
			orientationMs: window.orientationMs,
			window,
		};
		if (motor.fakeout) plan.fakeout = motor.fakeout;
		if (motor.promoS > 0) plan.promotionDelayMs = motor.promoS * 1000;

		st.plannedMs.push(thinkMs);
		// Counted here and not in the head: `sampleGuarded` discards re-sampled candidates, and a
		// discarded sample must not consume the budget. `mode` is re-read because the premove/physical
		// gates above can have converted the sample since the head produced it.
		if (sample.addedFast === true && mode === "instant") st.fastAdded++;
		st.lastPlan = plan;
		st.lastEvalOurPov = f.eval_cp;
		st.oppThinkMs = [...ctx.oppThinkMsHistory];
		this.logPlan(ctx, plan, f, alloc, comp, sample.terms ?? []);
		return plan;
	}

	private logPlan(
		ctx: TimingContext,
		plan: TimingPlan,
		f: Features,
		alloc: number,
		comp: number,
		terms: ReadonlyArray<readonly [string, number]>
	): void {
		const entry = buildTimingLogEntry({
			gameId: this.meta?.gameId ?? this._state.gameId,
			ply: ctx.ply,
			mode: plan.mode,
			plannedMs: plan.thinkMs,
			alloc,
			clockMs: f.tc === "untimed" ? 0 : ctx.myClockMs,
			comp,
			eps: this._state.eps,
			terms,
			persona: this.meta?.profile ?? ctx.profile,
		});
		this.entries.set(`${entry.gameId}:${entry.ply}`, entry);
		this.onEntry?.(entry);
	}

	private withElapsed(
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

	replan(plan: TimingPlan, ctx: TimingContext, reason: ReplanReason): TimingPlan {
		const spent = elapsedMs(plan, ctx.nowMs);
		const approach = plan.window.approachMs;
		switch (reason) {
			case "manual-now": {
				const p = this.withElapsed(
					plan,
					ctx,
					spent + approach,
					spentThenApproach(plan, spent, approach),
					"manual-now: hover wait 0, drag kept"
				);
				p.preMoveHoverMs = 0;
				return p;
			}
			case "engine-not-ready": {
				const thinkMs = Math.max(plan.thinkMs, spent + approach);
				const extra = thinkMs - plan.thinkMs;
				return this.withElapsed(
					plan,
					ctx,
					thinkMs,
					{ ...plan.window, scanMs: plan.window.scanMs + extra },
					`engine not ready: extended by ${extra.toFixed(0)} ms`
				);
			}
			case "engine-changed": {
				const st = this._state;
				st.freezeEps = true;
				let fresh: TimingPlan;
				try {
					fresh = this.planMove(ctx);
				} finally {
					st.freezeEps = false;
				}
				st.plannedMs.pop();
				const thinkMs = Math.max(spent + fresh.window.approachMs, fresh.thinkMs);
				const extra = thinkMs - fresh.thinkMs;
				const p = this.withElapsed(
					{ ...fresh, deadlineMs: plan.deadlineMs - plan.thinkMs + fresh.thinkMs },
					ctx,
					thinkMs,
					{ ...fresh.window, scanMs: fresh.window.scanMs + extra },
					"re-planned: chosen move changed"
				);
				st.plannedMs.push(thinkMs);
				return p;
			}
			case "clock-jump": {
				const f = computeFeatures(ctx, this._state);
				const capSec = hardCapSec(f);
				if (plan.thinkMs / 1000 <= capSec)
					return this.withElapsed(plan, ctx, plan.thinkMs, plan.window, "clock-jump: within caps");
				const clockEmergency = f.tc !== "untimed" && ctx.myClockMs < C.replan.emergencyClockMs;
				const b = boundByCap(
					plan.thinkMs / 1000,
					capSec,
					floorFor(plan.mode),
					clockEmergency,
					this.rng
				);
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
					this.rng
				);
				return this.withElapsed(
					plan,
					ctx,
					thinkMs,
					window,
					`clock-jump: truncated to ${thinkMs.toFixed(0)} ms`
				);
			}
			case "opponent-moved": {
				const last = ctx.moves.length ? ctx.moves[ctx.moves.length - 1] : undefined;
				if (plan.mode === "premove" && last !== undefined && last === ctx.expectedOppReply) {
					const fire = uniform(this.rng, 0, C.premove.maxS * 1000);
					return this.withElapsed(
						plan,
						ctx,
						spent + fire,
						{ ...IDLE_WINDOW, approachMs: spent + fire },
						"opponent moved as expected: premove fires"
					);
				}
				this.forbidPremove = true;
				try {
					return this.planMove({ ...ctx, expectedOppReply: null });
				} finally {
					this.forbidPremove = false;
				}
			}
			case "blur": {
				this.observe(spent, plan);
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
			case "emergency": {
				const motor = C.motor.minMotorMs;
				const p = this.withElapsed(
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
		}
	}

	/** Feed the realised think time back into ε_t, the pace residual and the log. */
	observe(actualThinkMs: number, plan: TimingPlan): void {
		const st = this._state;
		st.myThinkMs.push(actualThinkMs);
		if (st.tilt > 0) st.tilt--;
		if ((plan.mode === "normal" || plan.mode === "long") && actualThinkMs > 0 && plan.thinkMs > 0) {
			const shift = clamp(
				Math.log(actualThinkMs / plan.thinkMs),
				-C.replan.observeShiftClamp,
				C.replan.observeShiftClamp
			);
			st.eps += shift;
			const bodyMs = plan.features.bodyMedianMs;
			if (bodyMs !== undefined && bodyMs > 0)
				st.paceResiduals.push(Math.log(actualThinkMs) - Math.log(bodyMs));
		}
		const gameId = this.meta?.gameId ?? st.gameId;
		const entry = this.entries.get(`${gameId}:${st.ply}`);
		if (entry) {
			entry.actualMs = actualThinkMs;
			this.onEntry?.(entry);
		}
	}
}
