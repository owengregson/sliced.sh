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
import type { BoardEffect } from "@core/constants/board-effects";
import type { GamePortCommand } from "@core/constants/messages";
import type { MoveQualityMark } from "@core/constants/move-quality";
import { TIMINGS } from "@core/constants/timings";
import { log } from "@core/logger";

export interface BoardEffects {
	enabled(): boolean;
	setEnabled(on: boolean): void;
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
}

export function createBoardEffects(bridge: PageBridge, options: BoardEffectsOptions): BoardEffects {
	let enabled = options.initiallyEnabled === true;
	let drawn = false;
	let disposed = false;

	const ready = (): PageBridge | null => (!disposed && bridge.isAvailable() ? bridge : null);

	const clear = (): Promise<void> => {
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
		live
			.call(BRIDGE_KINDS.effects, payload, TIMINGS.adapterBridgeTimeoutMs)
			.then(() => undefined)
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
