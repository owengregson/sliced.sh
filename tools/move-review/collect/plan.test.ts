import { describe, expect, it } from "bun:test";
import type { BenchmarkGame } from "../evidence";
import { isCollectMode, parsePositionList, positionsToSearch } from "./plan";

const entry: BenchmarkGame = { pgn: "", ply: 5, labels: { "2": "Blunder", "5": "Brilliant" } };

describe("collection plan", () => {
	it("searches around the brilliant, around every mark, everything, or the listed positions", () => {
		expect(positionsToSearch("labelled", entry, 10, undefined)).toEqual([3, 4, 5]);
		expect(positionsToSearch("marked", entry, 10, undefined)).toEqual([0, 1, 2, 3, 4, 5]);
		expect(positionsToSearch("all", entry, 3, undefined)).toEqual([0, 1, 2, 3]);
		expect(positionsToSearch("list", entry, 4, [4, 9, 1, 1])).toEqual([1, 4]);
		expect(positionsToSearch("accept", entry, 10, [1])).toEqual([]);
	});

	it("reads list rows and accept probes, skipping malformed rows", () => {
		const list = parsePositionList("0:3\n1:x\n2:4:e4d5\n", "accept");
		expect([...list.listed]).toEqual([[0, [3]]]);
		expect([...list.accepts]).toEqual([[2, [{ index: 4, capture: "e4d5" }]]]);
		expect(isCollectMode("marked")).toBe(true);
		expect(isCollectMode("some")).toBe(false);
	});
});
