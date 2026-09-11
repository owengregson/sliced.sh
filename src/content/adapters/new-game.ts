/** Conservative discovery of restart controls; queue state is observed before any activation. */
import type { NewGameMode } from "./adapter";
import { queryAllSafe } from "./query";
import { SELECTORS as S } from "./selectors";

function labels(element: Element): string[] {
	return [element.getAttribute("aria-label"), element.getAttribute("title"), element.textContent]
		.filter((label): label is string => label !== null)
		.map((label) => label.replace(/\s+/g, " ").trim())
		.filter(Boolean);
}

/** Both the control and its ancestors must be rendered; hidden modal copies are common. */
function visible(element: Element, win: Window): boolean {
	if (!element.isConnected || element.closest(S.actionHidden)) return false;
	for (let node: Element | null = element; node; node = node.parentElement) {
		const style = win.getComputedStyle(node);
		if (
			style.display === "none" ||
			style.visibility === "hidden" ||
			style.visibility === "collapse" ||
			style.opacity === "0"
		)
			return false;
	}
	const rect = element.getBoundingClientRect();
	return (
		rect.width > 0 &&
		rect.height > 0 &&
		rect.right > 0 &&
		rect.bottom > 0 &&
		rect.left < win.innerWidth &&
		rect.top < win.innerHeight
	);
}

export function newGameSearchActive(doc: Document, win: Window): boolean {
	for (const selector of S.queueCancel) {
		if (queryAllSafe(doc, selector).some((element) => visible(element, win))) return true;
	}
	for (const selector of [...S.newGame, ...S.rematch, ...S.lobbyPlay, ...S.queueStatus]) {
		if (
			queryAllSafe(doc, selector).some(
				(element) => visible(element, win) && labels(element).some((label) => S.queueTextRe.test(label))
			)
		)
			return true;
	}
	return false;
}

export function newGameControl(
	doc: Document,
	win: Window,
	mode: NewGameMode,
	computer: boolean,
	lobby = false
): HTMLElement | null {
	const selectors = mode === "new" ? [...S.newGame, ...(lobby ? S.lobbyPlay : [])] : S.rematch;
	for (const selector of selectors) {
		for (const element of queryAllSafe(doc, selector)) {
			if (
				!visible(element, win) ||
				element.closest(S.actionDisabled) ||
				element.matches(S.actionNativeDisabled)
			)
				continue;
			if (win.getComputedStyle(element).pointerEvents === "none") continue;
			const text = labels(element);
			if (text.some((label) => S.queueTextRe.test(label))) continue;
			if (mode === "new" && text.some((label) => S.rematchTextRe.test(label))) continue;
			const positive =
				mode === "rematch"
					? text.some((label) => S.rematchTextRe.test(label))
					: element.matches(S.newGameIdentity) ||
						text.some(
							(label) =>
								S.newGameTextRe.test(label) ||
								(computer && S.playAgainTextRe.test(label)) ||
								(lobby &&
									S.lobbyPlay.some((candidate) => candidate === selector) &&
									S.lobbyPlayTextRe.test(label))
						);
			const control = element as HTMLElement;
			if (positive) return control;
		}
	}
	return null;
}
