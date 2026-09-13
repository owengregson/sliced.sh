// test/behavioral/game/input-mode.test.ts — `Settings.execution.inputMode` (owner, 2026-09-11).
//
// `click` commits a move as click-click — click the piece, carry the pointer over, click the
// square — and the site plays it; `auto` mixes drags and clicks per move. Assertions are on the
// dispatched CDP input and on the simulated board, never on a flag.
import { afterEach, describe, expect, it } from "bun:test";
import { CDP } from "@core/constants/cdp";
import { createGameHarness, type GameHarness } from "./harness";

let h: GameHarness;
afterEach(async () => {
	await h?.dispose();
});

const mouse = () => h.sim.debugger.commandsFor(CDP.inputDispatchMouseEvent);
const ofType = (type: string) => mouse().filter((c) => c.params?.type === type);
const squareAt = (command: { params?: Record<string, unknown> | undefined }): string | null =>
	h.site.board.squareOf(
		h.site.dom.elementAt(Number(command.params?.x), Number(command.params?.y)) as EventTarget | null
	);

describe("input mode", () => {
	it("click: the move is entered as two clicks — the piece, then the square — and lands", async () => {
		h = await createGameHarness({
			settings: { automation: { autoMove: true }, execution: { inputMode: "click" } },
		});
		await h.arrive();
		expect(await h.until(() => h.site.board.lastMove()?.byMe === true, 60_000)).toBe(true);
		const uci = h.site.board.lastMove()?.uci ?? "";
		// The second click submits on its press; its release follows the press hold.
		expect(await h.until(() => ofType("mouseReleased").length === 2, 2_000)).toBe(true);
		const presses = ofType("mousePressed");
		const releases = ofType("mouseReleased");
		expect(presses).toHaveLength(2);
		expect(squareAt(presses[0] ?? {})).toBe(uci.slice(0, 2));
		expect(squareAt(presses[1] ?? {})).toBe(uci.slice(2, 4));
		// The executed report follows the site's confirmation of the move.
		expect(await h.until(() => h.session().currentState() === "live:opponent-turn", 5_000)).toBe(
			true
		);
		expect((await h.snapshot()).session.lastExecution?.tier).toBe("click");
		expect(await h.until(() => h.session().currentState() === "live:opponent-turn", 5_000)).toBe(
			true
		);
	});

	it("drag: the default for tests, one press and one release on different squares", async () => {
		h = await createGameHarness({ settings: { automation: { autoMove: true } } });
		await h.arrive();
		expect(await h.until(() => h.site.board.lastMove()?.byMe === true, 60_000)).toBe(true);
		const uci = h.site.board.lastMove()?.uci ?? "";
		const presses = ofType("mousePressed");
		expect(presses).toHaveLength(1);
		expect(squareAt(presses[0] ?? {})).toBe(uci.slice(0, 2));
		expect(squareAt(ofType("mouseReleased")[0] ?? {})).toBe(uci.slice(2, 4));
	});

	it("auto: every move lands, as one press (a drag) or two (a click-click), never anything else", async () => {
		h = await createGameHarness({
			settings: { automation: { autoMove: true }, execution: { inputMode: "auto" } },
		});
		await h.arrive();
		let seen = mouse().length;
		const shapes = new Set<number>();
		for (let ply = 0; ply < 6; ply++) {
			expect(await h.until(() => h.site.board.lastMove()?.byMe === true, 60_000)).toBe(true);
			const since = mouse().slice(seen);
			const presses = since.filter((c) => c.params?.type === "mousePressed").length;
			expect([1, 2]).toContain(presses);
			shapes.add(presses);
			seen = mouse().length;
			const reply = h.site.board.legalMoves()[0];
			if (!reply) break;
			await h.arrive(reply);
		}
		expect(shapes.size).toBeGreaterThanOrEqual(1);
	});
});
