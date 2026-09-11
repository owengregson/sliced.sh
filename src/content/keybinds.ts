/**
 * In-page keybinds (Task 21). A capture-phase `keydown` listener on
 * `window`, so the site cannot swallow the shortcut by stopping propagation
 * in the bubble phase; editable targets (inputs, textareas, selects,
 * contenteditable) are ignored; repeats of the same action within
 * `TIMINGS.keybindDebounceMs` (and key auto-repeat) are dropped.
 *
 * `Keybinds.global` scope is the service worker's `chrome.commands`
 * (manifest shortcuts); while it is on, this page-scoped listener stays
 * inert except for bare Space, which Chrome's global command API cannot bind.
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
}

const EDITABLE_TAGS = new Set(["INPUT", "TEXTAREA", "SELECT"]);

export function isEditableTarget(target: EventTarget | null | undefined): boolean {
	if (!target || typeof target !== "object") return false;
	const el = target as Partial<HTMLElement> & { closest?: (s: string) => Element | null };
	if (typeof el.tagName !== "string") return false;
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

	const onKeyDown = (ev: KeyboardEvent): void => {
		const binds = getKeybinds();
		if (isEditableTarget(ev.target) || ev.composedPath().some(isEditableTarget)) return;
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
			ev.preventDefault();
			ev.stopImmediatePropagation();
			if (ev.repeat) return;
			const t = now();
			const last = lastFired.get(action);
			if (last !== undefined && t - last < debounceMs) return;
			lastFired.set(action, t);
			onAction(action);
			return;
		}
	};
	win.addEventListener("keydown", onKeyDown, true);
	return () => win.removeEventListener("keydown", onKeyDown, true);
}
