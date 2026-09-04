/**
 * Status pill (Appendix F §5.8): icon + text, `role="status"`, variants `--idle | --thinking |
 * --ok | --warn | --danger | --locked`. Text changes crossfade over `duration.1-5`.
 */

import type { IconName } from "@design/icons";
import { ANIM } from "../animation-manager";
import { setOptionalIcon } from "../icons-mount";
import { instantiate, part } from "../template";
import html from "../views/templates/components/pill.html?raw";

export type PillVariant = "idle" | "thinking" | "ok" | "warn" | "danger" | "locked";

export interface PillState {
	variant?: PillVariant;
	icon?: IconName | null;
	text?: string;
	/** Screen-reader label when the text alone is ambiguous ("Engine: Thinking · d18"). */
	ariaLabel?: string | null;
}

export interface PillHandle {
	readonly el: HTMLElement;
	update(state: PillState): void;
	dispose(): void;
}

const VARIANTS: readonly PillVariant[] = ["idle", "thinking", "ok", "warn", "danger", "locked"];

export function createPill(host: HTMLElement | null, initial: PillState = {}): PillHandle {
	const el = instantiate(html);
	const icon = part(el, ".sl-pill__icon");
	const text = part(el, ".sl-pill__text");
	let variant: PillVariant = "idle";

	function update(state: PillState): void {
		if (state.variant !== undefined && state.variant !== variant) {
			variant = state.variant;
			for (const v of VARIANTS) el.classList.toggle(`sl-pill--${v}`, v === variant);
		}
		if (state.icon !== undefined)
			setOptionalIcon(icon, state.icon, {
				spin: variant === "thinking" && state.icon === "status.thinking",
			});
		if (state.text !== undefined && state.text !== text.textContent) {
			text.textContent = state.text;
			void ANIM.fade(text, "in");
		}
		if (state.ariaLabel !== undefined) {
			if (state.ariaLabel) el.setAttribute("aria-label", state.ariaLabel);
			else el.removeAttribute("aria-label");
		}
	}

	el.classList.add("sl-pill--idle");
	update({ variant: "idle", icon: null, text: "", ...initial });
	host?.append(el);
	return {
		el,
		update,
		dispose() {
			el.remove();
		},
	};
}
