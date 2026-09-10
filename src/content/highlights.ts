/**
 * Highlight gate (Task 21, §13.3 rule 4). Routes the `highlight` / `arrow` /
 * `clearHighlight` port commands to the adapter — which draws through the
 * bridge: native `game.markings` when the board exposes it, the
 * bridge-embedded overlay program otherwise — and only while
 * `Settings.automation.highlightMoves`
 * is on (nothing is drawn until the service worker sends `settings`, whatever

 * the stored default says). `clearForExecution()` runs before every `observeMove` and
 * resolves only once the page side has acknowledged the clear (bounded by
 * the bridge call timeout, `TIMINGS.adapterBridgeTimeoutMs`), so no mark is
 * present at move-submission time.
 */

import type { ArrowLine, SiteAdapter } from "@content/adapters/adapter";
import type { GamePortCommand } from "@core/constants/messages";
import type { HighlightStyle, Square } from "@typedefs/game";

export interface Highlights {
	enabled(): boolean;
	setEnabled(on: boolean): void;
	highlight(from: Square, to: Square, style: HighlightStyle): void;
	arrows(lines: ArrowLine[]): void;
	/** Resolves once the page side acknowledged (a no-op when nothing was drawn). */
	clear(): Promise<void>;
	/** Clear before the hand moves; resolves when the page side acknowledged. */
	clearForExecution(): Promise<void>;
	/** Apply a port command; returns whether it was a highlight command. */
	apply(cmd: GamePortCommand): boolean;
}

export function createHighlights(adapter: SiteAdapter, initiallyEnabled = false): Highlights {
	let enabled = initiallyEnabled;
	let drawn = false;

	const clear = (): Promise<void> => {
		if (!drawn) return Promise.resolve();
		drawn = false;
		return adapter.clearHighlights();
	};

	const api: Highlights = {
		enabled: () => enabled,
		setEnabled(on) {
			enabled = on;
			if (!on) void clear();
		},
		highlight(from, to, style) {
			if (!enabled) return;
			drawn = true;
			adapter.highlight(from, to, style);
		},
		arrows(lines) {
			if (!enabled || lines.length === 0) return;
			drawn = true;
			adapter.arrows(lines);
		},
		clear,
		clearForExecution: clear,
		apply(cmd) {
			switch (cmd.kind) {
				case "highlight":
					api.highlight(cmd.from, cmd.to, cmd.style);
					return true;
				case "arrow":
					api.arrows(cmd.lines);
					return true;
				case "clearHighlight":
					void clear();
					return true;
				default:
					return false;
			}
		},
	};
	return api;
}
