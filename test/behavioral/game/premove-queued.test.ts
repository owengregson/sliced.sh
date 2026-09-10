// test/behavioral/game/premove-queued.test.ts — Fix F: a premove must be a *premove*. chess.com
// queues a move made during the opponent's turn and fires it the instant they move, so §7.4's
// armed premove is entered on the site **while the opponent is still to move** — asserted here on
// the dispatched CDP input, never on an internal flag — and reconciled against the next position.
//
// Every scenario is a recapture, the premove reason that invalidates itself when the opponent plays
// something else (`PREMOVE.queueReasons`). The scripted engine's line order is forced with `prefer`
// so the policy's `p(reply)` gate sees one dominant reply and the premove is the recapture.
import { afterEach, describe, expect, it } from "bun:test";
import { applyMoves } from "@core/chess/san";
import { chromeLocalGet } from "@core/chrome/storage";
import { DEFAULT_KEYBINDS } from "@core/constants/defaults";
import { LOCAL_KEYS } from "@core/constants/storage-keys";
import type { SessionStats, Square } from "@typedefs/game";
import type { TimingLogEntry } from "@typedefs/timing";
import { createGameHarness, type GameHarness } from "./harness";
import { positionKey } from "./scripted-engine";

let h: GameHarness;
afterEach(async () => {
	await h?.dispose();
});

interface Scenario {
	fen: string;
	/** Our move: a king shuffle, so the recapturing pawn stays where it is. */
	move: string;
	/** The reply the premove is conditioned on. */
	reply: string;
	/** Our premove. */
	premove: string;
	from: Square;
	to: Square;
}

/** White: Ke1, Nc3, b2. Black: Ke8, Bb4 — one piece aimed at the knight. */
const ONE_CAPTURER: Scenario = {
	fen: "4k3/8/8/8/1b6/2N5/1P6/4K3 w - - 0 1",
	move: "e1f1",
	reply: "b4c3",
	premove: "b2c3",
	from: "b2",
	to: "c3",
};
/** A legal reply that is *not* the predicted one and leaves `bxc3` illegal (nothing on c3 to take). */
const DROPPING_REPLY = "b4a5";

/** The same, with a black knight on e4 also aimed at c3: `bxc3` survives either capture. */
const TWO_CAPTURERS: Scenario = { ...ONE_CAPTURER, fen: "4k3/8/8/8/1b2n3/2N5/1P6/4K3 w - - 0 1" };
/** The unexpected reply that leaves our premove legal, so the site fires it anyway. */
const STILL_LEGAL_REPLY = "e4c3";

/** Two recaptures in one game: Bxc3/bxc3, then Bxf3/gxf3. */
const TWO_CYCLES = {
	fen: "7k/8/8/8/1b4b1/2N2N2/1P4P1/7K w - - 0 1",
	first: { move: "h1g1", reply: "b4c3", premove: "b2c3" },
	second: { reply: "g4f3", premove: "g2f3" },
};

/**
 * The ply our premove belongs to: the position after our move (ply 1) and the predicted reply,
 * which the session never sees, because the site plays our move in it.
 */
const PREMOVE_PLY = 2;

/**
 * Seeds tried until one draws a premove — §7.4's probability is a per-game latent and a per-move
 * draw, so no single seed is guaranteed to produce one. The `blitz` persona below raises the
 * latent (`TIMING_CONSTANTS.persona.profiles.blitz.premove`), which is what keeps this cheap.
 */
const SEEDS = 12;
/** Longest the opponent is left thinking while we wait for the premove drag (ms). */
const OPPONENT_THINK_MS = 4_000;
/** Long enough to cover the whole `PREMOVE.queueDelay…` range and the drag after it (ms). */
const PAST_THE_DELAY_MS = 10_000;

interface Dispatched {
	type: string;
	square: Square | null;
	at: number;
}

/** The `Input.dispatchMouseEvent` commands the executor sent, as board squares. */
function dispatched(from = 0): Dispatched[] {
	return h.sim.debugger
		.commandsFor("Input.dispatchMouseEvent")
		.slice(from)
		.map((c) => {
			const p = (c.params ?? {}) as { type?: string; x?: number; y?: number };
			const el = h.site.dom.elementAt(Number(p.x), Number(p.y)) as EventTarget | null;
			return { type: String(p.type), square: h.site.board.squareOf(el), at: c.at };
		});
}

/** §8.6 rows for a move that was played and carries a §13.6 quality pair (a searched move). */
function playedRows(): TimingLogEntry[] {
	return h.timingLog.entries().filter((e) => e.actualMs !== null && e.telemetry?.top1 !== undefined);
}

function pressCount(from = 0): number {
	return dispatched(from).filter((d) => d.type === "mousePressed").length;
}

/**
 * §8.6 rows for a move that was actually played and carries no §13.6 quality pair — which only a
 * premove produces (the timing model's own `premove` *mode* is a fast plan for a searched move and
 * keeps its pair, so the mode alone would not discriminate).
 */
function unscoredRows(): TimingLogEntry[] {
	return h.timingLog
		.entries()
		.filter((e) => e.actualMs !== null && e.telemetry?.top1 === undefined)
		.map((e) => e);
}

interface Armed {
	/** Index into the CDP command log, taken when the opponent-turn position was published. */
	mark: number;
	scenario: Scenario;
	/** `stopAtPending` only: this seed's draw did produce a premove, scheduled and not yet entered. */
	pending: boolean;
}

interface ArmOptions {
	seed: number;
	/** Whether the *site* holds premoves (chess.com's own setting, which we cannot read). */
	premoves: boolean;
	scenario?: Scenario;
	/** Stop once the premove is scheduled, before the drag goes out (the cancellation rows). */
	stopAtPending?: boolean;
}

/**
 * Play our move, publish the position the opponent is to move in, and let the session arm — and
 * enter — its premove.
 */
async function armPremove(o: ArmOptions): Promise<Armed> {
	const scenario = o.scenario ?? ONE_CAPTURER;
	const afterMove = applyMoves(scenario.fen, [scenario.move]) as string;
	const afterReply = applyMoves(afterMove, [scenario.reply]) as string;
	h = await createGameHarness({
		settings: {
			automation: { autoMove: true },
			// The persona with the strongest premove propensity (§7.4's `pi_p`), so the policy's own
			// draw does not make the test a lottery.
			strength: { matchOpponentRating: false, targetElo: 3000, persona: "blitz" },
		},
		timeControl: { baseMs: 180_000, incMs: 0 }, // blitz: §7.4 premoves at bullet/blitz only
		script: { bestCp: 900, stepCp: 900 },
		// §13.4's in-page keybinds reach the worker (the `Shift+X` cancellation row).
		sendKeybinds: true,
		fen: scenario.fen,
		gameId: `premove-queued-${o.seed}`,
		seed: `queued-${o.seed}`,
		premoves: o.premoves,
	});
	// The engine's line order, so the policy sees exactly one plausible reply and one recapture.
	h.transport.prefer.set(positionKey(scenario.fen), [scenario.move]);
	h.transport.prefer.set(positionKey(afterMove), [scenario.reply]);
	h.transport.prefer.set(positionKey(afterReply), [scenario.premove]);

	await h.arrive();
	expect(await h.until(() => h.session().currentState() === "live:opponent-turn", 60_000)).toBe(
		true
	);
	expect(h.site.board.lastMove()?.uci).toBe(scenario.move);
	// The opponent is to move: this is the window a premove is entered in.
	await h.arrive();
	const mark = h.sim.debugger.commandsFor("Input.dispatchMouseEvent").length;
	if (o.stopAtPending === true) {
		// The drag is scheduled for its human moment but has not gone out yet. §7.4's draw decides
		// whether there is one at all, so the caller tries the next seed when there is not.
		const pending = await h.until(() => h.executor()?.pendingMove() !== null, OPPONENT_THINK_MS);
		if (pending) expect(pressCount(mark)).toBe(0);
		return { mark, scenario, pending };
	}
	// The ponder, the §7.4 gate searches and the premove's own drag all run here; the drag is
	// finished once the hand has released, which is when the site has been handed the move.
	if (await h.until(() => pressCount(mark) > 0, OPPONENT_THINK_MS))
		await h.until(() => h.executor()?.isRunning() === false, OPPONENT_THINK_MS);
	await h.advance(50); // let the executor's own report reach the session
	expect(h.site.board.chess.turn()).toBe("b"); // still the opponent's turn throughout
	return { mark, scenario, pending: false };
}

/** `true` when this seed's draw produced a premove the site is now holding. */
function queued(): boolean {
	return h.site.premoveQueued() !== null;
}

describe("game session: a queued premove (Fix F)", () => {
	it("enters the armed premove on the site during the opponent's turn", async () => {
		let entered = false;
		for (let seed = 0; seed < SEEDS && !entered; seed++) {
			await h?.dispose();
			const { mark, scenario } = await armPremove({ seed, premoves: true });
			const input = dispatched(mark);
			const press = input.find((d) => d.type === "mousePressed");
			if (!press) continue; // this seed's draw produced no premove
			entered = true;
			const release = input.find((d) => d.type === "mouseReleased");
			// The drag is our premove, dispatched while the opponent is still to move.
			expect(press.square).toBe(scenario.from);
			expect(release?.square).toBe(scenario.to);
			expect(h.site.board.chess.turn()).toBe("b");
			// …and it is the site that holds it: nothing has been played.
			expect(h.site.board.lastMove()?.uci).toBe(scenario.move);
			expect(h.site.premoveQueued()).toEqual({ from: scenario.from, to: scenario.to });
			// One attempt only: a queued premove is never verified against the board, so the retry
			// policy must not enter the move a second time.
			expect(input.filter((d) => d.type === "mousePressed")).toHaveLength(1);
			expect(h.site.observeRequests()).toHaveLength(1); // our own move's, not the premove's
			// §13.7 item 3: the gesture is complete and resolved — the page is left with no piece
			// selected, never a half-drag or a stuck selection.
			expect(h.site.shadow.pendingSelection()).toBeNull();
			// Nothing is reported as played, and no §8.6 row claims one.
			expect(unscoredRows()).toHaveLength(0);
			const stats = await h.sw.run(
				() => chromeLocalGet(LOCAL_KEYS.sessionStats) as Promise<SessionStats | undefined>
			);
			expect(stats?.moves).toBe(1);
		}
		expect(entered).toBe(true);
	}, 180_000);

	it("outcome 1 — the predicted reply: the site fires the premove and it is recorded as ours", async () => {
		let fired = false;
		for (let seed = 0; seed < SEEDS && !fired; seed++) {
			await h?.dispose();
			const { scenario } = await armPremove({ seed, premoves: true });
			if (!queued()) continue;
			fired = true;
			await h.arrive(scenario.reply);
			// Both plies landed in one position: their reply and our premove.
			expect(h.site.board.lastMove()?.uci).toBe(scenario.premove);
			expect(h.site.premoveQueued()).toBeNull();
			expect(h.site.board.chess.turn()).toBe("b");
			// §8.6: the premove has a row of its own at the ply it was played in — the position after
			// the reply, which this session never saw — and it is the only played row without a
			// §13.6 quality pair, because no search ever ranked it.
			expect(await h.until(() => unscoredRows().length === 1, 5_000)).toBe(true);
			const row = unscoredRows()[0];
			expect(row?.mode).toBe("premove");
			expect(row?.ply).toBe(PREMOVE_PLY);
			expect(row?.telemetry).toBeDefined();
			expect(row?.telemetry?.ac.EventTrusted).toBe(true);
			expect(row?.telemetry?.ac.BlurCount).toBe(0);
			expect(row?.telemetry?.cpLoss).toBeUndefined();
			// The §13.2 window the input really happened in is the opponent's, so it is long enough
			// to contain the drag (`TotalFocusTime >= MoveHoldTime`, `ac-model.ts`).
			expect(row?.telemetry?.ac.TotalFocusTime).toBeGreaterThanOrEqual(
				row?.telemetry?.ac.MoveHoldTime ?? 0
			);
			// What the *site* computes for that ply is a different window from ours: it opens when the
			// reply lands and closes a few ms later, when the premove goes out. That near-zero hold is
			// what every human premove looks like, and §13.2's hold-time floor exempts the mode.
			const theirs = h.site.shadow.observations.at(-1);
			expect(theirs?.diag.from).toBe(scenario.from);
			expect(theirs?.diag.to).toBe(scenario.to);
			expect(theirs?.ac.EventTrusted).toBe(true);
			expect(theirs?.ac.BlurCount).toBe(0);
			// One piece selected in their window (ours), so no multi-select is charged to it.
			expect(theirs?.ac.DidSelectMultiplePieces).toBe(false);
			expect(h.site.shadow.pendingSelection()).toBeNull();
			const stats = await h.sw.run(
				() => chromeLocalGet(LOCAL_KEYS.sessionStats) as Promise<SessionStats | undefined>
			);
			expect(stats?.moves).toBe(2); // our searched move, then the premove
			expect(stats?.scoredMoves).toBe(1);
		}
		expect(fired).toBe(true);
	}, 180_000);

	it("outcome 2 — an unexpected reply the site drops: a normal turn, planned normally", async () => {
		let dropped = false;
		for (let seed = 0; seed < SEEDS && !dropped; seed++) {
			await h?.dispose();
			await armPremove({ seed, premoves: true });
			if (!queued()) continue;
			dropped = true;
			const searches = h.transport.goLines.length;
			await h.arrive(DROPPING_REPLY);
			// `bxc3` is illegal after `Ba5`: the site drops it and it is our turn again.
			expect(h.site.board.lastMove()?.uci).toBe(DROPPING_REPLY);
			expect(h.site.premoveQueued()).toBeNull();
			expect(await h.until(() => h.session().recommendation() !== null, 10_000)).toBe(true);
			expect(h.session().recommendation()?.chosen.source).not.toBe("premove");
			expect(h.transport.goLines.length).toBeGreaterThan(searches);
			// Nothing was recorded as played for the premove: every played row is a searched move.
			expect(unscoredRows()).toHaveLength(0);
			const stats = await h.sw.run(
				() => chromeLocalGet(LOCAL_KEYS.sessionStats) as Promise<SessionStats | undefined>
			);
			expect(stats?.moves).toBe(1);
			// §13.2: the page saw the dropped premove's press, and the site's move window does not end
			// when our drag does — it ends at our next submission. So the *next* move's blob counts
			// two pieces selected, and our own record of that move says the same thing (it would
			// otherwise understate the preview rate by exactly the premoves the site drops).
			expect(await h.until(() => h.site.board.ply() === 3, 30_000)).toBe(true);
			const theirs = h.site.shadow.observations.at(-1);
			expect(theirs?.diag.selections).toEqual([ONE_CAPTURER.from, theirs?.diag.from ?? "a1"]);
			expect(theirs?.ac.DidSelectMultiplePieces).toBe(true);
			expect(await h.until(() => unscoredRows().length + playedRows().length === 2, 5_000)).toBe(true);
			expect(playedRows().at(-1)?.telemetry?.ac.DidSelectMultiplePieces).toBe(true);
		}
		expect(dropped).toBe(true);
	}, 180_000);

	it("outcome 3 — an unexpected reply the premove survives: it fires anyway and is still ours", async () => {
		let fired = false;
		for (let seed = 0; seed < SEEDS && !fired; seed++) {
			await h?.dispose();
			const { scenario } = await armPremove({ seed, premoves: true, scenario: TWO_CAPTURERS });
			if (!queued()) continue;
			fired = true;
			// The knight takes on c3 instead of the bishop: `bxc3` is still legal, so the site plays
			// it even though the prediction was wrong.
			await h.arrive(STILL_LEGAL_REPLY);
			expect(h.site.board.lastMove()?.uci).toBe(scenario.premove);
			expect(h.site.board.chess.turn()).toBe("b");
			// It was our move and is accounted as one — §13.6 scores it as a premove (not at all) and
			// §8.6 still writes its `mode: "premove"` row.
			expect(await h.until(() => unscoredRows().length === 1, 5_000)).toBe(true);
			const row = unscoredRows()[0];
			expect(row?.mode).toBe("premove");
			expect(row?.ply).toBe(PREMOVE_PLY);
			expect(row?.telemetry?.ac.EventTrusted).toBe(true);
			const stats = await h.sw.run(
				() => chromeLocalGet(LOCAL_KEYS.sessionStats) as Promise<SessionStats | undefined>
			);
			expect(stats?.moves).toBe(2);
			expect(stats?.scoredMoves).toBe(1);
		}
		expect(fired).toBe(true);
	}, 180_000);

	it("the site is not holding premoves: the fast reply answers, and nothing is entered again", async () => {
		const after = (...moves: string[]): string =>
			applyMoves(TWO_CYCLES.fen, moves) as unknown as string;
		let fired = false;
		for (let seed = 0; seed < SEEDS && !fired; seed++) {
			await h?.dispose();
			// `premoves: false` is a player whose chess.com settings have premoves switched off — the
			// one case a queued premove cannot serve, and the reason §7.4's fast reply stays.
			const { mark } = await armPremove({
				seed,
				premoves: false,
				scenario: {
					fen: TWO_CYCLES.fen,
					move: TWO_CYCLES.first.move,
					reply: TWO_CYCLES.first.reply,
					premove: TWO_CYCLES.first.premove,
					from: "b2",
					to: "c3",
				},
			});
			if (pressCount(mark) === 0) continue; // no premove was drawn for this seed
			// The drag went out and the site kept nothing: the piece snapped back.
			expect(h.site.premoveQueued()).toBeNull();
			expect(h.site.board.lastMove()?.uci).toBe(TWO_CYCLES.first.move);
			// The second cycle's lines, for the premove the session arms after the reactive one plays.
			const cycle2 = after(TWO_CYCLES.first.move, TWO_CYCLES.first.reply, TWO_CYCLES.first.premove);
			h.transport.prefer.set(positionKey(cycle2), [TWO_CYCLES.second.reply]);
			h.transport.prefer.set(
				positionKey(
					after(
						TWO_CYCLES.first.move,
						TWO_CYCLES.first.reply,
						TWO_CYCLES.first.premove,
						TWO_CYCLES.second.reply
					)
				),
				[TWO_CYCLES.second.premove]
			);

			await h.arrive(TWO_CYCLES.first.reply);
			const rec = h.session().recommendation();
			if (rec?.chosen.source !== "premove") continue;
			fired = true;
			// §7.4's fast reply played it instead, after the reply landed.
			expect(rec.plan.mode).toBe("premove");
			expect(rec.chosen.uci).toBe(TWO_CYCLES.first.premove);
			expect(
				await h.until(() => h.site.board.lastMove()?.uci === TWO_CYCLES.first.premove, 5_000)
			).toBe(true);

			// Second cycle: the session has learned the site drops them, so nothing is entered during
			// the opponent's turn — and the arm is still there, because the fast reply plays it again.
			await h.arrive();
			const mark2 = h.sim.debugger.commandsFor("Input.dispatchMouseEvent").length;
			await h.advance(PAST_THE_DELAY_MS);
			expect(pressCount(mark2)).toBe(0);
			await h.arrive(TWO_CYCLES.second.reply);
			const rec2 = h.session().recommendation();
			expect(rec2?.chosen.source).toBe("premove");
			expect(rec2?.chosen.uci).toBe(TWO_CYCLES.second.premove);
		}
		expect(fired).toBe(true);
	}, 180_000);
});

/** Every way the owner can stop the assistant must stop a premove that has not gone out yet. */
const CANCELLATIONS: ReadonlyArray<{ name: string; act: () => Promise<void> }> = [
	{
		name: "Shift+X (the in-page disable keybind)",
		act: async () => {
			await h.pressKey({
				key: DEFAULT_KEYBINDS.disable.key,
				code: DEFAULT_KEYBINDS.disable.code,
				shiftKey: DEFAULT_KEYBINDS.disable.shiftKey,
			});
		},
	},
	{ name: "the master switch going off", act: () => h.patch({ enabled: false }) },
	{ name: "a disarm", act: () => h.drive(() => void h.session().command("disarm")) },
	{ name: "the game ending", act: () => h.drive(() => h.site.endGame()) },
	{ name: "the tab navigating away", act: () => h.drive(() => h.session().onTabEvent("navigated")) },
];

describe("game session: a queued premove is cancelled by every stop (Fix F)", () => {
	for (const row of CANCELLATIONS) {
		it(`${row.name} stops a premove that has not been entered`, async () => {
			let reached = false;
			for (let seed = 0; seed < SEEDS && !reached; seed++) {
				await h?.dispose();
				const { mark, pending } = await armPremove({ seed, premoves: true, stopAtPending: true });
				if (!pending) continue; // this seed's draw produced no premove
				reached = true;
				await row.act();
				// Past the whole entry-delay range: the drag never goes out and the site is handed
				// nothing at all.
				await h.advance(PAST_THE_DELAY_MS);
				expect(pressCount(mark)).toBe(0);
				expect(h.site.premoveQueued()).toBeNull();
				expect(h.site.board.lastMove()?.uci).toBe(ONE_CAPTURER.move);
			}
			expect(reached).toBe(true);
		}, 180_000);
	}

	it("the premove is not entered early by `playNow` during the opponent's turn", async () => {
		let reached = false;
		for (let seed = 0; seed < SEEDS && !reached; seed++) {
			await h?.dispose();
			const { mark, pending } = await armPremove({ seed, premoves: true, stopAtPending: true });
			if (!pending) continue;
			reached = true;
			await h.drive(() => void h.session().command("playNow"));
			await h.advance(1);
			// `playNow` is about *our* move; the premove keeps its own human moment.
			expect(pressCount(mark)).toBe(0);
			expect(h.site.premoveQueued()).toBeNull();
			// …and it still goes out at its own moment.
			expect(await h.until(() => pressCount(mark) > 0, PAST_THE_DELAY_MS)).toBe(true);
			expect(await h.until(() => h.executor()?.isRunning() === false, OPPONENT_THINK_MS)).toBe(true);
			expect(h.site.premoveQueued()).toEqual({ from: ONE_CAPTURER.from, to: ONE_CAPTURER.to });
		}
		expect(reached).toBe(true);
	}, 180_000);
});
