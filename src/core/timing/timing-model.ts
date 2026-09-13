/**
 * `TimingModel` (§8.3, §8.4a, §8.4b, §8.5, Appendix D §5): per game the
 * persona is sampled fresh from the per-game seed and every piece of state is
 * discarded; per move `features → budget → head.sample → budget normalization →
 * orientation → motor split → window allocation → TimingPlan`. Runs in the
 * service worker; the ChessMimic head's inference is prepared asynchronously
 * through `prepare()`.
 */

import { isLoneKing } from "@core/chess/material";
import { parseUci } from "@core/chess/san";
import type { Rng } from "@core/rng";
import { clamp } from "@core/util/clamp";
import type { Settings } from "@typedefs/settings";
import { budgetController, scheduleAlloc } from "./budget";
import { TIMING_CONSTANTS } from "./constants";
import { uniform } from "./distributions";
import { computeFeatures, featuresToRecord, isBotPace } from "./features";
import { createMoveBudget } from "./move-budget";
import { allocateWindow, type MotorTimes, motorModel } from "./move-window";
import { clockRacePolicy, opponentClockPressure } from "./opponent-pressure";
import { sampleOrientationMs } from "./orientation";
import { samplePersona } from "./persona-latents";
import { boundByCap } from "./pressure";
import { buildTimingLogEntry } from "./timing-log";

import type {
	DistributionHead,
	Features,
	GameMeta,
	GameTimingState,
	MoveWindowBudget,
	Persona,
	ReplanReason,
	TimingContext,
	TimingKnobs,
	TimingLogEntry,
	TimingMode,
	TimingPlan,
	TimingPreparation,
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

export interface TimingObservation {
	gameId: string;
	ply: number;
	/** Manual acceleration is observed for reporting without teaching the natural pace. */
	adaptPace?: boolean;
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
		paceResiduals: [],
		lastEvalOurPov: null,
		lastPlan: null,
		knobs: knobs ? { ...knobs } : { sigmaScale: 1, piOffset: 0, lambdaScale: 1 },
	};
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
	private settings: TimingSettings;
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

	/** Apply live controls to future plans without resetting the game's random stream or history. */
	updateSettings(settings: TimingSettings, persona: Pick<GameMeta, "profile" | "targetElo">): void {
		this.settings = settings;
		this._state.knobs = knobsFromSettings(settings);
		if (
			this.meta &&
			(this.meta.profile !== persona.profile || this.meta.targetElo !== persona.targetElo)
		) {
			this.meta = { ...this.meta, ...persona };
			this._persona = samplePersona(this.meta.gameId, persona.profile, persona.targetElo);
		}
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
	 * residual, the tilt counter, both pace histories, planned timing history and the eval the
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
		st.paceResiduals = [...previous.paceResiduals];
		st.lastEvalOurPov = previous.lastEvalOurPov;
		st.lastPlan = previous.lastPlan;
	}

	/** Kick off head-side inference for the position (no-op for the v1 head). */
	prepare(ctx: TimingContext, options?: TimingPreparation): Promise<void> {
		if (
			clockRacePolicy({
				ownClockMs: ctx.myClockMs,
				opponentClockMs: ctx.oppClockMs,
				baseMs: ctx.baseSec * 1000,
				incrementMs: ctx.incSec * 1000,
				loneKing: isLoneKing(ctx.fen, ctx.myColor),
			})
		)
			return Promise.resolve();
		return this.head.prepare?.(ctx, options) ?? Promise.resolve();
	}

	private allocFor(f: Features): number {
		return this.settings.respectBudget ? budgetController(f, this._persona) : scheduleAlloc(f);
	}

	private motorFor(
		f: Features,
		ctx: TimingContext,
		mode: TimingMode
	): MotorTimes & { fakeout?: TimingPlan["fakeout"] } {
		const motor = motorModel(f, ctx, this._persona, this.rng);
		if (mode !== "normal" || (f.tc !== "untimed" && f.clock_s <= C.fakeout.minClockS)) return motor;
		if (this.rng.next() >= C.fakeout.pBase + C.fakeout.pElo * (1 - f.elo_z)) return motor;
		const alt =
			f.n_reasonable >= 2 ? ctx.lines.find((line) => line.pvUci[0] !== ctx.chosenMove) : undefined;
		const piece = (alt && parseUci(alt.pvUci[0] ?? "")?.from) || f.from;
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
		const budget = createMoveBudget(
			f,
			this._persona,
			this.settings.speedScale,
			this.settings.respectBudget ? undefined : alloc
		);
		const sample = this.head.sample(f, this._persona, st, this.rng, alloc);
		let { tSec, mode } = sample;
		const why = [...sample.why];
		const rawMedian = this.head.median(f, this._persona, st, alloc);
		const rawMean = Math.max(
			C.moveBudget.minimumShapeMeanS,
			this.head.mean?.(f, this._persona, st, alloc) ?? rawMedian
		);
		// The learned distribution supplies relative difficulty and variation; the actual game clock
		// supplies scale. Normalize by the mean, because a median does not budget a heavy tail.
		const target = budget.targetSec * Math.exp(this._persona.s_game);
		const comp =
			f.tc === "untimed"
				? this.settings.speedScale
				: Math.min(this.settings.speedScale, target / rawMean);
		if (mode === "normal" || mode === "long") tSec *= comp;
		else if (mode === "instant") tSec *= Math.min(1, this.settings.speedScale);
		const median = rawMedian * comp;
		why.push(
			`move budget ${target.toFixed(2)} s; effort ${budget.effort.toFixed(2)}, recognition ${budget.recognition.toFixed(2)}`
		);

		if (mode === "premove" && (!f.premove_eligible || this.forbidPremove || !f.ponder_hit)) {
			mode = "instant";
			tSec = C.instant.minS + C.instant.rangeS * clamp(tSec / C.premove.maxS, 0, 1);
			why.push("no premove entered → instant");
		}
		if (mode === "premove") tSec += C.premove.penaltyS;
		if (f.opp_is_bot && mode !== "premove") why.push("bot opponent: mirror coefficient floored");

		const loneKing = isLoneKing(ctx.fen, ctx.myColor);
		const clockInput = {
			ownClockMs: ctx.myClockMs,
			opponentClockMs: ctx.oppClockMs,
			baseMs: ctx.baseSec * 1000,
			incrementMs: ctx.incSec * 1000,
		};
		const race = clockRacePolicy({ ...clockInput, loneKing });
		if (race) mode = "instant";
		const motor = this.motorFor(f, ctx, mode);
		const orientationMs = race || mode === "premove" ? 0 : sampleOrientationMs(f, this.rng);
		const physicalS = orientationMs / 1000 + motor.totalS;
		const clockEmergency = f.tc !== "untimed" && ctx.myClockMs < C.replan.emergencyClockMs;
		const capSec = Math.min(budget.capSec, Math.max(physicalS, budget.recognitionCapSec));
		const value =
			mode === "premove"
				? motor.totalS + tSec
				: mode === "instant"
					? physicalS + tSec
					: Math.max(tSec, physicalS);
		const bounded = boundByCap(value, capSec, floorFor(mode), clockEmergency, this.rng);
		let totalS = bounded.totalSec;
		let emergency = bounded.emergency;
		if (bounded.bound) why.push(`cap ${capSec.toFixed(2)} s binds (lo ${bounded.lo.toFixed(2)})`);

		const opponentPressure = opponentClockPressure(clockInput);
		if (opponentPressure > 0 && mode !== "premove") {
			const factor = 1 - C.opponentPressure.maxThinkReduction * opponentPressure;
			const floor = emergency ? C.motor.minMotorMs / 1000 : Math.max(floorFor(mode), physicalS);
			totalS = Math.min(totalS, Math.max(floor, totalS * factor));
			why.push(`opponent clock pressure: think ×${factor.toFixed(2)}`);
		}
		if (race) {
			if (race.opponentOnly) {
				const maxMs = Math.min(race.maxMoveMs, capSec * 1000);
				const minMs = Math.min(race.minMoveMs, maxMs * C.caps.jitterMin);
				totalS = uniform(this.rng, minMs, maxMs) / 1000;
				emergency = clockEmergency;
				why.push("opponent clock pressure: varied reply window");
			} else {
				totalS = Math.min(totalS, uniform(this.rng, race.minMoveMs, race.maxMoveMs) / 1000);
				emergency = true;
				why.push(loneKing ? "lone king: fast execution" : "own clock emergency: fast execution");
			}
		}
		if (emergency) why.push("emergency regime: no floors, minimal motor");
		const thinkMs = totalS * 1000;
		const motorMs = race || mode === "premove" ? thinkMs : Math.min(motor.totalS * 1000, thinkMs);
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
			budgetTargetSec: target,
			budgetEffort: budget.effort,
			recognition: budget.recognition,
			complexity: budget.complexity,
			headMeanSec: rawMean,
			opponentPressure,
			clockRace: race?.urgency ?? 0,
			opponentOnlyRace: race?.opponentOnly ? 1 : 0,
			loneKing: race && loneKing ? 1 : 0,
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
		if (!race && motor.fakeout) plan.fakeout = motor.fakeout;
		if (!race && motor.promoS > 0) plan.promotionDelayMs = motor.promoS * 1000;
		st.plannedMs.push(thinkMs);
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
			model: this.head.diagnostics?.(ctx.fen) ?? { head: this.head.id },
			targetElo: ctx.targetElo,
			opponentClockMs: ctx.oppClockMs,
			rationale: plan.rationale,
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
			case "withheld-then-released": {
				const thinkMs = Math.max(plan.thinkMs, spent + approach);
				const extra = thinkMs - plan.thinkMs;
				return this.withElapsed(
					plan,
					ctx,
					thinkMs,
					{ ...plan.window, scanMs: plan.window.scanMs + extra },
					`withheld then released: extended by ${extra.toFixed(0)} ms`
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
				const capSec = createMoveBudget(f, this._persona, this.settings.speedScale).capSec;
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
	observe(actualThinkMs: number, plan: TimingPlan, observation?: TimingObservation): void {
		const st = this._state;
		const gameId = this.meta?.gameId ?? st.gameId;
		if (observation && observation.gameId !== gameId) return;
		st.myThinkMs.push(actualThinkMs);
		if (st.tilt > 0) st.tilt--;
		if (
			observation?.adaptPace !== false &&
			(plan.mode === "normal" || plan.mode === "long") &&
			actualThinkMs > 0 &&
			plan.thinkMs > 0
		) {
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
		const entry = this.entries.get(`${gameId}:${observation?.ply ?? st.ply}`);
		if (entry) {
			entry.actualMs = actualThinkMs;
			this.onEntry?.(entry);
		}
	}
}
