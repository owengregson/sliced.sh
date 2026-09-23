/**
 * What an active spell does with its time, each read from the position rather than browsed from a
 * list: read a line, check a threat, glance at a king or the clock, browse the candidates, walk
 * to a rest spot, or look at whatever is nearest. Every activity spends its time through the
 * spell's `SpellTimeline`, which refuses a leg that no longer fits.
 */
import { fileOf, rankOf } from "@core/chess/squares";
import { EXECUTOR } from "@core/constants/cdp";
import type { Rng } from "@core/rng";
import type { Square } from "@typedefs/game";
import { EXPLORATION, OPPONENT_EXPLORATION as O } from "../constants";
import { sampleRange, smallRect } from "../geometry";
import type { LineReading } from "../opponent-candidates";
import { pointInBand } from "../sampling";
import type { MoveCandidate, Pt, Rect } from "../types";
import type { SpellTimeline } from "./timeline";
import type { ExplorationSide, OpponentExplorationOptions } from "./types";

/** An active spell's weighted choices (`glance`/`rest` are spells of their own). */
export type Activity = "line" | "threat" | "candidates" | "king" | "offBoard";

/** What the activities of one spell share: the position's reading, the hand and the stream. */
export interface SpellScene {
	readonly opts: OpponentExplorationOptions;
	/** Low time or an own-only policy: the opponent's pieces are never visited. */
	readonly ownOnly: boolean;
	/** The lines in reading order, trimmed to our own steps under `ownOnly`, none empty. */
	readonly readings: LineReading[];
	readonly hand: SpellTimeline;
	readonly rng: Rng;
	/** The line read last in this spell; a second reading prefers another. */
	lastLine: LineReading | null;
}

export function chooseActivity(scene: SpellScene, firstLook: boolean): Activity | null {
	const { opts, ownOnly, rng } = scene;
	const W = O.activityWeights;
	const sharp = opts.attention?.sharp === true ? O.sharpActivityScale : 1;
	const hasThreats = (opts.threats?.length ?? 0) > 0 || opts.lastMove !== undefined;
	const hasCandidates =
		opts.ownCandidates.length > 0 || (!ownOnly && opts.opponentCandidates.length > 0);
	const items: Activity[] = ["line", "threat", "candidates", "king", "offBoard"];
	const weights = [
		scene.readings.length > 0 ? W.line * sharp * (firstLook ? O.firstLookLineScale : 1) : 0,
		hasThreats ? W.threat * sharp : 0,
		hasCandidates ? W.candidates : 0,
		opts.kings ? W.king : 0,
		ownOnly ? 0 : W.offBoard,
	];
	if (!weights.some((weight) => weight > 0)) return null;
	return rng.weighted(items, weights);
}

export function perform(scene: SpellScene, activity: Activity): void {
	if (activity === "line") readLine(scene);
	else if (activity === "threat") threats(scene);
	else if (activity === "candidates") candidates(scene, O.activityCandidateVisits);
	else if (activity === "king") king(scene);
	else offBoard(scene);
}

/** Reply → answer → next in move order, with short dwells; sometimes a second, quicker pass. */
export function readLine(scene: SpellScene): void {
	const { readings, hand, rng } = scene;
	const pool =
		readings.length > 1 && scene.lastLine
			? readings.filter((reading) => reading !== scene.lastLine)
			: readings;
	if (pool.length === 0) return;
	const reading = rng.weighted(
		pool,
		pool.map((line) => 1 / (line.rank + 1))
	);
	scene.lastLine = reading;
	// A leg refused for room ends the reading: a line is never read with a step left out.
	const pass = (speed: number, dwellScale: number): boolean => {
		for (const step of reading.steps) {
			const fromDwell = sampleRange(O.readFromDwellMs, rng) * dwellScale;
			const toDwell = sampleRange(O.readToDwellMs, rng) * dwellScale;
			if (hand.visit(step.from, step.side, "hover", fromDwell, "line", speed) === "refused")
				return false;
			if (hand.visit(step.to, step.side, "trace", toDwell, "line", speed) === "refused") return false;
		}
		return true;
	};
	if (pass(1, 1) && rng.chance(O.rereadProb)) pass(O.rereadSpeedScale, O.rereadSpeedScale);
}

/** Our pieces the top replies attack, and the piece that just moved. */
export function threats(scene: SpellScene): void {
	const { opts, hand, rng } = scene;
	const targets: Array<{ square: Square; side: ExplorationSide }> = shuffle(
		(opts.threats ?? []).map((square) => ({ square, side: "own" as const })),
		rng
	);
	const last = opts.lastMove;
	if (last && !scene.ownOnly && rng.chance(O.lastMoveFirstProb)) {
		targets.unshift({ square: last.to, side: "opponent" });
	}
	const n = rng.int(O.threatVisits[0], O.threatVisits[1]);
	for (const target of targets.slice(0, n)) {
		hand.visit(target.square, target.side, "hover", sampleRange(O.threatDwellMs, rng), "threat");
	}
}

export function king(scene: SpellScene): void {
	const { opts, hand, rng } = scene;
	const kings = opts.kings;
	if (!kings) return;
	const own = scene.ownOnly || rng.chance(O.kingOwnProb);
	hand.visit(
		own ? kings.own : kings.opponent,
		own ? "own" : "opponent",
		"hover",
		sampleRange(O.kingDwellMs, rng),
		"king"
	);
}

/** The clock / move list beside the board, or just past an edge; inside the viewport. */
export function offBoard(scene: SpellScene): void {
	const { opts, hand, rng } = scene;
	const band = rng.chance(O.offBoardClockProb) ? "clock" : "offBoard";
	const target = viewportPoint(opts.geometry.boardRect, band, rng);
	const rect = smallRect(target, EXPLORATION.tracePointRectPx);
	hand.travelTo(target, rect, sampleRange(O.offBoardDwellMs, rng), {
		kind: "offBoard",
		activity: "offBoard",
	});
}

/** The pre-2026-09-12 candidate browse: weighted picks, never in rank order. */
export function candidates(scene: SpellScene, visitRange: readonly [number, number]): void {
	const { opts, hand, rng } = scene;
	const pools = {
		own: uniqueCandidates(opts.ownCandidates),
		opponent: scene.ownOnly ? [] : uniqueCandidates(opts.opponentCandidates),
	};
	const ownBias = sampleRange(O.ownBias, rng);
	const visited = new Set<Square>();
	let lastSide: ExplorationSide | null = null;
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
		const fresh = pool.filter((move) => move.from !== hand.lastTarget);
		if (fresh.length > 0) pool = fresh;
		const weights = pool.map((move) => move.probability);
		const candidate = weights.some((weight) => weight > 0)
			? rng.weighted(pool, weights)
			: rng.pick(pool);
		visited.add(candidate.from);
		const hovered = hand.visit(
			candidate.from,
			side,
			"hover",
			sampleRange(O.hoverDwellMs, rng),
			"candidates"
		);
		if (hovered !== "done" || rng.chance(O.traceProb)) {
			hand.visit(candidate.to, side, "trace", sampleRange(O.traceDwellMs, rng), "candidates");
		}
		lastSide = side;
		if (hand.room() <= O.minDwellMs) break;
		if (i + 1 < visits) hand.rest(Math.min(hand.room(), sampleRange(O.betweenVisitsMs, rng)));
	}
}

/** A rest spot: a piece drawn toward the centre, or a point just off the board edge. */
export function restSpot(scene: SpellScene): void {
	const { opts, hand, rng } = scene;
	const avoid = new Set<Square | null>([hand.lastTarget, opts.attention?.intendedTo ?? null]);
	const pieces = (opts.pieces ?? []).filter(
		(piece) => !avoid.has(piece.square) && (!scene.ownOnly || piece.side === "own")
	);
	if (pieces.length > 0 && rng.chance(O.restPieceProb)) {
		const weights = pieces.map(
			(piece) => (4 - fromCentre(piece.square)) ** EXECUTOR.postDropCentreBias
		);
		const piece = rng.weighted(pieces, weights);
		hand.visit(piece.square, piece.side, "hover", sampleRange(O.stillDwellMs, rng), "rest");
		return;
	}
	const target = viewportPoint(opts.geometry.boardRect, "offBoard", rng);
	hand.travelTo(
		target,
		smallRect(target, EXPLORATION.tracePointRectPx),
		sampleRange(O.stillDwellMs, rng),
		{
			kind: "offBoard",
			activity: "rest",
		}
	);
}

/** The nearest square worth a look — a line's piece, a threat, a king, a candidate. */
export function nearestLook(scene: SpellScene): void {
	const { opts, hand, rng } = scene;
	const squares = new Map<Square, ExplorationSide>();
	for (const reading of scene.readings) {
		for (const step of reading.steps) squares.set(step.from, step.side);
	}
	for (const square of opts.threats ?? []) squares.set(square, "own");
	for (const move of opts.ownCandidates) squares.set(move.from, "own");
	if (!scene.ownOnly) for (const move of opts.opponentCandidates) squares.set(move.from, "opponent");
	if (opts.kings) squares.set(opts.kings.own, "own");
	const cursor = hand.cursor;
	const byDistance = [...squares.entries()]
		.filter(([square]) => square !== hand.lastTarget)
		.map(([square, side]) => {
			const rect = opts.geometry.squareRect(square);
			const centre = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
			return { square, side, d: Math.hypot(centre.x - cursor.x, centre.y - cursor.y) };
		})
		.sort((a, b) => a.d - b.d);
	for (const { square, side } of byDistance.slice(0, O.nearestLookTries)) {
		const dwell = sampleRange(O.glanceDwellMs, rng);
		if (hand.visit(square, side, "hover", dwell, "glance") === "done") return;
	}
}

/** A point in `band` around the board, rounded and kept `viewportPadPx` inside the viewport. */
function viewportPoint(board: Rect, band: "clock" | "offBoard", rng: Rng): Pt {
	const raw = pointInBand(board, band, rng);
	return {
		x: Math.round(Math.max(O.viewportPadPx, raw.x)),
		y: Math.round(Math.max(O.viewportPadPx, raw.y)),
	};
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
