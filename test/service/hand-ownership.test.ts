// test/service/hand-ownership.test.ts — §13.5 hand ownership (real input counted, never used).
import { beforeEach, describe, expect, it } from "bun:test";
import { EXECUTOR } from "@core/constants";
import type { GamePortCommand } from "@core/constants/messages";
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
	it("publishes real ownership initially, on arm/release, and across content reconnects", () => {
		hand.dispose();
		const posts: Array<{ tabId: number; cmd: GamePortCommand }> = [];
		const connects = new Set<(tabId: number) => void>();
		hand = new HandOwnership({
			...link,
			tabs: () => [7],
			post: (tabId, cmd) => {
				posts.push({ tabId, cmd });
				return true;
			},
			onConnect: (cb) => {
				connects.add(cb);
				return () => void connects.delete(cb);
			},
		});
		expect(posts.at(-1)).toEqual({ tabId: 7, cmd: { kind: "inputOwnership", owned: false } });
		hand.armed(7);
		expect(posts.at(-1)?.cmd).toEqual({ kind: "inputOwnership", owned: true });
		for (const cb of connects) cb(7);
		expect(posts.at(-1)?.cmd).toEqual({ kind: "inputOwnership", owned: true });
		link.emit(7, { kind: "hello", site: "chesscom", pageKind: "live-game", adapterVersion: "test" });
		expect(posts.at(-1)?.cmd).toEqual({ kind: "inputOwnership", owned: true });
		hand.released(7);
		expect(posts.at(-1)?.cmd).toEqual({ kind: "inputOwnership", owned: false });
		hand.armed(7);
		hand.dispose();
		expect(posts.at(-1)?.cmd).toEqual({ kind: "inputOwnership", owned: false });
		expect(connects.size).toBe(0);
		expect(link.listeners()).toBe(0);
	});
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

	/**
	 * 2026-09-13: ownership is never announced to a tab that is not on a game page. The content
	 * side's own gate is what holds regardless; this keeps the worker from posting a lock the page
	 * will refuse anyway, and drops one the moment the tab's `hello` says it left a game page.
	 */
	it("announces ownership only to a tab whose last hello is a game page", () => {
		hand.dispose();
		const posts: GamePortCommand[] = [];
		hand = new HandOwnership({
			...link,
			post: (_tabId, cmd) => {
				posts.push(cmd);
				return true;
			},
		});
		const hello = (pageKind: "live-game" | "live-lobby" | "vs-computer" | "analysis" | "puzzles") =>
			link.emit(7, { kind: "hello", site: "chesscom", pageKind, adapterVersion: "test" });
		hand.armed(7);
		expect(posts.at(-1)).toEqual({ kind: "inputOwnership", owned: true });
		// SPA navigation to the analysis board: released for the page, still armed for the worker
		hello("analysis");
		expect(posts.at(-1)).toEqual({ kind: "inputOwnership", owned: false });
		expect(hand.isArmed(7)).toBe(true);
		hand.armed(7);
		expect(posts.at(-1)).toEqual({ kind: "inputOwnership", owned: false });
		hello("puzzles");
		expect(posts.at(-1)).toEqual({ kind: "inputOwnership", owned: false });
		// back on any game page, the standing arm is announced again
		for (const kind of ["live-lobby", "vs-computer", "live-game"] as const) {
			hello(kind);
			expect(posts.at(-1)).toEqual({ kind: "inputOwnership", owned: true });
		}
		hand.released(7);
		expect(posts.at(-1)).toEqual({ kind: "inputOwnership", owned: false });
	});

	it("dispose unsubscribes from the link", () => {
		hand.dispose();
		expect(link.listeners()).toBe(0);
	});
});
