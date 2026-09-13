/**
 * Conservative discovery of the post-game rematch controls (2026-09-13). Passive reads only —
 * the same discipline as `new-game.ts` and `resign.ts`: the content script reports a rect, the
 * service worker's `NewGameInput` performs the native click. A control is accepted only when it
 * is rendered, enabled and *positively* labelled for the action, so a generic ladder entry can
 * never resolve to "Decline" when "Accept" was asked for, or to a matchmaking "Cancel Search"
 * when the cancel of a pending offer was.
 *
 * The owner's captures cover the outgoing `aria-label="Rematch"` button and the incoming panel
 * (`.game-over-buttons-incoming-rematch` with "Accept Rematch" / "Decline Rematch"); the cancel of
 * a pending outgoing offer was not captured, so it is a labelled search inside the game-over
 * button containers and its absence is tolerated by the caller.
 */
import type { RematchAction } from "@core/constants/messages";
import { labels, visible } from "./new-game";
import { queryAllSafe } from "./query";
import { SELECTORS as S } from "./selectors";

function usable(element: Element, win: Window): boolean {
	return (
		visible(element, win) &&
		!element.closest(S.actionDisabled) &&
		!element.matches(S.actionNativeDisabled) &&
		win.getComputedStyle(element).pointerEvents !== "none"
	);
}

function insideIncoming(element: Element): boolean {
	return element.closest(S.rematchIncoming) !== null;
}

function positiveFor(action: RematchAction, element: Element): boolean {
	const text = labels(element);
	switch (action) {
		case "rematch":
			// Never a button of the incoming panel: "Accept Rematch" also contains the word.
			return !insideIncoming(element) && text.some((label) => S.rematchOfferTextRe.test(label));
		case "accept":
			return text.some((label) => S.rematchAcceptTextRe.test(label));
		case "decline":
			return text.some((label) => S.rematchDeclineTextRe.test(label));
		case "cancel":
			return (
				text.some((label) => S.rematchCancelLabelRe.test(label)) &&
				!text.some((label) => S.rematchCancelSearchRe.test(label))
			);
	}
}

function ladderFor(action: RematchAction): readonly string[] {
	switch (action) {
		case "rematch":
			return S.rematchOffer;
		case "accept":
			return S.rematchAccept;
		case "decline":
			return S.rematchDecline;
		case "cancel":
			return S.rematchCancelScope.map((scope) => `${scope} ${S.rematchCancelControl}`);
	}
}

/** The first usable, positively labelled control for `action`, walking its ladder in order. */
export function rematchControl(
	doc: Document,
	win: Window,
	action: RematchAction
): HTMLElement | null {
	for (const selector of ladderFor(action)) {
		for (const element of queryAllSafe(doc, selector)) {
			if (!usable(element, win)) continue;
			if (positiveFor(action, element)) return element as HTMLElement;
		}
	}
	return null;
}

/**
 * The opponent's offer is showing: a usable Accept inside the incoming panel (`usable` already
 * rejects a hidden or collapsed panel through the ancestor walk, so the panel's own box — which
 * a wrapper `div` may not have mid-render — is not asked for).
 */
export function incomingRematchShowing(doc: Document, win: Window): boolean {
	const accept = rematchControl(doc, win, "accept");
	return accept !== null && insideIncoming(accept);
}
