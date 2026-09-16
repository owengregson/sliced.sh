/**
 * Candidate-driven free pointer movement while waiting for the opponent ("pondering"); never
 * selects a piece. One call plans one *spell* of the turn's attention plan (owner, 2026-09-12): a
 * short first look, then active spells and stills alternating, their lengths set by the time
 * control, the opponent's elapsed think (attention decays), the game phase and whether a premove
 * or hold is armed. The caller refreshes candidates/geometry between spells and cancels on a turn
 * change. Without an attention context the spell is the pre-2026-09-12 bout.
 */
import { fileOf, rankOf } from "@core/chess/squares";
import { EXECUTOR } from "@core/constants/cdp";
import type { Rng } from "@core/rng";
import type { Square } from "@typedefs/game";
import { EXPLORATION, OPPONENT_EXPLORATION as O, REPERTOIRE, SAMPLING } from "./constants";
import { inRect, lastPoint, pathMs, sampleRange, smallRect } from "./geometry";
import type {
	ExplorationSide,
	LineReading,
	OpponentAttentionContext,
	OpponentExplorationCandidates,
	OpponentExplorationPolicy,
} from "./opponent-candidates";
import { generatePath, idleTremor } from "./path-generator";
import { chooseRepertoire, type RepertoireState, repertoireRoute } from "./repertoire";
import { pointInBand, samplePointInRect } from "./sampling";
import type { BoardGeometry, MotorProfile, MoveCandidate, PathPoint, Pt, Rect } from "./types";

export type { ExplorationSide } from "./opponent-candidates";

/** What a movement is part of (diagnostics and the unit tests; the hand treats every kind alike). */
export type ExplorationActivity =
	| "line"
	| "threat"
	| "candidates"
	| "king"
	| "offBoard"
	| "glance"
	| "compare"
	| "verify"
	| "relate"
	| "prepare"
	| "rest";

export interface OpponentExplorationAction {
	/**
	 * `hover`/`trace`: a path to a square and a dwell there. `rest`: a stationary dwell.
	 * `drift`: the idle tremor inside a dwell — a one-point path a few px away, then the rest of
	 * the dwell. `offBoard`: a path to a point beside the board (the clock / move list) and a dwell.
	 */
	kind: "hover" | "trace" | "rest" | "drift" | "offBoard";
	path?: PathPoint[];
	dwellMs: number;
	/** The candidate square this free movement considers, for diagnostics. */
	square?: Square;
	side?: ExplorationSide;
	activity?: ExplorationActivity;
}

/** The spell a plan is; the caller passes it back as `previousSpell` so spells alternate. */
export type ExplorationSpell = "first" | "active" | "glance" | "still";

export interface OpponentExplorationOptions extends OpponentExplorationCandidates {
	/** Strict ceiling on the entire spell, including orientation and terminal stillness. */
	maxMs?: number;
	/** Retain the previous plan's state; clear between games. Never contains coordinates. */
	repertoireState?: RepertoireState;
	geometry: BoardGeometry;
	profile: MotorProfile;
	cursor: Pt;
	/** The last inspected square of the previous bout; avoids restarting on the same piece. */
	previousTarget?: Square;
	/** The previous spell of this turn (absent for the first). */
	previousSpell?: ExplorationSpell;
	/** A no-ponder turn (`decideOpponentTurn`): stills only. */
	quiet?: boolean;
}

export interface OpponentExplorationPlan {
	repertoireState?: RepertoireState;
	actions: OpponentExplorationAction[];
	durationMs: number;
	lastTarget: Square | null;
	spell: ExplorationSpell;
}

/**
 * Rolled once per opponent turn: some turns get no pondering at all beyond a rest. The share is
 * the class's `noPonderProb`, raised when the opponent's clock promises a quick reply. A low-time
 * turn always ponders in its own short, own-only way (readiness), and a turn without a context
 * ponders as before.
 */
export function decideOpponentTurn(
	attention: OpponentAttentionContext | undefined,
	policy: OpponentExplorationPolicy | undefined,
	rng: Rng
): { ponder: boolean } {
	if (!attention || policy?.lowTime === true) return { ponder: true };
	const quick =
		attention.opponentClockMs > 0 && attention.opponentClockMs < O.quickReplyClockMs
			? O.noPonderShortBoost
			: 0;
	const probability = Math.min(1, O.attention[attention.tcClass].noPonderProb + quick);
	return { ponder: !rng.chance(probability) };
}

/** Plan one finite spell. The caller refreshes candidates/geometry and cancels on a turn change. */
export function planOpponentExploration(
	opts: OpponentExplorationOptions,
	rng: Rng
): OpponentExplorationPlan {
	const lowTime = opts.policy?.lowTime === true;
	const ownOnly = lowTime || opts.policy?.ownOnly === true;
	const attention = lowTime ? undefined : opts.attention;
	const spell = chooseSpell(opts, attention, rng);
	const ceiling =
		opts.maxMs === undefined
			? Number.POSITIVE_INFINITY
			: Number.isFinite(opts.maxMs)
				? Math.max(0, opts.maxMs)
				: 0;
	const durationMs = Math.min(ceiling, spellMs(spell, opts, attention, rng));
	const budget: Budget = { total: durationMs, spent: 0, activeUntil: durationMs };
	if (!attention) {
		const frac = sampleRange(lowTime ? O.lowTimeActiveFrac : O.activeFrac, rng);
		budget.activeUntil = durationMs * frac;
	}
	const plan = new SpellPlanner(opts, ownOnly, budget, rng, spell);
	if (!validRect(opts.geometry.boardRect)) {
		plan.rest(durationMs);
		return plan.finish();
	}
	if (
		opts.attention?.repertoire &&
		(opts.attention.repertoire.premovePending ||
			opts.attention.armed ||
			lowTime ||
			durationMs < REPERTOIRE.minWindowMs ||
			!Number.isFinite(opts.attention.myClockMs) ||
			opts.attention.myClockMs < REPERTOIRE.lowClockMs)
	)
		plan.suppressRepertoire();
	else if (spell === "still") plan.still();
	else if (spell === "glance") plan.glance();
	else if (opts.attention?.repertoire) plan.repertoireBout();
	else if (!attention) plan.legacyBout(lowTime);
	else plan.active(spell === "first");
	return plan.finish();
}

interface Budget {
	total: number;
	spent: number;
	/** Movement stops here; the remainder of the spell is stillness. */
	activeUntil: number;
}

function chooseSpell(
	opts: OpponentExplorationOptions,
	attention: OpponentAttentionContext | undefined,
	rng: Rng
): ExplorationSpell {
	if (opts.quiet) return "still";
	if (!attention) return "active";
	const previous = opts.previousSpell;
	if (previous === undefined) return "first";
	if (previous !== "still") return "still";
	const a = attentionLevel(attention);
	const activeProb =
		(attention.armed ? O.armed.activeProb : 1) *
		(O.decay.activeFloor + (1 - O.decay.activeFloor) * a);
	if (rng.chance(activeProb)) return "active";
	return rng.chance(O.decay.glanceProb) ? "glance" : "still";
}

/** `2^(−think / halfLife)`: 1 as their turn begins, halved after a half-life. */
function attentionLevel(attention: OpponentAttentionContext): number {
	const halfLife = O.attention[attention.tcClass].decayHalfLifeMs;
	return 2 ** (-Math.max(0, attention.opponentThinkMs) / halfLife);
}

function spellMs(
	spell: ExplorationSpell,
	opts: OpponentExplorationOptions,
	attention: OpponentAttentionContext | undefined,
	rng: Rng
): number {
	if (!attention) {
		return sampleRange(opts.policy?.lowTime === true ? O.lowTimeBoutMs : O.boutMs, rng);
	}
	const A = O.attention[attention.tcClass];
	if (spell === "still") {
		const growth = 1 + O.decay.stillGrowthMax * (1 - attentionLevel(attention));
		return sampleRange(A.stillMs, rng) * growth;
	}
	if (spell === "glance") return sampleRange(O.glanceMs, rng);
	const phase =
		attention.phase === "opening"
			? O.phaseActiveScale.opening
			: attention.phase === "endgame"
				? O.phaseActiveScale.endgame
				: attention.sharp
					? O.phaseActiveScale.sharp
					: O.phaseActiveScale.middlegame;
	const armed = attention.armed ? O.armed.activeScale : 1;
	if (spell === "first") return sampleRange(A.firstLookMs, rng) * armed;
	return sampleRange(A.activeMs, rng) * phase * armed;
}

type Activity = "line" | "threat" | "candidates" | "king" | "offBoard";

/** `skipped`: nothing to do (already there, wrong side); `refused`: no room left in the spell. */
type VisitResult = "done" | "skipped" | "refused";

class SpellPlanner {
	readonly actions: OpponentExplorationAction[] = [];
	private cursor: Pt;
	private lastTarget: Square | null;
	private firstMovement = true;
	private readonly traceScale: number;
	private readonly readings: LineReading[];
	private lastLine: LineReading | null = null;
	private repertoireState: RepertoireState | undefined;

	constructor(
		private readonly opts: OpponentExplorationOptions,
		private readonly ownOnly: boolean,
		private readonly budget: Budget,
		private readonly rng: Rng,
		private readonly spell: ExplorationSpell
	) {
		this.cursor = { ...opts.cursor };
		this.repertoireState = opts.repertoireState;
		this.lastTarget = opts.previousTarget ?? null;
		this.traceScale = sampleRange(O.traceSpeedScale, rng);
		this.readings = (opts.readings ?? []).map((reading) => ({
			rank: reading.rank,
			steps: ownOnly ? reading.steps.filter((step) => step.side === "own") : reading.steps,
		}));
		this.readings = this.readings.filter((reading) => reading.steps.length > 0);
	}

	finish(): OpponentExplorationPlan {
		this.rest(Math.max(0, this.budget.total - this.budget.spent));
		return {
			actions: this.actions,
			durationMs: this.budget.total,
			lastTarget: this.lastTarget,
			spell: this.spell,
			...(this.repertoireState ? { repertoireState: this.repertoireState } : {}),
		};
	}

	suppressRepertoire(): void {
		this.repertoireState = undefined;
		this.rest(this.budget.total);
	}

	// ── spells ────────────────────────────────────────────────────────────

	/** The pre-2026-09-12 bout: an orientation pause, candidate visits, then stillness. */
	legacyBout(lowTime: boolean): void {
		this.rest(sampleRange(O.orientationMs, this.rng));
		this.candidates(lowTime ? O.lowTimeVisits : O.visits);
	}

	/** Purpose persists for a few active bouts; target squares are re-derived every time. */
	repertoireBout(): void {
		const attention = this.opts.attention;
		const context = attention?.repertoire;
		if (!attention || !context) return;
		const candidates = [
			...this.opts.ownCandidates,
			...(this.ownOnly ? [] : this.opts.opponentCandidates),
		];
		const state = chooseRepertoire(
			context,
			this.repertoireState,
			{
				budgetMs: this.room(),
				myClockMs: this.opts.policy?.lowTime ? 0 : attention.myClockMs,
				candidates: candidates.length,
			},
			this.rng
		);
		this.repertoireState = state;
		if (state.intent === "still") return;
		this.rest(sampleRange(REPERTOIRE.orientationFrac, this.rng) * this.room());
		if (state.intent === "inspect" && this.readings.length > 0) {
			this.readLine();
			return;
		}
		if (state.intent === "verify" && (this.opts.threats?.length ?? 0) > 0) {
			this.threats();
			return;
		}
		const pool = state.intent === "prepare" ? this.opts.ownCandidates : candidates;
		const route = repertoireRoute(state.intent, pool, this.rng);
		const activity = state.intent === "inspect" ? "candidates" : state.intent;
		for (const target of route) {
			const dwell = sampleRange(
				state.intent === "verify" ? REPERTOIRE.verifyDwellMs : REPERTOIRE.dwellMs,
				this.rng
			);
			if ("square" in target) {
				const side = this.opts.ownCandidates.some(
					(c) => c.from === target.square || c.to === target.square
				)
					? "own"
					: "opponent";
				if (this.visit(target.square, side, "hover", dwell, activity) === "refused") break;
			} else {
				const a = this.opts.geometry.squareRect(target.between[0]);
				const b = this.opts.geometry.squareRect(target.between[1]);
				if (!validRect(a) || !validRect(b)) break;
				const point = {
					x: (a.left + a.width / 2 + b.left + b.width / 2) / 2,
					y: (a.top + a.height / 2 + b.top + b.height / 2) / 2,
				};
				if (
					!this.travelTo(point, smallRect(point, EXPLORATION.tracePointRectPx), dwell, {
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
		if (!first) {
			this.rest(
				Math.min(sampleRange(O.orientationMs, this.rng), this.budget.total * O.orientationMaxFrac)
			);
		}
		// The extras come first, while the spell still has room for them: a glance at the king, or
		// at the clock beside the board, before the reading.
		if (this.opts.kings && this.rng.chance(O.kingGlanceProb)) this.king();
		if (!this.ownOnly && this.rng.chance(O.offBoardGlanceProb)) this.offBoard();
		let idle = 0;
		for (let i = 0; i < O.visits[1] * 2 && this.room() > O.minDwellMs; i++) {
			const activity = this.chooseActivity(i === 0);
			if (!activity) break;
			const before = this.actions.length;
			this.perform(activity);
			if (this.actions.length === before) {
				// Nothing fitted: try another activity, without spending room on a pause between.
				if (++idle >= 2) break;
				continue;
			}
			if (this.room() > O.minDwellMs) {
				this.rest(Math.min(this.room(), sampleRange(O.betweenVisitsMs, this.rng)));
			}
		}
		// A spell too short for the leg it chose (bullet, a far piece) still looks at something
		// near the pointer rather than at nothing: an active spell is never motionless by accident.
		if (!this.actions.some((a) => a.path && a.kind !== "drift")) this.nearestLook();
	}

	/** The nearest square worth a look — a line's piece, a threat, a king, a candidate. */
	private nearestLook(): void {
		const squares = new Map<Square, ExplorationSide>();
		for (const reading of this.readings) {
			for (const step of reading.steps) squares.set(step.from, step.side);
		}
		for (const square of this.opts.threats ?? []) squares.set(square, "own");
		for (const move of this.opts.ownCandidates) squares.set(move.from, "own");
		if (!this.ownOnly)
			for (const move of this.opts.opponentCandidates) squares.set(move.from, "opponent");
		if (this.opts.kings) squares.set(this.opts.kings.own, "own");
		const byDistance = [...squares.entries()]
			.filter(([square]) => square !== this.lastTarget)
			.map(([square, side]) => {
				const rect = this.opts.geometry.squareRect(square);
				const centre = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
				return { square, side, d: Math.hypot(centre.x - this.cursor.x, centre.y - this.cursor.y) };
			})
			.sort((a, b) => a.d - b.d);
		for (const { square, side } of byDistance.slice(0, O.nearestLookTries)) {
			const dwell = sampleRange(O.glanceDwellMs, this.rng);
			if (this.visit(square, side, "hover", dwell, "glance") === "done") return;
		}
	}

	/** Decayed attention: one look (its slower first movement is the re-orientation), then a still. */
	glance(): void {
		const dwell = sampleRange(O.glanceDwellMs, this.rng);
		const kings = this.opts.kings;
		const step = this.readings[0]?.steps[0];
		const threat = this.opts.threats?.[0];
		if (kings && this.rng.chance(O.kingOwnProb))
			this.visit(kings.own, "own", "hover", dwell, "glance");
		else if (threat) this.visit(threat, "own", "hover", dwell, "glance");
		else if (step) this.visit(step.from, step.side, "hover", dwell, "glance");
		else if (kings) this.visit(kings.own, "own", "hover", dwell, "glance");
	}

	/**
	 * A still: possibly a walk to a rest spot first (never straight after another still), then
	 * a few long dwells, each with the idle tremor.
	 */
	still(): void {
		if (this.opts.previousSpell !== "still" && this.rng.chance(O.restMoveProb)) this.restSpot();
		while (this.room() > O.minDwellMs) {
			const dwell = Math.min(this.room(), sampleRange(O.stillDwellMs, this.rng));
			this.dwell(dwell, "rest");
		}
	}

	// ── activities ────────────────────────────────────────────────────────

	private chooseActivity(firstLook: boolean): Activity | null {
		const W = O.activityWeights;
		const sharp = this.opts.attention?.sharp === true ? O.sharpActivityScale : 1;
		const hasThreats = (this.opts.threats?.length ?? 0) > 0 || this.opts.lastMove !== undefined;
		const hasCandidates =
			this.opts.ownCandidates.length > 0 || (!this.ownOnly && this.opts.opponentCandidates.length > 0);
		const items: Activity[] = ["line", "threat", "candidates", "king", "offBoard"];
		const weights = [
			this.readings.length > 0 ? W.line * sharp * (firstLook ? O.firstLookLineScale : 1) : 0,
			hasThreats ? W.threat * sharp : 0,
			hasCandidates ? W.candidates : 0,
			this.opts.kings ? W.king : 0,
			this.ownOnly ? 0 : W.offBoard,
		];
		if (!weights.some((weight) => weight > 0)) return null;
		return this.rng.weighted(items, weights);
	}

	private perform(activity: Activity): void {
		if (activity === "line") this.readLine();
		else if (activity === "threat") this.threats();
		else if (activity === "candidates") this.candidates(O.activityCandidateVisits);
		else if (activity === "king") this.king();
		else this.offBoard();
	}

	/** Reply → answer → next in move order, with short dwells; sometimes a second, quicker pass. */
	private readLine(): void {
		const pool =
			this.readings.length > 1 && this.lastLine
				? this.readings.filter((reading) => reading !== this.lastLine)
				: this.readings;
		if (pool.length === 0) return;
		const reading = this.rng.weighted(
			pool,
			pool.map((line) => 1 / (line.rank + 1))
		);
		this.lastLine = reading;
		// A leg refused for room ends the reading: a line is never read with a step left out.
		const pass = (speed: number, dwellScale: number): boolean => {
			for (const step of reading.steps) {
				const fromDwell = sampleRange(O.readFromDwellMs, this.rng) * dwellScale;
				const toDwell = sampleRange(O.readToDwellMs, this.rng) * dwellScale;
				if (this.visit(step.from, step.side, "hover", fromDwell, "line", speed) === "refused")
					return false;
				if (this.visit(step.to, step.side, "trace", toDwell, "line", speed) === "refused") return false;
			}
			return true;
		};
		if (pass(1, 1) && this.rng.chance(O.rereadProb)) pass(O.rereadSpeedScale, O.rereadSpeedScale);
	}

	/** Our pieces the top replies attack, and the piece that just moved. */
	private threats(): void {
		const targets: Array<{ square: Square; side: ExplorationSide }> = shuffle(
			(this.opts.threats ?? []).map((square) => ({ square, side: "own" as const })),
			this.rng
		);
		const last = this.opts.lastMove;
		if (last && !this.ownOnly && this.rng.chance(O.lastMoveFirstProb)) {
			targets.unshift({ square: last.to, side: "opponent" });
		}
		const n = this.rng.int(O.threatVisits[0], O.threatVisits[1]);
		for (const target of targets.slice(0, n)) {
			this.visit(
				target.square,
				target.side,
				"hover",
				sampleRange(O.threatDwellMs, this.rng),
				"threat"
			);
		}
	}

	private king(): void {
		const kings = this.opts.kings;
		if (!kings) return;
		const own = this.ownOnly || this.rng.chance(O.kingOwnProb);
		this.visit(
			own ? kings.own : kings.opponent,
			own ? "own" : "opponent",
			"hover",
			sampleRange(O.kingDwellMs, this.rng),
			"king"
		);
	}

	/** The clock / move list beside the board, or just past an edge; inside the viewport. */
	private offBoard(): void {
		const board = this.opts.geometry.boardRect;
		const band = this.rng.chance(O.offBoardClockProb) ? "clock" : "offBoard";
		const raw = pointInBand(board, band, this.rng);
		const target = {
			x: Math.round(Math.max(O.viewportPadPx, raw.x)),
			y: Math.round(Math.max(O.viewportPadPx, raw.y)),
		};
		const rect = smallRect(target, EXPLORATION.tracePointRectPx);
		this.travelTo(target, rect, sampleRange(O.offBoardDwellMs, this.rng), {
			kind: "offBoard",
			activity: "offBoard",
		});
	}

	/** The pre-2026-09-12 candidate browse: weighted picks, never in rank order. */
	private candidates(visitRange: readonly [number, number]): void {
		const pools = {
			own: uniqueCandidates(this.opts.ownCandidates),
			opponent: this.ownOnly ? [] : uniqueCandidates(this.opts.opponentCandidates),
		};
		const ownBias = sampleRange(O.ownBias, this.rng);
		const visited = new Set<Square>();
		let lastSide: ExplorationSide | null = null;
		const visits = this.rng.int(visitRange[0], visitRange[1]);
		for (let i = 0; i < visits; i++) {
			let side: ExplorationSide = this.rng.chance(ownBias) ? "own" : "opponent";
			if (lastSide && this.rng.chance(O.switchSideProb))
				side = lastSide === "own" ? "opponent" : "own";
			const available = (s: ExplorationSide) => pools[s].filter((move) => !visited.has(move.from));
			let pool = available(side);
			if (pool.length === 0) {
				side = side === "own" ? "opponent" : "own";
				pool = available(side);
			}
			if (pool.length === 0) break;
			const fresh = pool.filter((move) => move.from !== this.lastTarget);
			if (fresh.length > 0) pool = fresh;
			const weights = pool.map((move) => move.probability);
			const candidate = weights.some((weight) => weight > 0)
				? this.rng.weighted(pool, weights)
				: this.rng.pick(pool);
			visited.add(candidate.from);
			const hovered = this.visit(
				candidate.from,
				side,
				"hover",
				sampleRange(O.hoverDwellMs, this.rng),
				"candidates"
			);
			if (hovered !== "done" || this.rng.chance(O.traceProb)) {
				this.visit(candidate.to, side, "trace", sampleRange(O.traceDwellMs, this.rng), "candidates");
			}
			lastSide = side;
			if (this.room() <= O.minDwellMs) break;
			if (i + 1 < visits) this.rest(Math.min(this.room(), sampleRange(O.betweenVisitsMs, this.rng)));
		}
	}

	/** A rest spot: a piece drawn toward the centre, or a point just off the board edge. */
	private restSpot(): void {
		const avoid = new Set<Square | null>([this.lastTarget, this.opts.attention?.intendedTo ?? null]);
		const pieces = (this.opts.pieces ?? []).filter(
			(piece) => !avoid.has(piece.square) && (!this.ownOnly || piece.side === "own")
		);
		if (pieces.length > 0 && this.rng.chance(O.restPieceProb)) {
			const weights = pieces.map(
				(piece) => (4 - fromCentre(piece.square)) ** EXECUTOR.postDropCentreBias
			);
			const piece = this.rng.weighted(pieces, weights);
			this.visit(piece.square, piece.side, "hover", sampleRange(O.stillDwellMs, this.rng), "rest");
			return;
		}
		const raw = pointInBand(this.opts.geometry.boardRect, "offBoard", this.rng);
		const target = {
			x: Math.round(Math.max(O.viewportPadPx, raw.x)),
			y: Math.round(Math.max(O.viewportPadPx, raw.y)),
		};
		this.travelTo(
			target,
			smallRect(target, EXPLORATION.tracePointRectPx),
			sampleRange(O.stillDwellMs, this.rng),
			{
				kind: "offBoard",
				activity: "rest",
			}
		);
	}

	// ── primitives ────────────────────────────────────────────────────────

	private room(): number {
		return this.budget.activeUntil - this.budget.spent;
	}

	rest(ms: number): void {
		const duration = Math.min(ms, Math.max(0, this.budget.total - this.budget.spent));
		if (!(duration > 0)) return;
		this.actions.push({ kind: "rest", dwellMs: duration, activity: "rest" });
		this.budget.spent += duration;
	}

	/** A dwell with the idle tremor: the tremor's one point becomes a `drift` inside it. */
	private dwell(ms: number, activity: ExplorationActivity): void {
		if (!(ms > 0)) return;
		const tremor = idleTremor(this.cursor, ms, this.opts.profile, this.rng);
		const point = tremor[0];
		if (!point || point.dtMs + this.opts.profile.sampleIntervalMs > ms) {
			this.rest(ms);
			return;
		}
		this.rest(point.dtMs);
		const step = { ...point, dtMs: this.opts.profile.sampleIntervalMs };
		const remainder = Math.max(0, ms - point.dtMs - step.dtMs);
		this.actions.push({ kind: "drift", path: [step], dwellMs: remainder, activity });
		this.budget.spent += step.dtMs + remainder;
		this.cursor = { x: step.x, y: step.y };
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

	private travelTo(
		target: Pt,
		rect: Rect,
		dwell: number,
		tag: {
			kind: "hover" | "trace" | "offBoard";
			activity: ExplorationActivity;
			square?: Square;
			side?: ExplorationSide;
		},
		speed = 1
	): boolean {
		const path = generatePath(this.cursor, target, rect, this.movementProfile(speed), this.rng);
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
		this.cursor = lastPoint(path, this.cursor);
		this.dwellAfter(action, dwellMs);
		return true;
	}

	/** Split a dwell between the action and a tremor drift, when the tremor fires. */
	private dwellAfter(action: OpponentExplorationAction, ms: number): void {
		const tremor = idleTremor(this.cursor, ms, this.opts.profile, this.rng);
		const point = tremor[0];
		if (!point || point.dtMs + this.opts.profile.sampleIntervalMs > ms) {
			action.dwellMs = ms;
			this.budget.spent += ms;
			return;
		}
		action.dwellMs = point.dtMs;
		this.budget.spent += point.dtMs;
		const step = { ...point, dtMs: this.opts.profile.sampleIntervalMs };
		const remainder = Math.max(0, ms - point.dtMs - step.dtMs);
		this.actions.push({
			kind: "drift",
			path: [step],
			dwellMs: remainder,
			activity: action.activity ?? "rest",
		});
		this.budget.spent += step.dtMs + remainder;
		this.cursor = { x: step.x, y: step.y };
	}

	private visit(
		square: Square,
		side: ExplorationSide,
		kind: "hover" | "trace",
		dwell: number,
		activity: ExplorationActivity,
		speed = 1
	): VisitResult {
		if (this.lastTarget === square) return "skipped";
		if (this.ownOnly && side !== "own") return "skipped";
		const rect = this.opts.geometry.squareRect(square);
		if (!validRect(rect)) return "skipped";
		// Looking at the piece under a stationary cursor needs no little repositioning loop.
		if (kind === "hover" && inRect(this.cursor, rect)) return "skipped";
		const target = samplePointInRect(
			rect,
			SAMPLING.hover.sigmaFrac,
			SAMPLING.hover.innerFrac,
			this.rng
		);
		if (!this.travelTo(target, rect, dwell, { kind, activity, square, side }, speed)) {
			return "refused";
		}
		this.lastTarget = square;
		return "done";
	}
}

function uniqueCandidates(input: readonly MoveCandidate[]): MoveCandidate[] {
	const seen = new Set<string>();
	return input
		.filter((move) => {
			const key = `${move.from}${move.to}`;
			if (move.from === move.to || seen.has(key)) return false;
			seen.add(key);
			return true;
		})
		.map((move) => ({
			...move,
			probability: Number.isFinite(move.probability) ? Math.max(0, move.probability) : 0,
		}));
}

/** Chebyshev distance from the board's centre: 0.5 for the four middle squares, 3.5 at the rim. */
function fromCentre(square: Square): number {
	return Math.max(Math.abs(fileOf(square) - 3.5), Math.abs(rankOf(square) - 3.5));
}

function shuffle<T>(items: readonly T[], rng: Rng): T[] {
	const out = [...items];
	for (let i = out.length - 1; i > 0; i--) {
		const j = rng.int(0, i);
		const a = out[i];
		const b = out[j];
		if (a !== undefined && b !== undefined) {
			out[i] = b;
			out[j] = a;
		}
	}
	return out;
}

function validRect(rect: Rect): boolean {
	return (
		Number.isFinite(rect.left) &&
		Number.isFinite(rect.top) &&
		Number.isFinite(rect.width) &&
		Number.isFinite(rect.height) &&
		rect.width > 0 &&
		rect.height > 0
	);
}
