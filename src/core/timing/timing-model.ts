/**
 * `TimingModel` (§8.3, §8.4a, §8.4b, §8.5, Appendix D §5): per game the
 * persona is sampled fresh from the per-game seed and every piece of state is
 * discarded; per move `features → budget → head.sample → budget normalization →
 * orientation → motor split → window allocation → TimingPlan`. Runs in the
 * service worker; the ChessMimic head's inference is prepared asynchronously
 * through `prepare()`.
 *
 * The class orchestrates the per-game state; the stages live under `./timing-model/`:
 * `normalise` (head sample → budgeted duration), `compose` (clock policies, motor, cap),
 * `assemble` (window phases and diagnostics) and `replan` (Appendix D §5).
 */

import { isLoneKing } from "@core/chess/material";
import {
	TIMING_CALIBRATION,
	type TimingCalibrationTable,
} from "@core/constants/timing-calibration";
import type { Rng } from "@core/rng";
import { clamp } from "@core/util/clamp";
import { budgetController, scheduleAlloc } from "./budget";
import { TIMING_CONSTANTS } from "./constants";
import { computeFeatures, isBotPace } from "./features";
import { createMoveBudget } from "./move-budget";
import { clockRacePolicy } from "./opponent-pressure";
import { samplePersona } from "./persona-latents";
import { buildTimingLogEntry } from "./timing-log/entry";
import { assemblePlan } from "./timing-model/assemble";
import { calibrateSample } from "./timing-model/calibrate";
import { composeThink } from "./timing-model/compose";
import { guardPremove, normaliseSample } from "./timing-model/normalise";
import { type ReplanHost, replan } from "./timing-model/replan";
import { adoptHistory, freshState, knobsFromSettings } from "./timing-model/state";

import type {
	DistributionHead,
	Features,
	GameMeta,
	GameTimingState,
	Persona,
	ReplanReason,
	TimingContext,
	TimingLogEntry,
	TimingPlan,
	TimingPreparation,
	TimingSettings,
} from "./types";

const C = TIMING_CONSTANTS;

export type { TimingSettings };

export { freshState, isBotPace, knobsFromSettings };

export interface TimingModelOptions {
	/** Receives every `TimingLogEntry` (creation and `observe()` updates re-send the same object). */
	onEntry?: (entry: TimingLogEntry) => void;
	/** The think-time calibration; default the shipped `TIMING_CALIBRATION` (the harness overrides it). */
	calibration?: TimingCalibrationTable;
}

export interface TimingObservation {
	gameId: string;
	ply: number;
	/** Manual acceleration is observed for reporting without teaching the natural pace. */
	adaptPace?: boolean;
}

export class TimingModel {
	private readonly head: DistributionHead;
	private settings: TimingSettings;
	private readonly rng: Rng;
	private readonly onEntry: ((entry: TimingLogEntry) => void) | undefined;
	private readonly calibration: TimingCalibrationTable;
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
		this.calibration = options.calibration ?? TIMING_CALIBRATION;
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
		adoptHistory(this._state, previous);
	}

	/** Kick off head-side inference for the position (no-op for the v1 head). */
	prepare(ctx: TimingContext, options?: TimingPreparation): Promise<void> {
		if (this.skipsInference(ctx)) return Promise.resolve();
		return this.head.prepare?.(ctx, options) ?? Promise.resolve();
	}

	/**
	 * Infer the chosen move's row when `prepare` did not already (call after the move is chosen,
	 * before `planMove`; no-op for the v1 head and under the same clock-race rule as `prepare`).
	 */
	prepareMove(ctx: TimingContext, options?: TimingPreparation): Promise<void> {
		if (this.skipsInference(ctx)) return Promise.resolve();
		return this.head.prepareMove?.(ctx, options) ?? Promise.resolve();
	}

	private skipsInference(ctx: TimingContext): boolean {
		const race = clockRacePolicy({
			ownClockMs: ctx.myClockMs,
			opponentClockMs: ctx.oppClockMs,
			baseMs: ctx.baseSec * 1000,
			incrementMs: ctx.incSec * 1000,
			loneKing: isLoneKing(ctx.fen, ctx.myColor),
		});
		// An opponent's short clock is a reason to play briskly, not to discard
		// position-conditioned thinking while we can still afford it.
		return race !== null && !race.opponentOnly;
	}

	private allocFor(f: Features): number {
		return this.settings.respectBudget ? budgetController(f, this._persona) : scheduleAlloc(f);
	}

	planMove(ctx: TimingContext): TimingPlan {
		const st = this._state;
		st.fen = ctx.fen;
		st.move = ctx.chosenMove;
		st.ply = ctx.ply;
		const f = computeFeatures(ctx, st);
		if (st.lastEvalOurPov !== null && f.eval_cp <= st.lastEvalOurPov - C.tilt.dropCp && st.tilt === 0)
			st.tilt = C.tilt.moves;
		const alloc = this.allocFor(f);
		const budget = createMoveBudget(
			f,
			this._persona,
			this.settings.moveTimeScale,
			this.settings.respectBudget ? undefined : alloc
		);
		const sample = this.head.sample(f, this._persona, st, this.rng, alloc);
		const why = [...sample.why];
		const rawMedian = this.head.median(f, this._persona, st, alloc);
		const rawMean = Math.max(
			C.moveBudget.minimumShapeMeanS,
			this.head.mean?.(f, this._persona, st, alloc) ?? rawMedian
		);
		const normalised = normaliseSample(
			{
				sample,
				rawMedian,
				rawMean,
				budget,
				sGame: this._persona.s_game,
				moveTimeScale: this.settings.moveTimeScale,
				untimed: f.tc === "untimed",
			},
			why
		);
		const calibrated = calibrateSample(
			normalised,
			{
				ctx,
				f,
				includesExecution: sample.includesExecution === true,
				table: this.calibration,
				moveTimeScale: this.settings.moveTimeScale,
			},
			why
		);
		const { tSec, mode } = guardPremove(calibrated.sample, f, this.forbidPremove, why);
		const composed = composeThink(
			{ f, ctx, mode, tSec, sample, budget, persona: this._persona, rng: this.rng },
			why
		);
		const plan = assemblePlan({
			ctx,
			f,
			alloc,
			budget,
			rawMean,
			includesExecution: sample.includesExecution === true,
			normalised,
			composed,
			eps: st.eps,
			rationale: why,
			rng: this.rng,
			calibration: { shift: calibrated.shift, situationIndex: calibrated.situationIndex },
		});
		st.plannedMs.push(plan.thinkMs);
		st.lastPlan = plan;
		st.lastEvalOurPov = f.eval_cp;
		st.oppThinkMs = [...ctx.oppThinkMsHistory];
		this.logPlan(ctx, plan, f, alloc, normalised.comp, sample.terms ?? []);
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

	replan(plan: TimingPlan, ctx: TimingContext, reason: ReplanReason): TimingPlan {
		return replan(this.replanHost, plan, ctx, reason);
	}

	/** The model as the re-plan rules see it. */
	private get replanHost(): ReplanHost {
		return {
			state: this._state,
			persona: this._persona,
			moveTimeScale: this.settings.moveTimeScale,
			rng: this.rng,
			planMove: (ctx) => this.planMove(ctx),
			planWithoutPremove: (ctx) => {
				this.forbidPremove = true;
				try {
					return this.planMove(ctx);
				} finally {
					this.forbidPremove = false;
				}
			},
			observe: (actualThinkMs, plan) => this.observe(actualThinkMs, plan),
		};
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
