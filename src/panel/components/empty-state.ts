/**
 * Empty state (Appendix F §5.14): large tertiary icon, title, ≤3-line body, 1–2 actions, note.
 * Vertically centred in the content area with a slight upward bias (CSS). Used by views 2, 3,
 * 7, 8 and the Lines section ("No lines yet").
 */

import type { IconName } from "@design/icons";
import { applyIcon } from "../icons-mount";
import { instantiate, part } from "../template";
import html from "../views/templates/components/empty-state.html?raw";
import { type ButtonOptions, createButton } from "./button";

export interface EmptyStateOptions {
	icon?: IconName | null;
	title: string;
	body?: string;
	actions?: ButtonOptions[];
	note?: string | null;
}

export interface EmptyStateHandle {
	readonly el: HTMLElement;
	update(patch: Partial<EmptyStateOptions>): void;
	dispose(): void;
}

export function createEmptyState(
	host: HTMLElement | null,
	options: EmptyStateOptions
): EmptyStateHandle {
	const el = instantiate(html);
	const icon = part(el, ".sl-empty__icon");
	const title = part(el, ".sl-empty__title");
	const body = part(el, ".sl-empty__body");
	const actions = part(el, ".sl-empty__actions");
	const note = part(el, ".sl-empty__note");
	let buttons: Array<ReturnType<typeof createButton>> = [];

	function update(patch: Partial<EmptyStateOptions>): void {
		if (patch.icon !== undefined) {
			if (patch.icon) {
				applyIcon(icon, patch.icon);
				icon.hidden = false;
			} else icon.hidden = true;
		}
		if (patch.title !== undefined) title.textContent = patch.title;
		if (patch.body !== undefined) {
			body.textContent = patch.body;
			body.hidden = !patch.body;
		}
		if (patch.actions !== undefined) {
			for (const b of buttons) b.dispose();
			buttons = [];
			actions.replaceChildren();
			for (const a of patch.actions.slice(0, 2)) buttons.push(createButton(actions, a));
			actions.hidden = patch.actions.length === 0;
		}
		if (patch.note !== undefined) {
			note.textContent = patch.note ?? "";
			note.hidden = !patch.note;
		}
	}

	update({
		icon: options.icon ?? null,
		title: options.title,
		body: options.body ?? "",
		actions: options.actions ?? [],
		note: options.note ?? null,
	});
	host?.append(el);
	return {
		el,
		update,
		dispose() {
			for (const b of buttons) b.dispose();
			el.remove();
		},
	};
}
