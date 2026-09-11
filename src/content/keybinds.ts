/**
 * In-page keybinds (Task 21). A capture-phase `keydown` listener on
 * `window`, so the site cannot swallow the shortcut by stopping propagation
 * in the bubble phase; editable targets (inputs, textareas, selects,
 * contenteditable) are ignored unless page input is exclusively owned; repeats of the same action within
 * `TIMINGS.keybindDebounceMs` (and key auto-repeat) are dropped.
 *
 * `Keybinds.global` scope is the service worker's `chrome.commands`
 * (manifest shortcuts); while it is on, this page-scoped listener stays
 * inert except for bare Space, which Chrome's global command API cannot bind.
 * Exclusive ownership consumes all other page keys and the remaining phases of shortcuts.
 */

import { TIMINGS } from "@core/constants/timings";
import type { Keybind, Keybinds } from "@typedefs/settings";

export type KeybindAction = Exclude<keyof Keybinds, "global">;

export const KEYBIND_ACTIONS: readonly KeybindAction[] = [
	"playMove",
	"toggleAutoMove",
	"disable",
	"speakMove",
];

export interface KeybindOptions {
	window?: Window;
	debounceMs?: number;
	now?: () => number;
	/** A sidebar key recorder owns keyboard input while it is capturing a new binding. */
	enabled?: () => boolean;
	/** The virtual hand owns page input; only matched bot shortcuts may act. */
	exclusive?: () => boolean;
}

const EDITABLE_TAGS = new Set(["INPUT", "TEXTAREA", "SELECT"]);
const NON_TEXT_INPUTS = new Set([
	"button",
	"submit",
	"reset",
	"checkbox",
	"radio",
	"range",
	"color",
	"file",
	"image",
	"hidden",
]);

export function isEditableTarget(target: EventTarget | null | undefined): boolean {
	if (!target || typeof target !== "object") return false;
	const el = target as Partial<HTMLInputElement> & { closest?: (s: string) => Element | null };
	if (typeof el.tagName !== "string") return false;
	if (el.tagName === "INPUT" && NON_TEXT_INPUTS.has(el.type ?? "text")) return false;
	if (EDITABLE_TAGS.has(el.tagName)) return true;
	if (el.isContentEditable === true) return true;
	const editable = typeof el.closest === "function" ? el.closest("[contenteditable]") : null;
	return editable !== null && editable.getAttribute("contenteditable") !== "false";
}

export function keybindMatches(ev: KeyboardEvent, bind: Keybind): boolean {
	const keyOk =
		(bind.code !== "" && ev.code === bind.code) ||
		(typeof ev.key === "string" && ev.key.toLowerCase() === bind.key.toLowerCase());
	return (
		keyOk &&
		ev.altKey === bind.altKey &&
		ev.ctrlKey === bind.ctrlKey &&
		ev.metaKey === bind.metaKey &&
		ev.shiftKey === bind.shiftKey
	);
}

/** Install the listener; returns the remover. */
export function installKeybinds(
	getKeybinds: () => Keybinds,
	onAction: (action: KeybindAction) => void,
	options: KeybindOptions = {}
): () => void {
	const win = options.window ?? window;
	const debounceMs = options.debounceMs ?? TIMINGS.keybindDebounceMs;
	const now = options.now ?? (() => Date.now());
	const lastFired = new Map<KeybindAction, number>();
	const suppressed = new Set<string>();
	const keyIds = (ev: KeyboardEvent): string[] => [
		...(ev.code ? [`code:${ev.code}`] : []),
		...(ev.key ? [`key:${ev.key.toLowerCase()}`] : []),
	];
	const consume = (ev: KeyboardEvent): void => {
		ev.preventDefault();
		ev.stopImmediatePropagation();
	};

	const onKeyDown = (ev: KeyboardEvent): void => {
		// A release may have happened in another tab/window. A fresh press replaces that
		// stale record, while key auto-repeat still belongs to the suppressed press.
		if (!ev.repeat) for (const id of keyIds(ev)) suppressed.delete(id);
		const exclusive = options.exclusive?.() === true;
		if (exclusive || keyIds(ev).some((id) => suppressed.has(id))) {
			consume(ev);
			for (const id of keyIds(ev)) suppressed.add(id);
		}
		if (ev.isComposing || options.enabled?.() === false) return;
		const binds = getKeybinds();
		if (!exclusive && (isEditableTarget(ev.target) || ev.composedPath().some(isEditableTarget)))
			return;
		for (const action of KEYBIND_ACTIONS) {
			if (!keybindMatches(ev, binds[action])) continue;
			const pageSpace =
				action === "playMove" &&
				ev.code === "Space" &&
				!ev.altKey &&
				!ev.ctrlKey &&
				!ev.metaKey &&
				!ev.shiftKey;
			if (binds.global && !pageSpace) continue;
			consume(ev);
			for (const id of keyIds(ev)) suppressed.add(id);
			if (ev.repeat) return;
			const t = now();
			const last = lastFired.get(action);
			if (last !== undefined && t - last < debounceMs) return;
			lastFired.set(action, t);
			onAction(action);
			return;
		}
	};
	const onKeyTail = (ev: KeyboardEvent): void => {
		if (options.enabled?.() === false && options.exclusive?.() !== true) {
			// A sidebar recorder takes over the full press, including its release.
			suppressed.clear();
			return;
		}
		const ids = keyIds(ev);
		// A stop/disarm shortcut can release ownership before its keyup. Finish consuming
		// that press so the page cannot react to an orphan release or keyboard activation.
		if (options.exclusive?.() === true || ids.some((id) => suppressed.has(id))) consume(ev);
		if (ev.type === "keyup") for (const id of ids) suppressed.delete(id);
	};
	win.addEventListener("keydown", onKeyDown, true);
	win.addEventListener("keypress", onKeyTail, true);
	win.addEventListener("keyup", onKeyTail, true);
	return () => {
		win.removeEventListener("keydown", onKeyDown, true);
		win.removeEventListener("keypress", onKeyTail, true);
		win.removeEventListener("keyup", onKeyTail, true);
		suppressed.clear();
	};
}
