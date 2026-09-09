// test/sim/telemetry/ac-shadow.test.ts — the fake `fps` plugin on hand-built event sequences:
// a happy-dom board, trusted (and one untrusted) pointer events dispatched at squares, window
// blur/focus edges, and a site model that applies the moves the selection model submits.
import { beforeEach, describe, expect, it } from "bun:test";
import type { Occupancy } from "@core/motor/types";
import { createTabDom, type TabDom } from "@test/sim/dom/tab-dom";
import { type AcShadow, createAcShadow, type SiteModel } from "@test/sim/telemetry/ac-shadow";
import type { Square } from "@typedefs/game";
import { BOARD, squareRect } from "../../core/motor/fixtures";

const ALL: Square[] = [];
for (const f of "abcdefgh") for (let r = 1; r <= 8; r++) ALL.push(`${f}${r}` as Square);

let dom: TabDom;
let shadow: AcShadow;
let now: number;
let submitted: Array<[Square, Square]>;
const occ = new Map<Square, Occupancy>();
const legal = new Map<Square, Square[]>();

function centre(sq: Square): { x: number; y: number } {
	const r = squareRect(sq);
	return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
}

function pointer(
	type: "pointermove" | "pointerdown" | "pointerup",
	x: number,
	y: number,
	trusted = true
) {
	const target = dom.elementAt(x, y) ?? (dom.document.body as unknown as Element);
	const ev = new dom.window.PointerEvent(type, {
		bubbles: true,
		cancelable: true,
		clientX: x,
		clientY: y,
		button: 0,
		buttons: type === "pointerdown" ? 1 : 0,
		pointerType: "mouse",
	});
	Object.defineProperty(ev, "isTrusted", { value: trusted, configurable: true });
	(target as unknown as { dispatchEvent(e: Event): boolean }).dispatchEvent(ev as unknown as Event);
}

function moveTo(sq: Square, steps = 4): number {
	// straight line from the current pointer position in `steps` pointermove events
	const from = shadow.pointerPosition() ?? { x: 0, y: 0 };
	const to = centre(sq);
	let length = 0;
	let prev = from;
	for (let i = 1; i <= steps; i++) {
		const p = {
			x: from.x + ((to.x - from.x) * i) / steps,
			y: from.y + ((to.y - from.y) * i) / steps,
		};
		length += Math.hypot(p.x - prev.x, p.y - prev.y);
		prev = p;
		now += 10;
		pointer("pointermove", p.x, p.y);
	}
	return length;
}

function click(sq: Square, trusted = true): void {
	const c = centre(sq);
	now += 30;
	pointer("pointerdown", c.x, c.y, trusted);
	now += 60;
	pointer("pointerup", c.x, c.y, trusted);
}

function drag(from: Square, to: Square): number {
	const a = centre(from);
	now += 30;
	pointer("pointerdown", a.x, a.y);
	const length = moveTo(to, 6);
	now += 40;
	const b = centre(to);
	pointer("pointerup", b.x, b.y);
	return length;
}

function blur(): void {
	dom.window.dispatchEvent(new dom.window.Event("blur"));
}
function focus(): void {
	dom.window.dispatchEvent(new dom.window.Event("focus"));
}

beforeEach(() => {
	dom = createTabDom("https://www.chess.com/play/computer");
	dom.setHTML(`<div id="board">${ALL.map((sq) => `<div id="${sq}"></div>`).join("")}</div>`);
	const asLayout = (r: { left: number; top: number; width: number; height: number }) => ({
		x: r.left,
		y: r.top,
		width: r.width,
		height: r.height,
	});
	dom.layout("#board", asLayout(BOARD));
	for (const sq of ALL) dom.layout(`#${sq}`, asLayout(squareRect(sq)));
	occ.clear();
	legal.clear();
	for (const sq of ALL) {
		const rank = Number(sq[1]);
		occ.set(sq, rank <= 2 ? "own" : rank >= 7 ? "enemy" : "empty");
	}
	legal.set("e2", ["e3", "e4"]);
	legal.set("d2", ["d3", "d4"]);
	legal.set("g1", ["f3", "h3"]);
	submitted = [];
	now = 1_000;
	const model: SiteModel = {
		squareOf: (target) => {
			const id = (target as { id?: string } | null)?.id ?? "";
			return ALL.includes(id as Square) ? (id as Square) : null;
		},
		occupancy: (sq) => occ.get(sq) ?? "empty",
		legalDestinations: (sq) => legal.get(sq) ?? [],
		submit: (from, to) => {
			submitted.push([from, to]);
			occ.set(to, "own");
			occ.set(from, "empty");
			return true;
		},
	};
	shadow = createAcShadow(dom, model, { now: () => now });
	// the hand rests off the board before the first position
	pointer("pointermove", 900, 400);
});

describe("ac shadow: one clean move", () => {
	it("a trusted click-click move yields the human-shaped blob with no focus fields set", () => {
		const arrived = now;
		shadow.positionArrived(now);
		let length = moveTo("e2");
		click("e2");
		length += moveTo("e4");
		click("e4");
		expect(submitted).toEqual([["e2", "e4"]]);
		expect(shadow.observations).toHaveLength(1);
		const { ac, lichessBlur, diag } = shadow.observations[0]!;
		expect(ac).toEqual({
			BlurCount: 0,
			DidBlurOnOpponentTurn: false,
			DidBlurOnOwnTurn: false,
			DidFocusOnOpponentTurn: false,
			DidFocusOnOwnTurn: false,
			DidSelectMultiplePieces: false,
			DidToggle: false,
			EventTrusted: true,
			MoveHoldTime: diag.submittedAt - arrived,
			PointerOffset: ac.PointerOffset,
			TotalBlurTime: 0,
			TotalFocusTime: diag.submittedAt - diag.periodStart,
		});
		expect("LastFocusToMoveTime" in ac).toBe(false);
		expect("MoveToFirstBlurTime" in ac).toBe(false);
		expect(ac.PointerOffset).toBeCloseTo(length, 6);
		expect(ac.MoveHoldTime).toBeGreaterThan(0);
		expect(lichessBlur).toBe(0);
		expect(diag.selections).toEqual(["e2"]);
		expect(diag.presses.map((p) => p.action)).toEqual(["select", "move"]);
		expect(diag.presses.every((p) => p.trusted && p.driftPx === 0)).toBe(true);
		expect(diag.pendingSelectionAtCommit).toBeNull();
		expect(diag.pressesBeforeCommit).toBe(1);
		expect(diag.pointerMaxStepPx).toBeGreaterThan(0);
		expect(diag.pointerFirstStepPx).toBeNull();
	});

	it("a trusted drag move submits on release; the drag's own pointermoves count toward PointerOffset", () => {
		shadow.positionArrived(now);
		const approach = moveTo("e2");
		const held = drag("e2", "e4");
		expect(submitted).toEqual([["e2", "e4"]]);
		const { ac, diag } = shadow.observations[0]!;
		expect(ac.PointerOffset).toBeCloseTo(approach + held, 6);
		expect(ac.EventTrusted).toBe(true);
		expect(diag.presses).toHaveLength(1);
		expect(diag.presses[0]).toMatchObject({ square: "e2", releaseSquare: "e4", action: "move" });
		expect(diag.pressesBeforeCommit).toBe(0);
		expect(diag.movesBeforeCommit).toBe(5); // the rest-point move that opened the period + the approach
	});

	it("an untrusted press in the committing gesture clears EventTrusted", () => {
		shadow.positionArrived(now);
		moveTo("e2");
		click("e2");
		moveTo("e4");
		click("e4", false);
		expect(submitted).toEqual([["e2", "e4"]]);
		expect(shadow.observations[0]!.ac.EventTrusted).toBe(false);
	});
});

describe("ac shadow: selections", () => {
	it("a preview (select, deselect on an empty square) before the move sets DidSelectMultiplePieces", () => {
		shadow.positionArrived(now);
		moveTo("g1");
		click("g1");
		expect(shadow.pendingSelection()).toBe("g1");
		moveTo("c4");
		click("c4"); // empty, not a knight destination: deselects
		expect(shadow.pendingSelection()).toBeNull();
		moveTo("e2");
		drag("e2", "e4");
		const { ac, diag } = shadow.observations[0]!;
		expect(ac.DidSelectMultiplePieces).toBe(true);
		expect(diag.selections).toEqual(["g1", "e2"]);
		expect(diag.presses.map((p) => p.action)).toEqual(["select", "deselect", "move"]);
		expect(diag.pendingSelectionAtCommit).toBeNull();
		expect(diag.pressesBeforeCommit).toBe(2);
	});

	it("a preview resolved by switching straight to the committed piece is a resolved selection", () => {
		shadow.positionArrived(now);
		moveTo("g1");
		click("g1");
		moveTo("d2");
		drag("d2", "d4");
		expect(submitted).toEqual([["d2", "d4"]]);
		const { ac, diag } = shadow.observations[0]!;
		expect(ac.DidSelectMultiplePieces).toBe(true);
		expect(diag.presses.map((p) => p.action)).toEqual(["select", "move"]);
		expect(diag.pendingSelectionAtCommit).toBe("g1");
	});

	it("a pending selection whose legal destination the next press lands on plays THAT move (the site's rule)", () => {
		shadow.positionArrived(now);
		moveTo("g1");
		click("g1");
		moveTo("f3");
		click("f3"); // f3 is a knight destination: this press submits g1f3
		expect(submitted).toEqual([["g1", "f3"]]);
		expect(shadow.observations[0]!.diag.presses.map((p) => p.action)).toEqual(["select", "move"]);
	});

	it("a drop on an illegal square unselects and submits nothing; the same piece is one selection", () => {
		shadow.positionArrived(now);
		moveTo("e2");
		drag("e2", "e5"); // not legal
		expect(submitted).toEqual([]);
		expect(shadow.pendingSelection()).toBeNull();
		moveTo("e2");
		drag("e2", "e4");
		const { ac, diag } = shadow.observations[0]!;
		expect(ac.DidSelectMultiplePieces).toBe(false);
		expect(diag.selections).toEqual(["e2"]);
		expect(diag.presses.map((p) => p.action)).toEqual(["select", "move"]);
		expect(diag.presses[0]).toMatchObject({ releaseSquare: "e5", action: "select" });
	});

	it("re-pressing the selected piece is not a second selection", () => {
		shadow.positionArrived(now);
		moveTo("e2");
		click("e2");
		click("e2");
		moveTo("e4");
		click("e4");
		const { ac, diag } = shadow.observations[0]!;
		expect(ac.DidSelectMultiplePieces).toBe(false);
		expect(diag.presses.map((p) => p.action)).toEqual(["select", "none", "move"]);
	});
});

describe("ac shadow: focus", () => {
	it("blur → focus inside the own-turn window is a toggle with the focus timings set", () => {
		shadow.positionArrived(now);
		now += 500;
		blur();
		const blurAt = now;
		now += 700;
		focus();
		const focusAt = now;
		moveTo("e2");
		drag("e2", "e4");
		const { ac, lichessBlur, diag } = shadow.observations[0]!;
		expect(ac.BlurCount).toBe(1);
		expect(ac.DidToggle).toBe(true);
		expect(ac.DidBlurOnOwnTurn).toBe(true);
		expect(ac.DidFocusOnOwnTurn).toBe(true);
		expect(ac.DidBlurOnOpponentTurn).toBe(false);
		expect(ac.DidFocusOnOpponentTurn).toBe(false);
		expect(ac.LastFocusToMoveTime).toBe(diag.submittedAt - focusAt);
		expect(ac.TotalBlurTime).toBe(700);
		expect(ac.TotalFocusTime).toBe(diag.submittedAt - diag.periodStart - 700);
		expect(ac.MoveToFirstBlurTime).toBe(blurAt - diag.periodStart);
		expect(lichessBlur).toBe(1);
	});

	it("a blur during the opponent's turn with focus regained after the position arrived", () => {
		// first move, clean
		shadow.positionArrived(now);
		moveTo("e2");
		drag("e2", "e4");
		const firstSubmit = shadow.observations[0]!.diag.submittedAt;
		// opponent thinks; the user tabs away and comes back after the reply arrives
		now += 1000;
		blur();
		now += 2000;
		shadow.positionArrived(now);
		now += 300;
		focus();
		moveTo("d2");
		drag("d2", "d4");
		const { ac, lichessBlur } = shadow.observations[1]!;
		expect(ac.BlurCount).toBe(1);
		expect(ac.DidBlurOnOpponentTurn).toBe(true);
		expect(ac.DidBlurOnOwnTurn).toBe(false);
		expect(ac.DidFocusOnOwnTurn).toBe(true);
		expect(ac.DidFocusOnOpponentTurn).toBe(false);
		expect(ac.DidToggle).toBe(true);
		expect(ac.MoveToFirstBlurTime).toBe(1000);
		expect(ac.TotalBlurTime).toBe(2300);
		expect(lichessBlur).toBe(1);
		// the first move's blob was closed before the blur: untouched
		expect(shadow.observations[0]!.ac.BlurCount).toBe(0);
		expect(shadow.observations[0]!.diag.submittedAt).toBe(firstSubmit);
	});

	it("a blur still open at submission counts its time up to the move and sets no focus timing", () => {
		shadow.positionArrived(now);
		now += 200;
		blur();
		now += 100;
		moveTo("e2");
		drag("e2", "e4");
		const { ac, diag } = shadow.observations[0]!;
		expect(ac.BlurCount).toBe(1);
		expect(ac.DidToggle).toBe(false);
		expect(ac.TotalBlurTime).toBe(diag.submittedAt - (diag.periodStart + 200));
		expect("LastFocusToMoveTime" in ac).toBe(false);
	});
});

describe("ac shadow: consecutive periods", () => {
	it("each blob counts only its own period's pointer path and reports the jump from the previous one", () => {
		shadow.positionArrived(now);
		moveTo("e2");
		drag("e2", "e4");
		const first = shadow.observations[0]!;
		// the pointer teleports between moves (what a real mouse grab would look like)
		now += 500;
		pointer("pointermove", 100, 100);
		shadow.positionArrived(now);
		const length = moveTo("d2") + drag("d2", "d4");
		const second = shadow.observations[1]!;
		expect(second.ac.PointerOffset).toBeCloseTo(
			length + Math.hypot(100 - centre("e4").x, 100 - centre("e4").y),
			6
		);
		expect(second.diag.pointerFirstStepPx).toBeCloseTo(
			Math.hypot(100 - centre("e4").x, 100 - centre("e4").y),
			6
		);
		expect(first.diag.pointerFirstStepPx).toBeNull();
		expect(second.diag.periodStart).toBe(first.diag.submittedAt);
	});

	it("dispose removes every listener", () => {
		shadow.positionArrived(now);
		shadow.dispose();
		moveTo("e2");
		drag("e2", "e4");
		expect(submitted).toEqual([]);
		expect(shadow.observations).toEqual([]);
	});
});
