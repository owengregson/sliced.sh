import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import path from "node:path";
import type { RuntimeMessageHandler } from "@core/chrome/runtime";
import { MSG } from "@core/constants/messages";
import { MOVE_QUALITY } from "@core/constants/move-quality";
import { FORCED_MATE_SOUNDS, MOVE_RATING_PLAYBACK, SOUNDS_DIR } from "@core/constants/sounds";
import { installMessageRouter } from "@core/messaging/router";
import {
	createMoveRatingSoundPlayer,
	type MoveRatingAudio,
	serveMoveRatingSounds,
} from "@offscreen/move-rating-sounds";

class FakeAudio implements MoveRatingAudio {
	preload = "";
	// Deliberately not the media defaults, so a test can see the player set every one of them.
	volume = 0.5;
	playbackRate = 0.5;
	preservesPitch = false;
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
	it("preloads only the five rating clips and the one forced-mate clip silently and reuses them for first playback", () => {
		const { player, sources } = setup();
		const names = ["brilliant", "great", "inaccuracy", "mistake", "blunder"];
		expect(sources.map((source) => source.url.split("/").at(-1))).toEqual([
			...names.map((name) => `${name}.mp3`),
			"forced.mp3",
		]);
		expect(sources.every((source) => source.preload === "auto" && source.plays === 0)).toBe(true);
		for (const name of names) expect(player.play(1, name)).toBe(true);
		expect(player.play(1, "mate", 0)).toBe(true);
		expect(sources).toHaveLength(6);
		expect(sources.every((source) => source.plays === 1)).toBe(true);
		player.dispose();
	});

	it("registers the one forced-mate clip, shipped under the sounds directory, and no numbered steps", () => {
		// Owner, 2026-09-15: "just use forced.mp3 without a number, don't swap between the sound files".
		expect(FORCED_MATE_SOUNDS.file).toBe("forced.mp3");
		const root = path.resolve(import.meta.dir, "../..");
		expect(existsSync(path.join(root, SOUNDS_DIR, FORCED_MATE_SOUNDS.file))).toBe(true);
		expect(JSON.stringify(FORCED_MATE_SOUNDS)).not.toMatch(/forced_\d/);
		expect(FORCED_MATE_SOUNDS.volumeScale).toBe(0.8);
		expect(FORCED_MATE_SOUNDS.semitonesPerOctave).toBe(12);
	});

	it("plays the forced-mate clip at its pitch, resampled as the panel pitches, at 0.8 of the rating volume", () => {
		const { player, sources, source } = setup();
		expect(player.play(1, "great")).toBe(true);
		const great = source("great.mp3");
		expect(great.volume).toBe(MOVE_RATING_PLAYBACK.volume);
		expect(great.playbackRate).toBe(MOVE_RATING_PLAYBACK.playbackRate);
		expect(great.preservesPitch).toBe(true);
		// The checkmate: +3 semitones.
		expect(player.play(1, "mate", MOVE_QUALITY.mateTopSemitones)).toBe(true);
		const top = source("forced.mp3");
		expect(top.plays).toBe(1);
		expect(top.playbackRate).toBeCloseTo(2 ** (3 / 12), 9);
		expect(top.preservesPitch).toBe(false);
		expect(top.volume).toBeCloseTo(MOVE_RATING_PLAYBACK.volume * 0.8, 9);
		// Only the requested clip sounded.
		expect(sources.filter((audio) => audio.plays === 1)).toHaveLength(2);
		// Every other move of a sequence: the same file, a fresh element, its own pitch.
		for (const [semitones, rate] of [
			[MOVE_QUALITY.mateMinSemitones, 0.5],
			[0, 1],
			[1.5, 2 ** (1.5 / 12)],
		] as const) {
			expect(player.play(1, "mate", semitones)).toBe(true);
			const voice = sources.at(-1);
			expect(voice?.url.endsWith("forced.mp3")).toBe(true);
			expect(voice).not.toBe(top);
			expect(voice?.plays).toBe(1);
			expect(voice?.playbackRate).toBeCloseTo(rate, 9);
			expect(voice?.preservesPitch).toBe(false);
			expect(voice?.volume).toBeCloseTo(0.8, 9);
		}
		player.dispose();
	});

	it("rejects a forced-mate chip without a playable pitch", () => {
		const { player, sources } = setup();
		for (const semitones of [
			undefined,
			null,
			MOVE_QUALITY.mateTopSemitones + 0.5,
			MOVE_QUALITY.mateMinSemitones - 0.5,
			Number.NaN,
			Number.POSITIVE_INFINITY,
			"3",
			[3],
		]) {
			expect(player.play(1, "mate", semitones)).toBe(false);
		}
		// A pitch never turns a rating clip into a forced-mate one.
		expect(player.play(1, "great", 3)).toBe(true);
		expect(sources.filter((audio) => audio.plays === 1).map((audio) => audio.url)).toEqual([
			expect.stringContaining("great.mp3"),
		]);
		player.dispose();
	});

	it("ignores unmapped qualities, alternate best files and malformed tab identities", () => {
		const { player, sources } = setup();
		for (const quality of ["best_v2", "best", "book", "constructor", "__proto__", null, 1]) {
			expect(player.play(1, quality)).toBe(false);
		}
		for (const tabId of [-1, Number.NaN, 1.5]) expect(player.play(tabId, "great")).toBe(false);
		expect(sources.every((source) => source.plays === 0)).toBe(true);
		player.dispose();
	});

	it("lets two distinct move verdicts overlap, even with the same rating", () => {
		const { player, sources, source } = setup();
		player.play(1, "great");
		player.play(1, "great");
		expect(sources.filter((audio) => audio.plays === 1)).toHaveLength(2);
		expect(source("great.mp3").pauses).toBe(0);
		player.stop(1);
		expect(sources.filter((audio) => audio.plays === 1).every((audio) => audio.pauses === 1)).toBe(
			true
		);
		player.dispose();
	});

	it("stops only the sender tab and releases finished or errored voices", () => {
		const { player, source } = setup();
		player.play(1, "great");
		player.play(2, "brilliant");
		player.play(2, "blunder");
		source("brilliant.mp3").emit("ended");
		source("blunder.mp3").emit("error");
		player.stop(2);
		expect(source("great.mp3").pauses).toBe(0);
		expect(source("brilliant.mp3").pauses).toBe(0);
		expect(source("blunder.mp3").pauses).toBe(1);
		expect(source("brilliant.mp3").listenerCount).toBe(0);
		expect(source("blunder.mp3").listenerCount).toBe(0);
		player.stop(1);
		expect(source("great.mp3").pauses).toBe(1);
		expect(source("great.mp3").listenerCount).toBe(0);
		player.dispose();
	});

	it("clears pending playback and does not revive it when its promise later resolves", async () => {
		const { player, source } = setup();
		let resolve!: () => void;
		const great = source("great.mp3");
		great.playResult = new Promise<void>((done) => {
			resolve = done;
		});
		player.play(1, "great");
		player.stop(1);
		expect(great.pauses).toBe(1);
		resolve();
		await Promise.resolve();
		expect(great.pauses).toBe(2);
		expect(great.listenerCount).toBe(0);
		player.dispose();
	});

	it("contains media construction, synchronous play and autoplay rejection failures", async () => {
		const unavailable = createMoveRatingSoundPlayer(() => {
			throw new Error("No audio");
		});
		expect(unavailable.play(1, "great")).toBe(false);
		unavailable.dispose();
		const { player, source } = setup();
		source("great.mp3").playError = new Error("No decoder");
		expect(player.play(1, "great")).toBe(false);
		expect(source("great.mp3").listenerCount).toBe(0);
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
		player.play(1, "great");
		player.play(2, "blunder");
		player.dispose();
		expect(sources.every((source) => source.pauses === 1 && source.listenerCount === 0)).toBe(true);
		expect(player.play(1, "great")).toBe(false);
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
		expect(dispatch({ type: MSG.OFFSCREEN_MOVE_RATING_SOUND, quality: "great", tabId: 99 })).toEqual([
			{ success: true, response: true },
		]);
		expect(source("great.mp3").plays).toBe(1);
		expect(
			dispatch({ type: MSG.OFFSCREEN_MOVE_RATING_SOUND, quality: "mate", mateSemitones: 2, tabId: 99 })
		).toEqual([{ success: true, response: true }]);
		expect(source("forced.mp3").plays).toBe(1);
		expect(source("forced.mp3").playbackRate).toBeCloseTo(2 ** (2 / 12), 9);
		expect(source("forced.mp3").preservesPitch).toBe(false);
		expect(dispatch({ type: MSG.OFFSCREEN_MOVE_RATING_SOUND, quality: "mate" })).toEqual([
			{ success: true, response: false },
		]);
		expect(source("forced.mp3").pauses).toBe(0);
		for (const invalid of [
			{ ...sender, id: "other-extension" },
			{ ...sender, frameId: 1 },
			{ id: "our-extension" },
		]) {
			expect(dispatch({ type: MSG.OFFSCREEN_MOVE_RATING_SOUND, quality: null }, invalid)).toEqual([
				{ success: true, response: false },
			]);
		}
		expect(source("great.mp3").pauses).toBe(0);
		expect(dispatch({ type: MSG.OFFSCREEN_MOVE_RATING_SOUND, quality: null, tabId: 99 })).toEqual([
			{ success: true, response: true },
		]);
		expect(source("great.mp3").pauses).toBe(1);
		expect(source("forced.mp3").pauses).toBe(1);
		stop();
		expect(runtimeListeners.size).toBe(1);
		expect(dispatch({ type: MSG.OFFSCREEN_MOVE_RATING_SOUND, quality: "great" })).toEqual([]);
		sw.dispose();
		expect(runtimeListeners.size).toBe(0);
	});
});
