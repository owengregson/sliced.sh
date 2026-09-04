/**
 * Segmented control (Appendix F §5.15): a sunken track whose active segment is a raised pill
 * that slides between segments. `role="tablist"` / `role="tab"`; arrow keys move between
 * segments. Used by the view switch (Game / Settings / Engine) and Drag / Click.
 */

import type { IconName } from "@design/icons";
import { applyIcon } from "../icons-mount";
import { instantiate, part } from "../template";
import html from "../views/templates/components/segment.html?raw";
import itemHtml from "../views/templates/components/segment-item.html?raw";
import { attachTooltip } from "./popover";

export interface SegmentItem<T extends string> {
	id: T;
	label: string;
	icon?: IconName;
	/** Tooltip shown when labels are hidden (<420 px) — the label is used when omitted. */
	tooltip?: string;
}

export interface SegmentOptions<T extends string> {
	items: ReadonlyArray<SegmentItem<T>>;
	value: T;
	ariaLabel?: string;
	disabled?: boolean;
	onChange: (value: T) => void;
}

export interface SegmentHandle<T extends string> {
	readonly el: HTMLElement;
	readonly value: T;
	update(patch: { value?: T; disabled?: boolean }): void;
	dispose(): void;
}

export function createSegment<T extends string>(
	host: HTMLElement | null,
	options: SegmentOptions<T>
): SegmentHandle<T> {
	const el = instantiate(html);
	const indicator = part(el, ".sl-segment__indicator");
	if (options.ariaLabel) el.setAttribute("aria-label", options.ariaLabel);
	let value = options.value;
	let disabled = options.disabled ?? false;
	const buttons = new Map<T, HTMLButtonElement>();
	const tooltips: Array<() => void> = [];

	for (const item of options.items) {
		const button = instantiate<HTMLButtonElement>(itemHtml);
		button.dataset.value = item.id;
		part(button, ".sl-segment__label").textContent = item.label;
		if (item.icon) {
			const icon = part(button, ".sl-segment__icon");
			applyIcon(icon, item.icon);
			icon.hidden = false;
		}
		tooltips.push(attachTooltip(button, item.tooltip ?? item.label));
		el.append(button);
		buttons.set(item.id, button);
	}

	function render(): void {
		const ids = [...buttons.keys()];
		const index = Math.max(0, ids.indexOf(value));
		for (const [id, button] of buttons) {
			const active = id === value;
			button.setAttribute("aria-selected", active ? "true" : "false");
			button.setAttribute("tabindex", active && !disabled ? "0" : "-1");
			button.classList.toggle("is-active", active);
			if (disabled) button.setAttribute("aria-disabled", "true");
			else button.removeAttribute("aria-disabled");
		}
		indicator.style.setProperty("--sl-segment-index", String(index));
		indicator.style.setProperty("--sl-segment-count", String(ids.length));
		el.dataset.value = value;
		if (disabled) el.setAttribute("aria-disabled", "true");
		else el.removeAttribute("aria-disabled");
	}

	function select(next: T, emit: boolean): void {
		if (next === value) return;
		value = next;
		render();
		if (emit) options.onChange(next);
	}

	const onClick = (event: MouseEvent): void => {
		const button = (event.target as Element | null)?.closest<HTMLButtonElement>(".sl-segment__item");
		if (!button || !el.contains(button)) return;
		event.preventDefault();
		if (disabled) return;
		select(button.dataset.value as T, true);
	};
	const onKeyDown = (event: KeyboardEvent): void => {
		if (disabled) return;
		const ids = [...buttons.keys()];
		const i = ids.indexOf(value);
		let next: T | undefined;
		if (event.key === "ArrowRight" || event.key === "ArrowDown") next = ids[(i + 1) % ids.length];
		else if (event.key === "ArrowLeft" || event.key === "ArrowUp")
			next = ids[(i - 1 + ids.length) % ids.length];
		else if (event.key === "Home") next = ids[0];
		else if (event.key === "End") next = ids[ids.length - 1];
		if (next === undefined) return;
		event.preventDefault();
		select(next, true);
	};
	el.addEventListener("click", onClick);
	el.addEventListener("keydown", onKeyDown);
	render();
	host?.append(el);

	return {
		el,
		get value() {
			return value;
		},
		update(patch) {
			if (patch.disabled !== undefined) disabled = patch.disabled;
			if (patch.value !== undefined) value = patch.value;
			render();
		},
		dispose() {
			el.removeEventListener("click", onClick);
			el.removeEventListener("keydown", onKeyDown);
			for (const t of tooltips) t();
			el.remove();
		},
	};
}
