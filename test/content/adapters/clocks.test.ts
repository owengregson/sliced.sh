// test/content/adapters/clocks.test.ts
import { describe, expect, it } from "bun:test";
import { activeClockColor, parseClockText, readClock } from "@content/adapters/clocks";
import { loadFixture, pageDocument, q } from "./helpers";

describe("parseClockText", () => {
	it("parses tenths, minutes and hours", () => {
		expect(parseClockText("0:16.0")).toBe(16_000);
		expect(parseClockText("0:16.4")).toBe(16_400);
		expect(parseClockText("2:59")).toBe(179_000);
		expect(parseClockText("1:00:00")).toBe(3_600_000);
		expect(parseClockText("00:09.4")).toBe(9_400);
		expect(parseClockText(" 01:00:00 ")).toBe(3_600_000);
	});
	// The owner reports chess.com adds tenths below roughly a minute; whether it also drops the
	// `0:` is unconfirmed, so both sub-minute shapes must read. A dropped reading is worse than a
	// wrong one: `readClock` returns null and the think time silently re-inflates in exactly the
	// regime the timing model exists to handle.
	it("parses the sub-minute shapes with no colon", () => {
		expect(parseClockText("59.8")).toBe(59_800);
		expect(parseClockText("9.8")).toBe(9_800);
		expect(parseClockText("59")).toBe(59_000);
		expect(parseClockText("0.4")).toBe(400);
		expect(parseClockText(" 9.8 ")).toBe(9_800);
	});
	it("returns NaN on junk", () => {
		expect(Number.isNaN(parseClockText(""))).toBe(true);
		expect(Number.isNaN(parseClockText("abc"))).toBe(true);
		expect(Number.isNaN(parseClockText("1:2:3:4"))).toBe(true);
		// a bare number that cannot be a clock reading is still junk, not 2024 s
		expect(Number.isNaN(parseClockText("2024"))).toBe(true);
		expect(Number.isNaN(parseClockText("1:"))).toBe(true);
		expect(Number.isNaN(parseClockText(":30"))).toBe(true);
		expect(Number.isNaN(parseClockText("1:2.3.4"))).toBe(true);
	});
});

describe("chess.com clocks", () => {
	it("reads both sides and the active colour", () => {
		const dom = loadFixture("chesscom-live");
		expect(readClock(pageDocument(dom), "w")).toEqual({
			ms: 16_000,
			running: true,
			hasTenths: true,
		});
		expect(readClock(pageDocument(dom), "b")).toEqual({
			ms: 179_000,
			running: false,
			hasTenths: false,
		});
		expect(activeClockColor(pageDocument(dom))).toBe("w");
	});
	it("keeps the reading when the page renders bare sub-minute seconds", () => {
		const dom = loadFixture("chesscom-live");
		// the same clock element, rendered the way chess.com renders it under a minute
		q(dom, ".clock-component.clock-bottom.clock-white .clock-time-monospace").textContent = "9.8";
		expect(readClock(pageDocument(dom), "w")).toEqual({
			ms: 9_800,
			running: true,
			hasTenths: true,
		});
	});
	it("returns null when the page has no clocks (vs computer)", () => {
		const dom = loadFixture("chesscom-computer");
		expect(readClock(pageDocument(dom), "w")).toBeNull();
		expect(activeClockColor(pageDocument(dom))).toBeNull();
	});
});
