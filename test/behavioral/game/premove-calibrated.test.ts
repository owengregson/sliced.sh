// test/behavioral/game/premove-calibrated.test.ts — the think-time calibration's premove rate
// reaches the session's own premove path (`PremoveArming.arm` → `premoveCandidate` →
// `QueuedPremove.enter`). With a table that never premoves recaptures, no premove is entered during
// the opponent's turn. With one that always does, the same recapture is entered on the site, again
// only while the opponent is still to move. The move is the one the arm pre-decided for the
// predicted reply; nothing is played before their move lands except through that queue.
import { afterEach, expect, it } from "bun:test";
import { applyMoves } from "@core/chess/san";
import type { TimingCalibrationTable } from "@core/constants/timing-calibration";
import * as actual from "@core/constants/timing-calibration";
import { createGameHarness, type GameHarness } from "./harness";
import { positionKey } from "./scripted-engine";

/**
 * The shipped table object, overwritten in place for this file (each test file runs in its own
 * process): the session reads `TIMING_CALIBRATION` through its default arguments.
 */
const shipped = actual.TIMING_CALIBRATION as unknown as Record<string, unknown>;
function useTable(t: TimingCalibrationTable): void {
	for (const key of Object.keys(t)) shipped[key] = t[key as keyof TimingCalibrationTable];
}

function withRecapturePremove(p: number): TimingCalibrationTable {
	const cls = {
		...actual.TIMING_CALIBRATION_IDENTITY.blitz,
		premove: { recapture: [p], other: null },
	};
	return { bullet: cls, blitz: cls, rapid: cls };
}

let h: GameHarness | undefined;
afterEach(async () => {
	await h?.dispose();
	h = undefined;
});

// White: Ke1, Nc3, b2. Black: Ke8, Bb4. We shuffle the king, Black takes on c3, bxc3 takes back.
const FEN = "4k3/8/8/8/1b6/2N5/1P6/4K3 w - - 0 1";
const MOVE = "e1f1";
const REPLY = "b4c3";
const PREMOVE = "b2c3";

/** Play our move, publish the opponent-turn position, and report whether a premove press went out. */
async function enteredPremove(seed: number): Promise<boolean> {
	const afterMove = applyMoves(FEN, [MOVE]) as string;
	const afterReply = applyMoves(afterMove, [REPLY]) as string;
	h = await createGameHarness({
		settings: {
			automation: { autoMove: true },
			strength: { matchOpponentRating: false, targetElo: 2600, persona: "blitz" },
		},
		timeControl: { baseMs: 180_000, incMs: 0 },
		script: { bestCp: 900, stepCp: 900 },
		fen: FEN,
		gameId: `premove-calibrated-${seed}`,
		seed: `calibrated-${seed}`,
		premoves: true,
	});
	const harness = h;
	harness.transport.prefer.set(positionKey(FEN), [MOVE]);
	harness.transport.prefer.set(positionKey(afterMove), [REPLY]);
	harness.transport.prefer.set(positionKey(afterReply), [PREMOVE]);
	await harness.arrive();
	expect(
		await harness.until(() => harness.session().currentState() === "live:opponent-turn", 60_000)
	).toBe(true);
	await harness.arrive();
	const mark = harness.sim.debugger.commandsFor("Input.dispatchMouseEvent").length;
	// The premove drag: a press on b2 released on c3 (the idle hand may touch other squares).
	const drag = () => {
		const input = harness.sim.debugger
			.commandsFor("Input.dispatchMouseEvent")
			.slice(mark)
			.map((c) => {
				const p = (c.params ?? {}) as { type?: string; x?: number; y?: number };
				const el = harness.site.dom.elementAt(Number(p.x), Number(p.y)) as EventTarget | null;
				return { type: String(p.type), square: harness.site.board.squareOf(el) };
			});
		const press = input.findIndex(
			(d) => d.type === "mousePressed" && d.square === PREMOVE.slice(0, 2)
		);
		return (
			press >= 0 &&
			input.slice(press).some((d) => d.type === "mouseReleased" && d.square === PREMOVE.slice(2, 4))
		);
	};
	const pressed = await harness.until(drag, 4_000);
	// Whatever happened, it happened during the opponent's turn: nothing was played on the board.
	expect(harness.site.board.lastMove()?.uci).toBe(MOVE);
	return pressed;
}

it("never enters a recapture premove when the calibrated rate is 0", async () => {
	useTable(withRecapturePremove(0));
	for (let seed = 0; seed < 4; seed++) expect(await enteredPremove(seed)).toBe(false);
}, 120_000);

it("enters the pre-decided recapture during the opponent's turn when the calibrated rate is 1", async () => {
	useTable(withRecapturePremove(1));
	let entered = 0;
	for (let seed = 0; seed < 4; seed++) if (await enteredPremove(seed)) entered++;
	expect(entered).toBeGreaterThanOrEqual(3);
}, 120_000);
