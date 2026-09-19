import { describe, expect, it } from "bun:test";
import type { MoveQuality } from "@core/constants/move-quality";
import { BRILLIANT } from "@core/constants/review";
import { evaluateBrilliant, planBrilliant } from "@core/engine/brilliant";
import {
	classifyMoveQuality,
	type MoveQualityInput,
	passedBrilliantGates,
} from "@core/engine/move-quality";
import { Chess } from "chess.js";

const fixture = (await Bun.file(
	new URL("../../fixtures/review/false-brilliant-180027994972.json", import.meta.url)
).json()) as {
	pgn: string;
	reportedPly: number;
	input: MoveQualityInput;
	originalVerdict: { quality: string };
};

const positives = (await Bun.file(
	new URL("../../fixtures/review/mating-threat-positive-controls.json", import.meta.url)
).json()) as {
	controls: Array<{ san: string; input: MoveQualityInput; expectedQuality: MoveQuality }>;
};

describe("180027994972 — 12...Qf6 is a mating threat, not a sacrifice", () => {
	it.each(positives.controls)(
		"preserves the known Brilliant gates for $san",
		({ input, expectedQuality }) => {
			const result = classifyMoveQuality(input);
			expect(passedBrilliantGates(result)).toBe(true);
			expect(result?.quality).toBe(expectedQuality);
		}
	);
	it("replays the complete supplied game and the reported move", () => {
		const board = new Chess();
		board.loadPgn(fixture.pgn);
		const moves = board.history({ verbose: true });
		expect(moves[fixture.reportedPly - 1]?.before).toBe(fixture.input.fen);
		expect(moves[fixture.reportedPly - 1]?.lan).toBe("d8f6");
		expect(board.isCheckmate()).toBe(true);
	});
	it("rejects each apparent gift with a legal forced mating line", () => {
		for (const line of [
			["Qf6", "Qxe4", "Qxf2+", "Kh1", "Qg1#"],
			["Qf6", "Kxf1", "Qxf2#"],
		]) {
			const board = new Chess(fixture.input.fen);
			for (const san of line) board.move(san);
			expect(board.isCheckmate()).toBe(true);
		}
	});
	it("corrects Brilliant to Great on identical full-network evidence, independently of the PV", () => {
		expect(fixture.originalVerdict.quality).toBe("brilliant");
		for (const pv of [undefined, ["d8f6"], ["d8f6", "d5c5", "e4c5"], ["d8f6", "d5e4", "f6f2"]]) {
			const before = pv
				? {
						...fixture.input.before,
						lines: fixture.input.before.lines.map((line) =>
							line.pvUci[0] === "d8f6" ? { ...line, pvUci: pv } : line
						),
					}
				: fixture.input.before;
			const result = classifyMoveQuality({ ...fixture.input, before });
			expect(result?.quality).toBe("great");
			expect(result?.brilliant?.reason).toBe("mating-threat");
			expect(result?.loss).toBe(0);
		}
	});
	it("requires a winning non-sacrificing alternative and a complete mate proof", () => {
		const plan = planBrilliant(fixture.input)!;
		const evidence = {
			playedPoints: 0.951,
			loss: 0,
			alternatives: [{ uci: "f1a6", points: 0.919 }],
			moverRating: 2502,
		};
		expect(evaluateBrilliant(plan, evidence).reason).toBe("mating-threat");
		// A proven mating sequence remains eligible for Brilliant; a conditional trap differs.
		expect(evaluateBrilliant(plan, { ...evidence, playedMate: 3 }).reason).not.toBe("mating-threat");
		expect(
			evaluateBrilliant(plan, { ...evidence, alternatives: [{ uci: "f1a6", points: 0.5 }] }).brilliant
		).toBe(true);
		// One capture only mates in two: finding the other branch's mate in one is insufficient.
		expect(
			evaluateBrilliant(plan, evidence, { ...BRILLIANT, ignoredThreatMatePlies: 1 }).reason
		).not.toBe("mating-threat");
		expect(evaluateBrilliant(plan, evidence, { ...BRILLIANT, maxExchangeNodes: 0 }).reason).not.toBe(
			"mating-threat"
		);
	});
});
