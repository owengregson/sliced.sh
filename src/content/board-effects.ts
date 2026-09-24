/**
 * Board-effect relay (owner's brief, 2026-09-13). The service worker decides what the move that
 * just landed did and how good it was; this forwards the batch to the MAIN-world bridge, which
 * owns the element — nothing in this world inserts DOM (`Markings.draw`: "no DOM insertion from
 * the adapter", §13.3).
 *
 * It is deliberately not part of `Highlights`: the two layers have separate elements, separate
 * settings and separate clears, so a recommendation mark coming and going must not disturb a batch
 * mid-animation, and turning one off must not blank the other.
 *
 * The orientation is read here for the same reason the recommendation mark reads it: the page side
 * draws from screen coordinates and has no other way to know which way round the board is.
 */

import { BRIDGE_KINDS, type PageBridge } from "@content/adapters/bridge-protocol";
import { runtimeSendMessage } from "@core/chrome/runtime";
import type { BoardEffect } from "@core/constants/board-effects";
import { type GamePortCommand, MSG } from "@core/constants/messages";
import { MOVE_QUALITY, type MoveQualityMark } from "@core/constants/move-quality";
import { TIMINGS } from "@core/constants/timings";
import { log } from "@core/logger";

export interface BoardEffects {
	/** The rays and the capture mark (`automation.boardEffects`). */
	enabled(): boolean;
	setEnabled(on: boolean): void;
	/**
	 * The rating chip (`automation.moveQualityChips`), independent of `setEnabled` (owner,
	 * 2026-09-15): with the rays off a batch still draws and sounds its chip; with the ratings off a
	 * batch draws only its rays. Turning either off erases the whole layer — the page overlay has
	 * one clear — and the other kind resumes with the next move.
	 */
	setRatingsEnabled(on: boolean): void;
	setSoundsEnabled(on: boolean): void;
	/**
	 * The forced-mate chip's own sound (`automation.forcedMateSounds`, owner 2026-09-14). Inert
	 * while `setSoundsEnabled` is off; off, a forced-mate chip plays nothing at all.
	 */
	setForcedMateSoundsEnabled(on: boolean): void;
	/** Apply a port command; returns whether it was one of the effect layer's. */
	apply(cmd: GamePortCommand): boolean;
	/** Resolves once the page side answered (a no-op when nothing was drawn). */
	clear(): Promise<void>;
	dispose(): void;
}

export interface BoardEffectsPayload {
	orientation: "white" | "black";
	mine: boolean;
	effects: BoardEffect[];
	quality?: MoveQualityMark;
}

export interface BoardEffectsOptions {
	/** Black at the bottom (`SiteAdapter.isFlipped`). */
	flipped(): boolean;
	/** The rays start on (tests; production waits for the `settings` command). */
	initiallyEnabled?: boolean;
	/** The rating chip starts on (tests; production waits for the `settings` command). */
	initiallyRatingsEnabled?: boolean;
	/**
	 * Override the extension-owned player in tests. `mateSemitones` accompanies a `mate` chip only,
	 * as the pitch `forcedMateSemitones` settled on.
	 */
	sound?(quality: MoveQualityMark["quality"] | null, mateSemitones?: number): void;
}

/**
 * The forced-mate pitch a chip names, clamped to `MOVE_QUALITY.mateMinSemitones` …
 * `mateTopSemitones` (not rounded: a tangential move sits between steps); `null` when the chip
 * carries no usable value, which plays nothing.
 */
export function forcedMateSemitones(semitones: number | undefined): number | null {
	if (semitones === undefined || !Number.isFinite(semitones)) return null;
	return Math.min(MOVE_QUALITY.mateTopSemitones, Math.max(MOVE_QUALITY.mateMinSemitones, semitones));
}

export function createBoardEffects(bridge: PageBridge, options: BoardEffectsOptions): BoardEffects {
	let enabled = options.initiallyEnabled === true;
	let ratingsEnabled = options.initiallyRatingsEnabled === true;
	let drawn = false;
	let disposed = false;
	let soundsEnabled = false;
	let soundGeneration = 0;
	let forcedMateSoundsEnabled = false;
	let forcedMateGeneration = 0;
	const sound =
		options.sound ??
		((quality: MoveQualityMark["quality"] | null, mateSemitones?: number): void => {
			void runtimeSendMessage({
				type: MSG.OFFSCREEN_MOVE_RATING_SOUND,
				quality,
				...(mateSemitones === undefined ? {} : { mateSemitones }),
			}).catch((error: unknown) => log.debug("board effects: sound unavailable", error));
		});

	const ready = (): PageBridge | null => (!disposed && bridge.isAvailable() ? bridge : null);

	const clear = (): Promise<void> => {
		soundGeneration += 1;
		if (soundsEnabled) sound(null);
		if (!drawn) return Promise.resolve();
		drawn = false;
		const live = ready();
		if (!live) return Promise.resolve();
		return live
			.call(BRIDGE_KINDS.effectsClear, undefined, TIMINGS.adapterBridgeTimeoutMs)
			.then(() => undefined)
			.catch((error: unknown) => {
				log.debug("board effects: clear failed", error);
			});
	};

	const draw = (cmd: Extract<GamePortCommand, { kind: "effects" }>): void => {
		// Each half of the batch passes its own gate; a batch left with nothing to draw is not sent.
		const mark = ratingsEnabled ? cmd.quality : undefined;
		if (!enabled && !mark) return;
		const live = ready();
		if (!live) return;
		const payload: BoardEffectsPayload = {
			orientation: options.flipped() ? "black" : "white",
			mine: cmd.mine,
			effects: enabled ? cmd.effects : [],
			...(mark ? { quality: mark } : {}),
		};
		drawn = true;
		const generation = soundGeneration;
		const playSound = soundsEnabled;
		const mateGeneration = forcedMateGeneration;
		const playForcedMate = forcedMateSoundsEnabled;
		live
			.call<boolean>(BRIDGE_KINDS.effects, payload, TIMINGS.adapterBridgeTimeoutMs)
			.then((added) => {
				if (
					added !== true ||
					!mark ||
					!playSound ||
					!soundsEnabled ||
					!ratingsEnabled ||
					disposed ||
					generation !== soundGeneration
				)
					return;
				if (mark.quality !== "mate") {
					sound(mark.quality);
					return;
				}
				// A forced-mate chip has its own switch and never falls back to a rating clip.
				const semitones = forcedMateSemitones(mark.mateSemitones);
				if (
					semitones !== null &&
					playForcedMate &&
					forcedMateSoundsEnabled &&
					mateGeneration === forcedMateGeneration
				)
					sound(mark.quality, semitones);
			})
			.catch((error: unknown) => {
				log.debug("board effects: draw failed", error);
			});
	};

	return {
		enabled: () => enabled,
		setEnabled(on) {
			if (enabled === on) return;
			enabled = on;
			if (!on) void clear();
		},
		setRatingsEnabled(on) {
			if (ratingsEnabled === on) return;
			ratingsEnabled = on;
			if (!on) void clear();
		},
		setSoundsEnabled(on) {
			if (soundsEnabled === on) return;
			soundsEnabled = on;
			soundGeneration += 1;
			if (!on) sound(null);
		},
		setForcedMateSoundsEnabled(on) {
			if (forcedMateSoundsEnabled === on) return;
			forcedMateSoundsEnabled = on;
			forcedMateGeneration += 1;
			// The player stops a tab's voices together, so this silences a rating clip still
			// sounding as well — the same stop the rating switch sends.
			if (!on && soundsEnabled) sound(null);
		},
		apply(cmd) {
			switch (cmd.kind) {
				case "effects":
					draw(cmd);
					return true;
				case "clearEffects":
					void clear();
					return true;
				default:
					return false;
			}
		},
		clear,
		dispose() {
			if (disposed) return;
			void clear();
			disposed = true;
		},
	};
}
