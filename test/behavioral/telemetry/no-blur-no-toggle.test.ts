// test/behavioral/telemetry/no-blur-no-toggle.test.ts — Task 33 Step 2 (a)–(c): a full simulated bot
// game with auto-play armed, observed by the `ac` shadow: every blob is blur-free, untoggled and
// trusted; a panel click (focus leaves the page) inside the think window skips that move and the
// telemetry pill warns; a real pointer event during the hand is counted and changes nothing.
import { afterEach, describe, expect, it } from "bun:test";
import { EXECUTOR } from "@core/constants/cdp";
import { SIM_TELEMETRY } from "@test/sim/telemetry/constants";
import { runSimulatedGame, type SimulatedGame } from "@test/sim/telemetry/harness";
import { COPY } from "../../../src/panel/copy";
import { telemetryPill } from "../../../src/panel/views/live/session-strip";
import { assertHumanShapedAc, moveMetaOf } from "../../../tools/telemetry-conformance/ac-model";

let game: SimulatedGame | null = null;
afterEach(async () => {
	await game?.dispose();
	game = null;
});

describe("telemetry: a 30-move bot game with auto-play armed (Step 2a)", () => {
	it("every ac blob has BlurCount 0, DidToggle false, EventTrusted true and no focus timings; lichess blur bits are 0", async () => {
		game = await runSimulatedGame({
			seed: "reference-game",
			moves: SIM_TELEMETRY.referenceGameMoves,
		});
		expect(game.moves).toHaveLength(SIM_TELEMETRY.referenceGameMoves);
		expect(game.moves.every((m) => m.result.ok && m.result.outcome === "executed")).toBe(true);
		expect(game.acs).toHaveLength(SIM_TELEMETRY.referenceGameMoves);
		for (const ac of game.acs) {
			expect(ac.BlurCount).toBe(0);
			expect(ac.DidToggle).toBe(false);
			expect(ac.EventTrusted).toBe(true);
			expect(ac.DidBlurOnOwnTurn).toBe(false);
			expect(ac.DidBlurOnOpponentTurn).toBe(false);
			expect(ac.DidFocusOnOwnTurn).toBe(false);
			expect(ac.DidFocusOnOpponentTurn).toBe(false);
			expect(ac.TotalBlurTime).toBe(0);
			expect("LastFocusToMoveTime" in ac).toBe(false);
			expect("MoveToFirstBlurTime" in ac).toBe(false);
		}
		expect(game.blurBits.every((b) => b === 0)).toBe(true);
		// the whole game passes the shared assertion (band checks included, N = 30)
		const summary = assertHumanShapedAc(game.acs, { moves: game.moves.map(moveMetaOf) });
		expect(summary.n).toBe(SIM_TELEMETRY.referenceGameMoves);
		expect(summary.blurCount).toBe(0);
		// the extension never touched focus or the active tab, and the page saw the tab stay focused
		expect(game.focusApiCalls).toEqual({ tabsUpdate: 0, windowsUpdate: 0, bringToFront: 0 });
		expect(game.site.pageFocusEvents()).toEqual({ blur: 0, focus: 0 });
	});
});

describe("telemetry: focus discipline inside the think window (Step 2b)", () => {
	it("a simulated panel click during the think window skips the move, the pill says 'blur seen', and the move plays after a fresh window", async () => {
		let injected = false;
		game = await runSimulatedGame({
			seed: "panel-click",
			moves: 3,
			duringMove: async ({ index, site, sim }) => {
				if (index !== 1 || injected) return;
				injected = true;
				await sim.time.advance(300); // inside the think window, before the committed press
				site.panelClick(); // focus leaves the page: window blur, document.hasFocus() false
			},
		});
		// move 1 was skipped (the panel still holds focus: `unfocused`; a blur seen in the window),
		// nothing was dispatched after the edge, then the move was replayed
		const skipped = game.moves.find((m) => m.index === 1 && !m.result.ok);
		expect(skipped).toBeDefined();
		expect(skipped?.result).toMatchObject({
			ok: false,
			outcome: "skipped",
			reason: EXECUTOR.reasons.unfocused,
			pressed: false,
		});
		expect(skipped?.commands.filter((c) => c.type !== "mouseMoved")).toHaveLength(0);
		// the gate learns of the blur one port hop after the page saw it; nothing goes out after that
		const blurAt = skipped?.blurAt ?? Number.NaN;
		const blurSeenAt = skipped?.blurSeenAt ?? Number.NaN;
		expect(blurSeenAt).toBeGreaterThanOrEqual(blurAt);
		expect(blurSeenAt - blurAt).toBeLessThan(SIM_TELEMETRY.portHopMaxMs);
		for (const c of skipped?.commands ?? []) expect(c.at).toBeLessThanOrEqual(blurSeenAt);
		expect((skipped?.commands ?? []).filter((c) => c.at > blurAt).length).toBeLessThanOrEqual(1);
		// the panel's telemetry pill warned while the blur was in the window
		expect(skipped?.focusAtSkip).toEqual({ pageHasFocus: false, blurSeenThisMove: true });
		expect(
			telemetryPill({ ...skipped!.focusAtSkip!, handsOff: true, realPointerEventsDuringHand: 0 })
		).toMatchObject({ variant: "warn", text: COPY.telemetry.blur });
		// the replay of the same move after a fresh window executed, and the other moves were untouched
		const replay = game.moves.find((m) => m.index === 1 && m.retryOf !== undefined);
		expect(replay?.result).toMatchObject({ ok: true, outcome: "executed" });
		expect(replay?.uci).toBe(skipped?.uci);
		expect(game.moves.filter((m) => m.result.ok)).toHaveLength(3);
		// the shadow saw exactly one blur/focus pair, on the skipped move's window, and clean blobs after it
		expect(game.site.pageFocusEvents()).toEqual({ blur: 1, focus: 1 });
		const acs = game.acs;
		expect(acs).toHaveLength(3);
		expect(acs[0]?.BlurCount).toBe(0);
		expect(acs[1]?.BlurCount).toBe(1); // the human clicked into the board again: a real toggle, not ours
		expect(acs[1]?.DidToggle).toBe(true);
		expect(acs[2]?.BlurCount).toBe(0);
		expect(acs[2]?.DidToggle).toBe(false);
	});
});

describe("telemetry: real pointer input during the hand (Step 2c, V2.1)", () => {
	it("a real pointer event leaves the execution unaffected and increments realPointerEventsDuringHand", async () => {
		let before = -1;
		let after = -1;
		game = await runSimulatedGame({
			seed: "real-pointer",
			moves: 2,
			duringMove: async ({ index, tabId, site, sim, sw }) => {
				if (index !== 1) return;
				await sim.time.advance(200);
				before = sw.ownership.realPointerCount(tabId);
				site.realPointer("pointerdown", 20, 20); // the user taps the mouse off the board
				site.realPointer("pointerup", 20, 20);
				await sim.time.runMicrotasks();
				after = sw.ownership.realPointerCount(tabId);
			},
		});
		expect(game.moves.every((m) => m.result.ok && m.result.outcome === "executed")).toBe(true);
		expect(before).toBeGreaterThanOrEqual(0);
		expect(after - before).toBe(2);
		expect(
			telemetryPill({
				pageHasFocus: true,
				blurSeenThisMove: false,
				handsOff: true,
				realPointerEventsDuringHand: after,
			})
		).toMatchObject({
			variant: "danger",
			text: COPY.telemetry.mouse,
		});
		// the hand's own path was not re-anchored by the real event: every dispatch continues from the previous one
		const cmds = game.moves[1]!.commands;
		for (let i = 1; i < cmds.length; i++) {
			const prev = cmds[i - 1]!;
			const cur = cmds[i]!;
			expect(Math.hypot(cur.x - prev.x, cur.y - prev.y)).toBeLessThanOrEqual(game.maxStepPx);
		}
		assertHumanShapedAc(game.acs, { moves: game.moves.map(moveMetaOf) });
	});
});
