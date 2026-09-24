/**
 * The open panel ports. A side-panel port's `sender` carries no tab or window, so each panel names
 * its own window in a `hello` (`PanelPortCommand`) on every (re)connect; connections are grouped
 * by that window so each window's panel gets the snapshot of its own game tab.
 */

import type { PanelPortCommand, PanelPortMessage } from "@core/constants/messages";
import type { AcceptedPort } from "@core/messaging/ports";
import { activeTabId } from "@service/panel-broadcaster/snapshot";

export type PanelPort = AcceptedPort<PanelPortMessage, PanelPortCommand>;

export interface Connection {
	port: PanelPort;
	/** The window the panel named in its `hello`; `null` until then (the last-focused window). */
	windowId: number | null;
	/** Listener releases (disconnect, `hello`) — released when the connection is dropped. */
	readonly offs: Array<() => void>;
	/** The newest build posted here; a slower older build resolving after it is dropped. */
	lastSeq: number;
}

export class PanelConnections {
	private readonly conns = new Set<Connection>();

	get size(): number {
		return this.conns.size;
	}

	has(conn: Connection): boolean {
		return this.conns.has(conn);
	}

	all(): Connection[] {
		return [...this.conns];
	}

	add(port: PanelPort): Connection {
		const conn: Connection = { port, windowId: null, offs: [], lastSeq: 0 };
		this.conns.add(conn);
		return conn;
	}

	/** Forget a connection and release its listeners. */
	drop(conn: Connection): void {
		if (!this.conns.delete(conn)) return;
		for (const off of conn.offs.splice(0)) off();
	}

	/** The connections whose window shows `tabId` (one `tabs.query` per distinct window). */
	async showing(tabId: number): Promise<Connection[]> {
		const active = new Map<number | null, number | null>();
		const shown: Connection[] = [];
		for (const conn of [...this.conns]) {
			let resolved = active.get(conn.windowId);
			if (resolved === undefined) {
				resolved = await activeTabId(conn.windowId);
				active.set(conn.windowId, resolved);
			}
			if (resolved === tabId) shown.push(conn);
		}
		return shown;
	}
}

/** `conns` grouped by the window they show, in first-seen order. */
export function byWindow(conns: readonly Connection[]): Map<number | null, Connection[]> {
	const groups = new Map<number | null, Connection[]>();
	for (const conn of conns) {
		const group = groups.get(conn.windowId);
		if (group) group.push(conn);
		else groups.set(conn.windowId, [conn]);
	}
	return groups;
}
