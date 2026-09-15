import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { RuntimeMessageHandler } from "@core/chrome/runtime";
import { MSG } from "@core/constants/messages";
import { installMessageRouter } from "@core/messaging/router";
import {
	createMoveRatingSoundPlayer,
	type MoveRatingAudio,
	serveMoveRatingSounds,
} from "@offscreen/move-rating-sounds";

class FakeAudio implements MoveRatingAudio {
	preload = "";
	plays = 0;
	pauses = 0;
	playResult: Promise<void> | undefined;
	playError: Error | undefined;
	listeners = new Map<string, Set<() => void>>();
	constructor(readonly url: string) {}
	play(): Promise<void> | void {
		this.plays++;
		if (this.playError) throw this.playError;
		return this.playResult;
	}
	pause(): void {
		this.pauses++;
	}
	addEventListener(type: string, listener: () => void): void {
		const listeners = this.listeners.get(type) ?? new Set();
		listeners.add(listener);
		this.listeners.set(type, listeners);
	}
	removeEventListener(type: string, listener: () => void): void {
		this.listeners.get(type)?.delete(listener);
	}
	emit(type: string): void {
		for (const listener of this.listeners.get(type) ?? []) listener();
	}
	get listenerCount(): number {
		return [...this.listeners.values()].reduce((count, listeners) => count + listeners.size, 0);
	}
}

let runtimeListeners: Set<RuntimeMessageHandler>;
const globalRecord = globalThis as Record<string, unknown>;
let previousChrome: unknown;
beforeEach(() => {
	previousChrome = globalRecord.chrome;
	runtimeListeners = new Set();
	globalRecord.chrome = {
		runtime: {
			id: "our-extension",
			getURL: (path: string) => `chrome-extension://our-extension/${path}`,
			onMessage: {
				addListener: (listener: RuntimeMessageHandler) => runtimeListeners.add(listener),
				removeListener: (listener: RuntimeMessageHandler) => runtimeListeners.delete(listener),
			},
		},
	};
});
afterEach(() => {
	if (previousChrome === undefined) delete globalRecord.chrome;
	else globalRecord.chrome = previousChrome;
});

function setup() {
	const sources: FakeAudio[] = [];
	const player = createMoveRatingSoundPlayer((url) => {
		const source = new FakeAudio(url);
		sources.push(source);
		return source;
	});
	const source = (name: string): FakeAudio => sources.find((audio) => audio.url.endsWith(name))!;
	return { player, sources, source };
}

describe("move-rating sounds", () => {
	it("preloads only the five requested clips silently and reuses them for first playback", () => {
		const { player, sources } = setup();
		const names = ["brilliant", "best", "inaccuracy", "mistake", "blunder"];
		expect(sources.map((source) => source.url.split("/").at(-1))).toEqual(
			names.map((name) => `${name}.mp3`)
		);
		expect(sources.every((source) => source.preload === "auto" && source.plays === 0)).toBe(true);
		for (const name of names) expect(player.play(1, name)).toBe(true);
		expect(sources).toHaveLength(5);
		expect(sources.every((source) => source.plays === 1)).toBe(true);
		player.dispose();
	});

	it("ignores unmapped qualities, alternate best files and malformed tab identities", () => {
		const { player, sources } = setup();
		for (const quality of ["best_v2", "great", "book", "constructor", "__proto__", null, 1]) {
			expect(player.play(1, quality)).toBe(false);
		}
		for (const tabId of [-1, Number.NaN, 1.5]) expect(player.play(tabId, "best")).toBe(false);
		expect(sources.every((source) => source.plays === 0)).toBe(true);
		player.dispose();
	});

	it("lets two distinct move verdicts overlap, even with the same rating", () => {
		const { player, sources, source } = setup();
		player.play(1, "best");
		player.play(1, "best");
		expect(sources.filter((audio) => audio.plays === 1)).toHaveLength(2);
		expect(source("best.mp3").pauses).toBe(0);
		player.stop(1);
		expect(sources.filter((audio) => audio.plays === 1).every((audio) => audio.pauses === 1)).toBe(
			true
		);
		player.dispose();
	});

	it("stops only the sender tab and releases finished or errored voices", () => {
		const { player, source } = setup();
		player.play(1, "best");
		player.play(2, "brilliant");
		player.play(2, "blunder");
		source("brilliant.mp3").emit("ended");
		source("blunder.mp3").emit("error");
		player.stop(2);
		expect(source("best.mp3").pauses).toBe(0);
		expect(source("brilliant.mp3").pauses).toBe(0);
		expect(source("blunder.mp3").pauses).toBe(1);
		expect(source("brilliant.mp3").listenerCount).toBe(0);
		expect(source("blunder.mp3").listenerCount).toBe(0);
		player.stop(1);
		expect(source("best.mp3").pauses).toBe(1);
		expect(source("best.mp3").listenerCount).toBe(0);
		player.dispose();
	});

	it("clears pending playback and does not revive it when its promise later resolves", async () => {
		const { player, source } = setup();
		let resolve!: () => void;
		const best = source("best.mp3");
		best.playResult = new Promise<void>((done) => {
			resolve = done;
		});
		player.play(1, "best");
		player.stop(1);
		expect(best.pauses).toBe(1);
		resolve();
		await Promise.resolve();
		expect(best.pauses).toBe(2);
		expect(best.listenerCount).toBe(0);
		player.dispose();
	});

	it("contains media construction, synchronous play and autoplay rejection failures", async () => {
		const unavailable = createMoveRatingSoundPlayer(() => {
			throw new Error("No audio");
		});
		expect(unavailable.play(1, "best")).toBe(false);
		unavailable.dispose();
		const { player, source } = setup();
		source("best.mp3").playError = new Error("No decoder");
		expect(player.play(1, "best")).toBe(false);
		expect(source("best.mp3").listenerCount).toBe(0);
		source("brilliant.mp3").playResult = Promise.reject(
			new DOMException("Blocked", "NotAllowedError")
		);
		expect(player.play(1, "brilliant")).toBe(true);
		await Promise.resolve();
		expect(source("brilliant.mp3").listenerCount).toBe(0);
		expect(source("brilliant.mp3").pauses).toBe(1);
		player.dispose();
	});

	it("disposes all active and preloaded sources and rejects further playback", () => {
		const { player, sources } = setup();
		player.play(1, "best");
		player.play(2, "blunder");
		player.dispose();
		expect(sources.every((source) => source.pauses === 1 && source.listenerCount === 0)).toBe(true);
		expect(player.play(1, "best")).toBe(false);
		player.dispose();
		expect(sources.every((source) => source.pauses === 1)).toBe(true);
	});
});

describe("offscreen sound messaging", () => {
	it("routes only extension content messages, derives the tab from sender, and has no SW reply race", () => {
		const { player, source } = setup();
		const sw = installMessageRouter();
		sw.install();
		const stop = serveMoveRatingSounds(player);
		const sender = {
			id: "our-extension",
			tab: { id: 7 },
			frameId: 0,
		} as chrome.runtime.MessageSender;
		function dispatch(message: unknown, from = sender): unknown[] {
			const replies: unknown[] = [];
			for (const listener of runtimeListeners) listener(message, from, (reply) => replies.push(reply));
			return replies;
		}
		expect(dispatch({ type: "irrelevant" })).toEqual([]);
		expect(dispatch({ type: MSG.OFFSCREEN_MOVE_RATING_SOUND, quality: "best", tabId: 99 })).toEqual([
			{ success: true, response: true },
		]);
		expect(source("best.mp3").plays).toBe(1);
		for (const invalid of [
			{ ...sender, id: "other-extension" },
			{ ...sender, frameId: 1 },
			{ id: "our-extension" },
		]) {
			expect(dispatch({ type: MSG.OFFSCREEN_MOVE_RATING_SOUND, quality: null }, invalid)).toEqual([
				{ success: true, response: false },
			]);
		}
		expect(source("best.mp3").pauses).toBe(0);
		expect(dispatch({ type: MSG.OFFSCREEN_MOVE_RATING_SOUND, quality: null, tabId: 99 })).toEqual([
			{ success: true, response: true },
		]);
		expect(source("best.mp3").pauses).toBe(1);
		stop();
		expect(runtimeListeners.size).toBe(1);
		expect(dispatch({ type: MSG.OFFSCREEN_MOVE_RATING_SOUND, quality: "best" })).toEqual([]);
		sw.dispose();
		expect(runtimeListeners.size).toBe(0);
	});
});
