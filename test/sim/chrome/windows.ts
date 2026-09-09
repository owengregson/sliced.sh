// test/sim/chrome/windows.ts
/**
 * `chrome.windows`: one focused window id plus `onFocusChanged` (`setFocus` drives it), and the
 * window each extension page belongs to — Chrome resolves `getCurrent()` against the *calling*
 * page, so it is keyed on the active context (`setCurrent`); unset contexts report window 1.
 */

import type { Bus } from "@test/sim/contexts/bus";

export const WINDOW_ID_NONE = -1;
export const WINDOW_ID_CURRENT = -2;

export function createWindowsSubsystem(bus: Bus) {
	const onFocusChanged = bus.event<[number]>();
	let focused = 1;
	const current = new Map<string, number>();

	const toApi = (id: number): chrome.windows.Window => ({
		id,
		focused: id === focused,
		alwaysOnTop: false,
		incognito: false,
		state: "normal",
		type: "normal",
		top: 0,
		left: 0,
		width: 1280,
		height: 800,
	});

	const api = {
		WINDOW_ID_NONE,
		WINDOW_ID_CURRENT,
		get(windowId: number, ...rest: unknown[]) {
			const callback = rest[rest.length - 1];
			return bus.settle(callback, toApi(windowId === WINDOW_ID_CURRENT ? 1 : windowId));
		},
		getCurrent(...rest: unknown[]) {
			return bus.settle(rest[rest.length - 1], toApi(current.get(bus.activeContextId()) ?? 1));
		},
		getLastFocused(...rest: unknown[]) {
			return bus.settle(rest[rest.length - 1], toApi(focused === WINDOW_ID_NONE ? 1 : focused));
		},
		onFocusChanged: {
			addListener: onFocusChanged.addListener,
			removeListener: onFocusChanged.removeListener,
			hasListener: onFocusChanged.hasListener,
		},
	};

	return {
		api,
		/** Put a context's page in `windowId`: what its own `windows.getCurrent()` reports. */
		setCurrent(contextId: string, windowId: number): void {
			current.set(contextId, windowId);
		},
		/** Focus a window (`WINDOW_ID_NONE` = the browser lost focus); fires `onFocusChanged`. */
		setFocus(windowId: number): void {
			focused = windowId;
			onFocusChanged.fire(windowId);
		},
		focused: (): number => focused,
	};
}

export type WindowsSubsystem = ReturnType<typeof createWindowsSubsystem>;
