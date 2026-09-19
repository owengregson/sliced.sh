import { describe, expect, it } from "bun:test";
import type { MoveQuality } from "@core/constants/move-quality";
import {
	classifyMoveQuality,
	DEFAULT_MOVE_QUALITY_TUNING,
	type MoveQualityInput,
} from "@core/engine/move-quality";
import { Chess } from "chess.js";

const fixture = (await Bun.file(
	new URL("../../fixtures/review/blunder-margins-2450.json", import.meta.url)
).json()) as {
	pgn: string;
	cases: {
		ply: number;
		san: string;
		input: MoveQualityInput;
		originalQuality: MoveQuality;
		expectedQuality: MoveQuality;
	}[];
};

describe("conservative blunder margins", () => {
	it("replays all five reported moves and grades the preserved full-engine evidence", () => {
		const board = new Chess();
		board.loadPgn(fixture.pgn);
		const moves = board.history({ verbose: true });
		for (const entry of fixture.cases) {
			const move = moves[entry.ply - 1];
			expect(move?.before).toBe(entry.input.fen);
			expect(move?.lan).toBe(entry.input.uci);
			expect(move?.san).toBe(entry.san);
			const original = classifyMoveQuality(entry.input, {
				...DEFAULT_MOVE_QUALITY_TUNING,
				classification: {
					...DEFAULT_MOVE_QUALITY_TUNING.classification,
					blunderMinReferenceLoss: 0,
				},
			});
			const current = classifyMoveQuality(entry.input);
			expect(original?.quality).toBe(entry.originalQuality);
			expect(current?.quality).toBe(entry.expectedQuality);
			expect(current?.loss).toBe(original?.loss);
		}
	});

	it("does not turn the 2450 rating multiplier alone into a blunder", () => {
		const input = scoreDrop(0, -180);
		expect(classifyMoveQuality(input)?.loss).toBeGreaterThan(0.2);
		expect(classifyMoveQuality(input)?.quality).toBe("mistake");
	});

	it("admits blunders only past the reference margin at both normal and high Elo", () => {
		for (const moverRating of [1500, 2450]) {
			expect(classifyMoveQuality({ ...scoreDrop(0, -370), moverRating })?.quality).toBe("mistake");
			expect(classifyMoveQuality({ ...scoreDrop(0, -400), moverRating })?.quality).toBe("blunder");
		}
	});

	it("retains clear losses, reversal of an advantage, and allowing forced mate as blunders", () => {
		for (const rating of [700, 1500, 2450]) {
			for (const input of [scoreDrop(0, -600), scoreDrop(300, -300)]) {
				expect(classifyMoveQuality({ ...input, moverRating: rating })?.quality).toBe("blunder");
			}
			const mate = scoreDrop(0, -600);
			mate.after!.lines[0]!.score = { mate: 3 };
			expect(classifyMoveQuality({ ...mate, moverRating: rating })?.quality).toBe("blunder");
		}
	});

	it("retains a blunder for Ne4's large loss instead of forcing every reported move to match", () => {
		const entry = fixture.cases.find((entry) => entry.san === "Ne4");
		expect(entry).toBeDefined();
		expect(classifyMoveQuality(entry!.input)?.quality).toBe("blunder");
	});
});

function scoreDrop(best: number, played: number): MoveQualityInput {
	return {
		fen: new Chess().fen(),
		uci: "a2a3",
		moverRating: 2450,
		before: {
			depth: 18,
			lines: [{ multipv: 1, depth: 18, score: { cp: best }, pvUci: ["e2e4"], pvSan: [] }],
		},
		after: {
			depth: 18,
			lines: [{ multipv: 1, depth: 18, score: { cp: -played }, pvUci: ["e7e5"], pvSan: [] }],
		},
	};
}
