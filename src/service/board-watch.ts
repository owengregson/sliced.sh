/**
 * Board geometry watch (§9.5). The content script reports the 8×8 board's
 * viewport rect whenever it moves or resizes (`boardRect`, a passive
 * `ResizeObserver` + the window's own `resize` / `scroll`); this keeps the
 * latest one per tab so the service worker can answer two questions
 * synchronously, without a port round trip:
 *
 *   - *has the board moved since the hand planned with it?* — a drag whose
 *     coordinate space shifted mid-flight must not carry on into stale
 *     coordinates (`HandController`);
 *   - *has the page stopped moving?* — arming attaches the debugger, Chrome
 *     shows its infobar and the page reflows, so the first execution after an
 *     attach waits for the rect to be still (`MoveExecutor`).
 *
 * Read-only bookkeeping: nothing here talks to the page.
 */

import { EXECUTOR } from "@core/constants/cdp";
import type { GamePortMessage } from "@core/constants/messages";
import { rectShiftPx } from "@core/motor/geometry";
import type { Rect } from "@core/motor/types";
import { defaultNow } from "@core/util/scheduler";
import type { ContentLinkEvents } from "@service/content-link";

/** What the hand and the executor need of a board watch (the seam tests fake). */
export interface BoardRectSource {
	/** The board's rect as the page last reported it; `null` when it never has. */
	rect(tabId: number): Rect | null;
	/**
	 * When the reported rect last *changed* beyond `EXECUTOR.boardMoveTolerancePx`
	 * (the first report counts as a change); `null` while nothing has been reported.
	 */
	changedAt(tabId: number): number | null;
}

interface TabBoard {
	rect: Rect;
	changedAt: number;
}

export class BoardWatch implements BoardRectSource {
	private readonly tabs = new Map<number, TabBoard>();
	private readonly now: () => number;
	private readonly offs: Array<() => void> = [];

	constructor(link?: ContentLinkEvents, options: { now?: () => number } = {}) {
		this.now = options.now ?? defaultNow;
		if (!link) return;
		this.offs.push(link.onMessage("*", (tabId, msg) => this.onPortMessage(tabId, msg)));
		// A tab whose port went away will report a fresh rect when it comes back; the old one is
		// stale geometry that must not make the next execution wait or abort.
		this.offs.push(link.onDisconnect((tabId) => this.forget(tabId)));
	}

	rect(tabId: number): Rect | null {
		const entry = this.tabs.get(tabId);
		return entry ? { ...entry.rect } : null;
	}

	changedAt(tabId: number): number | null {
		return this.tabs.get(tabId)?.changedAt ?? null;
	}

	/** The tab's port went away: its geometry is no longer evidence of anything. */
	forget(tabId: number): void {
		this.tabs.delete(tabId);
	}

	dispose(): void {
		for (const off of this.offs.splice(0)) off();
		this.tabs.clear();
	}

	private onPortMessage(tabId: number, msg: GamePortMessage): void {
		if (msg.kind !== "boardRect") return;
		const previous = this.tabs.get(tabId);
		// A report that repeats the rect is not a change: the stability window must not be rearmed
		// by a `scroll` that moved nothing, or an execution after an attach would never start.
		if (previous && rectShiftPx(previous.rect, msg.rect) <= EXECUTOR.boardMoveTolerancePx) {
			previous.rect = { ...msg.rect };
			return;
		}
		this.tabs.set(tabId, { rect: { ...msg.rect }, changedAt: msg.at ?? this.now() });
	}
}

/**
 * How far the board has moved from `planned` according to `source`, or `null`
 * when it has not moved beyond the tolerance (or nothing was ever reported, so
 * there is no evidence either way and the planned rect stands).
 */
export function boardShift(
	source: BoardRectSource | null,
	tabId: number,
	planned: Rect
): Rect | null {
	const live = source?.rect(tabId) ?? null;
	if (!live) return null;
	return rectShiftPx(planned, live) > EXECUTOR.boardMoveTolerancePx ? live : null;
}
