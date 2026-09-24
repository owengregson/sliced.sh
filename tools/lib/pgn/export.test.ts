import { describe, expect, it } from "bun:test";
import { clockCommentsMs, numericTag, parseClock, parseGames, parseTimeControl } from "./export";
import { splitAtEventTags, splitGamesTrimmed } from "./split";
import { thinksOf } from "./thinks";

const EXPORT = [
	'[Event "Live Chess"]',
	'[White "a"]',
	'[WhiteElo "2410"]',
	'[TimeControl "180"]',
	"",
	"1. e4 {[%clk 0:02:58.5]} e5 {[%clk 0:02:59]} 2. Nf3 {[%clk 0:02:51.5]} 1-0",
	"",
	'[Event "Live Chess"]',
	'[White "b"]',
	"",
	"1. d4 {[%clk 0:00:59]} *",
	"",
].join("\r\n");

describe("PGN export parsing", () => {
	it("splits games at the next tag line and reads every clock in ply order", () => {
		const games = parseGames(EXPORT);
		expect(games.map((g) => g.headers.White)).toEqual(["a", "b"]);
		expect(games[0]?.clocksAfterPly).toEqual([178.5, 179, 171.5]);
		expect(games[1]?.clocksAfterPly).toEqual([59]);
		expect(splitAtEventTags(EXPORT)).toHaveLength(2);
		expect(splitGamesTrimmed(EXPORT.replace(/\r\n/g, "\n"))).toHaveLength(2);
	});

	it("reads clocks, time controls and numeric tags", () => {
		expect(parseClock("0:02:59.9")).toBeCloseTo(179.9, 9);
		expect(parseClock("x:1")).toBeNaN();
		expect(parseTimeControl("180+2")).toEqual({ baseSec: 180, incSec: 2 });
		expect(parseTimeControl("-")).toBeNull();
		expect(clockCommentsMs("1. e4 {[%clk 0:02:58.5]} e5 [%clk 0:02:59]")).toEqual([178500, 179000]);
		expect(numericTag(EXPORT, "WhiteElo")).toBe(2410);
		expect(numericTag(EXPORT, "BlackElo")).toBeUndefined();
	});

	it("attributes thinks per side from the base clock, dropping negative ones", () => {
		const [game] = parseGames(EXPORT);
		if (!game) throw new Error("no game");
		expect(thinksOf(game, 0, 180, 0).map((t) => [t.moveNo, t.thinkS])).toEqual([
			[1, 1.5],
			[2, 7],
		]);
		expect(thinksOf(game, 1, 180, 0).map((t) => t.fraction)).toEqual([1]);
	});
});
