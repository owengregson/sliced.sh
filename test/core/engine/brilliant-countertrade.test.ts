import { describe, expect, it } from "bun:test";
import { classifyMoveQuality, type MoveQualityInput } from "@core/engine/move-quality";
import { Chess } from "chess.js";

const fixture = (await Bun.file(
	new URL("../../fixtures/review/false-brilliant-180019136748.json", import.meta.url)
).json()) as {
	pgn: string;
	reportedPly: number;
	input: MoveQualityInput;
	originalVerdict: { quality: string };
};

describe("180019136748 — off-square queen countertrade", () => {
	it("replays the supplied game to the exact reported position", () => {
		const board = new Chess();
		board.loadPgn(fixture.pgn);
		const move = board.history({ verbose: true })[fixture.reportedPly - 1];
		expect(move?.before).toBe(fixture.input.fen);
		expect(move?.lan).toBe(fixture.input.uci);
		expect(move?.san).toBe("Nxd4");
	});
	it("corrects Brilliant to Great on the identical full-network review evidence", () => {
		expect(fixture.originalVerdict.quality).toBe("brilliant");
		const result = classifyMoveQuality(fixture.input);
		expect(result?.quality).toBe("great");
		expect(result?.brilliant).toBeNull();
		expect(result?.loss).toBe(0);
	});
	it("rejects the false sacrifice whether the PV accepts, declines, or omits the queen trade", () => {
		for (const pvUci of [["c6d4", "f4c7", "d4b5"], ["c6d4", "e2d4", "c7f4"], ["c6d4"]]) {
			const before = {
				...fixture.input.before,
				lines: fixture.input.before.lines.map((line) =>
					line.pvUci[0] === "c6d4" ? { ...line, pvUci } : line
				),
			};
			expect(classifyMoveQuality({ ...fixture.input, before })?.quality).toBe("great");
		}
	});
});
