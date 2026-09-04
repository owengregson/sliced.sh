/**
 * Text input (Appendix F §5.16): `control.lg` for the license key, `control.md` elsewhere.
 * Invalid state sets `aria-invalid` with a danger hint; a trailing icon button slot hosts the
 * reveal toggle. The input never receives focus programmatically (§10.4).
 */

import type { IconName } from "@design/icons";
import { applyIcon } from "../icons-mount";
import { instantiate, part } from "../template";
import html from "../views/templates/components/input.html?raw";

export interface InputOptions {
	label: string;
	value?: string;
	placeholder?: string;
	type?: "text" | "password";
	size?: "md" | "lg";
	hint?: string | null;
	mono?: boolean;
	autocomplete?: string;
	maxLength?: number;
	/** Trailing icon button (e.g. reveal); `onTrailing` receives the click. */
	trailing?: { icon: IconName; label: string; onClick: () => void } | null;
	disabled?: boolean;
	onInput?: (value: string) => void;
	onSubmit?: (value: string) => void;
}

export interface InputHandle {
	readonly el: HTMLElement;
	readonly input: HTMLInputElement;
	readonly value: string;
	update(patch: {
		value?: string;
		hint?: string | null;
		invalid?: string | null;
		disabled?: boolean;
		type?: "text" | "password";
		trailing?: { icon: IconName; label: string } | null;
	}): void;
	dispose(): void;
}

let inputSeq = 0;

export function createInput(host: HTMLElement | null, options: InputOptions): InputHandle {
	const el = instantiate(html);
	const label = part(el, ".sl-input__label");
	const input = part<HTMLInputElement>(el, ".sl-input__control");
	const trailing = part<HTMLButtonElement>(el, ".sl-input__trailing");
	const trailingIcon = part(trailing, ".sl-icon");
	const hint = part(el, ".sl-input__hint");
	const hintId = `sl-input-hint-${++inputSeq}`;
	hint.id = hintId;

	el.classList.add(`sl-input--${options.size ?? "md"}`);
	if (options.mono) input.classList.add("sl-type-mono");
	label.textContent = options.label;
	input.type = options.type ?? "text";
	input.value = options.value ?? "";
	if (options.placeholder) input.placeholder = options.placeholder;
	if (options.autocomplete) input.autocomplete = options.autocomplete as AutoFill;
	if (options.maxLength) input.maxLength = options.maxLength;
	input.disabled = options.disabled === true;

	function setHint(text: string | null, invalid: boolean): void {
		hint.textContent = text ?? "";
		hint.hidden = !text;
		hint.classList.toggle("sl-input__hint--danger", invalid);
		if (text) input.setAttribute("aria-describedby", hintId);
		else input.removeAttribute("aria-describedby");
	}

	function setTrailing(next: { icon: IconName; label: string } | null | undefined): void {
		if (!next) {
			trailing.hidden = true;
			return;
		}
		applyIcon(trailingIcon, next.icon);
		trailing.setAttribute("aria-label", next.label);
		trailing.hidden = false;
	}

	const onInput = (): void => {
		if (input.getAttribute("aria-invalid") === "true") {
			input.removeAttribute("aria-invalid");
			el.classList.remove("sl-input--invalid");
			setHint(options.hint ?? null, false);
		}
		options.onInput?.(input.value);
	};
	const onKeyDown = (event: KeyboardEvent): void => {
		if (event.key === "Enter") {
			event.preventDefault();
			options.onSubmit?.(input.value);
		}
	};
	const onTrailing = (event: MouseEvent): void => {
		event.preventDefault();
		options.trailing?.onClick();
	};
	input.addEventListener("input", onInput);
	input.addEventListener("keydown", onKeyDown);
	trailing.addEventListener("click", onTrailing);

	setHint(options.hint ?? null, false);
	setTrailing(options.trailing);
	host?.append(el);

	return {
		el,
		input,
		get value() {
			return input.value;
		},
		update(patch) {
			if (patch.value !== undefined) input.value = patch.value;
			if (patch.type !== undefined) input.type = patch.type;
			if (patch.disabled !== undefined) input.disabled = patch.disabled;
			if (patch.trailing !== undefined) setTrailing(patch.trailing);
			if (patch.invalid !== undefined) {
				const invalid = patch.invalid !== null;
				if (invalid) input.setAttribute("aria-invalid", "true");
				else input.removeAttribute("aria-invalid");
				el.classList.toggle("sl-input--invalid", invalid);
				setHint(invalid ? patch.invalid : (patch.hint ?? options.hint ?? null), invalid);
			} else if (patch.hint !== undefined) setHint(patch.hint, false);
		},
		dispose() {
			input.removeEventListener("input", onInput);
			input.removeEventListener("keydown", onKeyDown);
			trailing.removeEventListener("click", onTrailing);
			el.remove();
		},
	};
}
