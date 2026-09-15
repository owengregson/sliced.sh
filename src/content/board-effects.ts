/**
 * Board-effect relay (owner's brief, 2026-09-13). The service worker decides what the move that
 * just landed did and how good it was; this forwards the batch to the MAIN-world bridge, which
 * owns the element — nothing in this world inserts DOM (`AdapterBase.draw`: "no DOM insertion from
 * the adapter", §13.3).
 *
 * It is deliberately not part of `Highlights`: the two layers have separate elements, separate
 * settings and separate clears, so a recommendation mark coming and going must not disturb a batch
 * mid-animation, and turning one off must not blank the other.
 *
 * The orientation is read here for the same reason the recommendation mark reads it: the page side
 * draws from screen coordinates and has no other way to know which way round the board is.
 */

import { BRIDGE_KINDS, type PageBridge } from "@content/adapters/adapter";
import { runtimeSendMessage } from "@core/chrome/runtime";
import type { BoardEffect } from "@core/constants/board-effects";
import { type GamePortCommand, MSG } from "@core/constants/messages";
import type { MoveQualityMark } from "@core/constants/move-quality";
import { TIMINGS } from "@core/constants/timings";
import { log } from "@core/logger";

export interface BoardEffects {
	enabled(): boolean;
	setEnabled(on: boolean): void;
	setSoundsEnabled(on: boolean): void;
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
	initiallyEnabled?: boolean;
	/** Override the extension-owned player in tests. */
	sound?(quality: MoveQualityMark["quality"] | null): void;
}

export function createBoardEffects(bridge: PageBridge, options: BoardEffectsOptions): BoardEffects {
	let enabled = options.initiallyEnabled === true;
	let drawn = false;
	let disposed = false;
	let soundsEnabled = false;
	let soundGeneration = 0;
	const sound =
		options.sound ??
		((quality: MoveQualityMark["quality"] | null): void => {
			void runtimeSendMessage({ type: MSG.OFFSCREEN_MOVE_RATING_SOUND, quality }).catch(
				(error: unknown) => log.debug("board effects: sound unavailable", error)
			);
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
		if (!enabled) return;
		const live = ready();
		if (!live) return;
		const payload: BoardEffectsPayload = {
			orientation: options.flipped() ? "black" : "white",
			mine: cmd.mine,
			effects: cmd.effects,
			...(cmd.quality ? { quality: cmd.quality } : {}),
		};
		drawn = true;
		const generation = soundGeneration;
		const playSound = soundsEnabled;
		live
			.call<boolean>(BRIDGE_KINDS.effects, payload, TIMINGS.adapterBridgeTimeoutMs)
			.then((added) => {
				if (
					added === true &&
					cmd.quality &&
					playSound &&
					soundsEnabled &&
					enabled &&
					!disposed &&
					generation === soundGeneration
				)
					sound(cmd.quality.quality);
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
		setSoundsEnabled(on) {
			if (soundsEnabled === on) return;
			soundsEnabled = on;
			soundGeneration += 1;
			if (!on) sound(null);
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
