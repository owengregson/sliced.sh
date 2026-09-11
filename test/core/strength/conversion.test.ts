import { describe, expect, it } from "bun:test";
import { loadPosition } from "@core/chess/fen";
import { isLoneKing } from "@core/chess/material";
import { applyMoves } from "@core/chess/san";
import { createRng } from "@core/rng";
import { conversionPool } from "@core/strength/conversion";
import { selectMove } from "@core/strength/move-selector";
import { ctx, line, START } from "./helpers";

const QUEEN = "7k/5K2/6Q1/8/8/8/8/8 w - - 0 1";
const race = { baseMs: 180000, incrementMs: 0, myClockMs: 30000, oppClockMs: 1000 };

describe("winning-position conversion", () => {
	it("plays a legal immediate mate even when a stale cp line rates it below the other move", () => {
		const lines = [line(QUEEN, "g6g5", { cp: 1500 }, 1), line(QUEEN, "g6g7", { cp: 0 }, 2)];
		for (const selectionMode of ["engine-elo", "persona-sampling", "hybrid"] as const) {
			const chosen = selectMove(
				lines,
				ctx({
					...race,
					fen: QUEEN,
					phase: "endgame",
					targetElo: 800,
					selectionMode,
					engineBestmove: "g6g5",
				})
			);
			expect(chosen.uci).toBe("g6g7");
			expect(loadPosition(applyMoves(QUEEN, [chosen.uci]) ?? "")?.isCheckmate()).toBe(true);
		}
	});

	it("vetoes immediate stalemate while retaining an evaluated win", () => {
		const lines = [line(QUEEN, "f7e6", { cp: 1600 }, 1), line(QUEEN, "g6g5", { cp: 1500 }, 2)];
		expect(loadPosition(applyMoves(QUEEN, ["f7e6"]) ?? "")?.isStalemate()).toBe(true);
		const chosen = selectMove(
			lines,
			ctx({ fen: QUEEN, phase: "endgame", targetElo: 3650, engineBestmove: "f7e6" })
		);
		expect(chosen.uci).toBe("g6g5");
		expect(chosen.rationale.join(" ")).toContain("avoiding a searched stalemate");
	});

	it("rejects a PV which exchanges away the final mating material", () => {
		const fen = "8/8/8/8/8/1k6/r7/R6K w - - 0 1";
		const lines = [line(fen, "a1a2", { cp: 500 }, 1, ["b3a2"]), line(fen, "a1c1", { cp: 450 }, 2)];
		expect(loadPosition(applyMoves(fen, ["a1a2", "b3a2"]) ?? "")?.isInsufficientMaterial()).toBe(
			true
		);
		const result = conversionPool(lines, { fen, phase: "endgame" });
		expect(result.avoidedDraw).toBe(true);
		expect(result.lines.map((l) => l.pvUci[0])).toEqual(["a1c1"]);
	});

	it("keeps raw large score differences and protects a won position in a clock race", () => {
		const fen = "7k/8/8/8/8/5K2/6P1/8 w - - 0 1";
		const lines = [line(fen, "g2g3", { cp: 2500 }, 1), line(fen, "f3f4", { cp: 1100 }, 2)];
		for (let seed = 0; seed < 40; seed++) {
			expect(
				selectMove(
					lines,
					ctx({
						...race,
						fen,
						phase: "endgame",
						targetElo: 800,
						blunderScale: 100,
						rng: createRng(seed),
					})
				).uci
			).toBe("g2g3");
		}
	});

	it("prefers pawn progress within a small searched loss, without inventing a win from equality", () => {
		const fen = "7k/8/8/8/8/5K2/6P1/8 w - - 0 1";
		const lines = [line(fen, "f3f4", { cp: 500 }, 1), line(fen, "g2g3", { cp: 480 }, 2)];
		expect(
			selectMove(
				lines,
				ctx({ fen, phase: "endgame", selectionMode: "engine-elo", engineBestmove: "f3f4" })
			).uci
		).toBe("g2g3");
		expect(
			conversionPool(
				lines.map((l) => ({ ...l, score: { cp: 0 } })),
				{ fen, phase: "endgame" }
			).active
		).toBe(false);
	});
});

describe("clock-race strength", () => {
	it("slightly varies near-best moves even at max strength, never large losses or forced losses", () => {
		const lines = [
			line(START, "e2e4", { cp: 50 }, 1),
			line(START, "d2d4", { cp: 20 }, 2),
			line(START, "g1f3", { cp: -100 }, 3),
			line(START, "f2f3", { mate: -5 }, 4),
		];
		const picks = new Set<string>();
		for (let seed = 0; seed < 100; seed++) {
			const chosen = selectMove(
				lines,
				ctx({ ...race, targetElo: 3650, rng: createRng(seed), blunderScale: 100 })
			);
			picks.add(chosen.uci);
			expect(chosen.cpLoss).toBeLessThanOrEqual(60);
			expect(chosen.source).not.toBe("blunder");
		}
		expect([...picks].sort()).toEqual(["d2d4", "e2e4"]);
		expect(selectMove(lines, ctx({ ...race, oppClockMs: 10000, targetElo: 3650 })).uci).toBe("e2e4");
	});

	it("recognises a lone king only for the side with no other pieces", () => {
		expect(isLoneKing(QUEEN, "b")).toBe(true);
		expect(isLoneKing(QUEEN, "w")).toBe(false);
		expect(isLoneKing("invalid", "w")).toBe(false);
	});
});
