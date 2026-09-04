/**
 * View 7 — Update available (Appendix F §4.8): mark, "sliced 2.1 is ready", up to three lines of
 * release notes, Restart and update (`onUpdate`, wired by the boot code) and Later — a shell
 * `dismiss-update` action, which returns to the previous view and leaves the info banner; the
 * shell never re-interrupts and the router defers the interrupt while a game is live.
 */

import { log } from "@core/logger";
import { createEmptyState } from "../components/empty-state";
import { COPY } from "../copy";
import { instantiate, part } from "../template";
import type { View } from "../view";
import { mountMark } from "./mark";
import html from "./templates/update.html?raw";

export interface UpdateViewOptions {
	/** The version that is ready (default: the build define, as the shell's banner does). */
	version?: string;
	/** Release notes for the body (≤3 lines); hidden when absent. */
	notes?: string | null;
	/** Restart and update (Task 27/31 wires the runtime reload). */
	onUpdate?: () => void;
}

export function createUpdateView(options: UpdateViewOptions = {}): View {
	return {
		mount(ctx) {
			const el = instantiate(html);
			const mark = part<HTMLImageElement>(el, ".sl-update__mark");
			const unmountMark = mountMark(mark);
			const empty = createEmptyState(el, {
				icon: null,
				title: COPY.update.title(options.version ?? __SL_VERSION__),
				body: options.notes ?? "",
				actions: [
					{
						label: COPY.update.primary,
						variant: "primary",
						size: "lg",
						icon: "action.update",
						onClick: () => {
							if (options.onUpdate) options.onUpdate();
							else log.info("update: no updater wired");
						},
					},
					{ label: COPY.update.later, variant: "ghost" },
				],
				note: COPY.update.note,
			});
			empty.el.prepend(mark);
			const later = empty.el.querySelectorAll<HTMLElement>(".sl-empty__actions .sl-button")[1];
			if (later) later.dataset.action = "dismiss-update";
			ctx.container.append(el);
			return () => {
				unmountMark();
				empty.dispose();
				el.remove();
			};
		},
	};
}

export const updateView: View = createUpdateView();
