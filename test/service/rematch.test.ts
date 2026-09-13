// test/service/rematch.test.ts — 2026-09-13: the rematch decision (titled, once per opponent per
// playing session, the settings) and the step's state machine on a fake scheduler: their offer is
// accepted, ours is sent and either answered by the next game or withdrawn at the deadline, an
// offer of theirs arriving while ours is pending is taken, and every abort/failure path is
// reported rather than thrown.
import { describe, expect, it } from "bun:test";
import { REMATCH } from "@core/constants/rematch";
import {
	isTitled,
	markRematched,
	type RematchClickAction,
	type RematchClickStatus,
	RematchStep,
	rematchEligible,
	rematchOffersLeft,
} from "@service/rematch";
import { DEFAULT_SETTINGS } from "@typedefs/settings";
import type { PlayingSession } from "@typedefs/storage";

const automation = { ...DEFAULT_SETTINGS.automation, autoQueue: true, rematchTitled: true };

function session(rematched?: string[]): PlayingSession {
	return {
		gameId: "g1",
		startedAt: 0,
		endsAt: 60_000,
		completedGames: 1,
		lastFinishedGameId: "g1",
		breakUntil: null,
		...(rematched ? { rematched } : {}),
	};
}

describe("the rematch decision", () => {
	it("a titled opponent with the settings on is eligible; untitled, unnamed, or a setting off is not", () => {
		expect(isTitled({ name: "fm", title: "FM" })).toBe(true);
		expect(isTitled({ name: "x" })).toBe(false);
		expect(isTitled({ name: "x", title: "" })).toBe(false);
		expect(rematchEligible({ name: "fm", title: "FM" }, automation, session())).toBe(true);
		expect(rematchEligible({ name: "fm", title: "FM" }, automation, undefined)).toBe(true);
		expect(rematchEligible({ name: "amateur" }, automation, session())).toBe(false);
		expect(rematchEligible({ name: "", title: "GM" }, automation, session())).toBe(false);
		expect(rematchEligible(null, automation, session())).toBe(false);
		expect(
			rematchEligible({ name: "fm", title: "FM" }, { ...automation, rematchTitled: false }, session())
		).toBe(false);
		expect(
			rematchEligible({ name: "fm", title: "FM" }, { ...automation, autoQueue: false }, session())
		).toBe(false);
	});

	it("one rematch per opponent per playing session, recorded by name", () => {
		const s = session();
		expect(rematchOffersLeft(s, "fm")).toBe(true);
		markRematched(s, "fm");
		expect(s.rematched).toEqual(["fm"]);
		expect(rematchOffersLeft(s, "fm")).toBe(false);
		expect(rematchOffersLeft(s, "gm")).toBe(true);
		expect(rematchEligible({ name: "fm", title: "FM" }, automation, s)).toBe(false);
		expect(REMATCH.offersPerOpponent).toBe(1);
	});
});

interface Fake {
	step: RematchStep;
	clicks: RematchClickAction[];
	incomingReads: number;
	advance(ms: number): Promise<void>;
	set incoming(value: boolean);
	set answer(value: (action: RematchClickAction) => RematchClickStatus);
}

function fake(): Fake {
	let now = 1_000;
	let sequence = 0;
	let incoming = false;
	let answer: (action: RematchClickAction) => RematchClickStatus = () => "started";
	const timers = new Map<number, { at: number; fn: () => void }>();
	const clicks: RematchClickAction[] = [];
	const state = { incomingReads: 0 };
	const flush = async () => {
		for (let n = 0; n < 12; n++) await Promise.resolve();
	};
	const step = new RematchStep({
		incoming: async () => {
			state.incomingReads += 1;
			return incoming;
		},
		click: async (_tabId, _gameId, action) => {
			clicks.push(action);
			return { status: answer(action) };
		},
		now: () => now,
		scheduler: {
			setTimeout(fn, ms) {
				const id = ++sequence;
				timers.set(id, { at: now + ms, fn });
				return id;
			},
			clearTimeout(handle) {
				timers.delete(handle as number);
			},
		},
	});
	return {
		step,
		clicks,
		get incomingReads() {
			return state.incomingReads;
		},
		set incoming(value: boolean) {
			incoming = value;
		},
		set answer(value: (action: RematchClickAction) => RematchClickStatus) {
			answer = value;
		},
		async advance(ms: number) {
			await flush();
			const end = now + ms;
			for (;;) {
				const next = [...timers].sort((a, b) => a[1].at - b[1].at)[0];
				if (!next || next[1].at > end) break;
				timers.delete(next[0]);
				now = next[1].at;
				next[1].fn();
				await flush();
			}
			now = end;
			await flush();
		},
	};
}

describe("the rematch step", () => {
	it("no incoming offer: clicks Rematch, marks at the press, resolves `started` when the game arrives", async () => {
		const f = fake();
		let clicked = 0;
		const run = f.step.run(1, "g1", new AbortController().signal, { onClicked: () => clicked++ });
		await f.advance(0);
		expect(f.clicks).toEqual(["rematch"]);
		expect(clicked).toBe(1);
		expect(f.step.isWaiting(1)).toBe(true);
		await f.advance(5_000);
		f.step.gameStarted(1);
		await f.advance(0);
		expect(await run).toEqual({ outcome: "started", clicked: true });
		expect(f.step.isWaiting(1)).toBe(false);
		// The page was not asked to cancel anything.
		expect(f.clicks).toEqual(["rematch"]);
	});

	it("their offer showing: clicks Accept and never Rematch", async () => {
		const f = fake();
		f.incoming = true;
		const run = f.step.run(1, "g1", new AbortController().signal);
		await f.advance(0);
		expect(f.clicks).toEqual(["accept"]);
		f.step.gameStarted(1);
		expect(await run).toEqual({ outcome: "started", clicked: true });
	});

	it("nobody takes our offer within the timeout: Cancel is clicked and the outcome is `expired`", async () => {
		const f = fake();
		const run = f.step.run(1, "g1", new AbortController().signal);
		await f.advance(REMATCH.acceptTimeoutMs - 1);
		expect(f.clicks).toEqual(["rematch"]);
		await f.advance(1);
		expect(await run).toEqual({ outcome: "expired", clicked: true });
		expect(f.clicks).toEqual(["rematch", "cancel"]);
		// The incoming read repeated at `incomingPollMs` throughout the wait.
		expect(f.incomingReads).toBeGreaterThanOrEqual(REMATCH.acceptTimeoutMs / REMATCH.incomingPollMs);
	});

	it("a missing Cancel control is tolerated: the outcome is still `expired`", async () => {
		const f = fake();
		f.answer = (action) => (action === "cancel" ? "not-ready" : "started");
		const run = f.step.run(1, "g1", new AbortController().signal);
		await f.advance(REMATCH.acceptTimeoutMs);
		expect(await run).toEqual({ outcome: "expired", clicked: true });
	});

	it("their offer arriving while ours is pending is accepted, and the wait goes on", async () => {
		const f = fake();
		const run = f.step.run(1, "g1", new AbortController().signal);
		await f.advance(REMATCH.incomingPollMs * 2 + 1);
		expect(f.clicks).toEqual(["rematch"]);
		f.incoming = true;
		await f.advance(REMATCH.incomingPollMs);
		expect(f.clicks).toEqual(["rematch", "accept"]);
		// Accepted: no further incoming reads decide anything, and no Cancel at the deadline.
		await f.advance(REMATCH.acceptTimeoutMs);
		expect(await run).toEqual({ outcome: "expired", clicked: true });
		expect(f.clicks).toEqual(["rematch", "accept"]);
	});

	it("no rematch control on the page: `not-ready`, nothing marked", async () => {
		const f = fake();
		f.answer = () => "not-ready";
		let clicked = 0;
		const result = await f.step.run(1, "g1", new AbortController().signal, {
			onClicked: () => clicked++,
		});
		expect(result).toEqual({ outcome: "not-ready", clicked: false });
		expect(clicked).toBe(0);
		expect(f.clicks).toEqual(["rematch"]);
	});

	it("their panel vanishing between the read and the click falls back to our own offer", async () => {
		const f = fake();
		f.incoming = true;
		f.answer = (action) => (action === "accept" ? "not-ready" : "started");
		const run = f.step.run(1, "g1", new AbortController().signal);
		await f.advance(0);
		expect(f.clicks).toEqual(["accept", "rematch"]);
		f.step.gameStarted(1);
		expect(await run).toEqual({ outcome: "started", clicked: true });
	});

	it("a game already on the board is `in-game`", async () => {
		const f = fake();
		f.answer = () => "in-game";
		expect(await f.step.run(1, "g1", new AbortController().signal)).toEqual({
			outcome: "in-game",
			clicked: false,
		});
	});

	it("an abort during the wait is `aborted`; a game observed before the abort is `started`", async () => {
		const f = fake();
		const controller = new AbortController();
		const run = f.step.run(1, "g1", controller.signal);
		await f.advance(3_000);
		controller.abort();
		expect(await run).toEqual({ outcome: "aborted", clicked: true });
		expect(f.clicks).toEqual(["rematch"]);

		const g = fake();
		const second = new AbortController();
		const other = g.step.run(2, "g2", second.signal);
		await g.advance(3_000);
		g.step.gameStarted(2);
		second.abort();
		expect(await other).toEqual({ outcome: "started", clicked: true });
	});

	it("a read that rejects is reported as `not-ready`, never thrown", async () => {
		let sequence = 0;
		const step = new RematchStep({
			incoming: async () => {
				throw new Error("no port");
			},
			click: async () => ({ status: "started" }),
			now: () => 0,
			scheduler: {
				setTimeout: () => ++sequence,
				clearTimeout: () => {},
			},
		});
		expect(await step.run(1, null, new AbortController().signal)).toEqual({
			outcome: "not-ready",
			clicked: false,
		});
	});
});
