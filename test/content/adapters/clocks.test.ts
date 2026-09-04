// test/content/adapters/clocks.test.ts
import { describe, expect, it } from "bun:test";
import {
	chesscomActiveClockColor,
	lichessRunningClockColor,
	parseClockText,
	readChesscomClock,
	readLichessClock,
} from "@content/adapters/clocks";
import { loadFixture, pageDocument } from "./helpers";

describe("parseClockText", () => {
	it("parses tenths, minutes and hours", () => {
		expect(parseClockText("0:16.0")).toBe(16_000);
		expect(parseClockText("0:16.4")).toBe(16_400);
		expect(parseClockText("2:59")).toBe(179_000);
		expect(parseClockText("1:00:00")).toBe(3_600_000);
		expect(parseClockText("00:09.4")).toBe(9_400);
		expect(parseClockText(" 01:00:00 ")).toBe(3_600_000);
	});
	it("returns NaN on junk", () => {
		expect(Number.isNaN(parseClockText(""))).toBe(true);
		expect(Number.isNaN(parseClockText("abc"))).toBe(true);
		expect(Number.isNaN(parseClockText("1:2:3:4"))).toBe(true);
	});
});

describe("chess.com clocks", () => {
	it("reads both sides and the active colour", () => {
		const dom = loadFixture("chesscom-live");
		expect(readChesscomClock(pageDocument(dom), "w")).toEqual({
			ms: 16_000,
			running: true,
			hasTenths: true,
		});
		expect(readChesscomClock(pageDocument(dom), "b")).toEqual({
			ms: 179_000,
			running: false,
			hasTenths: false,
		});
		expect(chesscomActiveClockColor(pageDocument(dom))).toBe("w");
	});
	it("returns null when the page has no clocks (vs computer)", () => {
		const dom = loadFixture("chesscom-computer");
		expect(readChesscomClock(pageDocument(dom), "w")).toBeNull();
		expect(chesscomActiveClockColor(pageDocument(dom))).toBeNull();
	});
});

describe("lichess clocks", () => {
	it("reads the <sep>/<tenths> markup and the running class", () => {
		const dom = loadFixture("lichess-round-white");
		expect(readLichessClock(pageDocument(dom), "w")).toEqual({
			ms: 16_000,
			running: true,
			hasTenths: true,
		});
		expect(readLichessClock(pageDocument(dom), "b")).toEqual({
			ms: 179_000,
			running: false,
			hasTenths: false,
		});
		expect(lichessRunningClockColor(pageDocument(dom))).toBe("w");
	});
	it("reads an hour clock on the black fixture", () => {
		const dom = loadFixture("lichess-round-black");
		expect(readLichessClock(pageDocument(dom), "b")).toEqual({
			ms: 3_600_000,
			running: true,
			hasTenths: false,
		});
		expect(lichessRunningClockColor(pageDocument(dom))).toBe("b");
	});
});
