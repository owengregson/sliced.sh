/** Native radio choices: keyboard navigation and focus stay with the browser. */
import { instantiate, part } from "../../template";
import choiceHtml from "../templates/settings/choice.html?raw";
import choicesHtml from "../templates/settings/choices.html?raw";

export interface ChoiceItem {
	id: string;
	label: string;
	description?: string;
}

let nextGroup = 0;

export function createChoices(
	host: HTMLElement,
	options: {
		label: string;
		items: readonly ChoiceItem[];
		value: string;
		onChange(value: string): void;
	}
) {
	const el = instantiate<HTMLFieldSetElement>(choicesHtml);
	part(el, "legend").textContent = options.label;
	const name = `settings-choice-${++nextGroup}`;
	const inputs = new Map<string, HTMLInputElement>();
	let value = options.value;
	let disabled = false;
	for (const item of options.items) {
		const label = instantiate<HTMLLabelElement>(choiceHtml);
		const input = part<HTMLInputElement>(label, "input");
		input.name = name;
		input.value = item.id;
		label.dataset.value = item.id;
		part(label, ".sl-choice__label").textContent = item.label;
		const detail = part(label, ".sl-choice__detail");
		detail.textContent = item.description ?? "";
		detail.hidden = !item.description;
		inputs.set(item.id, input);
		el.append(label);
	}
	function render(): void {
		el.disabled = disabled;
		for (const [id, input] of inputs) {
			input.checked = id === value;
			input.disabled = disabled;
		}
	}
	function change(event: Event): void {
		const input = event.target;
		if (disabled || !(input instanceof HTMLInputElement) || !input.checked) return;
		if (!inputs.has(input.value) || input.value === value) return;
		value = input.value;
		render();
		options.onChange(value);
	}
	// Enter also activates the focused choice; Space and arrows keep their native behavior.
	function keydown(event: KeyboardEvent): void {
		if (event.key !== "Enter" || disabled) return;
		const input = event.target;
		if (!(input instanceof HTMLInputElement)) return;
		event.preventDefault();
		input.click();
	}
	el.addEventListener("change", change);
	el.addEventListener("keydown", keydown);
	render();
	host.append(el);
	return {
		el,
		update(patch: { value?: string; disabled?: boolean }): void {
			if (patch.value !== undefined) value = patch.value;
			if (patch.disabled !== undefined) disabled = patch.disabled;
			render();
		},
		dispose(): void {
			el.removeEventListener("change", change);
			el.removeEventListener("keydown", keydown);
			el.remove();
		},
	};
}
