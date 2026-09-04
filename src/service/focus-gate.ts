/**
 * Focus discipline (§13.4). The executor may only touch the board when the
 * page has had focus continuously since the current position arrived, the
 * document is visible and the tab is the active one in its window. Sources:
 * the content script's `focus` port messages (window `focus`/`blur`,
 * `visibilitychange`), `chrome.windows.onFocusChanged` (browser lost focus)
 * and `chrome.tabs.onActivated`. A blur edge inside the move window marks the
 * move `blur-in-window` until the next `positionArrived`; the extension never
 * changes focus itself — it waits, and the panel shows why.
 */

import { onTabActivated, onTabRemoved } from "@core/chrome/tabs";
import { onWindowFocusChanged, windowIdNone } from "@core/chrome/windows";
import { EXECUTOR } from "@core/constants/cdp";
import type { GamePortMessage } from "@core/constants/messages";
import { defaultNow } from "@core/util/scheduler";
import type { ContentLinkEvents } from "@service/content-link";

export type FocusReason =
	| typeof EXECUTOR.reasons.unfocused
	| typeof EXECUTOR.reasons.hidden
	| typeof EXECUTOR.reasons.blurInWindow;

export type FocusVerdict = { ok: true } | { ok: false; reason: FocusReason };

export interface FocusSnapshot {
	pageHasFocus: boolean;
	blurSeenThisMove: boolean;
}

export type FocusEdgeListener = (tabId: number, hasFocus: boolean, at: number) => void;

interface TabFocus {
	/** `null` until the content script has reported once. */
	hasFocus: boolean | null;
	visible: boolean;
	active: boolean;
	browserFocused: boolean;
	blurSeen: boolean;
	positionAt: number | null;
}

const fresh = (): TabFocus => ({
	hasFocus: null,
	visible: true,
	active: true,
	browserFocused: true,
	blurSeen: false,
	positionAt: null,
});

export class FocusGate {
	private readonly states = new Map<number, TabFocus>();
	private readonly edgeListeners = new Set<FocusEdgeListener>();
	private readonly offs: Array<() => void>;
	private readonly now: () => number;

	constructor(
		private readonly link: ContentLinkEvents,
		options: { now?: () => number } = {}
	) {
		this.now = options.now ?? defaultNow;
		this.offs = [
			link.onMessage("*", (tabId, msg) => this.onPortMessage(tabId, msg)),
			link.onDisconnect((tabId) => void this.states.delete(tabId)),
			onWindowFocusChanged((windowId) => this.onWindowFocus(windowId)),
			onTabActivated((info) => this.onActivated(info.tabId, info.windowId)),
			onTabRemoved((tabId) => void this.states.delete(tabId)),
		];
	}

	/** A new position for `tabId` opens a fresh move window. */
	positionArrived(tabId: number, at: number): void {
		const s = this.state(tabId);
		s.positionAt = at;
		s.blurSeen = false;
	}

	canExecute(tabId: number): FocusVerdict {
		const s = this.states.get(tabId);
		if (s?.hasFocus !== true || !s.browserFocused)
			return { ok: false, reason: EXECUTOR.reasons.unfocused };
		if (!s.visible || !s.active) return { ok: false, reason: EXECUTOR.reasons.hidden };
		if (s.blurSeen) return { ok: false, reason: EXECUTOR.reasons.blurInWindow };
		return { ok: true };
	}

	snapshot(tabId: number): FocusSnapshot {
		const s = this.states.get(tabId);
		return { pageHasFocus: s?.hasFocus === true, blurSeenThisMove: s?.blurSeen ?? false };
	}

	/** Every focus/blur transition the page reports. */
	onEdge(listener: FocusEdgeListener): () => void {
		this.edgeListeners.add(listener);
		return () => void this.edgeListeners.delete(listener);
	}

	dispose(): void {
		for (const off of this.offs.splice(0)) off();
		this.edgeListeners.clear();
		this.states.clear();
	}

	private state(tabId: number): TabFocus {
		let s = this.states.get(tabId);
		if (!s) {
			s = fresh();
			this.states.set(tabId, s);
		}
		return s;
	}

	private onPortMessage(tabId: number, msg: GamePortMessage): void {
		if (msg.kind !== "focus") return;
		const s = this.state(tabId);
		const was = s.hasFocus;
		s.hasFocus = msg.hasFocus;
		s.visible = msg.visibility === "visible";
		if (!msg.hasFocus) s.blurSeen = true;
		if (was !== msg.hasFocus) {
			for (const l of [...this.edgeListeners]) l(tabId, msg.hasFocus, msg.at ?? this.now());
		}
	}

	private onWindowFocus(windowId: number): void {
		const none = windowIdNone();
		for (const [tabId, s] of this.states) {
			if (windowId === none) {
				s.browserFocused = false;
				s.blurSeen = true;
				continue;
			}
			const own = this.link.windowIdOf(tabId);
			s.browserFocused = own === null || own === windowId;
			if (!s.browserFocused) s.blurSeen = true;
		}
	}

	private onActivated(activeTabId: number, windowId: number): void {
		for (const [tabId, s] of this.states) {
			const own = this.link.windowIdOf(tabId);
			if (own !== null && own !== windowId) continue;
			s.active = tabId === activeTabId;
		}
		if (!this.states.has(activeTabId)) this.state(activeTabId).active = true;
	}
}
