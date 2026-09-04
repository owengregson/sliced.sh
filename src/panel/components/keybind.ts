/**
 * Keybind capture (Appendix F §5.4, §6.4). Click the chip to capture: modifiers alone show the
 * combo live, the first non-modifier key completes on key up. Esc cancels (keeps the old key),
 * Backspace/Delete clears, a conflict with another sliced keybind shows the hint and Enter
 * swaps, and global scope refuses combos without Ctrl or Alt. Saved keys pulse and tick.
 */

import { TOKENS } from "@design/tokens.generated";
import type { Keybind } from "@typedefs/settings";
import { COPY } from "../copy";
import { registerEscape } from "../keys";
import { playUiSound } from "../sounds";
import { instantiate, part } from "../template";
import html from "../views/templates/components/keybind.html?raw";

/** §6.4 step 4: the chip pulses `brand-tint` over `duration.4`. */
const SAVED_PULSE_MS = TOKENS.motion.durationMs[4];

const MODIFIER_KEYS: ReadonlySet<string> = new Set(["Shift", "Control", "Alt", "Meta"]);

const KEY_NAMES: Readonly<Record<string, string>> = {
	" ": COPY.keybind.keys.space,
	Enter: COPY.keybind.keys.enter,
	Escape: COPY.keybind.keys.escape,
	Backspace: COPY.keybind.keys.backspace,
	ArrowUp: COPY.keybind.keys.up,
	ArrowDown: COPY.keybind.keys.down,
	ArrowLeft: COPY.keybind.keys.left,
	ArrowRight: COPY.keybind.keys.right,
	Tab: COPY.keybind.keys.tab,
	Delete: COPY.keybind.keys.delete,
};

function modifierPrefix(
	kb: Pick<Keybind, "ctrlKey" | "altKey" | "shiftKey" | "metaKey">
): string[] {
	const parts: string[] = [];
	if (kb.ctrlKey) parts.push(COPY.keybind.keys.ctrl);
	if (kb.altKey) parts.push(COPY.keybind.keys.alt);
	if (kb.shiftKey) parts.push(COPY.keybind.keys.shift);
	if (kb.metaKey) parts.push(COPY.keybind.keys.meta);
	return parts;
}

/** "Space", "A", "Ctrl+Shift+P" — the key name as printed on a keyboard (§7.1). */
export function formatKeybind(kb: Keybind | null | undefined): string {
	if (!kb) return COPY.keybind.notSet;
	const named = KEY_NAMES[kb.key];
	const base = named ?? (kb.key.length === 1 ? kb.key.toUpperCase() : kb.key);
	return [...modifierPrefix(kb), base].join("+");
}

function fromEvent(event: KeyboardEvent): Keybind {
	return {
		key: event.key.length === 1 ? event.key.toLowerCase() : event.key,
		code: event.code,
		altKey: event.altKey,
		ctrlKey: event.ctrlKey,
		metaKey: event.metaKey,
		shiftKey: event.shiftKey,
	};
}

/** Global (`chrome.commands`) shortcuts need Ctrl or Alt (§6.4 step 3). */
export function isGlobalCombo(kb: Keybind): boolean {
	return kb.ctrlKey || kb.altKey;
}

export type KeybindState = "set" | "empty" | "capturing" | "conflict";

export interface KeybindOptions {
	label: string;
	value: Keybind | null;
	global: boolean;
	/** Name of the action already using `kb`, or null when free. */
	conflicts?: (kb: Keybind) => string | null;
	disabled?: boolean;
	onChange: (kb: Keybind | null) => void;
	/** Enter on a conflict: the caller swaps the two bindings, then this row shows `kb`. */
	onSwap?: (kb: Keybind, otherAction: string) => void;
}

export interface KeybindUpdate {
	value?: Keybind | null;
	global?: boolean;
	disabled?: boolean;
}

export interface KeybindHandle {
	readonly el: HTMLElement;
	readonly capturing: boolean;
	readonly value: Keybind | null;
	update(patch: KeybindUpdate): void;
	/** Re-validate the current key against the scope (global needs a modifier). */
	validate(): boolean;
	cancel(): void;
	dispose(): void;
}

export function createKeybindCapture(
	host: HTMLElement | null,
	options: KeybindOptions
): KeybindHandle {
	const el = instantiate(html);
	const labelEl = part(el, ".sl-keybind__label");
	const chip = part<HTMLButtonElement>(el, ".sl-keybind__key");
	const clear = part<HTMLButtonElement>(el, ".sl-keybind__clear");
	const hint = part(el, ".sl-keybind__hint");

	let value = options.value;
	let global = options.global;
	let disabled = options.disabled ?? false;
	let capturing = false;
	let conflictWith: { kb: Keybind; other: string } | null = null;
	let pending: Keybind | null = null;
	let unregisterEscape: (() => void) | null = null;
	let pulseTimer: ReturnType<typeof setTimeout> | null = null;

	labelEl.textContent = options.label;

	function setHint(text: string | null): void {
		hint.textContent = text ?? "";
		hint.hidden = !text;
	}

	function state(): KeybindState {
		if (conflictWith) return "conflict";
		if (capturing) return "capturing";
		return value ? "set" : "empty";
	}

	function render(): void {
		const s = state();
		el.dataset.state = s;
		clear.hidden = !value || capturing || disabled;
		chip.textContent =
			s === "conflict" && conflictWith
				? formatKeybind(conflictWith.kb)
				: s === "capturing"
					? pending
						? [...modifierPrefix(pending), COPY.keybind.keys.more].join("+")
						: COPY.keybind.capturing
					: formatKeybind(value);
		if (disabled) el.setAttribute("aria-disabled", "true");
		else el.removeAttribute("aria-disabled");
		if (capturing) el.setAttribute("aria-live", "polite");
		else el.removeAttribute("aria-live");
	}

	function validate(): boolean {
		const invalid = global && value !== null && !isGlobalCombo(value);
		if (invalid) {
			el.dataset.invalid = "true";
			setHint(COPY.keybind.global);
		} else {
			delete el.dataset.invalid;
			if (!capturing) setHint(null);
		}
		return !invalid;
	}

	function stopCapture(): void {
		if (!capturing) return;
		capturing = false;
		conflictWith = null;
		pending = null;
		document.removeEventListener("keydown", onKeyDown, true);
		document.removeEventListener("keyup", onKeyUp, true);
		unregisterEscape?.();
		unregisterEscape = null;
		setHint(null);
		render();
		validate();
	}

	function commit(kb: Keybind | null): void {
		value = kb;
		stopCapture();
		render();
		validate();
		if (kb) {
			el.classList.add("sl-keybind--saved");
			if (pulseTimer !== null) clearTimeout(pulseTimer);
			pulseTimer = setTimeout(() => {
				el.classList.remove("sl-keybind--saved");
				pulseTimer = null;
			}, SAVED_PULSE_MS);
			playUiSound("keybindSaved");
		}
		options.onChange(kb);
	}

	function startCapture(): void {
		if (capturing || disabled) return;
		capturing = true;
		conflictWith = null;
		pending = null;
		document.addEventListener("keydown", onKeyDown, true);
		document.addEventListener("keyup", onKeyUp, true);
		unregisterEscape = registerEscape("capture", cancel);
		setHint(null);
		render();
	}

	function cancel(): void {
		if (!capturing) return;
		stopCapture();
	}

	function tryCommit(kb: Keybind): void {
		if (global && !isGlobalCombo(kb)) {
			conflictWith = null;
			pending = null;
			setHint(COPY.keybind.global);
			render();
			return; // stays capturing
		}
		const other = options.conflicts?.(kb) ?? null;
		if (other) {
			conflictWith = { kb, other };
			pending = null;
			setHint(COPY.keybind.conflict(other));
			render();
			return;
		}
		commit(kb);
	}

	function onKeyDown(event: KeyboardEvent): void {
		if (!capturing) return;
		if (event.key === "Escape") return; // handled by the Escape registry (priority order)
		event.preventDefault();
		event.stopPropagation();
		if (event.key === "Backspace" || event.key === "Delete") {
			commit(null);
			return;
		}
		if (event.key === "Enter" && conflictWith) {
			const { kb, other } = conflictWith;
			conflictWith = null;
			options.onSwap?.(kb, other);
			commit(kb);
			return;
		}
		if (MODIFIER_KEYS.has(event.key)) {
			pending = fromEvent(event);
			conflictWith = null;
			render();
			return;
		}
		pending = fromEvent(event);
		conflictWith = null;
		chip.textContent = formatKeybind(pending);
	}

	function onKeyUp(event: KeyboardEvent): void {
		if (!capturing || !pending) return;
		if (MODIFIER_KEYS.has(event.key)) {
			// Modifier released without a key: back to plain capturing.
			if (MODIFIER_KEYS.has(pending.key)) {
				pending = null;
				render();
			}
			return;
		}
		event.preventDefault();
		event.stopPropagation();
		const kb = pending;
		pending = null;
		if (MODIFIER_KEYS.has(kb.key)) return;
		tryCommit(kb);
	}

	const onChipClick = (event: MouseEvent): void => {
		event.preventDefault();
		if (capturing) return;
		startCapture();
	};
	const onClearClick = (event: MouseEvent): void => {
		event.preventDefault();
		if (disabled) return;
		commit(null);
	};
	chip.addEventListener("click", onChipClick);
	clear.addEventListener("click", onClearClick);

	render();
	validate();
	host?.append(el);

	return {
		el,
		get capturing() {
			return capturing;
		},
		get value() {
			return value;
		},
		update(patch) {
			if (patch.value !== undefined) value = patch.value;
			if (patch.global !== undefined) global = patch.global;
			if (patch.disabled !== undefined) {
				disabled = patch.disabled;
				if (disabled) stopCapture();
			}
			render();
			validate();
		},
		validate,
		cancel,
		dispose() {
			stopCapture();
			if (pulseTimer !== null) clearTimeout(pulseTimer);
			chip.removeEventListener("click", onChipClick);
			clear.removeEventListener("click", onClearClick);
			el.remove();
		},
	};
}
