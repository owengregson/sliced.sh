/**
 * The hand's ledger for one spell: where the pointer is, what it looked at last, how much of the
 * spell is spent, and the primitives every activity is built from — a rest, a tremor dwell, a
 * travel to a point, a visit to a square. Each primitive charges the budget and refuses a leg
 * that would not leave room for its dwell, so no activity can overrun the spell.
 */
import type { Rng } from "@core/rng";
import type { Square } from "@typedefs/game";
import { OPPONENT_EXPLORATION as O, SAMPLING } from "../constants";
import { inRect, lastPoint, pathMs, sampleRange, validRect } from "../geometry";
import { generatePath, idleTremor } from "../path-generator";
import { samplePointInRect } from "../sampling";
import type { MotorProfile, PathPoint, Pt, Rect } from "../types";
import type {
	ExplorationActivity,
	ExplorationSide,
	OpponentExplorationAction,
	OpponentExplorationOptions,
} from "./types";

export interface SpellBudget {
	total: number;
	spent: number;
	/** Movement stops here; the remainder of the spell is stillness. */
	activeUntil: number;
}

/** `skipped`: nothing to do (already there, wrong side); `refused`: no room left in the spell. */
export type VisitResult = "done" | "skipped" | "refused";

export interface TravelTag {
	kind: "hover" | "trace" | "offBoard";
	activity: ExplorationActivity;
	square?: Square;
	side?: ExplorationSide;
}

type TimelineOptions = Pick<
	OpponentExplorationOptions,
	"cursor" | "previousTarget" | "previousSpell" | "profile" | "geometry"
>;

export class SpellTimeline {
	readonly actions: OpponentExplorationAction[] = [];
	private at: Pt;
	private target: Square | null;
	private firstMovement = true;
	private readonly traceScale: number;

	constructor(
		private readonly opts: TimelineOptions,
		private readonly ownOnly: boolean,
		readonly budget: SpellBudget,
		private readonly rng: Rng
	) {
		this.at = { ...opts.cursor };
		this.target = opts.previousTarget ?? null;
		this.traceScale = sampleRange(O.traceSpeedScale, rng);
	}

	/** Where the pointer is after the actions so far. */
	get cursor(): Pt {
		return this.at;
	}

	/** The last square visited (initially the previous bout's). */
	get lastTarget(): Square | null {
		return this.target;
	}

	/** Active time left before the spell's stillness. */
	room(): number {
		return this.budget.activeUntil - this.budget.spent;
	}

	rest(ms: number): void {
		const duration = Math.min(ms, Math.max(0, this.budget.total - this.budget.spent));
		if (!(duration > 0)) return;
		this.actions.push({ kind: "rest", dwellMs: duration, activity: "rest" });
		this.budget.spent += duration;
	}

	/** A dwell with the idle tremor: the tremor's one point becomes a `drift` inside it. */
	dwell(ms: number, activity: ExplorationActivity): void {
		if (!(ms > 0)) return;
		const tremor = this.tremor(ms);
		if (!tremor) {
			this.rest(ms);
			return;
		}
		this.rest(tremor.leadMs);
		this.drift(tremor.step, tremor.remainderMs, activity);
	}

	travelTo(target: Pt, rect: Rect, dwell: number, tag: TravelTag, speed = 1): boolean {
		const path = generatePath(this.at, target, rect, this.movementProfile(speed), this.rng);
		const travelMs = pathMs(path);
		const roomAfter = this.room() - travelMs;
		if (path.length === 0 || roomAfter < O.minDwellMs) return false;
		const dwellMs = Math.min(dwell, roomAfter);
		const action: OpponentExplorationAction = {
			kind: tag.kind,
			path,
			dwellMs: 0,
			activity: tag.activity,
		};
		if (tag.square) action.square = tag.square;
		if (tag.side) action.side = tag.side;
		this.actions.push(action);
		this.budget.spent += travelMs;
		this.at = lastPoint(path, this.at);
		this.dwellAfter(action, dwellMs);
		return true;
	}

	visit(
		square: Square,
		side: ExplorationSide,
		kind: "hover" | "trace",
		dwell: number,
		activity: ExplorationActivity,
		speed = 1
	): VisitResult {
		if (this.target === square) return "skipped";
		if (this.ownOnly && side !== "own") return "skipped";
		const rect = this.opts.geometry.squareRect(square);
		if (!validRect(rect)) return "skipped";
		// Looking at the piece under a stationary cursor needs no little repositioning loop.
		if (kind === "hover" && inRect(this.at, rect)) return "skipped";
		const target = samplePointInRect(
			rect,
			SAMPLING.hover.sigmaFrac,
			SAMPLING.hover.innerFrac,
			this.rng
		);
		if (!this.travelTo(target, rect, dwell, { kind, activity, square, side }, speed)) {
			return "refused";
		}
		this.target = square;
		return "done";
	}

	private movementProfile(speed: number): MotorProfile {
		const reorient =
			this.firstMovement && this.opts.previousSpell === "still" ? O.reorientSpeedScale : 1;
		this.firstMovement = false;
		return {
			...this.opts.profile,
			travelSpeedScale: this.opts.profile.travelSpeedScale * this.traceScale * reorient * speed,
		};
	}

	/** Split a dwell between the action and a tremor drift, when the tremor fires. */
	private dwellAfter(action: OpponentExplorationAction, ms: number): void {
		const tremor = this.tremor(ms);
		if (!tremor) {
			action.dwellMs = ms;
			this.budget.spent += ms;
			return;
		}
		action.dwellMs = tremor.leadMs;
		this.budget.spent += tremor.leadMs;
		this.drift(tremor.step, tremor.remainderMs, action.activity ?? "rest");
	}

	/**
	 * Where a dwell of `ms` puts its tremor: the still lead-in, the one-sample step and the still
	 * remainder. `null` when the tremor does not fire or would not fit.
	 */
	private tremor(ms: number): { leadMs: number; step: PathPoint; remainderMs: number } | null {
		const point = idleTremor(this.at, ms, this.opts.profile, this.rng)[0];
		if (!point || point.dtMs + this.opts.profile.sampleIntervalMs > ms) return null;
		const step = { ...point, dtMs: this.opts.profile.sampleIntervalMs };
		return { leadMs: point.dtMs, step, remainderMs: Math.max(0, ms - point.dtMs - step.dtMs) };
	}

	private drift(step: PathPoint, remainderMs: number, activity: ExplorationActivity): void {
		this.actions.push({ kind: "drift", path: [step], dwellMs: remainderMs, activity });
		this.budget.spent += step.dtMs + remainderMs;
		this.at = { x: step.x, y: step.y };
	}
}
