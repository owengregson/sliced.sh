/**
 * What the chess.com adapter watches: the board, the move list and the clocks directly, and the
 * body for the SPA's structural changes (board replacement, the game-over modal, the result row,
 * the promotion window, the post-game toolbar), filtered to those subtrees. The watched elements
 * are remembered so a reading can tell when any of them was replaced (or first appeared — the
 * live page has no move list until the first move is played) and re-install.
 */

import { SELECTORS as S } from "../selectors";
import { boardOf, clockElementsOf, moveListOf } from "./board";

/** Body-observer interest: board replacement, game-over modal, result row, promotion window. */
const RELEVANT = [
	...S.board,
	// the live page has no `wc-simple-move-list` until the first move is played
	...S.moveList,
	...S.gameOver,
	...S.result,
	...S.newGame,
	...S.queueCancel,
	...S.queueStatus,
	...S.promotionWindow,
	S.computerClock,
	S.postGameToolbar,
].join(",");

export interface WatchedElements {
	board: Element | null;
	moveList: Element | null;
	clocks: Element[];
}

export function watchedElementsOf(doc: Document, computer: boolean): WatchedElements {
	return {
		board: boardOf(doc),
		moveList: moveListOf(doc),
		clocks: clockElementsOf(doc, computer),
	};
}

/** Whether `now` names any element other than `watched` does. */
export function watchedReplaced(watched: WatchedElements, now: WatchedElements): boolean {
	return (
		now.board !== watched.board ||
		now.moveList !== watched.moveList ||
		now.clocks.length !== watched.clocks.length ||
		now.clocks.some((clock, index) => clock !== watched.clocks[index])
	);
}

export interface ObserverInstaller {
	readonly doc: Document;
	readonly win: Window;
	observe(
		target: Node | null,
		init: MutationObserverInit,
		filter?: (records: MutationRecord[]) => boolean
	): void;
	addObserverDisposer(fn: () => void): void;
	touches(records: MutationRecord[], selector: string): boolean;
	schedule(): void;
}

/** Install the watchers for `watched` (in this order: board, move list, clocks, body, popstate). */
export function installChesscomObservers(on: ObserverInstaller, watched: WatchedElements): void {
	on.observe(watched.board, {
		childList: true,
		subtree: true,
		attributes: true,
		attributeFilter: ["class", "style"],
	});
	on.observe(watched.moveList, {
		childList: true,
		subtree: true,
		characterData: true,
		attributes: true,
		attributeFilter: ["class"],
	});
	for (const clock of watched.clocks)
		on.observe(clock, {
			attributes: true,
			attributeFilter: ["class"],
			childList: true,
			subtree: true,
			characterData: true,
		});
	// SPA: board replacement, game-over modal, result row (filtered to those subtrees)
	on.observe(
		on.doc.body,
		{
			childList: true,
			subtree: true,
			attributes: true,
			attributeFilter: ["class", "style", "hidden", "aria-hidden", "aria-label", "href"],
		},
		(records) =>
			on.touches(records, RELEVANT) ||
			records.some((record) => {
				const target = record.target.nodeType === 1 ? (record.target as Element) : null;
				return (
					target !== null &&
					(target.closest(RELEVANT) !== null ||
						(record.type === "attributes" && target.querySelector(RELEVANT) !== null))
				);
			})
	);
	const onPop = (): void => on.schedule();
	on.win.addEventListener("popstate", onPop);
	on.addObserverDisposer(() => on.win.removeEventListener("popstate", onPop));
}
