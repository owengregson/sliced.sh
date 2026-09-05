/**
 * The two row controls the component layer does not provide: a stepper (`[−] 3 [+]`) and a
 * native select. Both follow the component conventions (host append, `update`, `dispose`,
 * `aria-disabled` while disabled, no `focus()`).
 */

import { SETTINGS_COPY } from "../../copy";
import { playUiSound } from "../../sounds";
import { instantiate, part } from "../../template";
import selectHtml from "../templates/settings/select.html?raw";
import stepperHtml from "../templates/settings/stepper.html?raw";

export interface StepperOptions {
	min: number;
	max: number;
	value: number;
	ariaLabel: string;
	format?: (value: number) => string;
	/** Below `min` sits an "auto" position; `onChange` then receives `null`. */
	auto?: boolean;
	disabled?: boolean;
	onChange: (value: number | null) => void;
}

export interface StepperHandle {
	readonly el: HTMLElement;
	readonly value: number | null;
	update(patch: { value?: number | null; disabled?: boolean }): void;
	dispose(): void;
}

export function createStepper(host: HTMLElement | null, options: StepperOptions): StepperHandle {
	const el = instantiate(stepperHtml);
	const dec = part<HTMLButtonElement>(el, ".sl-stepper__button--dec");
	const inc = part<HTMLButtonElement>(el, ".sl-stepper__button--inc");
	const out = part(el, ".sl-stepper__value");
	const format = options.format ?? String;
	const floor = options.auto ? options.min - 1 : options.min;
	let value: number | null = options.value;
	let disabled = options.disabled ?? false;

	part(el, ".sl-stepper__legend").textContent = options.ariaLabel;
	dec.setAttribute("aria-label", SETTINGS_COPY.stepper.decreaseLabel);
	inc.setAttribute("aria-label", SETTINGS_COPY.stepper.increaseLabel);
	part(dec, ".sl-stepper__glyph").textContent = SETTINGS_COPY.stepper.decrease;
	part(inc, ".sl-stepper__glyph").textContent = SETTINGS_COPY.stepper.increase;

	const position = (): number => (value === null ? floor : value);

	function render(): void {
		out.textContent = value === null ? SETTINGS_COPY.format.threadsAuto : format(value);
		const atMin = position() <= floor;
		const atMax = position() >= options.max;
		setDisabled(dec, disabled || atMin);
		setDisabled(inc, disabled || atMax);
		if (disabled) el.setAttribute("aria-disabled", "true");
		else el.removeAttribute("aria-disabled");
	}

	function step(delta: number): void {
		if (disabled) return;
		const next = Math.min(options.max, Math.max(floor, position() + delta));
		if (next === position()) return;
		value = options.auto && next < options.min ? null : next;
		render();
		playUiSound("stepper");
		options.onChange(value);
	}

	const onDec = (event: MouseEvent): void => {
		event.preventDefault();
		step(-1);
	};
	const onInc = (event: MouseEvent): void => {
		event.preventDefault();
		step(1);
	};
	dec.addEventListener("click", onDec);
	inc.addEventListener("click", onInc);
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
			dec.removeEventListener("click", onDec);
			inc.removeEventListener("click", onInc);
			el.remove();
		},
	};
}

function setDisabled(button: HTMLButtonElement, disabled: boolean): void {
	if (disabled) button.setAttribute("aria-disabled", "true");
	else button.removeAttribute("aria-disabled");
}

export interface SelectOption {
	value: string;
	label: string;
}

export interface SelectOptions {
	options: readonly SelectOption[];
	value: string;
	ariaLabel: string;
	disabled?: boolean;
	onChange: (value: string) => void;
}

export interface SelectHandle {
	readonly el: HTMLElement;
	readonly select: HTMLSelectElement;
	readonly value: string;
	update(patch: { value?: string; options?: readonly SelectOption[]; disabled?: boolean }): void;
	dispose(): void;
}

export function createSelect(host: HTMLElement | null, options: SelectOptions): SelectHandle {
	const el = instantiate(selectHtml);
	const select = part<HTMLSelectElement>(el, ".sl-select__control");
	select.setAttribute("aria-label", options.ariaLabel);
	let value = options.value;
	let disabled = options.disabled ?? false;

	function setOptions(list: readonly SelectOption[]): void {
		select.replaceChildren();
		for (const o of list) {
			const option = document.createElement("option");
			option.value = o.value;
			option.textContent = o.label;
			select.append(option);
		}
	}

	function render(): void {
		select.value = value;
		select.disabled = disabled;
		if (disabled) el.setAttribute("aria-disabled", "true");
		else el.removeAttribute("aria-disabled");
	}

	const onChange = (): void => {
		if (disabled) return;
		value = select.value;
		options.onChange(value);
	};
	select.addEventListener("change", onChange);
	setOptions(options.options);
	render();
	host?.append(el);

	return {
		el,
		select,
		get value() {
			return value;
		},
		update(patch) {
			if (patch.options !== undefined) setOptions(patch.options);
			if (patch.disabled !== undefined) disabled = patch.disabled;
			if (patch.value !== undefined) value = patch.value;
			render();
		},
		dispose() {
			select.removeEventListener("change", onChange);
			el.remove();
		},
	};
}
