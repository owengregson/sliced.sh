/**
 * Toggle (Appendix F §5.2, §6.1): `role="switch"`, click / Space toggles. The `armed` variant
 * (auto-play only) arms with a 600 ms press-and-hold (pointer or Space/Enter) and disarms with
 * a single click — arming is the slow, cancellable direction; disarming is the fast one.
 */

import { UI_TIMINGS } from "@core/constants/ui";
import type { IconName } from "@design/icons";
import { COPY } from "../copy";
import { setOptionalIcon } from "../icons-mount";
import { playUiSound } from "../sounds";
import { instantiate, part } from "../template";
import html from "../views/templates/components/toggle.html?raw";

export type ToggleState = "off" | "on" | "arming" | "armed";

export interface ToggleOptions {
	label: string;
	checked: boolean;
	icon?: IconName | null;
	hint?: string | null;
	/** Auto-play variant: hold to arm, click to disarm. */
	armed?: boolean;
	/** Hold duration for the armed variant (default `UI_TIMINGS.armHoldMs`). */
	holdMs?: number;
	locked?: boolean;
	disabled?: boolean;
	/** `aria-describedby` target id for the hold hint (one is created when omitted). */
	describedBy?: string;
	onChange: (checked: boolean) => void;
	/** Release before the hold completed (once-per-session tooltip is the caller's). */
	onHoldCancelled?: () => void;
}

export interface ToggleUpdate {
	checked?: boolean;
	label?: string;
	hint?: string | null;
	locked?: boolean;
	disabled?: boolean;
}

export interface ToggleHandle {
	readonly el: HTMLButtonElement;
	readonly checked: boolean;
	readonly state: ToggleState;
	update(patch: ToggleUpdate): void;
	dispose(): void;
}

let hintSeq = 0;

export function createToggle(host: HTMLElement | null, options: ToggleOptions): ToggleHandle {
	const el = instantiate<HTMLButtonElement>(html);
	const icon = part(el, ".sl-toggle__icon");
	const labelEl = part(el, ".sl-toggle__label");
	const hintEl = part(el, ".sl-toggle__hint");
	const lock = part(el, ".sl-toggle__lock");
	const armedVariant = options.armed === true;
	const holdMs = options.holdMs ?? UI_TIMINGS.armHoldMs;

	let checked = options.checked;
	let locked = options.locked ?? false;
	let disabled = options.disabled ?? false;
	let baseLabel = options.label;
	let holdTimer: ReturnType<typeof setTimeout> | null = null;
	let holding: "pointer" | "key" | null = null;
	/** The click that ends an arming gesture (or a completed arm) must not toggle. */
	let swallowClick = false;
	let holdHint: HTMLElement | null = null;
	/** §6.1 step 4: after a disarm the label reads "Auto-play off" until the next update/arm. */
	let disarmed = false;

	if (armedVariant) {
		el.classList.add("sl-toggle--armable");
		if (options.describedBy) el.setAttribute("aria-describedby", options.describedBy);
		else {
			holdHint = document.createElement("span");
			holdHint.className = "sl-visually-hidden";
			holdHint.id = `sl-toggle-hint-${++hintSeq}`;
			holdHint.textContent = COPY.a11y.toggleHoldHint;
			el.setAttribute("aria-describedby", holdHint.id);
		}
	}

	const interactive = (): boolean => !disabled && !locked;

	function state(): ToggleState {
		if (holding) return "arming";
		if (checked) return armedVariant ? "armed" : "on";
		return "off";
	}

	function render(): void {
		const s = state();
		el.dataset.state = s;
		el.setAttribute("aria-checked", checked ? "true" : "false");
		el.classList.toggle("sl-toggle--on", checked && !armedVariant);
		el.classList.toggle("sl-toggle--armed", s === "armed");
		el.classList.toggle("sl-toggle--arming", s === "arming");
		el.classList.toggle("sl-toggle--locked", locked);
		if (disabled || locked) el.setAttribute("aria-disabled", "true");
		else el.removeAttribute("aria-disabled");
		lock.hidden = !locked;
		labelEl.textContent =
			s === "arming"
				? COPY.toggle.arming
				: s === "armed"
					? COPY.toggle.armed
					: armedVariant && disarmed
						? COPY.toggle.off
						: baseLabel;
	}

	function setChecked(next: boolean, emit: boolean): void {
		if (checked === next) return;
		checked = next;
		disarmed = armedVariant && emit && !next;
		render();
		if (emit) {
			if (armedVariant) playUiSound(next ? "arm" : "disarm");
			else playUiSound(next ? "toggleOn" : "toggleOff");
			options.onChange(next);
		}
	}

	function clearHold(): void {
		if (holdTimer !== null) {
			clearTimeout(holdTimer);
			holdTimer = null;
		}
	}

	function startHold(kind: "pointer" | "key"): void {
		if (holding || checked || !interactive()) return;
		holding = kind;
		el.style.setProperty("--sl-hold-ms", `${holdMs}ms`);
		render();
		holdTimer = setTimeout(() => {
			holdTimer = null;
			holding = null;
			swallowClick = true;
			setChecked(true, true);
		}, holdMs);
	}

	function cancelHold(): void {
		if (!holding) return;
		clearHold();
		holding = null;
		swallowClick = true;
		render();
		options.onHoldCancelled?.();
	}

	const onClick = (event: MouseEvent): void => {
		event.preventDefault();
		if (swallowClick) {
			swallowClick = false;
			return;
		}
		if (!interactive()) return;
		if (armedVariant) {
			if (checked) setChecked(false, true); // instant disarm
			return; // arming only through the hold
		}
		setChecked(!checked, true);
	};

	const onPointerDown = (event: PointerEvent): void => {
		// A new physical gesture can always disarm, even after an interrupted earlier hold.
		if (!holding) swallowClick = false;
		if (!armedVariant || event.isPrimary === false || checked) return;
		startHold("pointer");
	};
	const onPointerEnd = (): void => {
		if (holding === "pointer") cancelHold();
	};

	const onKeyDown = (event: KeyboardEvent): void => {
		if (event.key !== " " && event.key !== "Enter") return;
		event.preventDefault();
		if (!interactive()) return;
		if (!armedVariant) {
			if (event.repeat) return;
			setChecked(!checked, true);
			return;
		}
		if (checked) {
			if (!event.repeat) setChecked(false, true);
			return;
		}
		if (!event.repeat) startHold("key");
	};
	const onKeyUp = (event: KeyboardEvent): void => {
		if (event.key !== " " && event.key !== "Enter") return;
		if (holding === "key") cancelHold();
		swallowClick = false; // keyboard gestures never produce a synthetic click here
	};

	el.addEventListener("click", onClick);
	el.addEventListener("pointerdown", onPointerDown);
	el.addEventListener("pointerup", onPointerEnd);
	el.addEventListener("pointercancel", onPointerEnd);
	el.addEventListener("pointerleave", onPointerEnd);
	el.addEventListener("keydown", onKeyDown);
	el.addEventListener("keyup", onKeyUp);

	setOptionalIcon(icon, options.icon);
	if (options.hint) {
		hintEl.textContent = options.hint;
		hintEl.hidden = false;
	}
	render();
	if (host) {
		host.append(el);
		if (holdHint) host.append(holdHint);
	}

	return {
		el,
		get checked() {
			return checked;
		},
		get state() {
			return state();
		},
		update(patch) {
			if (patch.label !== undefined) baseLabel = patch.label;
			if (patch.hint !== undefined) {
				hintEl.textContent = patch.hint ?? "";
				hintEl.hidden = !patch.hint;
			}
			if (patch.locked !== undefined) locked = patch.locked;
			if (patch.disabled !== undefined) disabled = patch.disabled;
			if (!interactive()) cancelHold();
			if (patch.checked !== undefined && patch.checked !== checked) {
				if (holding) cancelHold();
				checked = patch.checked;
				disarmed = false;
			}
			render();
		},
		dispose() {
			clearHold();
			el.removeEventListener("click", onClick);
			el.removeEventListener("pointerdown", onPointerDown);
			el.removeEventListener("pointerup", onPointerEnd);
			el.removeEventListener("pointercancel", onPointerEnd);
			el.removeEventListener("pointerleave", onPointerEnd);
			el.removeEventListener("keydown", onKeyDown);
			el.removeEventListener("keyup", onKeyUp);
			holdHint?.remove();
			el.remove();
		},
	};
}
