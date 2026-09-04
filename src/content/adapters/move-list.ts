/**
 * Move-list parsers (Appendix C §1.3, §2.3). chess.com nodes may carry
 * `data-figurine`; lichess round tags are obfuscated and rotate, so the
 * structural detector `findLichessRoundMoves` is the primary reader.
 */

import type { GameResult } from "@typedefs/game";
import { queryAllFirst, queryFirst, querySafe } from "./query";
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
export function sanFromChesscomNode(node: Element): string {
	const C = SELECTORS.chesscom;
	const content = queryFirst(C.moveText, node)?.element ?? node;
	let text = "";
	for (const child of Array.from(content.childNodes)) {
		if (child.nodeType === 1) {
			const el = child as Element;
			const fig = el.getAttribute(C.figurineAttr);
			text += fig ?? el.textContent ?? "";
		} else text += child.textContent ?? "";
	}
	return normalizeSan(text);
}

export interface ChesscomMoveList {
	sans: string[];
	/** Index of the selected node, `-1` when none is selected (live end). */
	selectedIndex: number;
	result: GameResult | null;
}

export function readChesscomMoveList(root: ParentNode): ChesscomMoveList {
	const C = SELECTORS.chesscom;
	const list = queryFirst(C.moveList, root)?.element;
	if (!list) return { sans: [], selectedIndex: -1, result: null };
	const nodes = queryAllFirst(C.moveNode, list)?.elements ?? [];
	const sans: string[] = [];
	let selectedIndex = -1;
	nodes.forEach((node, i) => {
		const san = sanFromChesscomNode(node);
		if (!san) return;
		sans.push(san);
		const selected = C.moveSelected.some((s) => {
			try {
				return node.querySelector(s) !== null || node.matches(s);
			} catch {
				return false;
			}
		});
		if (selected) selectedIndex = i;
	});
	const result = parseResultText(queryFirst(C.result, root)?.element.textContent);
	return { sans, selectedIndex, result };
}

export interface LichessRoundMoves {
	container: Element;
	moves: Element[];
	moveTag: string;
	indexTag: string;
	index: (m: Element) => number;
	/** Move number of the first index element (≠ 1 when the game starts from a position). */
	firstIndex: number;
}

const PLACEHOLDER = "…";

/**
 * Structural detector: the moves container is the element whose children
 * alternate `<indexTag>N</indexTag>, <moveTag>san</moveTag>, <moveTag>san</moveTag>`.
 * Never hardcodes tag names (they rotate: 2019-05, 2023-01, 2026-07).
 */
export function findLichessRoundMoves(root: ParentNode): LichessRoundMoves | null {
	const L = SELECTORS.lichess;
	const app = querySafe(root, L.roundApp);
	if (!app) return null;
	const isSan = (el: Element): boolean =>
		L.sanTextRe.test((el.textContent ?? "").trim().replace(L.sanNoiseRe, ""));
	for (const el of Array.from(app.querySelectorAll("*"))) {
		if (el.children.length < 2 || L.nonMoveContainerTagRe.test(el.tagName)) continue;
		const kids = Array.from(el.children);
		const first = kids[0];
		if (!first || !/^\d+$/.test((first.textContent ?? "").trim())) continue;
		const next = kids.slice(1, 3);
		if (!next.every((k) => k.tagName !== first.tagName && isSan(k))) continue;
		const indexTag = first.tagName;
		const moveTag = next[0]?.tagName ?? "";
		const moves = kids.filter(
			(k) =>
				k.tagName !== indexTag && k.tagName !== "DIV" && (k.textContent ?? "").trim() !== PLACEHOLDER
		);
		return {
			container: el,
			moves,
			moveTag,
			indexTag,
			index: (m) => moves.indexOf(m),
			firstIndex: Number((first.textContent ?? "").trim()),
		};
	}
	return null;
}

export interface LichessMoveList {
	sans: string[];
	/** Index into `sans` of the active move, `-1` when none is marked. */
	activeIndex: number;
	/** Plies before the first listed move (0 for a game from the start). */
	firstPly: number;
	result: GameResult | null;
}

export function readLichessMoveList(root: ParentNode): LichessMoveList {
	const L = SELECTORS.lichess;
	const found = findLichessRoundMoves(root);
	const result = parseResultText(queryFirst(L.result, root)?.element.textContent);
	if (!found) return { sans: [], activeIndex: -1, firstPly: 0, result };
	const sans: string[] = [];
	let activeIndex = -1;
	found.moves.forEach((m, i) => {
		const san = normalizeSan(m.textContent ?? "");
		if (!san) return;
		sans.push(san);
		if (m.classList.length > 0 && !m.classList.contains(L.plainTextClass)) activeIndex = i;
	});
	// first listed slot may be a black move ("…" placeholder): count it as one skipped ply
	const kids = Array.from(found.container.children);
	const secondIsPlaceholder = (kids[1]?.textContent ?? "").trim() === PLACEHOLDER;
	const firstPly = Math.max(0, (found.firstIndex - 1) * 2 + (secondIsPlaceholder ? 1 : 0));
	return { sans, activeIndex, firstPly, result };
}
