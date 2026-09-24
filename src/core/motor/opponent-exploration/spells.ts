/**
 * The spells an attention plan alternates: the first look and later active spells (weighted
 * activities), a glance under decayed attention, a still, the repertoire's purposeful bout and
 * the pre-2026-09-12 bout for a caller without an attention context. One `SpellPlanner` plans
 * one spell and hands back the finished plan.
 */
import type { Rng } from "@core/rng";
import { EXPLORATION, OPPONENT_EXPLORATION as O, REPERTOIRE } from "../constants";
import { midpoint, sampleRange, smallRect, validRect } from "../geometry";
import { chooseRepertoire, type RepertoireState, repertoireRoute } from "../repertoire";
import {
	candidates,
	chooseActivity,
	king,
	nearestLook,
	offBoard,
	perform,
	readLine,
	restSpot,
	type SpellScene,
	threats,
} from "./activities";
import { type SpellBudget, SpellTimeline } from "./timeline";
import type {
	ExplorationSpell,
	OpponentExplorationOptions,
	OpponentExplorationPlan,
} from "./types";

export class SpellPlanner {
	private readonly hand: SpellTimeline;
	private readonly scene: SpellScene;
	private repertoireState: RepertoireState | undefined;

	constructor(
		private readonly opts: OpponentExplorationOptions,
		private readonly ownOnly: boolean,
		private readonly budget: SpellBudget,
		private readonly rng: Rng,
		private readonly spell: ExplorationSpell
	) {
		this.repertoireState = opts.repertoireState;
		this.hand = new SpellTimeline(opts, ownOnly, budget, rng);
		const readings = (opts.readings ?? []).map((reading) => ({
			rank: reading.rank,
			steps: ownOnly ? reading.steps.filter((step) => step.side === "own") : reading.steps,
		}));
		this.scene = {
			opts,
			ownOnly,
			readings: readings.filter((reading) => reading.steps.length > 0),
			hand: this.hand,
			rng,
			lastLine: null,
		};
	}

	finish(): OpponentExplorationPlan {
		this.hand.rest(Math.max(0, this.budget.total - this.budget.spent));
		return {
			actions: this.hand.actions,
			durationMs: this.budget.total,
			lastTarget: this.hand.lastTarget,
			spell: this.spell,
			...(this.repertoireState ? { repertoireState: this.repertoireState } : {}),
		};
	}

	rest(ms: number): void {
		this.hand.rest(ms);
	}

	suppressRepertoire(): void {
		this.repertoireState = undefined;
		this.hand.rest(this.budget.total);
	}

	/** The pre-2026-09-12 bout: an orientation pause, candidate visits, then stillness. */
	legacyBout(lowTime: boolean): void {
		this.hand.rest(sampleRange(O.orientationMs, this.rng));
		candidates(this.scene, lowTime ? O.lowTimeVisits : O.visits);
	}

	/** Purpose persists for a few active bouts; target squares are re-derived every time. */
	repertoireBout(): void {
		const { opts, hand, rng } = this;
		const attention = opts.attention;
		const context = attention?.repertoire;
		if (!attention || !context) return;
		const pool = [...opts.ownCandidates, ...(this.ownOnly ? [] : opts.opponentCandidates)];
		const state = chooseRepertoire(
			context,
			this.repertoireState,
			{
				budgetMs: hand.room(),
				myClockMs: opts.policy?.lowTime ? 0 : attention.myClockMs,
				candidates: pool.length,
			},
			rng
		);
		this.repertoireState = state;
		if (state.intent === "still") return;
		hand.rest(sampleRange(REPERTOIRE.orientationFrac, rng) * hand.room());
		if (state.intent === "inspect" && this.scene.readings.length > 0) {
			readLine(this.scene);
			return;
		}
		if (state.intent === "verify" && (opts.threats?.length ?? 0) > 0) {
			threats(this.scene);
			return;
		}
		const route = repertoireRoute(
			state.intent,
			state.intent === "prepare" ? opts.ownCandidates : pool,
			rng
		);
		const activity = state.intent === "inspect" ? "candidates" : state.intent;
		for (const target of route) {
			const dwell = sampleRange(
				state.intent === "verify" ? REPERTOIRE.verifyDwellMs : REPERTOIRE.dwellMs,
				rng
			);
			if ("square" in target) {
				const side = opts.ownCandidates.some((c) => c.from === target.square || c.to === target.square)
					? "own"
					: "opponent";
				if (hand.visit(target.square, side, "hover", dwell, activity) === "refused") break;
			} else {
				const a = opts.geometry.squareRect(target.between[0]);
				const b = opts.geometry.squareRect(target.between[1]);
				if (!validRect(a) || !validRect(b)) break;
				const point = midpoint(a, b);
				if (
					!hand.travelTo(point, smallRect(point, EXPLORATION.tracePointRectPx), dwell, {
						kind: "trace",
						activity: "relate",
						...(this.ownOnly ? { side: "own" as const } : {}),
					})
				)
					break;
			}
		}
	}

	/**
	 * The first look reads the position (the executor's initial rest is its orientation); a later
	 * active spell orients briefly, then mixes the activities.
	 */
	active(first: boolean): void {
		const { hand, rng } = this;
		if (!first) {
			hand.rest(Math.min(sampleRange(O.orientationMs, rng), this.budget.total * O.orientationMaxFrac));
		}
		// The extras come first, while the spell still has room for them: a glance at the king, or
		// at the clock beside the board, before the reading.
		if (this.opts.kings && rng.chance(O.kingGlanceProb)) king(this.scene);
		if (!this.ownOnly && rng.chance(O.offBoardGlanceProb)) offBoard(this.scene);
		let idle = 0;
		for (let i = 0; i < O.visits[1] * 2 && hand.room() > O.minDwellMs; i++) {
			const activity = chooseActivity(this.scene, i === 0);
			if (!activity) break;
			const before = hand.actions.length;
			perform(this.scene, activity);
			if (hand.actions.length === before) {
				// Nothing fitted: try another activity, without spending room on a pause between.
				if (++idle >= 2) break;
				continue;
			}
			if (hand.room() > O.minDwellMs) {
				hand.rest(Math.min(hand.room(), sampleRange(O.betweenVisitsMs, rng)));
			}
		}
		// A spell too short for the leg it chose (bullet, a far piece) still looks at something
		// near the pointer rather than at nothing: an active spell is never motionless by accident.
		if (!hand.actions.some((a) => a.path && a.kind !== "drift")) nearestLook(this.scene);
	}

	/** Decayed attention: one look (its slower first movement is the re-orientation), then a still. */
	glance(): void {
		const { hand, rng } = this;
		const dwell = sampleRange(O.glanceDwellMs, rng);
		const kings = this.opts.kings;
		const step = this.scene.readings[0]?.steps[0];
		const threat = this.opts.threats?.[0];
		if (kings && rng.chance(O.kingOwnProb)) hand.visit(kings.own, "own", "hover", dwell, "glance");
		else if (threat) hand.visit(threat, "own", "hover", dwell, "glance");
		else if (step) hand.visit(step.from, step.side, "hover", dwell, "glance");
		else if (kings) hand.visit(kings.own, "own", "hover", dwell, "glance");
	}

	/**
	 * A still: possibly a walk to a rest spot first (never straight after another still), then
	 * a few long dwells, each with the idle tremor.
	 */
	still(): void {
		const { hand, rng } = this;
		if (this.opts.previousSpell !== "still" && rng.chance(O.restMoveProb)) restSpot(this.scene);
		while (hand.room() > O.minDwellMs) {
			const dwell = Math.min(hand.room(), sampleRange(O.stillDwellMs, rng));
			hand.dwell(dwell, "rest");
		}
	}
}
