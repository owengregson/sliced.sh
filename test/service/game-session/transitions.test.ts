// test/service/game-session/transitions.test.ts — Task 30 Step 1: every `(state, event)` edge of
// Part I §3.3 is enumerated here; a pair the table does not define is a no-op and logs a warning.
import { describe, expect, it } from "bun:test";
import { log } from "@core/logger";
import {
	GAME_SESSION_EVENTS,
	GAME_SESSION_STATES,
	isLiveState,
	isMyTurnState,
	nextState,
	TRANSITIONS,
	type TransitionInput,
} from "@service/game-session/transitions";
import type { GameSessionState } from "@typedefs/game";

const MINE: TransitionInput = { myTurn: true };
const THEIRS: TransitionInput = { myTurn: false };

/** The whole table as `(state, event, input) → next | null`, written out by hand. */
type Row = readonly [GameSessionState, string, TransitionInput, GameSessionState | null];

const EXPECTED: readonly Row[] = [
	// ── idle ───────────────────────────────────────────────────────────────────
	["idle", "hello", {}, "waiting-for-game"],
	["idle", "gameStarted", {}, "live:opponent-turn"],
	["idle", "positionChanged", MINE, "live:my-turn:analysing"],
	["idle", "positionChanged", THEIRS, "live:opponent-turn"],
	["idle", "gameEnded", {}, null],
	["idle", "playNow", {}, null],
	["idle", "armAutoMove", {}, "waiting-for-game"],
	["idle", "disarm", {}, null],
	["idle", "disable", {}, "idle"],
	["idle", "handStarted", {}, null],
	["idle", "executed", {}, null],
	["idle", "failed", {}, null],
	["idle", "tabRemoved", {}, "idle"],
	["idle", "navigated", {}, "idle"],
	// ── waiting-for-game ───────────────────────────────────────────────────────
	["waiting-for-game", "hello", {}, "waiting-for-game"],
	["waiting-for-game", "gameStarted", {}, "live:opponent-turn"],
	["waiting-for-game", "positionChanged", MINE, "live:my-turn:analysing"],
	["waiting-for-game", "positionChanged", THEIRS, "live:opponent-turn"],
	["waiting-for-game", "gameEnded", {}, "waiting-for-game"],
	["waiting-for-game", "playNow", {}, null],
	["waiting-for-game", "armAutoMove", {}, "waiting-for-game"],
	["waiting-for-game", "disarm", {}, "waiting-for-game"],
	["waiting-for-game", "disable", {}, "idle"],
	["waiting-for-game", "handStarted", {}, null],
	["waiting-for-game", "executed", {}, null],
	["waiting-for-game", "failed", {}, null],
	["waiting-for-game", "tabRemoved", {}, "idle"],
	["waiting-for-game", "navigated", {}, "waiting-for-game"],
	// ── live:opponent-turn ─────────────────────────────────────────────────────
	["live:opponent-turn", "hello", {}, "live:opponent-turn"],
	["live:opponent-turn", "gameStarted", {}, "live:opponent-turn"],
	["live:opponent-turn", "positionChanged", MINE, "live:my-turn:analysing"],
	["live:opponent-turn", "positionChanged", THEIRS, "live:opponent-turn"],
	["live:opponent-turn", "gameEnded", {}, "game-over"],
	["live:opponent-turn", "playNow", {}, null],
	["live:opponent-turn", "armAutoMove", {}, "live:opponent-turn"],
	["live:opponent-turn", "disarm", {}, "live:opponent-turn"],
	["live:opponent-turn", "disable", {}, "idle"],
	["live:opponent-turn", "handStarted", {}, null],
	["live:opponent-turn", "executed", {}, "live:opponent-turn"],
	["live:opponent-turn", "failed", {}, "live:opponent-turn"],
	["live:opponent-turn", "tabRemoved", {}, "idle"],
	["live:opponent-turn", "navigated", {}, "waiting-for-game"],
	// ── live:my-turn:analysing ─────────────────────────────────────────────────
	["live:my-turn:analysing", "hello", {}, "live:my-turn:analysing"],
	["live:my-turn:analysing", "gameStarted", {}, "live:opponent-turn"],
	["live:my-turn:analysing", "positionChanged", MINE, "live:my-turn:analysing"],
	["live:my-turn:analysing", "positionChanged", THEIRS, "live:opponent-turn"],
	["live:my-turn:analysing", "gameEnded", {}, "game-over"],
	["live:my-turn:analysing", "playNow", {}, "live:my-turn:analysing"],
	["live:my-turn:analysing", "armAutoMove", {}, "live:my-turn:analysing"],
	["live:my-turn:analysing", "disarm", {}, "live:my-turn:analysing"],
	["live:my-turn:analysing", "disable", {}, "idle"],
	["live:my-turn:analysing", "handStarted", {}, null],
	["live:my-turn:analysing", "executed", {}, "live:opponent-turn"],
	["live:my-turn:analysing", "failed", {}, "live:my-turn:analysing"],
	["live:my-turn:analysing", "tabRemoved", {}, "idle"],
	["live:my-turn:analysing", "navigated", {}, "waiting-for-game"],
	// ── live:my-turn:recommended ───────────────────────────────────────────────
	["live:my-turn:recommended", "hello", {}, "live:my-turn:recommended"],
	["live:my-turn:recommended", "gameStarted", {}, "live:opponent-turn"],
	["live:my-turn:recommended", "positionChanged", MINE, "live:my-turn:analysing"],
	["live:my-turn:recommended", "positionChanged", THEIRS, "live:opponent-turn"],
	["live:my-turn:recommended", "gameEnded", {}, "game-over"],
	["live:my-turn:recommended", "playNow", {}, "live:my-turn:executing"],
	["live:my-turn:recommended", "armAutoMove", {}, "live:my-turn:recommended"],
	["live:my-turn:recommended", "disarm", {}, "live:my-turn:recommended"],
	["live:my-turn:recommended", "disable", {}, "idle"],
	["live:my-turn:recommended", "handStarted", {}, "live:my-turn:executing"],
	["live:my-turn:recommended", "executed", {}, "live:opponent-turn"],
	["live:my-turn:recommended", "failed", {}, "live:my-turn:recommended"],
	["live:my-turn:recommended", "tabRemoved", {}, "idle"],
	["live:my-turn:recommended", "navigated", {}, "waiting-for-game"],
	// ── live:my-turn:executing ─────────────────────────────────────────────────
	["live:my-turn:executing", "hello", {}, "live:my-turn:executing"],
	["live:my-turn:executing", "gameStarted", {}, "live:opponent-turn"],
	["live:my-turn:executing", "positionChanged", MINE, "live:my-turn:analysing"],
	["live:my-turn:executing", "positionChanged", THEIRS, "live:opponent-turn"],
	["live:my-turn:executing", "gameEnded", {}, "game-over"],
	["live:my-turn:executing", "playNow", {}, "live:my-turn:executing"],
	["live:my-turn:executing", "armAutoMove", {}, "live:my-turn:executing"],
	["live:my-turn:executing", "disarm", {}, "live:my-turn:recommended"],
	["live:my-turn:executing", "disable", {}, "idle"],
	["live:my-turn:executing", "handStarted", {}, "live:my-turn:executing"],
	["live:my-turn:executing", "executed", {}, "live:opponent-turn"],
	["live:my-turn:executing", "failed", {}, "live:my-turn:recommended"],
	["live:my-turn:executing", "tabRemoved", {}, "idle"],
	["live:my-turn:executing", "navigated", {}, "waiting-for-game"],
	// ── game-over ──────────────────────────────────────────────────────────────
	["game-over", "hello", {}, "waiting-for-game"],
	["game-over", "gameStarted", {}, "live:opponent-turn"],
	["game-over", "positionChanged", MINE, "game-over"],
	["game-over", "positionChanged", THEIRS, "game-over"],
	["game-over", "gameEnded", {}, "game-over"],
	["game-over", "playNow", {}, null],
	["game-over", "armAutoMove", {}, "game-over"],
	["game-over", "disarm", {}, "game-over"],
	["game-over", "disable", {}, "idle"],
	["game-over", "handStarted", {}, null],
	["game-over", "executed", {}, "game-over"],
	["game-over", "failed", {}, "game-over"],
	["game-over", "tabRemoved", {}, "idle"],
	["game-over", "navigated", {}, "waiting-for-game"],
];

describe("game session transitions (§3.3)", () => {
	it("declares the seven states and thirteen events", () => {
		expect([...GAME_SESSION_STATES]).toEqual([
			"idle",
			"waiting-for-game",
			"live:opponent-turn",
			"live:my-turn:analysing",
			"live:my-turn:recommended",
			"live:my-turn:executing",
			"game-over",
		]);
		expect([...GAME_SESSION_EVENTS]).toEqual([
			"hello",
			"gameStarted",
			"positionChanged",
			"gameEnded",
			"playNow",
			"armAutoMove",
			"disarm",
			"disable",
			"handStarted",
			"executed",
			"failed",
			"tabRemoved",
			"navigated",
		]);
	});

	it("covers every (state, event) pair exactly once in the expectation table", () => {
		const seen = new Set<string>();
		for (const [state, event] of EXPECTED) seen.add(`${state}|${event}`);
		const all = new Set<string>();
		for (const state of GAME_SESSION_STATES)
			for (const event of GAME_SESSION_EVENTS) all.add(`${state}|${event}`);
		expect([...all].filter((k) => !seen.has(k))).toEqual([]);
		expect([...seen].filter((k) => !all.has(k))).toEqual([]);
	});

	for (const [state, event, input, expected] of EXPECTED) {
		const turn = "myTurn" in input ? (input.myTurn ? " (my turn)" : " (their turn)") : "";
		it(`${state} + ${event}${turn} → ${expected ?? "no-op"}`, () => {
			expect(nextState(state, event as never, input)).toBe(expected);
		});
	}

	it("logs a warning and returns null for an undefined pair", () => {
		const warnings: unknown[][] = [];
		const original = log.warn;
		log.warn = (...args: unknown[]): void => void warnings.push(args);
		try {
			expect(nextState("idle", "executed", {})).toBeNull();
		} finally {
			log.warn = original;
		}
		expect(warnings.length).toBe(1);
		expect(String(warnings[0]?.[0])).toContain("no transition");
	});

	it("exposes the table as data (no state has an entry for an unknown event)", () => {
		for (const state of GAME_SESSION_STATES) {
			const row = TRANSITIONS[state];
			for (const key of Object.keys(row))
				expect(GAME_SESSION_EVENTS as readonly string[]).toContain(key);
		}
	});

	it("classifies live and my-turn states", () => {
		expect(GAME_SESSION_STATES.filter(isLiveState)).toEqual([
			"live:opponent-turn",
			"live:my-turn:analysing",
			"live:my-turn:recommended",
			"live:my-turn:executing",
		]);
		expect(GAME_SESSION_STATES.filter(isMyTurnState)).toEqual([
			"live:my-turn:analysing",
			"live:my-turn:recommended",
			"live:my-turn:executing",
		]);
	});
});
