// test/behavioral/game/resign.test.ts — 2026-09-12: a forced mate against us is resigned, not
// played out. The whole stack on the simulator: the scripted engine answers `score mate -N`, the
// session waits its "evaluating the forced mate" moment (`RESIGN.delayMs`), `ResignInput` walks
// the hand to the site's resign control, clicks it, then its confirmation, and the site ends the
// game. Every guard the brief names has a case: mate too far away, a shallow search, a line that
// escapes, an unarmed hand, a position that moves on during the delay, and a page without a
// resign control (the move is played instead, so the game never stalls).
import { afterEach, describe, expect, it } from "bun:test";
import { CDP } from "@core/constants/cdp";
import { RESIGN } from "@core/constants/resign";
import { SIM_TELEMETRY } from "@test/sim/telemetry/constants";
import type { PositionSnapshot } from "@typedefs/game";
import { createGameHarness, type GameHarness, type GameHarnessOptions } from "./harness";

let h: GameHarness;
afterEach(async () => {
	await h?.dispose();
});

interface Press {
	x: number;
	y: number;
	at: number;
}

const presses = (): Press[] =>
	h.sim.debugger
		.commandsFor(CDP.inputDispatchMouseEvent)
		.filter((c) => (c.params as { type: string }).type === "mousePressed")
		.map((c) => ({ ...(c.params as { x: number; y: number }), at: c.at }));

const resignCommands = () => h.commands().filter((c) => c.kind === "resign");
/** Discovery reads only (a revalidation carries the `targetId`). */
const resignReads = () => resignCommands().filter((c) => c.targetId === undefined);

const inside = (
	p: { x: number; y: number },
	r: { x: number; y: number; width: number; height: number }
): boolean => p.x >= r.x && p.x <= r.x + r.width && p.y >= r.y && p.y <= r.y + r.height;

/** The harness with the hand armed in the waiting view (§13.4) and the site's resign controls laid out. */
async function armed(options: GameHarnessOptions = {}): Promise<void> {
	h = await createGameHarness({
		settings: { automation: { autoMove: true } },
		resignControls: true,
		...options,
	});
	await h.sw.run(() => h.session().command("armAutoMove"));
	expect(h.executor()?.isArmed()).toBe(true);
}

const movePlayed = (): boolean => h.site.board.lastMove()?.byMe === true;

describe("resigning a forced mate (2026-09-12)", () => {
	it("mate in 2 against us: no move is played; after the delay the hand clicks resign, then confirm, and the game ends", async () => {
		await armed({ script: { mateIn: -2 } });
		await h.arrive();
		expect(await h.until(() => h.session().recommendation() !== null, 5_000)).toBe(true);
		const recommendedAt = h.sim.now();
		const rec = h.session().recommendation();
		expect(rec?.lines[0]?.score.mate).toBe(-2);
		expect(rec?.lines.every((line) => (line.score.mate ?? 0) < 0)).toBe(true);

		// The human moment first: nothing is pressed before the shortest delay could have elapsed.
		await h.advance(RESIGN.delayMs[0] - 200);
		expect(presses()).toHaveLength(0);
		expect(h.site.resignClicks()).toHaveLength(0);

		expect(await h.until(() => h.site.resignClicks().length === 2, RESIGN.delayMs[1] + 15_000)).toBe(
			true
		);
		const clicks = h.site.resignClicks();
		expect(clicks.map((c) => c.step)).toEqual(["resign", "confirm"]);
		expect(inside(clicks[0]!, SIM_TELEMETRY.resignControls.resign)).toBe(true);
		expect(inside(clicks[1]!, SIM_TELEMETRY.resignControls.confirm)).toBe(true);

		// Exactly the two native presses, each inside the control it was aimed at.
		const pressed = presses();
		expect(pressed).toHaveLength(2);
		expect(inside(pressed[0]!, SIM_TELEMETRY.resignControls.resign)).toBe(true);
		expect(inside(pressed[1]!, SIM_TELEMETRY.resignControls.confirm)).toBe(true);
		// The resign press waited at least the sampled delay (plus the walk), never longer than
		// the delay's ceiling plus a generous walk.
		expect(pressed[0]!.at - recommendedAt).toBeGreaterThanOrEqual(RESIGN.delayMs[0]);
		expect(pressed[0]!.at - recommendedAt).toBeLessThanOrEqual(RESIGN.delayMs[1] + 10_000);
		// The confirmation was read before it was answered.
		expect(clicks[1]!.at - clicks[0]!.at).toBeGreaterThanOrEqual(RESIGN.confirmDelayMs[0]);
		// The hand walked to the control — a real approach, not a teleport.
		const moved = h.sim.debugger
			.commandsFor(CDP.inputDispatchMouseEvent)
			.filter((c) => (c.params as { type: string }).type === "mouseMoved");
		expect(moved.length).toBeGreaterThan(10);

		// No move was played and the site ended the game on the confirmation.
		expect(h.site.observeRequests()).toHaveLength(0);
		expect(movePlayed()).toBe(false);
		expect(await h.until(() => h.session().currentState() === "game-over", 2_000)).toBe(true);
		expect(h.sim.input.pointer(h.tabId)?.buttons).toBe(0);
		// Once per game: one attempt — the resign control is read before and after the attach
		// check (the infobar can shift the layout), the confirmation once it appears.
		expect(resignReads().filter((c) => c.step === "resign").length).toBeLessThanOrEqual(2);
		expect(resignReads().filter((c) => c.step === "confirm")).toHaveLength(1);
	});

	it("mate in 4 against us is played on: the move is made and nothing is asked about resigning", async () => {
		await armed({ script: { mateIn: -(RESIGN.maxMateIn + 1) } });
		await h.arrive();
		expect(await h.until(movePlayed, 60_000)).toBe(true);
		expect(resignCommands()).toHaveLength(0);
		expect(h.site.resignClicks()).toHaveLength(0);
	});

	it("a shallow search reporting mate does not resign (RESIGN.minDepth)", async () => {
		await armed({ script: { mateIn: -2, depth: RESIGN.minDepth - 1 } });
		await h.arrive();
		expect(await h.until(movePlayed, 60_000)).toBe(true);
		expect(resignCommands()).toHaveLength(0);
	});

	it("when the best line escapes and only the others are mated, the position is not resigned", async () => {
		await armed({ script: { mateIn: -2, escapeBest: true } });
		await h.arrive();
		expect(await h.until(movePlayed, 60_000)).toBe(true);
		expect(resignCommands()).toHaveLength(0);
	});

	it("`automation.resignLostGames` off (2026-09-13): the mate is played out, nothing is asked about resigning", async () => {
		await armed({
			settings: { automation: { autoMove: true, resignLostGames: false } },
			script: { mateIn: -2 },
		});
		await h.arrive();
		expect(await h.until(movePlayed, 60_000)).toBe(true);
		expect(resignCommands()).toHaveLength(0);
		expect(h.site.resignClicks()).toHaveLength(0);
	});

	it("an unarmed hand never resigns: the recommendation stands and nothing touches the page", async () => {
		h = await createGameHarness({
			settings: { automation: { autoMove: false } },
			resignControls: true,
			script: { mateIn: -2 },
		});
		expect(h.executor()?.isArmed()).toBe(false);
		await h.arrive();
		expect(await h.until(() => h.session().recommendation() !== null, 5_000)).toBe(true);
		await h.advance(RESIGN.delayMs[1] + 5_000);
		expect(resignCommands()).toHaveLength(0);
		expect(presses()).toHaveLength(0);
		expect(h.site.resignClicks()).toHaveLength(0);
		expect(movePlayed()).toBe(false);
	});

	it("a position that moves on during the delay cancels the resignation", async () => {
		await armed({ script: { mateIn: -2 } });
		await h.arrive();
		expect(await h.until(() => h.session().recommendation() !== null, 5_000)).toBe(true);
		await h.advance(300);
		expect(resignCommands()).toHaveLength(0);
		// The owner moved by hand: the board is now the opponent's turn (after 1.e4).
		const snapshot: PositionSnapshot = {
			site: "chesscom",
			gameId: h.site.gameId,
			fen: "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1",
			ply: 1,
			sideToMove: "b",
			myColor: "w",
			approximate: false,
			clocks: { w: { ms: 299_000, running: true }, b: { ms: 300_000, running: true } },
			capturedAt: h.sim.now(),
			timeControl: { baseMs: 300_000, incMs: 2_000 },
			lastMove: { from: "e2", to: "e4", san: "e4" },
		};
		await h.drive(() => h.site.post({ kind: "position", snapshot }));
		expect(h.session().currentState()).toBe("live:opponent-turn");
		await h.advance(RESIGN.delayMs[1] + 5_000);
		expect(resignCommands()).toHaveLength(0);
		expect(presses()).toHaveLength(0);
		expect(h.site.resignClicks()).toHaveLength(0);
	});

	it("no resign control on the page: the recommended move is played instead, and the attempt is not repeated", async () => {
		await armed({ script: { mateIn: -2 } });
		h.site.dom.query("#resign").setAttribute("hidden", "");
		await h.arrive();
		expect(await h.until(() => h.session().recommendation() !== null, 5_000)).toBe(true);
		expect(await h.until(() => resignReads().length === 1, RESIGN.delayMs[1] + 2_000)).toBe(true);
		expect(await h.until(movePlayed, 60_000)).toBe(true);
		expect(h.site.resignClicks()).toHaveLength(0);
		expect(resignReads()).toHaveLength(1);
		// The next position of the same game is still lost, but the game resigns at most once.
		const ply = h.site.board.ply();
		await h.arrive("e7e5");
		expect(await h.until(() => h.site.board.ply() > ply + 1, 60_000)).toBe(true);
		expect(resignReads()).toHaveLength(1);
		expect(h.site.resignClicks()).toHaveLength(0);
	});
});
