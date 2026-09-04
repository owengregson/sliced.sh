// test/service/hand-ownership.test.ts — §13.5 hand ownership (real input counted, never used).
import { beforeEach, describe, expect, it } from "bun:test";
import { EXECUTOR } from "@core/constants";
import { HandOwnership } from "@service/hand-ownership";
import { fakeLink } from "./fakes";

let link: ReturnType<typeof fakeLink>;
let hand: HandOwnership;
const T0 = 1_000_000;
const now = { value: T0 };

beforeEach(() => {
	now.value = T0;
	link = fakeLink({ 7: 1 });
	hand = new HandOwnership(link, { now: () => now.value });
});

describe("HandOwnership", () => {
	it("arming transfers the pointer to the hand at the start point; released drops ownership", () => {
		expect(hand.isArmed(7)).toBe(false);
		expect(hand.position(7)).toBeNull();
		hand.armed(7, { x: 400, y: 600 });
		expect(hand.isArmed(7)).toBe(true);
		expect(hand.position(7)).toEqual({ x: 400, y: 600 });
		hand.setPosition(7, { x: 410, y: 590 });
		expect(hand.position(7)).toEqual({ x: 410, y: 590 });
		hand.released(7);
		expect(hand.isArmed(7)).toBe(false);
		expect(hand.position(7)).toEqual({ x: 410, y: 590 }); // the rest point survives for the next arm
	});

	it("real pointer events while armed are only counted — the virtual position never moves", () => {
		hand.armed(7, { x: 400, y: 600 });
		hand.realPointerSeen(7, T0 + 10);
		link.emit(7, { kind: "cursor", x: 12, y: 34, t: T0 + 20, real: true });
		expect(hand.realPointerCount(7)).toBe(2);
		expect(hand.position(7)).toEqual({ x: 400, y: 600 });
		expect(hand.lastRealSeenAt(7)).toBe(T0 + 20);
		hand.released(7);
		hand.armed(7, { x: 1, y: 1 });
		expect(hand.realPointerCount(7)).toBe(0); // per arming session
	});

	it("while not armed, cursor reports become the plausible start for the next arming (age < 5 s)", () => {
		link.emit(7, { kind: "cursor", x: 300, y: 500, t: T0, real: true });
		expect(hand.realPointerCount(7)).toBe(0);
		now.value = T0 + EXECUTOR.realCursorMaxAgeMs - 1;
		expect(hand.lastRealPosition(7)).toEqual({ x: 300, y: 500 });
		now.value = T0 + EXECUTOR.realCursorMaxAgeMs + 1;
		expect(hand.lastRealPosition(7)).toBeNull();
		expect(hand.startPoint(7, () => ({ x: 9, y: 9 }))).toEqual({ x: 9, y: 9 });
		now.value = T0 + 100;
		expect(hand.startPoint(7, () => ({ x: 9, y: 9 }))).toEqual({ x: 300, y: 500 });
		hand.armed(7, { x: 5, y: 5 });
		hand.released(7);
		// a previous rest point wins over an old real position
		now.value = T0 + 200;
		expect(hand.startPoint(7, () => ({ x: 9, y: 9 }))).toEqual({ x: 5, y: 5 });
	});

	it("dispose unsubscribes from the link", () => {
		hand.dispose();
		expect(link.listeners()).toBe(0);
	});
});
