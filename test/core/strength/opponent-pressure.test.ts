import { describe, expect, it } from "bun:test";
import { createRng } from "@core/rng";
import { selectMove } from "@core/strength/move-selector";
import { ctx, line } from "./helpers";

const FEN = "6k1/7p/8/8/8/8/7P/R5K1 w - - 0 1";
const rng = () => ({ ...createRng("clock-pressure"), chance: () => true });
const clocks = { fen: FEN, baseMs: 180000, myClockMs: 60000, oppClockMs: 1000, incrementMs: 0 };
const lines = [line(FEN, "a1b1", { cp: 200 }, 1), line(FEN, "a1a8", { cp: 180 }, 2)];

describe("opponent clock selection post-layer", () => {
	it("prefers a searched safe check when the opponent is nearly out of time", () => {
		const chosen = selectMove(
			lines,
			ctx({ ...clocks, selectionMode: "engine-elo", engineBestmove: "a1b1", rng: rng() })
		);
		expect(chosen.uci).toBe("a1a8");
		expect(chosen.cpLoss).toBe(20);
		expect(chosen.rationale.join(" ")).toContain("opponent clock pressure");
	});

	it("does not buy aggression with a bad move or ignore the opponent's increment", () => {
		const expensive = [lines[0]!, line(FEN, "a1a8", { cp: 100 }, 2)];
		expect(
			selectMove(
				expensive,
				ctx({ ...clocks, selectionMode: "engine-elo", engineBestmove: "a1b1", rng: rng() })
			).uci
		).toBe("a1b1");
		expect(
			selectMove(
				lines,
				ctx({
					...clocks,
					incrementMs: 10000,
					selectionMode: "engine-elo",
					engineBestmove: "a1b1",
					rng: rng(),
				})
			).uci
		).toBe("a1b1");
	});

	it("suppresses injected blunders under substantial pressure while retaining forced mate", () => {
		const withBlunder = [...lines, line(FEN, "g1f1", { cp: -900 }, 3)];
		const ordinary = selectMove(
			withBlunder,
			ctx({ ...clocks, oppClockMs: 90000, rng: rng(), blunderScale: 100 })
		);
		expect(ordinary.source).toBe("blunder");
		const pressured = selectMove(withBlunder, ctx({ ...clocks, rng: rng(), blunderScale: 100 }));
		expect(pressured.source).not.toBe("blunder");
		expect(pressured.cpLoss).toBeLessThanOrEqual(35);
		const mating = [line(FEN, "a1a8", { mate: 2 }, 1), lines[0]!];
		const mate = selectMove(mating, ctx({ ...clocks, targetElo: 2000, rng: rng() }));
		expect(mate.uci).toBe("a1a8");
		expect(mate.source).toBe("mate");
	});
});
