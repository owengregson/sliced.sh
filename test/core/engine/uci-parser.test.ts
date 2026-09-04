// test/core/engine/uci-parser.test.ts
import { describe, expect, it } from "bun:test";
import {
	isInterimBoundLine,
	parseBestmove,
	parseId,
	parseInfo,
	parseOption,
} from "@core/engine/uci-parser";

describe("parseInfo", () => {
	it("parses a full Stockfish multipv line with every token", () => {
		const info = parseInfo(
			"info depth 12 seldepth 18 multipv 2 score cp -35 upperbound wdl 120 700 180 nodes 91234 nps 812000 hashfull 12 tbhits 0 time 112 pv e7e5 g1f3 b8c6"
		);
		expect(info).toEqual({
			depth: 12,
			seldepth: 18,
			multipv: 2,
			score: { type: "cp", value: -35, bound: "upper" },
			wdl: [120, 700, 180],
			nodes: 91234,
			nps: 812000,
			hashfull: 12,
			tbhits: 0,
			time: 112,
			pv: ["e7e5", "g1f3", "b8c6"],
		});
	});
	it("parses mate scores and lowerbound", () => {
		expect(parseInfo("info depth 5 score mate -3 lowerbound pv a1a2")?.score).toEqual({
			type: "mate",
			value: -3,
			bound: "lower",
		});
		expect(parseInfo("info depth 0 score mate 0")).toEqual({
			depth: 0,
			score: { type: "mate", value: 0 },
		});
	});
	it("parses `info string` as the rest of the line", () => {
		expect(parseInfo("info string NNUE evaluation using nn-1c0000000000.nnue (133MiB)")).toEqual({
			string: "NNUE evaluation using nn-1c0000000000.nnue (133MiB)",
		});
	});
	it("parses currmove lines", () => {
		expect(parseInfo("info depth 14 currmove e2e4 currmovenumber 3")).toEqual({
			depth: 14,
			currmove: "e2e4",
			currmovenumber: 3,
		});
	});
	it("swallows refutation/currline and skips unknown tokens", () => {
		expect(parseInfo("info depth 3 bogus 7 refutation e2e4 e7e5")).toEqual({ depth: 3 });
		expect(parseInfo("  info   depth 3   pv   e2e4  ")).toEqual({ depth: 3, pv: ["e2e4"] });
	});
	it("returns undefined for non-info lines", () => {
		expect(parseInfo("bestmove e2e4")).toBeUndefined();
		expect(parseInfo("")).toBeUndefined();
		expect(parseInfo("information depth 3")).toBeUndefined();
	});
	it("leaves malformed numeric values undefined", () => {
		expect(parseInfo("info depth x nodes 5")).toEqual({ nodes: 5 });
		expect(parseInfo("info score cp")).toEqual({});
	});
});

describe("isInterimBoundLine", () => {
	it("ignores bound lines for multipv 1 only", () => {
		const bound = { type: "cp" as const, value: 3, bound: "upper" as const };
		expect(isInterimBoundLine({ multipv: 1, score: bound })).toBe(true);
		expect(isInterimBoundLine({ score: bound })).toBe(true);
		expect(isInterimBoundLine({ multipv: 2, score: bound })).toBe(false);
		expect(isInterimBoundLine({ multipv: 1, score: { type: "cp", value: 3 } })).toBe(false);
		expect(isInterimBoundLine({ depth: 3 })).toBe(false);
	});
});

describe("parseBestmove", () => {
	it("parses bestmove with ponder", () => {
		expect(parseBestmove("bestmove e2e4 ponder e7e5")).toEqual({ bestmove: "e2e4", ponder: "e7e5" });
	});
	it("parses bestmove without ponder", () => {
		expect(parseBestmove("bestmove e2e4")).toEqual({ bestmove: "e2e4" });
	});
	it("maps (none) to null", () => {
		expect(parseBestmove("bestmove (none)")).toEqual({ bestmove: null });
	});
	it("returns undefined for other lines and a bare bestmove", () => {
		expect(parseBestmove("info depth 1")).toBeUndefined();
		expect(parseBestmove("bestmove")).toBeUndefined();
	});
});

describe("parseOption", () => {
	it("parses a spin option", () => {
		expect(parseOption("option name UCI_Elo type spin default 1320 min 1320 max 3190")).toEqual({
			name: "UCI_Elo",
			spec: { type: "spin", default: "1320", min: 1320, max: 3190 },
		});
	});
	it("parses names with spaces, check, combo and string options", () => {
		expect(parseOption("option name Skill Level type spin default 20 min 0 max 20")).toEqual({
			name: "Skill Level",
			spec: { type: "spin", default: "20", min: 0, max: 20 },
		});
		expect(parseOption("option name Ponder type check default false")).toEqual({
			name: "Ponder",
			spec: { type: "check", default: "false" },
		});
		expect(parseOption("option name EvalFile type string default nn-1c0000000000.nnue")).toEqual({
			name: "EvalFile",
			spec: { type: "string", default: "nn-1c0000000000.nnue" },
		});
		expect(
			parseOption("option name Style type combo default Normal var Solid var Normal var Risky")
		).toEqual({
			name: "Style",
			spec: { type: "combo", default: "Normal", vars: ["Solid", "Normal", "Risky"] },
		});
		expect(parseOption("option name Clear Hash type button")).toEqual({
			name: "Clear Hash",
			spec: { type: "button" },
		});
	});
	it("returns undefined for malformed lines", () => {
		expect(parseOption("option name X")).toBeUndefined();
		expect(parseOption("option type spin")).toBeUndefined();
		expect(parseOption("id name X")).toBeUndefined();
		expect(parseOption("option name X type bogus")).toBeUndefined();
	});
});

describe("parseId", () => {
	it("parses name and author", () => {
		expect(parseId("id name Stockfish 18")).toEqual({ key: "name", value: "Stockfish 18" });
		expect(parseId("id author the Stockfish developers (see AUTHORS file)")).toEqual({
			key: "author",
			value: "the Stockfish developers (see AUTHORS file)",
		});
	});
	it("returns undefined otherwise", () => {
		expect(parseId("id version 1")).toBeUndefined();
		expect(parseId("uciok")).toBeUndefined();
	});
});
