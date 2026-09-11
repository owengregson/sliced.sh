/**
 * Recommendation marks use the bridge's pointer-transparent SVG, replacing the previous mark
 * atomically. The page suppresses identical animations while still repairing a replaced board
 * or applying a changed orientation. An execution's repeated mark keeps its existing animation.
 *
 * Nothing clears for a verifier or press: the mark belongs to the whole action. Completion,
 * a new position, disabling highlights, or an explicit clear removes it from the service worker.
 */

import type { ArrowLine, DrawOptions, SiteAdapter } from "@content/adapters/adapter";
import type { GamePortCommand } from "@core/constants/messages";
import type { HighlightStyle, Square } from "@typedefs/game";

export interface Highlights {
	enabled(): boolean;
	setEnabled(on: boolean): void;
	highlight(from: Square, to: Square, style: HighlightStyle, options?: DrawOptions): void;
	arrows(lines: ArrowLine[]): void;
	/** Resolves once the page side acknowledged (a no-op when nothing was drawn). */
	clear(): Promise<void>;
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
			// Our SVG replaces atomically, animates, and survives the board's own presses.
			adapter.highlight(from, to, style, { forceOverlay: true });
		},
		arrows(lines) {
			if (!enabled || lines.length === 0) return;
			drawn = true;
			adapter.arrows(lines, { forceOverlay: true });
		},
		clear,
		apply(cmd) {
			switch (cmd.kind) {
				case "highlight":
					api.highlight(cmd.from, cmd.to, cmd.style, { forceOverlay: cmd.overlay === true });
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
