import { expect, it } from "bun:test";
import { Chess } from "chess.js";
import { samplePositions } from "./verification-audit";

function pgn(): string {
	const clock = "{[%clk 0:02:50]}";
	return Array.from(
		{ length: 12 },
		(_, i) => `${i * 2 + 1}. Nf3 ${clock} Nf6 ${clock} ${i * 2 + 2}. Ng1 ${clock} Ng8 ${clock}`
	).join(" ");
}

it("audit separates games, excludes prior tuning games, and replays genuine positions/history", () => {
	const games = [900, 1400, 1900, 2400, 2700].flatMap((elo) =>
		Array.from({ length: 8 }, (_, i) => ({
			url: `https://www.chess.com/game/live/${elo}-${i}`,
			timeClass: "blitz",
			whiteElo: elo,
			blackElo: elo,
			pgn: pgn(),
		}))
	);
	const excluded = new Set(["900-0", "1400-0", "1900-0", "2400-0", "2700-0"]);
	const rows = samplePositions(games, excluded, 4);
	expect(rows).toHaveLength(20);
	expect(samplePositions([...games].reverse(), excluded, 4)).toEqual(rows);
	expect(new Set(rows.map((row) => row.gameId)).size).toBe(rows.length);
	for (const row of rows) {
		expect(excluded.has(row.gameId)).toBe(false);
		expect(row.historyFens.at(-1)).toBe(row.fen);
		expect(row.historyFens).toHaveLength(8);
		const board = new Chess(row.fen);
		expect(
			board.moves({ verbose: true }).some((m) => m.from + m.to + (m.promotion ?? "") === row.humanMove)
		).toBe(true);
	}
	const train = new Set(rows.filter((r) => r.split === "development").map((r) => r.gameId));
	const heldout = rows.filter((r) => r.split === "heldout");
	expect(train.size).toBeGreaterThan(0);
	expect(heldout.length).toBeGreaterThan(0);
	expect(heldout.some((r) => train.has(r.gameId))).toBe(false);
});
