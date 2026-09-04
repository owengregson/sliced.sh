/**
 * Ordered-ladder queries over the selector registry (Appendix C §5).
 * An invalid selector in a ladder is skipped, never thrown.
 */

export interface LadderHit {
	element: Element;
	index: number;
}

export interface LadderAllHit {
	elements: Element[];
	index: number;
}

function safeQuery(root: ParentNode, selector: string): Element | null {
	try {
		return root.querySelector(selector);
	} catch {
		return null;
	}
}

function safeQueryAll(root: ParentNode, selector: string): Element[] {
	try {
		return Array.from(root.querySelectorAll(selector));
	} catch {
		return [];
	}
}

/** First candidate with a match, and which one it was. */
export function queryFirst(candidates: readonly string[], root: ParentNode): LadderHit | null {
	for (let index = 0; index < candidates.length; index++) {
		const selector = candidates[index];
		if (selector === undefined) continue;
		const element = safeQuery(root, selector);
		if (element) return { element, index };
	}
	return null;
}

export function queryFirstElement(candidates: readonly string[], root: ParentNode): Element | null {
	return queryFirst(candidates, root)?.element ?? null;
}

/** Every match of the first candidate that matches anything. */
export function queryAllFirst(
	candidates: readonly string[],
	root: ParentNode
): LadderAllHit | null {
	for (let index = 0; index < candidates.length; index++) {
		const selector = candidates[index];
		if (selector === undefined) continue;
		const elements = safeQueryAll(root, selector);
		if (elements.length > 0) return { elements, index };
	}
	return null;
}

export function querySafe(root: ParentNode, selector: string): Element | null {
	return safeQuery(root, selector);
}

export function queryAllSafe(root: ParentNode, selector: string): Element[] {
	return safeQueryAll(root, selector);
}
