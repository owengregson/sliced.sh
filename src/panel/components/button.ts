/**
 * Button (Appendix F §5.1): `.sl-button` with icon / label / kbd chip / armed ring. Variants
 * `--primary | --danger | --ghost` (+ `--danger-text`), sizes `--sm | --md | --lg`, `--block`.
 * Loading locks the width to the pre-loading width and swaps the label for spinner + verb.
 */

import type { IconName } from "@design/icons";
import { setOptionalIcon } from "../icons-mount";
import { instantiate, part } from "../template";
import html from "../views/templates/components/button.html?raw";
import { type CountdownRingHandle, createCountdownRing } from "./countdown-ring";

export type ButtonVariant = "primary" | "danger" | "ghost";
export type ButtonSize = "sm" | "md" | "lg";

export interface ButtonOptions {
	label: string;
	variant?: ButtonVariant;
	/** Ghost buttons that act destructively (Sign out, Clear log). */
	dangerText?: boolean;
	size?: ButtonSize;
	block?: boolean;
	icon?: IconName | null;
	/** Trailing keyboard hint chip ("Space"). */
	kbd?: string | null;
	disabled?: boolean;
	/** `aria-label` override (e.g. the armed play button's spoken countdown). */
	ariaLabel?: string | null;
	onClick?: (event: MouseEvent) => void;
}

export interface ButtonState {
	label?: string;
	/** Swap the visual variant (Reattach is primary only while detached, Appendix F §4.7). */
	variant?: ButtonVariant;
	icon?: IconName | null;
	kbd?: string | null;
	disabled?: boolean;
	ariaLabel?: string | null;
	/** Swap label for spinner + verb; width locked while loading. */
	loading?: string | null;
	/** Play button only: armed state with the countdown ring visible. */
	armed?: boolean;
}

export interface ButtonHandle {
	readonly el: HTMLButtonElement;
	/** Play-button countdown ring (created lazily on first use / first `armed: true`). */
	readonly ring: CountdownRingHandle;
	update(state: ButtonState): void;
	dispose(): void;
}

const VARIANT_CLASSES: Record<ButtonVariant, string> = {
	primary: "sl-button--primary",
	danger: "sl-button--danger",
	ghost: "sl-button--ghost",
};

export function createButton(host: HTMLElement | null, options: ButtonOptions): ButtonHandle {
	const el = instantiate<HTMLButtonElement>(html);
	const icon = part(el, ".sl-button__icon");
	const label = part(el, ".sl-button__label");
	const kbd = part(el, ".sl-button__kbd");
	const ringHost = part(el, ".sl-button__ring");
	let ring: CountdownRingHandle | null = null; // created on the first `armed: true`
	let loading = false;
	let lockedWidth: string | null = null;

	el.classList.add(VARIANT_CLASSES[options.variant ?? "ghost"]);
	if (options.dangerText) el.classList.add("sl-button--danger-text");
	el.classList.add(`sl-button--${options.size ?? "md"}`);
	if (options.block) el.classList.add("sl-button--block");

	const onClick = (event: MouseEvent): void => {
		if (el.getAttribute("aria-disabled") === "true" || loading) {
			event.preventDefault();
			return;
		}
		options.onClick?.(event);
	};
	el.addEventListener("click", onClick);

	function setDisabled(disabled: boolean): void {
		if (disabled) el.setAttribute("aria-disabled", "true");
		else el.removeAttribute("aria-disabled");
	}

	function update(state: ButtonState): void {
		if (state.variant !== undefined) {
			for (const cls of Object.values(VARIANT_CLASSES)) el.classList.remove(cls);
			el.classList.add(VARIANT_CLASSES[state.variant]);
		}
		if (state.label !== undefined && !loading) label.textContent = state.label;
		if (state.icon !== undefined) setOptionalIcon(icon, state.icon);
		if (state.kbd !== undefined) {
			kbd.textContent = state.kbd ?? "";
			kbd.hidden = !state.kbd;
		}
		if (state.disabled !== undefined) setDisabled(state.disabled);
		if (state.ariaLabel !== undefined) {
			if (state.ariaLabel) el.setAttribute("aria-label", state.ariaLabel);
			else el.removeAttribute("aria-label");
		}
		if (state.loading !== undefined) {
			const wasLoading = loading;
			const next = Boolean(state.loading);
			if (next && !loading) {
				lockedWidth = el.style.width;
				const width = el.getBoundingClientRect().width;
				if (width > 0) el.style.width = `${width}px`;
				el.dataset.idleLabel = label.textContent ?? "";
			}
			loading = next;
			el.classList.toggle("sl-button--loading", loading);
			el.setAttribute("aria-busy", loading ? "true" : "false");
			if (loading) label.textContent = state.loading ?? "";
			else if (wasLoading) {
				el.style.width = lockedWidth ?? "";
				lockedWidth = null;
				label.textContent = state.label ?? el.dataset.idleLabel ?? "";
				delete el.dataset.idleLabel;
			}
		}
		if (state.armed !== undefined) {
			el.classList.toggle("sl-button--armed", state.armed);
			if (state.armed && !ring) ring = createCountdownRing(ringHost, { size: "md" });
			ringHost.hidden = !state.armed;
		}
	}

	update({
		label: options.label,
		icon: options.icon ?? null,
		kbd: options.kbd ?? null,
		disabled: options.disabled ?? false,
		ariaLabel: options.ariaLabel ?? null,
	});
	host?.append(el);

	return {
		el,
		get ring() {
			if (!ring) ring = createCountdownRing(ringHost, { size: "md" });
			return ring;
		},
		update,
		dispose() {
			el.removeEventListener("click", onClick);
			ring?.dispose();
			el.remove();
		},
	};
}
