/**
 * Hand ownership (§13.5, V2.1). Arming auto-play transfers the pointer to the
 * virtual hand: from then until the user stops it, the hand's own position is
 * authoritative for every path start and real pointer input is **only
 * counted** (for the Engine view's "real pointer events during hand control")
 * — it never pauses, aborts, re-anchors or re-plans. While not armed, the
 * content script's `cursor` reports give the plausible start for the next
 * arming (age < `EXECUTOR.realCursorMaxAgeMs`), after the rest point of a
 * previous hand session.
 */

import { EXECUTOR } from "@core/constants/cdp";
import type { GamePortMessage } from "@core/constants/messages";
import type { Pt } from "@core/motor/types";
import { defaultNow } from "@core/util/scheduler";
import type { ContentLinkEvents } from "@service/content-link";

interface TabHand {
	armed: boolean;
	/** The virtual cursor (authoritative while armed; the rest point afterwards). */
	position: Pt | null;
	realCount: number;
	lastRealAt: number | null;
	/** Last real position reported while the hand was NOT armed. */
	lastReal: { x: number; y: number; t: number } | null;
}

const fresh = (): TabHand => ({
	armed: false,
	position: null,
	realCount: 0,
	lastRealAt: null,
	lastReal: null,
});

export class HandOwnership {
	private readonly tabs = new Map<number, TabHand>();
	private readonly now: () => number;
	private off: () => void;

	constructor(link?: ContentLinkEvents, options: { now?: () => number } = {}) {
		this.now = options.now ?? defaultNow;
		this.off = link ? link.onMessage("*", (tabId, msg) => this.onPortMessage(tabId, msg)) : () => {};
	}

	/**
	 * Transfer the pointer to the hand starting at `startPoint` (omitted: keep the
	 * previous rest point, or let the first execution pick a plausible start);
	 * resets the real-input counter.
	 */
	armed(tabId: number, startPoint?: Pt): void {
		const s = this.state(tabId);
		s.armed = true;
		if (startPoint) s.position = { x: Math.round(startPoint.x), y: Math.round(startPoint.y) };
		s.realCount = 0;
		s.lastRealAt = null;
	}

	/** The user stopped the hand; the last position survives as the next rest point. */
	released(tabId: number): void {
		const s = this.tabs.get(tabId);
		if (s) s.armed = false;
	}

	isArmed(tabId: number): boolean {
		return this.tabs.get(tabId)?.armed ?? false;
	}

	position(tabId: number): Pt | null {
		const p = this.tabs.get(tabId)?.position;
		return p ? { ...p } : null;
	}

	/** The controller records where the hand ended after every dispatch. */
	setPosition(tabId: number, p: Pt): void {
		this.state(tabId).position = { x: Math.round(p.x), y: Math.round(p.y) };
	}

	/** Counts only (§13.5) — real input never changes the hand. */
	realPointerSeen(tabId: number, at: number): void {
		const s = this.state(tabId);
		if (!s.armed) return;
		s.realCount += 1;
		s.lastRealAt = at;
	}

	realPointerCount(tabId: number): number {
		return this.tabs.get(tabId)?.realCount ?? 0;
	}

	lastRealSeenAt(tabId: number): number | null {
		return this.tabs.get(tabId)?.lastRealAt ?? null;
	}

	/** The last real pointer position reported while unarmed, if younger than the max age. */
	lastRealPosition(tabId: number): Pt | null {
		const r = this.tabs.get(tabId)?.lastReal;
		if (!r || this.now() - r.t > EXECUTOR.realCursorMaxAgeMs) return null;
		return { x: r.x, y: r.y };
	}

	/** Where the next hand session starts: the previous rest point, a fresh real position, else `fallback()`. */
	startPoint(tabId: number, fallback: () => Pt): Pt {
		return this.position(tabId) ?? this.lastRealPosition(tabId) ?? fallback();
	}

	dispose(): void {
		this.off();
		this.off = () => {};
		this.tabs.clear();
	}

	private state(tabId: number): TabHand {
		let s = this.tabs.get(tabId);
		if (!s) {
			s = fresh();
			this.tabs.set(tabId, s);
		}
		return s;
	}

	private onPortMessage(tabId: number, msg: GamePortMessage): void {
		if (msg.kind !== "cursor") return;
		const s = this.state(tabId);
		if (s.armed) {
			s.realCount += 1;
			s.lastRealAt = msg.t;
			return;
		}
		s.lastReal = { x: msg.x, y: msg.y, t: msg.t };
	}
}
