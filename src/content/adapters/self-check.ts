/**
 * Runtime self-checks and the selector probe (Appendix C §5). Pure
 * functions over readings the adapter supplies; the adapter assembles the
 * `ProbeReport` and log `adapter.selectorMiss` for required concerns.
 */

import type { ProbeMatch, Rect, SelfCheckResult } from "./adapter";
import { pointToSquare, squareToPoint } from "./geometry";
import { queryFirst } from "./query";

export interface LadderProbe {
	matched: ProbeMatch[];
	misses: string[];
}

/** Which candidate index matched per concern; concerns with no match are misses. */
export function probeLadders(
	ladders: Record<string, readonly string[]>,
	root: ParentNode
): LadderProbe {
	const matched: ProbeMatch[] = [];
	const misses: string[] = [];
	for (const [concern, candidates] of Object.entries(ladders)) {
		const hit = queryFirst(candidates, root);
		if (hit) {
			matched.push({ concern, index: hit.index, selector: candidates[hit.index] ?? "" });
		} else misses.push(concern);
	}
	return { matched, misses };
}

/** 2..32 pieces, exactly one king per colour (§5.1). */
export function checkBoardSanity(placement: string | null): SelfCheckResult {
	const name = "boardSanity";
	if (!placement) return { name, ok: false, detail: "no placement" };
	const pieces = placement.replace(/[/1-8]/g, "");
	const whiteKings = (pieces.match(/K/g) ?? []).length;
	const blackKings = (pieces.match(/k/g) ?? []).length;
	if (pieces.length < 2 || pieces.length > 32)
		return { name, ok: false, detail: `${pieces.length} pieces` };
	if (whiteKings !== 1 || blackKings !== 1)
		return { name, ok: false, detail: `kings ${whiteKings}/${blackKings}` };
	return { name, ok: true };
}

/** Replay placement equals the DOM placement (§5.2). */
export function checkPlacementConsistency(
	replayPlacement: string | null,
	domPlacement: string | null
): SelfCheckResult {
	const name = "placementConsistency";
	if (!domPlacement) return { name, ok: false, detail: "no DOM placement" };
	if (!replayPlacement) return { name, ok: false, detail: "no replay" };
	return replayPlacement === domPlacement
		? { name, ok: true }
		: { name, ok: false, detail: `replay ${replayPlacement} vs dom ${domPlacement}` };
}

/** Clock colour vs move-list parity vs bridge turn (§5.3): any disagreement is reported. */
export function checkTurnConsistency(
	sources: Array<{ name: string; turn: "w" | "b" | null }>
): SelfCheckResult {
	const name = "turnConsistency";
	const known = sources.filter((s) => s.turn !== null);
	if (known.length < 2) return { name, ok: true, detail: "single source" };
	const first = known[0]?.turn;
	const disagree = known.filter((s) => s.turn !== first);
	return disagree.length === 0
		? { name, ok: true }
		: { name, ok: false, detail: known.map((s) => `${s.name}=${s.turn}`).join(" ") };
}

/** Independent orientation readings agree (§5.4). */
export function checkOrientation(
	readings: Array<{ name: string; flipped: boolean | null }>
): SelfCheckResult {
	const name = "orientation";
	const known = readings.filter((r) => r.flipped !== null);
	if (known.length === 0) return { name, ok: false, detail: "no reading" };
	const first = known[0]?.flipped;
	return known.every((r) => r.flipped === first)
		? { name, ok: true }
		: { name, ok: false, detail: known.map((r) => `${r.name}=${r.flipped}`).join(" ") };
}

/**
 * `squareToPoint("a1")` hits an element inside the board and
 * `pointToSquare(squareToPoint(sq)) === sq` for a few squares (§5.5).
 */
export function checkGeometry(
	board: Element,
	rect: Rect | { x: number; y: number; width: number; height: number },
	flipped: boolean,
	doc: Document
): SelfCheckResult {
	const name = "geometry";
	if (!(rect.width > 0)) return { name, ok: false, detail: "empty rect" };
	for (const sq of ["a1", "h8", "e4", "d5"] as const) {
		if (pointToSquare(squareToPoint(sq, rect, flipped), rect, flipped) !== sq)
			return { name, ok: false, detail: `round-trip ${sq}` };
	}
	if (typeof doc.elementFromPoint === "function") {
		const p = squareToPoint("a1", rect, flipped);
		const hit = doc.elementFromPoint(p.x, p.y);
		if (!hit || (hit !== board && !board.contains(hit)))
			return { name, ok: false, detail: "a1 centre misses the board" };
	}
	return { name, ok: true };
}
