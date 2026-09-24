/** The shared hand stack: the per-tab content ports and what watches them for the executor. */

import { BoardWatch } from "@service/board-watch";
import { ContentLink } from "@service/content-link";
import { DebuggerManager } from "@service/debugger-manager";
import { FocusGate } from "@service/focus-gate";
import { HandOwnership } from "@service/hand-ownership";
import type { Keepalive } from "@service/keepalive";

export interface HandStack {
	link: ContentLink;
	debuggerManager: DebuggerManager;
	focus: FocusGate;
	ownership: HandOwnership;
	board: BoardWatch;
}

export function createHandStack(keepalive: Keepalive): HandStack {
	const link = new ContentLink();
	const debuggerManager = new DebuggerManager({ keepalive });
	const focus = new FocusGate(link, {
		isFocusMaintained: (tabId) => debuggerManager.isFocusMaintained(tabId),
	});
	const ownership = new HandOwnership(link);
	// §9.5: the board's viewport rect per tab, as the content script reports it.
	const board = new BoardWatch(link);
	return { link, debuggerManager, focus, ownership, board };
}
