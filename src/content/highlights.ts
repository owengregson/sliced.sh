/**
 * Highlight gate (Task 21, §13.3 rule 4). Routes the `highlight` / `arrow` /
 * `clearHighlight` port commands to the adapter — which draws through the
 * bridge: native `game.markings` when the board exposes it, the
 * bridge-embedded overlay program otherwise — and only while
 * `Settings.automation.highlightMoves` is on (nothing is drawn until the
 * service worker sends `settings`, whatever the stored default says).
 *
 * **Nothing here clears for an execution.** §13.3 rule 4's "no mark may be
 * present at move-submission time" is overruled for the mark of the move being
 * submitted (the owner's ruling, 2026-09-10): that mark belongs to the hand's
 * whole action and only completion erases it, from the service worker
 * (`GameSession.onExecuted` / `onNotExecuted`). The clear that used to run
 * before every `observeMove` is why that could not hold — `observeMove` is the
 * verifier, and `runWithRetry` issues one after every attempt and before every
 * retry, so a retry tier ran with nothing on the board.
 * `highlightMoves` going off still clears, which is a different thing.
 *
 * A mark never stacks on a mark: a `highlight` / `arrow` while something of ours
 * is already drawn clears it first. The generic SVG overlay happens to redraw
 * from scratch, but native `game.markings` does not — it only ever *adds*, and
 * the keys of the previous draw are forgotten — so without this a new
 * recommendation (or every hover of the panel's line list) left the old squares
 * on the board for good (owner's live test, 2026-09-09). The clear and the draw
 * are two bridge calls in that order on one channel, so the page applies them in
 * that order.
 *
 * The one exception is a **forced-overlay** draw, which is the mark of a move
 * the hand is already acting on: a separate clear would leave the board
 * unmarked for a frame at exactly the moment the owner is watching, so the page
 * program makes that draw a replacement instead (it removes our own native
 * markings inside the `draw` handler, and `ovDraw` rebuilds the overlay from
 * scratch). One bridge call, no gap.
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
		highlight(from, to, style, options = {}) {
			if (!enabled) return;
			// A forced-overlay draw replaces on the page, in one call: see the note above.
			if (options.forceOverlay !== true) void clear();
			drawn = true;
			adapter.highlight(from, to, style, options);
		},
		arrows(lines) {
			if (!enabled || lines.length === 0) return;
			void clear();
			drawn = true;
			adapter.arrows(lines);
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
