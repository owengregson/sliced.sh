/**
 * Conservative discovery of the resign control and its confirmation (2026-09-12). Passive reads
 * only — the same discipline as `new-game.ts`: the content script reports a rect, the service
 * worker's `ResignInput` performs the native click. A control is accepted only when it is
 * rendered, enabled, and *positively* labelled for the step, so a generic
 * `.game-controls-component button` ladder entry cannot resolve to "Draw" or "Abort".
 *
 * The confirmation lives in a popup that appears only after the resign click (the owner,
 * 2026-09-12: "its in a popup that appears when you click the resign button"), and chess.com's
 * markup for it is not in the fixtures. So the confirmation is found two ways, in order: first as
 * a positively labelled control that was **not visible before the resign click** (`baseline` —
 * every clickable control visible when the resign control was read), a new control inside a
 * dialog-like container ranking first; then the selector ladder. Class names never decide alone.
 */
import type { ResignStep } from "@core/constants/messages";
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

function ariaOrTitle(element: Element): string[] {
	return [element.getAttribute("aria-label"), element.getAttribute("title")].filter(
		(label): label is string => label !== null
	);
}

function positiveFor(step: ResignStep, element: Element): boolean {
	const text = labels(element);
	if (step === "resign") {
		return (
			text.some((label) => S.resignTextRe.test(label)) ||
			ariaOrTitle(element).some((label) => S.resignLabelRe.test(label))
		);
	}
	return text.some((label) => S.resignConfirmTextRe.test(label));
}

/** Every clickable control currently visible and usable — the baseline a popup is measured against. */
export function visibleControls(doc: Document, win: Window): Set<Element> {
	return new Set(queryAllSafe(doc, S.resignAnyControl).filter((el) => usable(el, win)));
}

function inPopup(element: Element): boolean {
	return S.resignPopup.some((selector) => element.closest(selector) !== null);
}

/**
 * The first usable, positively labelled control for `step`, walking the ladder in order.
 * `exclude` is the control already identified for the *other* step: the confirmation's label
 * may legitimately read "Resign", so without it the resign control itself would be rediscovered
 * as its own confirmation and clicked twice. `baseline` (confirm step): the controls visible
 * before the resign click — a positively labelled control outside it is the popup's.
 */
export function resignControl(
	doc: Document,
	win: Window,
	step: ResignStep,
	exclude: Element | null = null,
	baseline: ReadonlySet<Element> | null = null
): HTMLElement | null {
	const excluded = (element: Element): boolean =>
		exclude !== null && (element === exclude || exclude.contains(element));
	if (step === "confirm" && baseline) {
		const fresh = queryAllSafe(doc, S.resignAnyControl).filter(
			(el) => !baseline.has(el) && !excluded(el) && usable(el, win) && positiveFor(step, el)
		);
		const popup = fresh.find(inPopup);
		const first = popup ?? fresh[0];
		if (first) return first as HTMLElement;
	}
	const selectors = step === "resign" ? S.resign : S.resignConfirm;
	for (const selector of selectors) {
		for (const element of queryAllSafe(doc, selector)) {
			if (excluded(element)) continue;
			if (!usable(element, win)) continue;
			if (positiveFor(step, element)) return element as HTMLElement;
		}
	}
	return null;
}
