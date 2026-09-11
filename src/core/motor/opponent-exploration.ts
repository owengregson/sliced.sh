/** Candidate-driven free pointer movement while waiting for the opponent; never selects a piece. */
import type { Rng } from "@core/rng";
import type { Square } from "@typedefs/game";
import { OPPONENT_EXPLORATION as O, SAMPLING } from "./constants";
import { inRect, lastPoint, pathMs, sampleRange } from "./geometry";
import type { OpponentExplorationPolicy } from "./opponent-candidates";
import { generatePath } from "./path-generator";
import { samplePointInRect } from "./sampling";
import type { BoardGeometry, MotorProfile, MoveCandidate, PathPoint, Pt, Rect } from "./types";

export type ExplorationSide = "own" | "opponent";

export interface OpponentExplorationAction {
	kind: "hover" | "trace" | "rest";
	path?: PathPoint[];
	dwellMs: number;
	/** The candidate square this free movement considers, for diagnostics. */
	square?: Square;
	side?: ExplorationSide;
}

export interface OpponentExplorationOptions {
	geometry: BoardGeometry;
	profile: MotorProfile;
	cursor: Pt;
	ownCandidates: readonly MoveCandidate[];
	opponentCandidates: readonly MoveCandidate[];
	policy?: OpponentExplorationPolicy;
	/** The last inspected square of the previous bout; avoids restarting on the same piece. */
	previousTarget?: Square;
}

export interface OpponentExplorationPlan {
	actions: OpponentExplorationAction[];
	durationMs: number;
	lastTarget: Square | null;
}

/** Plan one finite activity bout. The caller refreshes candidates/geometry and cancels on a turn change. */
export function planOpponentExploration(
	opts: OpponentExplorationOptions,
	rng: Rng
): OpponentExplorationPlan {
	const lowTime = opts.policy?.lowTime === true;
	const ownOnly = lowTime || opts.policy?.ownOnly === true;
	const durationMs = sampleRange(lowTime ? O.lowTimeBoutMs : O.boutMs, rng);
	const activeUntil = durationMs * sampleRange(lowTime ? O.lowTimeActiveFrac : O.activeFrac, rng);
	const actions: OpponentExplorationAction[] = [];
	const pools = {
		own: candidates(opts.ownCandidates),
		opponent: ownOnly ? [] : candidates(opts.opponentCandidates),
	};
	let cursor = { ...opts.cursor };
	let lastTarget = opts.previousTarget ?? null;
	let spent = 0;
	let lastSide: ExplorationSide | null = null;
	const ownBias = sampleRange(O.ownBias, rng);
	const visited = new Set<Square>();

	const rest = (ms: number): void => {
		if (!(ms > 0)) return;
		actions.push({ kind: "rest", dwellMs: ms });
		spent += ms;
	};
	const visit = (
		square: Square,
		side: ExplorationSide,
		kind: "hover" | "trace",
		dwell: number
	): boolean => {
		if (lastTarget === square) return false;
		const rect = opts.geometry.squareRect(square);
		if (!validRect(rect)) return false;
		// Looking at the piece under a stationary cursor needs no little repositioning loop.
		if (kind === "hover" && inRect(cursor, rect)) return false;
		const target = samplePointInRect(rect, SAMPLING.hover.sigmaFrac, SAMPLING.hover.innerFrac, rng);
		const path = generatePath(cursor, target, rect, opts.profile, rng);
		const travelMs = pathMs(path);
		const room = activeUntil - spent - travelMs;
		if (path.length === 0 || room < O.minDwellMs) return false;
		const dwellMs = Math.min(dwell, room);
		actions.push({ kind, square, side, path, dwellMs });
		spent += travelMs + dwellMs;
		cursor = lastPoint(path, cursor);
		lastTarget = square;
		lastSide = side;
		return true;
	};

	if (!validRect(opts.geometry.boardRect)) {
		rest(durationMs);
		return { actions, durationMs, lastTarget };
	}
	rest(sampleRange(O.orientationMs, rng));
	const visitRange = lowTime ? O.lowTimeVisits : O.visits;
	const visits = rng.int(visitRange[0], visitRange[1]);
	for (let i = 0; i < visits; i++) {
		let side: ExplorationSide = rng.chance(ownBias) ? "own" : "opponent";
		if (lastSide && rng.chance(O.switchSideProb)) side = lastSide === "own" ? "opponent" : "own";
		const available = (s: ExplorationSide) => pools[s].filter((move) => !visited.has(move.from));
		let pool = available(side);
		if (pool.length === 0) {
			side = side === "own" ? "opponent" : "own";
			pool = available(side);
		}
		if (pool.length === 0) break;
		const fresh = pool.filter((move) => move.from !== lastTarget);
		if (fresh.length > 0) pool = fresh;
		const weights = pool.map((move) => move.probability);
		const candidate = weights.some((weight) => weight > 0)
			? rng.weighted(pool, weights)
			: rng.pick(pool);
		visited.add(candidate.from);
		const hovered = visit(candidate.from, side, "hover", sampleRange(O.hoverDwellMs, rng));
		if (!hovered || rng.chance(O.traceProb)) {
			visit(candidate.to, side, "trace", sampleRange(O.traceDwellMs, rng));
		}
		const room = activeUntil - spent;
		if (room <= O.minDwellMs) break;
		if (i + 1 < visits) rest(Math.min(room, sampleRange(O.betweenVisitsMs, rng)));
	}
	rest(Math.max(0, durationMs - spent));
	return { actions, durationMs, lastTarget };
}

function candidates(input: readonly MoveCandidate[]): MoveCandidate[] {
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
