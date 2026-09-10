/**
 * Move-list parser (Appendix C §1.3). chess.com move nodes may carry
 * `data-figurine` spans instead of letters, so the SAN is assembled from the
 * node's children rather than read off `textContent`.
 */

import type { GameResult } from "@typedefs/game";
import { queryAllFirst, queryFirst } from "./query";
import { SELECTORS } from "./selectors";

const FIGURINES: Record<string, string> = {
	"♔": "K",
	"♕": "Q",
	"♖": "R",
	"♗": "B",
	"♘": "N",
	"♚": "K",
	"♛": "Q",
	"♜": "R",
	"♝": "B",
	"♞": "N",
};

/** Unicode figurines → letters, annotations (`?!`), draw marks and whitespace stripped. */
export function normalizeSan(text: string): string {
	let out = "";
	for (const ch of text) out += FIGURINES[ch] ?? ch;
	return out
		.replace(/[?!½]/g, "")
		.replace(/\s+/g, "")
		.replace(/^0-0-0/, "O-O-O")
		.replace(/^0-0/, "O-O");
}

export function parseResultText(text: string | null | undefined): GameResult | null {
	const t = (text ?? "").replace(/\s+/g, "");
	if (t === "1-0" || t === "0-1") return t;
	if (t === "1/2-1/2" || t === "½-½") return "1/2-1/2";
	return null;
}

/** SAN of one chess.com node: figurine spans contribute their letter, text nodes their text. */
export function sanFromMoveNode(node: Element): string {
	const content = queryFirst(SELECTORS.moveText, node)?.element ?? node;
	let text = "";
	for (const child of Array.from(content.childNodes)) {
		if (child.nodeType === 1) {
			const el = child as Element;
			const fig = el.getAttribute(SELECTORS.figurineAttr);
			text += fig ?? el.textContent ?? "";
		} else text += child.textContent ?? "";
	}
	return normalizeSan(text);
}

export interface MoveList {
	sans: string[];
	/** Index of the selected node, `-1` when none is selected (live end). */
	selectedIndex: number;
	result: GameResult | null;
}

export function readMoveList(root: ParentNode): MoveList {
	const list = queryFirst(SELECTORS.moveList, root)?.element;
	if (!list) return { sans: [], selectedIndex: -1, result: null };
	const nodes = queryAllFirst(SELECTORS.moveNode, list)?.elements ?? [];
	const sans: string[] = [];
	let selectedIndex = -1;
	nodes.forEach((node, i) => {
		const san = sanFromMoveNode(node);
		if (!san) return;
		sans.push(san);
		const selected = SELECTORS.moveSelected.some((s) => {
			try {
				return node.querySelector(s) !== null || node.matches(s);
			} catch {
				return false;
			}
		});
		if (selected) selectedIndex = i;
	});
	const result = parseResultText(queryFirst(SELECTORS.result, root)?.element.textContent);
	return { sans, selectedIndex, result };
}
