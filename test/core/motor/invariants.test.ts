// test/core/motor/invariants.test.ts — Step 5 / §9.6a: 500 random simulated moves.
import { describe, expect, it } from "bun:test";
import { CLICK, MOTOR_DEFAULTS, PROFILE_NOISE, SAMPLING } from "@core/motor/constants";
import { ExplorationPlanner } from "@core/motor/exploration";
import { perGameProfile, perMoveProfile, sampleRange } from "@core/motor/motor-profile";
import { generatePath, grabWobble } from "@core/motor/path-generator";
import { clickReleasePoint, plausibleStart, samplePointInRect } from "@core/motor/sampling";
import type { MotorProfile, PathPoint, Pt } from "@core/motor/types";
import { createRng, type Rng } from "@core/rng";
import type { Square } from "@typedefs/game";
import { ALL_SQUARES, BOARD, dist, geometry, inside, squareRect } from "./fixtures";

interface Press {
	at: Pt;
	square: Square;
	kind: "committed-from" | "committed-to" | "preview" | "preview-deselect";
}

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

function randomPosition(rng: Rng) {
	const squares = [...ALL_SQUARES];
	const own: Square[] = [];
	for (let i = 0; i < 6; i++) own.push(squares.splice(rng.int(0, squares.length - 1), 1)[0]!);
	const dests = new Map<Square, Square[]>();
	for (const sq of own) {
		const n = rng.int(0, 5);
		const pool = ALL_SQUARES.filter((s) => !own.includes(s));
		const d: Square[] = [];
		for (let i = 0; i < n; i++) d.push(pool.splice(rng.int(0, pool.length - 1), 1)[0]!);
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
		legalDestinations: (sq: Square) => dests.get(sq) ?? [],
	};
}

function checkPath(start: Pt, path: PathPoint[], m: MotorProfile) {
	let prev = start;
	for (const p of path) {
		expect(Number.isInteger(p.x) && Number.isInteger(p.y)).toBe(true);
		expect(p.dtMs).toBeGreaterThan(0);
		if (p.x === prev.x && p.y === prev.y) expect(p.dtMs).toBeGreaterThan(0);
		expect((dist(prev, p) / p.dtMs) * 1000).toBeLessThanOrEqual(m.peakSpeedCapPxPerS + 1e-6);
		expect(dist(prev, p)).toBeLessThanOrEqual((m.peakSpeedCapPxPerS * m.sampleIntervalMs) / 1000 + 1);
		prev = p;
	}
}

describe("motor invariants (500 random moves)", () => {
	it("holds every §9.6a invariant across a simulated game sequence", () => {
		const rng = createRng("invariants");
		const game = perGameProfile(MOTOR_DEFAULTS, rng);
		const planner = new ExplorationPlanner();
		const seenPaths = new Set<string>();
		let cursor: Pt = plausibleStart(BOARD, rng);
		let previews = 0;
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
			const presses: Press[] = [];
			const fromRect = squareRect(pos.committed.from);
			const toRect = squareRect(pos.committed.to);
			const style = rng.chance(0.6) ? "drag" : "click";

			// Exploration (pre-touch window) — previews are the only non-committed presses.
			const actions = planner.plan(rng.int(300, 5000), pos.candidates, GEO, m, rng, {
				thinkMs: rng.int(300, 8000),
				mode: rng.pick(["normal", "long", "premove", "instant"] as const),
				nReasonable: pos.candidates.length,
				myClockMs: rng.int(5_000, 120_000),
				persona: "balanced",
				previewScale: 1,
				committed: pos.committed,
				legalDestinations: pos.legalDestinations,
				cursor,
			});
			let selected: Square | null = null;
			for (const a of actions) {
				if (a.path) {
					checkPath(cursor, a.path, m);
					const last = a.path[a.path.length - 1];
					if (last) cursor = { x: last.x, y: last.y };
				}
				const pv = a.preview;
				if (!pv) continue;
				previews++;
				expect(selected).toBeNull();
				expect(inside(pv.press, pv.pieceRect)).toBe(true);
				presses.push({ at: pv.press, square: pv.piece, kind: "preview" });
				selected = pv.piece;
				const dests = pos.legalDestinations(pv.piece);
				if (pv.dragPath) {
					checkPath(pv.press, pv.dragPath, m);
					expect(inside(pv.release, pv.pieceRect)).toBe(true);
				} else expect(dist(pv.press, pv.release)).toBeLessThanOrEqual(2);
				checkPath(pv.release, pv.hoverPath, m);
				cursor = pv.hoverPoint;
				if (pv.deselect) {
					checkPath(cursor, pv.deselect.path, m);
					expect(dests).not.toContain(pv.deselect.square);
					expect(dist(pv.deselect.press, pv.deselect.release)).toBeLessThanOrEqual(2);
					presses.push({ at: pv.deselect.press, square: pv.deselect.square, kind: "preview-deselect" });
					selected = null;
					cursor = pv.deselect.release;
				} else {
					expect(pv.resolve).toBe("switch");
					expect(dests).not.toContain(pos.committed.from);
					expect(pv.piece).not.toBe(pos.committed.from);
				}
			}
			// The committed press resolves any remaining (switch-mode) selection: it is never a
			// legal destination of the selected piece, so it selects the committed piece.
			if (selected !== null) expect(pos.legalDestinations(selected)).not.toContain(pos.committed.from);

			// Committed move.
			const press = samplePointInRect(
				fromRect,
				SAMPLING.press.sigmaFrac,
				SAMPLING.press.innerFrac,
				rng
			);
			const approach = generatePath(cursor, press, fromRect, m, rng);
			if (approach.length > 0) {
				checkPath(cursor, approach, m);
				expect(dist(cursor, approach[0]!)).toBeLessThanOrEqual(12);
				const last = approach[approach.length - 1]!;
				expect(inside(last, fromRect)).toBe(true);
				cursor = { x: last.x, y: last.y };
				seenPaths.add(JSON.stringify(approach));
			}
			expect(inside(cursor, fromRect)).toBe(true);
			presses.push({ at: cursor, square: pos.committed.from, kind: "committed-from" });
			if (style === "drag") {
				const wobble = grabWobble(cursor, m, rng);
				checkPath(cursor, wobble, m);
				cursor = { x: wobble[wobble.length - 1]!.x, y: wobble[wobble.length - 1]!.y };
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
			} else {
				const release = clickReleasePoint(cursor, rng);
				expect(dist(cursor, release)).toBeLessThanOrEqual(2);
				cursor = release;
				const second = samplePointInRect(
					toRect,
					SAMPLING.press.sigmaFrac,
					SAMPLING.press.innerFrac,
					rng
				);
				const travel = generatePath(cursor, second, toRect, m, rng);
				checkPath(cursor, travel, m);
				const last = travel[travel.length - 1]!;
				cursor = { x: last.x, y: last.y };
				expect(inside(cursor, toRect)).toBe(true);
				presses.push({ at: cursor, square: pos.committed.to, kind: "committed-to" });
				const rel = clickReleasePoint(cursor, rng);
				expect(dist(cursor, rel)).toBeLessThanOrEqual(2);
				cursor = rel;
				expect(sampleRange(CLICK.interClickGapMs, rng)).toBeGreaterThanOrEqual(
					CLICK.interClickGapMs[0]
				);
			}
			// Every press is the committed move or a modelled, resolved preview.
			for (const p of presses)
				expect(["committed-from", "committed-to", "preview", "preview-deselect"]).toContain(p.kind);
			expect(presses.filter((p) => p.kind === "committed-from").length).toBe(1);
		}
		expect(moves).toBe(500);
		expect(previews).toBeGreaterThan(0);
		expect(seenPaths.size).toBeGreaterThan(500);
	});
});
