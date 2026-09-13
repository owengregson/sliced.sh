// test/behavioral/game/scramble-hold.test.ts — the scramble hold (owner, 2026-09-11).
//
// In a race on our own clock the hand no longer answers the opponent at executor speed: during
// their turn it picks the expected piece up, carries it to its destination and holds it there,
// and their move is the cue to let go. Every assertion is on dispatched CDP input — the press, the
// absence of a release while they think, the release after they moved — never on a flag.
import { afterEach, describe, expect, it } from "bun:test";
import { hangsOutright } from "@core/chess/safety";
import { applyMoves, legalMoves } from "@core/chess/san";
import { CDP } from "@core/constants/cdp";
import { DEFAULT_KEYBINDS } from "@core/constants/defaults";
import { SCRAMBLE_HOLD } from "@core/constants/hold";
import { createGameHarness, type GameHarness } from "./harness";

let h: GameHarness;
afterEach(async () => {
	await h?.dispose();
});

const BULLET = { baseMs: 60_000, incMs: 0 };
/** Our clock is inside the own-clock race threshold; theirs is comfortable. */
const SCRAMBLE = { w: 30_000, b: 3_000 };

const mouse = () => h.sim.debugger.commandsFor(CDP.inputDispatchMouseEvent);
const presses = () => mouse().filter((c) => c.params?.type === "mousePressed");
const releases = () => mouse().filter((c) => c.params?.type === "mouseReleased");
const squareAt = (command: { params?: Record<string, unknown> | undefined }): string | null =>
	h.site.board.squareOf(
		h.site.dom.elementAt(Number(command.params?.x), Number(command.params?.y)) as EventTarget | null
	);

/** Seeds tried until one draws a hold — the decision is a checkpoint roll, never certain. */
const SEEDS = 12;

async function holding(): Promise<string> {
	let pressed = false;
	for (let seed = 0; seed < SEEDS && !pressed; seed++) {
		await h?.dispose();
		h = await createGameHarness({
			myColor: "b",
			seed: `scramble-hold-${seed}`,
			sendKeybinds: true,
			timeControl: BULLET,
			script: { pvDepth: 2 },
			settings: { automation: { autoMove: true }, execution: { verifyMoves: true } },
		});
		await h.arrive(null, SCRAMBLE);
		pressed = await h.until(() => presses().length === 1, 2_000);
	}
	expect(pressed).toBe(true);
	const held = h.executor()?.holdingMove()?.rec.chosen;
	expect(held).toBeDefined();
	if (!held) throw new Error("no held move");
	expect(squareAt(presses()[0] ?? {})).toBe(held.from);
	// Their think: the piece stays up, over its destination, and nothing is released.
	await h.advance(2_000);
	expect(releases()).toHaveLength(0);
	expect(h.executor()?.holdingMove()).not.toBeNull();
	expect(h.site.board.lastMove()).toBeNull();
	return held.uci;
}

describe("scramble hold", () => {
	it("holds the piece over its destination while the opponent thinks and lets go on their move", async () => {
		const uci = await holding();
		// The reply the hold was prepared against: the one that leads to the held move's position.
		const before = h.site.board.fen();
		const predictedFen = h.executor()?.holdingMove()?.rec.fen ?? "";
		const reply = legalMoves(before).find((m) => {
			const after = applyMoves(before, [m]);
			return after !== null && after.split(" ")[0] === predictedFen.split(" ")[0];
		});
		expect(reply).toBeDefined();
		if (!reply) throw new Error("no predicted reply");
		const releasesBefore = releases().length;
		await h.arrive(reply, { w: 29_000, b: 3_000 });
		const arrivedAt = h.sim.now();
		expect(await h.until(() => h.site.board.lastMove()?.byMe === true, 5_000)).toBe(true);
		const first = releases()[releasesBefore];
		expect(first).toBeDefined();
		// Never before their move, and only after a human reaction to it.
		expect(Number(first?.at ?? 0)).toBeGreaterThanOrEqual(
			arrivedAt + SCRAMBLE_HOLD.releaseReactionMs[0]
		);
		if (hangsOutright(applyMoves(before, [reply]) ?? "", uci)) {
			// Their move left the ready piece en prise: it went back, and a searched move followed.
			expect(squareAt(first ?? {})).toBe(uci.slice(0, 2));
			expect(h.site.board.lastMove()?.uci).not.toBe(uci);
		} else {
			expect(h.site.board.lastMove()?.uci).toBe(uci);
			expect(squareAt(first ?? {})).toBe(uci.slice(2, 4));
		}
		expect(await h.until(() => h.session().currentState() === "live:opponent-turn", 5_000)).toBe(
			true
		);
		expect(h.executor()?.holdingMove()).toBeNull();
	});

	it("gives the piece back on its own square when the hold times out, playing nothing", async () => {
		const uci = await holding();
		await h.advance(SCRAMBLE_HOLD.scrambleHoldMs[1] + 1_000);
		expect(await h.until(() => releases().length === 1, 5_000)).toBe(true);
		expect(squareAt(releases()[0] ?? {})).toBe(uci.slice(0, 2));
		expect(h.site.board.lastMove()).toBeNull();
		expect(h.executor()?.holdingMove()).toBeNull();
		expect(h.session().currentState()).toBe("live:opponent-turn");
	});

	it("gives the piece back when auto-play is turned off mid-hold", async () => {
		const uci = await holding();
		await h.pressKey(DEFAULT_KEYBINDS.toggleAutoMove);
		expect(await h.until(() => releases().length === 1, 5_000)).toBe(true);
		expect(squareAt(releases()[0] ?? {})).toBe(uci.slice(0, 2));
		expect(h.site.board.lastMove()).toBeNull();
		expect(h.executor()?.isArmed()).toBe(false);
	});
});
