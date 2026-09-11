// test/core/motor/invariants.test.ts — Step 5 / §9.6a: 500 random simulated moves with a
// site-faithful selection model (chessground / chess.com: a press on a legal destination of
// the selected piece plays that move; a press on an own piece selects it; anything else clears).
import { describe, expect, it } from "bun:test";
import { MOTOR_DEFAULTS, PROFILE_NOISE, SAMPLING } from "@core/motor/constants";
import { ExplorationPlanner } from "@core/motor/exploration";
import { perGameProfile, perMoveProfile } from "@core/motor/motor-profile";
import { generatePath, grabWobble } from "@core/motor/path-generator";
import { plausibleStart, samplePointInRect } from "@core/motor/sampling";
import type { MotorProfile, Occupancy, PathPoint, Pt } from "@core/motor/types";
import { createRng, type Rng } from "@core/rng";
import type { Square } from "@typedefs/game";
import { ALL_SQUARES, BOARD, dist, geometry, inside, squareRect } from "./fixtures";

const GEO = geometry();
const NUMERIC_KEYS = [
	"fittsA",
	"fittsB",
	"travelSpeedScale",
	"peakSpeedCapPxPerS",
	"jitterPx",
	"overshootProb",
	"hesitationProb",
	"microCorrectionProb",
] as const;

interface Position {
	candidates: Array<{ from: Square; to: Square; probability: number; uci: string }>;
	committed: { from: Square; to: Square };
	legalDestinations(sq: Square): Square[];
	occupancy(sq: Square): Occupancy;
}

/** Six own pieces, six enemy pieces; own destinations may include own squares (castling-like). */
function randomPosition(rng: Rng): Position | null {
	const squares = [...ALL_SQUARES];
	const take = (): Square => squares.splice(rng.int(0, squares.length - 1), 1)[0]!;
	const own: Square[] = [];
	const enemy: Square[] = [];
	for (let i = 0; i < 6; i++) own.push(take());
	for (let i = 0; i < 6; i++) enemy.push(take());
	const occ = new Map<Square, Occupancy>();
	for (const s of own) occ.set(s, "own");
	for (const s of enemy) occ.set(s, "enemy");
	const dests = new Map<Square, Square[]>();
	for (const sq of own) {
		const n = rng.int(0, 5);
		const pool = ALL_SQUARES.filter((s) => occ.get(s) !== "own");
		const d: Square[] = [];
		for (let i = 0; i < n; i++) d.push(pool.splice(rng.int(0, pool.length - 1), 1)[0]!);
		if (rng.chance(0.4)) d.push(rng.pick(own.filter((s) => s !== sq))); // king → rook style
		dests.set(sq, d);
	}
	const movable = own.filter((s) => (dests.get(s)?.length ?? 0) > 0);
	if (movable.length === 0) return null;
	const cands = movable.slice(0, 3).map((from, i) => {
		const to = rng.pick(dests.get(from) ?? []);
		return { from, to, probability: [0.6, 0.3, 0.1][i] ?? 0.1, uci: `${from}${to}` };
	});
	return {
		candidates: cands,
		committed: cands[0]!,
		legalDestinations: (sq) => dests.get(sq) ?? [],
		occupancy: (sq) => occ.get(sq) ?? "empty",
	};
}

function checkPath(start: Pt, path: PathPoint[], m: MotorProfile) {
	let prev = start;
	for (const p of path) {
		expect(Number.isInteger(p.x) && Number.isInteger(p.y)).toBe(true);
		expect(p.dtMs).toBeGreaterThan(0);
		expect((dist(prev, p) / p.dtMs) * 1000).toBeLessThanOrEqual(m.peakSpeedCapPxPerS + 1e-6);
		expect(dist(prev, p)).toBeLessThanOrEqual((m.peakSpeedCapPxPerS * m.sampleIntervalMs) / 1000 + 1);
		prev = p;
	}
}

/** Site selection model; returns true when the press plays a move. */
function press(sel: { selected: Square | null }, square: Square, pos: Position): boolean {
	if (sel.selected !== null && pos.legalDestinations(sel.selected).includes(square)) {
		sel.selected = null;
		return true;
	}
	sel.selected = pos.occupancy(square) === "own" ? square : null;
	return false;
}

describe("motor invariants (500 random moves)", () => {
	it("holds every §9.6a invariant across a simulated game sequence", () => {
		const rng = createRng("invariants");
		const game = perGameProfile(MOTOR_DEFAULTS, rng);
		const planner = new ExplorationPlanner();
		const seenPaths = new Set<string>();
		let cursor: Pt = plausibleStart(BOARD, rng);
		let previews = 0;
		let maxPresses = 0;
		let idleSwitches = 0;
		let switches = 0;
		let moves = 0;
		while (moves < 500) {
			const pos = randomPosition(rng);
			if (!pos) continue;
			moves++;
			const m = perMoveProfile(game, rng);
			for (const k of NUMERIC_KEYS) {
				const r = m[k] / game[k];
				expect(r).toBeGreaterThanOrEqual(1 - PROFILE_NOISE.perMoveClamp - 1e-9);
				expect(r).toBeLessThanOrEqual(1 + PROFILE_NOISE.perMoveClamp + 1e-9);
			}
			const fromRect = squareRect(pos.committed.from);
			const toRect = squareRect(pos.committed.to);
			const sel = { selected: null as Square | null };
			let pressCount = 0;
			/** What the plan says the page will be pressed on: one press per preview leg. */
			let plannedPresses = 0;

			// Exploration (pre-touch window) — previews are the only non-committed presses.
			const actions = planner.plan(rng.int(300, 5000), pos.candidates, GEO, m, rng, {
				thinkMs: rng.int(300, 10_000),
				mode: rng.pick(["normal", "long", "premove", "instant"] as const),
				nReasonable: pos.candidates.length,
				myClockMs: rng.int(5_000, 120_000),
				persona: "balanced",
				previewScale: rng.chance(0.5) ? 2 : 1,
				committed: pos.committed,
				legalDestinations: pos.legalDestinations,
				occupancy: pos.occupancy,
				cursor,
			});
			for (const a of actions) {
				if (a.path) {
					checkPath(cursor, a.path, m);
					const last = a.path[a.path.length - 1];
					if (last) cursor = { x: last.x, y: last.y };
				}
				const pv = a.preview;
				if (!pv) continue;
				previews++;
				pressCount++;
				plannedPresses += 1 + (pv.deselect ? 1 : 0);
				expect(inside(pv.press, pv.pieceRect)).toBe(true);
				expect(pos.occupancy(pv.piece)).toBe("own");
				// The preview press must select, never play a move.
				expect(press(sel, pv.piece, pos)).toBe(false);
				expect(sel.selected).toBe(pv.piece);
				if (pv.dragPath) {
					checkPath(pv.press, pv.dragPath, m);
					expect(inside(pv.release, pv.pieceRect)).toBe(true);
				} else expect(dist(pv.press, pv.release)).toBeLessThanOrEqual(2);
				checkPath(pv.release, pv.hoverPath, m);
				cursor = pv.hoverPoint;
				const d = pv.deselect;
				if (d) {
					pressCount++;
					checkPath(cursor, d.path, m);
					expect(dist(d.press, d.release)).toBeLessThanOrEqual(2);
					expect(inside(d.press, squareRect(d.square))).toBe(true);
					expect(press(sel, d.square, pos)).toBe(false);
					// The resolve label matches what the click actually did.
					expect(d.occupancy).toBe(pos.occupancy(d.square));
					if (pv.resolve === "switch-to-idle") {
						idleSwitches++;
						expect(d.occupancy).toBe("own");
						expect(pos.legalDestinations(d.square)).toEqual([]);
						expect(sel.selected).toBe(d.square);
					} else {
						expect(pv.resolve).toBe("deselect");
						expect(d.occupancy === "empty" || d.occupancy === "enemy").toBe(true);
						expect(sel.selected).toBeNull();
					}
					cursor = d.release;
				} else {
					switches++;
					expect(pv.resolve).toBe("switch");
					expect(sel.selected).toBe(pv.piece);
				}
			}
			// No pending selection can turn the committed press into a move.
			if (sel.selected !== null)
				expect(pos.legalDestinations(sel.selected)).not.toContain(pos.committed.from);

			// Committed move.
			const pressPt = samplePointInRect(
				fromRect,
				SAMPLING.press.sigmaFrac,
				SAMPLING.press.innerFrac,
				rng
			);
			const approach = generatePath(cursor, pressPt, fromRect, m, rng);
			if (approach.length > 0) {
				checkPath(cursor, approach, m);
				expect(dist(cursor, approach[0]!)).toBeLessThanOrEqual(12);
				const last = approach[approach.length - 1]!;
				expect(inside(last, fromRect)).toBe(true);
				cursor = { x: last.x, y: last.y };
				seenPaths.add(JSON.stringify(approach));
			}
			expect(inside(cursor, fromRect)).toBe(true);
			pressCount++;
			expect(press(sel, pos.committed.from, pos)).toBe(false);
			expect(sel.selected).toBe(pos.committed.from);
			// The committed move is a drag, always: grab, travel, release inside the destination.
			// There is no click-click form to simulate — it was removed end to end.
			const wobble = grabWobble(cursor, m, rng);
			checkPath(cursor, wobble, m);
			const settled = wobble.at(-1) ?? cursor;
			cursor = { x: settled.x, y: settled.y };
			const drop = samplePointInRect(
				toRect,
				SAMPLING.release.sigmaFrac,
				SAMPLING.release.innerFrac,
				rng
			);
			const travel = generatePath(cursor, drop, toRect, m, rng);
			checkPath(cursor, travel, m);
			const last = travel[travel.length - 1]!;
			expect(seenPaths.has(JSON.stringify(travel))).toBe(false);
			seenPaths.add(JSON.stringify(travel));
			cursor = { x: last.x, y: last.y };
			expect(inside(cursor, toRect)).toBe(true); // mouseReleased inside its target
			// The page is pressed exactly once for the committed drag plus once per planned preview
			// leg — an equality, so a plan that grew a press the simulation did not walk (or a
			// second committed press) fails here rather than sliding under a slack ceiling.
			expect(pressCount).toBe(1 + plannedPresses);
			maxPresses = Math.max(maxPresses, pressCount);
		}
		expect(moves).toBe(500);
		// and the model's own ceiling — one committed press plus two previews with a deselect each —
		// is never exceeded over the whole run
		expect(maxPresses).toBeLessThanOrEqual(1 + 2 * 2);
		expect(maxPresses).toBeGreaterThan(1);
		expect(previews).toBeGreaterThan(0);
		expect(switches).toBeGreaterThan(0);
		expect(seenPaths.size).toBeGreaterThan(500);
	});
});
