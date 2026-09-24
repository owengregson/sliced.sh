/** Keybind names and predicates, free of the DOM: how a binding prints and what counts as a combo. */

import type { Keybind } from "@typedefs/settings";
import { COPY } from "../../copy";

export const MODIFIER_KEYS: ReadonlySet<string> = new Set(["Shift", "Control", "Alt", "Meta"]);

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

export function modifierPrefix(
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

/** The binding a key event describes (printable keys lower-cased). */
export function fromEvent(event: KeyboardEvent): Keybind {
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

/** Whether a keydown is the given keybind (code or key, all four modifiers). */
export function matchesKeybind(event: KeyboardEvent, kb: Keybind): boolean {
	const keyMatch =
		(kb.code !== "" && event.code === kb.code) || event.key.toLowerCase() === kb.key.toLowerCase();
	return (
		keyMatch &&
		event.altKey === kb.altKey &&
		event.ctrlKey === kb.ctrlKey &&
		event.metaKey === kb.metaKey &&
		event.shiftKey === kb.shiftKey
	);
}
