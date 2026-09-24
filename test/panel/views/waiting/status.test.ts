import { describe, expect, test } from "bun:test";
import { COPY } from "@panel/copy";
import { autoPlayState } from "@panel/views/auto-play-state";
import { autoplayHint, waitingStatus } from "@panel/views/waiting/status";
import { makeSnapshot } from "../../fixtures";

const NOW = 1_000_000;

describe("waitingStatus", () => {
	test("a watched tab reads connected, a reading one warns", () => {
		expect(waitingStatus(makeSnapshot(), NOW)).toEqual({
			text: COPY.waiting.watching,
			counting: false,
			warn: false,
		});
		expect(waitingStatus(makeSnapshot({ state: "idle" }), NOW)).toMatchObject({
			text: COPY.waiting.reading,
			warn: true,
		});
	});

	test("the assistant switch off overrides everything", () => {
		const snapshot = makeSnapshot({ settings: { enabled: false } });
		expect(waitingStatus(snapshot, NOW).text).toBe(COPY.move.disabled);
		expect(autoplayHint(snapshot, autoPlayState(snapshot))).toBe(COPY.waiting.autoplayOff);
	});

	test("a queue delay counts down; a rematch counts whole seconds", () => {
		const base = makeSnapshot();
		const settings = {
			...base.settings,
			automation: { ...base.settings.automation, autoQueue: true },
		};
		const waiting = {
			...base,
			settings,
			session: {
				...base.session,
				autoQueue: { status: "waiting" as const, dueAt: NOW + 65_000, attempts: 0 },
			},
		};
		expect(waitingStatus(waiting, NOW)).toEqual({
			text: COPY.waiting.queueDelay("1:05"),
			counting: true,
			warn: true,
		});
		const rematch = {
			...waiting,
			session: {
				...waiting.session,
				autoQueue: { status: "rematch" as const, dueAt: NOW + 4_200, attempts: 0 },
			},
		};
		expect(waitingStatus(rematch, NOW).text).toBe(COPY.waiting.queueRematch("5"));
	});

	test("the hint says armed for the next game once armed", () => {
		const snapshot = makeSnapshot({ armed: true });
		expect(autoplayHint(snapshot, autoPlayState(snapshot))).toBe(COPY.waiting.preArmed);
	});
});
