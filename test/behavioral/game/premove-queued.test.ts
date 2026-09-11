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
import { TOAST_KEYS } from "@core/constants/toasts";
import type { SessionStats, Square } from "@typedefs/game";
import type { AcBlob } from "@typedefs/telemetry";
import type { TimingLogEntry } from "@typedefs/timing";
import {
	type AcMoveMeta,
	assertHumanShapedAc,
	assertWellFormedAc,
} from "../../../tools/telemetry-conformance/ac-model";
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
	/** …and its SAN, which only exists in the position *after* the predicted reply. */
	san: string;
	from: Square;
	to: Square;
}

/** White: Ke1, Nc3, b2. Black: Ke8, Bb4 — one piece aimed at the knight. */
const ONE_CAPTURER: Scenario = {
	fen: "4k3/8/8/8/1b6/2N5/1P6/4K3 w - - 0 1",
	move: "e1f1",
	reply: "b4c3",
	premove: "b2c3",
	san: "bxc3",
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
/**
 * The `playNow` row needs a seed whose scheduled moment is at least this far off, so that "no press
 * yet" is a statement about the guard and not about the hand's motor path (measured in review: an
 * ungated `playNow` presses ~300 ms later).
 */
const MEASURABLE_SLACK_MS = 700;
/** How far short of the scheduled moment that row stops and checks (ms). */
const EARLY_PRESS_MARGIN_MS = 150;

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
	return h.timingLog.entries().filter((e) => e.actualMs !== null && e.telemetry?.top1 === undefined);
}

/**
 * The invariant that catches a stolen §13.2 window outright: a move that was **played** carries the
 * record of the window it was played in. Before the premove got a window of its own, a premove
 * report arriving after the next position had opened its window closed *that* one, and the real move
 * that followed kept its `actualMs` and lost its `telemetry` — invisible to everything `report.py`
 * computes.
 *
 * It is not a *global* invariant of the session: a pre-existing defect outside this lane loses the
 * record of any move whose `executed` report lands after the next position arrived, because
 * `recordMove` aims `markActual`/`attachTelemetry` at `snapshot.ply`, which is the new position's by
 * then (review Minor N4). These cases assert it over runs that do not contain that ordering.
 */
function playedRowsWithoutTelemetry(): TimingLogEntry[] {
	return h.timingLog.entries().filter((e) => e.actualMs !== null && e.telemetry === undefined);
}

/**
 * Run the project's own §13.2 model (`assertHumanShapedAc`) over every row that carries a blob,
 * which is what no test in the repository did before this one — and is what would have caught the
 * premove's stolen window (`TotalFocusTime 0` against a `MoveHoldTime` of hundreds of ms).
 *
 * Only called on runs with no blur and no *dropped* premove. A blur is the owner's own action and
 * legitimately puts `BlurCount`/`TotalBlurTime` into the row it lands in, and a dropped premove
 * legitimately charges its press to the next move — over a two-row population that reads as a
 * 100 % preview rate, which the model's sample-size-free `hardMax` rejects. Both are asserted
 * field by field in their own cases instead.
 */
function rowsWithBlobs(only?: (e: TimingLogEntry) => boolean): {
	acs: AcBlob[];
	moves: AcMoveMeta[];
} {
	const acs: AcBlob[] = [];
	const moves: AcMoveMeta[] = [];
	for (const e of h.timingLog.entries()) {
		const t = e.telemetry;
		if (!t || (only !== undefined && !only(e))) continue;
		acs.push(t.ac);
		const meta: AcMoveMeta = { mode: e.mode, thinkMs: e.actualMs ?? e.plannedMs, clockMs: e.clockMs };
		if (t.nReasonable !== undefined) meta.nReasonable = t.nReasonable;
		// The row states whose window it was; the model is never told to infer it from the mode.
		if (t.ownerOwnsWindow === true) meta.ownerOwnsWindow = true;
		moves.push(meta);
	}
	return { acs, moves };
}

function assertRowsHumanShaped(): void {
	const { acs, moves } = rowsWithBlobs();
	expect(acs.length).toBeGreaterThan(0);
	assertHumanShapedAc(acs, { moves });
}

/**
 * Every **queued-premove** row against the per-move half of the §13.2 model — well-formedness and
 * conduct, with **no statistical band** (owner's ruling, Fix round 2). A premove press is a committed
 * move attempt, not a §9.3a preview touch, so pooling it into the preview-rate band would corrupt
 * the one population another lane has just measured. What such a row can be held to — and what
 * Critical 1 needed and did not have — is that it describes a real window.
 *
 * The rows are selected by "played and carrying no §13.6 quality pair", **not** by `mode`: the timing
 * model plans plenty of *searched* moves in `premove` mode, and those rows are ordinary own-turn rows
 * that must keep every strict rule. Only a premove is unscored.
 */
function assertQueuedPremoveRows(): void {
	const isQueued = (e: TimingLogEntry): boolean =>
		e.actualMs !== null && e.telemetry?.top1 === undefined;
	const rows = h.timingLog.entries().filter(isQueued);
	const { acs, moves } = rowsWithBlobs(isQueued);
	expect(acs.length).toBeGreaterThan(0);
	assertWellFormedAc(acs, { moves });
	for (const e of rows) {
		// The owner's first ruling, enforced: a premove press is a committed move attempt, not a
		// §9.3a preview touch, and `multiSelectEligible` is the *only* thing keeping it out of the
		// preview-rate band — `report.py` takes that band's denominator from this field, and the band
		// was measured at 6–8 % over a population with no premove presses in it.
		expect(e.telemetry?.multiSelectEligible).toBe(false);
		// …and the row says whose window it was, rather than leaving the model to guess from the mode.
		expect(e.telemetry?.ownerOwnsWindow).toBe(true);
	}
}

interface Armed {
	/** Index into the CDP command log, taken when the opponent-turn position was published. */
	mark: number;
	/** Index into `h.toasts` at the same moment (our own move's "Played …" is already in it). */
	toastMark: number;
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
	/**
	 * Stop the moment the *site* holds the premove, while the hand is still winding down and the
	 * executor has not reported. This is the ordering `reconcilePremove` defers for, and it is the
	 * common one at bullet.
	 */
	stopAtRelease?: boolean;
	/** Stop between the press and the release — the gesture is half-made. */
	stopAtPress?: boolean;
	/**
	 * Stop while the hand still holds the piece and the pointer is already over the destination. A
	 * cancel here releases *there* (`HandController.recover` releases at the current position), so
	 * the site receives the gesture from a drag the executor reports as `aborted`.
	 */
	stopOverDestination?: boolean;
	/**
	 * Runs after our own move has been played and **before** the opponent-turn position is
	 * published — the only place from which a stop can reach the session before a premove is armed
	 * for that turn.
	 */
	afterOurMove?: () => Promise<void>;
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
	await o.afterOurMove?.();
	// The opponent is to move: this is the window a premove is entered in.
	await h.arrive();
	const mark = h.sim.debugger.commandsFor("Input.dispatchMouseEvent").length;
	const toastMark = h.toasts.length;
	if (o.stopAtPending === true) {
		// The drag is scheduled for its human moment but has not gone out yet. §7.4's draw decides
		// whether there is one at all, so the caller tries the next seed when there is not.
		const pending = await h.until(() => h.executor()?.pendingMove() !== null, OPPONENT_THINK_MS);
		if (pending) expect(pressCount(mark)).toBe(0);
		return { mark, toastMark, scenario, pending };
	}
	if (o.stopOverDestination === true) {
		const held = await h.until(
			() => {
				const input = dispatched(mark);
				return (
					input.some((d) => d.type === "mousePressed") &&
					!input.some((d) => d.type === "mouseReleased") &&
					input.at(-1)?.square === scenario.to
				);
			},
			OPPONENT_THINK_MS,
			1
		);
		return { mark, toastMark, scenario, pending: held };
	}
	if (o.stopAtPress === true) {
		const pressed = await h.until(
			() => pressCount(mark) > 0 && !dispatched(mark).some((d) => d.type === "mouseReleased"),
			OPPONENT_THINK_MS,
			1
		);
		return { mark, toastMark, scenario, pending: pressed };
	}
	if (o.stopAtRelease === true) {
		// The release has gone out (the site has the gesture) but the hand is still in its post-drop
		// rest, so the executor has not reported yet.
		const released = await h.until(() => h.site.premoveQueued() !== null, OPPONENT_THINK_MS, 1);
		return { mark, toastMark, scenario, pending: released };
	}
	// The ponder, the §7.4 gate searches and the premove's own drag all run here; the drag is
	// finished once the hand has released, which is when the site has been handed the move.
	if (await h.until(() => pressCount(mark) > 0, OPPONENT_THINK_MS))
		await h.until(() => h.executor()?.isRunning() === false, OPPONENT_THINK_MS);
	await h.advance(50); // let the executor's own report reach the session
	expect(h.site.board.chess.turn()).toBe("b"); // still the opponent's turn throughout
	return { mark, toastMark, scenario, pending: false };
}

/** `true` when this seed's draw produced a premove the site is now holding. */
function queued(): boolean {
	return h.site.premoveQueued() !== null;
}

describe("game session: a queued premove (Fix F)", () => {
	it("resumes free exploration after a queued drag without touching the queued piece again", async () => {
		let entered = false;
		for (let seed = 0; seed < SEEDS && !entered; seed++) {
			await h?.dispose();
			const { mark } = await armPremove({ seed, premoves: true });
			if (!queued()) continue;
			entered = true;
			expect(h.executor()?.isRunning()).toBe(false);
			const held = h.site.premoveQueued();
			const before = dispatched().length;
			const presses = pressCount(mark);
			expect(await h.until(() => dispatched().length > before + 20, 3000)).toBe(true);
			await h.advance(10_000);
			expect(pressCount(mark)).toBe(presses);
			expect(h.site.premoveQueued()).toEqual(held);
			expect(h.executor()?.isExploring()).toBe(true);
			expect(h.session().currentState()).toBe("live:opponent-turn");
		}
		expect(entered).toBe(true);
	});

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
			// Every played move kept the record of the window it was played in, and the whole export
			// satisfies the project's own §13.2 model.
			expect(playedRowsWithoutTelemetry()).toHaveLength(0);
			assertQueuedPremoveRows();
			assertRowsHumanShaped();
			// And every row's realised think is its *own*. `TimingModel.observe` writes `actualMs`
			// under the model's last-planned ply, so calling it for a hand-built premove plan lands
			// the drag's elapsed on the previous searched move's row (found in review).
			for (const r of h.timingLog.entries().filter((e) => e.actualMs !== null))
				expect(r.actualMs).toBe(r.telemetry?.ac.MoveHoldTime ?? r.actualMs);
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
			expect(playedRowsWithoutTelemetry()).toHaveLength(0);
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
			expect(playedRowsWithoutTelemetry()).toHaveLength(0);
			assertQueuedPremoveRows();
			assertRowsHumanShaped();
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
					san: "bxc3",
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

/**
 * The orderings where the opponent's reply lands inside the drag's own lifetime. At bullet this is
 * the common case, not a corner: the entry delay is `U(350, 1200) ms` and the drag takes a few
 * hundred more, so an opponent think of a second or two overlaps it. Every §13.2 defect this lane
 * shipped lived here.
 */
describe("game session: the opponent replies while the premove drag is still in flight (Fix F)", () => {
	it("the premove fires: its row describes the window its input was really in", async () => {
		let fired = false;
		for (let seed = 0; seed < SEEDS && !fired; seed++) {
			await h?.dispose();
			const { scenario, pending } = await armPremove({ seed, premoves: true, stopAtRelease: true });
			if (!pending) continue;
			// The site has the gesture and the hand has not reported yet: this is the ordering
			// `reconcilePremove` defers for.
			expect(h.executor()?.isRunning()).toBe(true);
			fired = true;
			await h.arrive(scenario.reply);
			expect(await h.until(() => unscoredRows().length === 1, 10_000)).toBe(true);
			expect(h.site.board.lastMove()?.uci).toBe(scenario.premove);
			const row = unscoredRows()[0];
			expect(row?.mode).toBe("premove");
			expect(row?.ply).toBe(PREMOVE_PLY);
			// The premove's window is a fork of the opponent-turn window, so it contains the drag.
			// Sharing the session's single window meant this row got `TotalFocusTime 0` against a
			// `MoveHoldTime` of hundreds of ms — which `assertHumanShapedAc` rejects outright.
			const ac = row?.telemetry?.ac;
			expect(ac?.MoveHoldTime).toBeGreaterThan(0);
			expect(ac?.TotalFocusTime).toBeGreaterThanOrEqual(ac?.MoveHoldTime ?? 0);
			expect(playedRowsWithoutTelemetry()).toHaveLength(0);
			// The per-move half of the model, over the premove row itself: this is the guard Critical 1
			// needed, and it costs no band (Fix round 2).
			assertQueuedPremoveRows();
			assertRowsHumanShaped();
		}
		expect(fired).toBe(true);
	}, 180_000);

	it("the premove does not fire: the real move that follows keeps its own §13.2 record", async () => {
		let reached = false;
		for (let seed = 0; seed < SEEDS && !reached; seed++) {
			await h?.dispose();
			const { pending } = await armPremove({ seed, premoves: true, stopAtRelease: true });
			if (!pending) continue;
			reached = true;
			expect(h.executor()?.isRunning()).toBe(true);
			await h.arrive(DROPPING_REPLY);
			// Our own move for this position is searched, planned and played as normal …
			expect(await h.until(() => playedRows().length === 2, 60_000)).toBe(true);
			// … and it still carries the record of its own window. A premove report that closed the
			// session's window took this record with it, leaving a played row with `actualMs` and no
			// `telemetry` — a real move missing from everything `report.py` computes.
			expect(playedRowsWithoutTelemetry()).toHaveLength(0);
			expect(unscoredRows()).toHaveLength(0);
		}
		expect(reached).toBe(true);
	}, 180_000);

	it("a fired premove leaves the history a second premove can be armed from", async () => {
		const after = (...moves: string[]): string =>
			applyMoves(TWO_CYCLES.fen, moves) as unknown as string;
		let reached = false;
		for (let seed = 0; seed < SEEDS && !reached; seed++) {
			await h?.dispose();
			const { mark } = await armPremove({
				seed,
				premoves: true,
				scenario: {
					fen: TWO_CYCLES.fen,
					move: TWO_CYCLES.first.move,
					reply: TWO_CYCLES.first.reply,
					premove: TWO_CYCLES.first.premove,
					san: "bxc3",
					from: "b2",
					to: "c3",
				},
			});
			if (pressCount(mark) === 0 || !queued()) continue;
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
			// Two plies land in one position, so the history has to be written by hand: without it
			// `priorFen` still points two plies back and the move list never saw either ply, and the
			// *next* premove cannot be replayed from our own move at all.
			await h.arrive(TWO_CYCLES.first.reply);
			expect(h.site.board.lastMove()?.uci).toBe(TWO_CYCLES.first.premove);
			reached = true;
			// The position the premove landed in is the opponent's turn again, so the second cycle arms
			// and sends from it with no further position needed.
			const mark2 = h.sim.debugger.commandsFor("Input.dispatchMouseEvent").length;
			expect(await h.until(() => pressCount(mark2) > 0, PAST_THE_DELAY_MS)).toBe(true);
			expect(await h.until(() => h.executor()?.isRunning() === false, OPPONENT_THINK_MS)).toBe(true);
			expect(h.site.premoveQueued()).toEqual({ from: "g2", to: "f3" });
		}
		expect(reached).toBe(true);
	}, 180_000);

	it("a drag that never finished teaches nothing about the site: the next turn still tries", async () => {
		const after = (...moves: string[]): string =>
			applyMoves(TWO_CYCLES.fen, moves) as unknown as string;
		let reached = false;
		for (let seed = 0; seed < SEEDS && !reached; seed++) {
			await h?.dispose();
			// `premoves: false` keeps the site out of it, so the only thing under test is what the
			// session concludes from an *interrupted* gesture.
			const { pending } = await armPremove({
				seed,
				premoves: false,
				stopAtPress: true,
				scenario: {
					fen: TWO_CYCLES.fen,
					move: TWO_CYCLES.first.move,
					reply: TWO_CYCLES.first.reply,
					premove: TWO_CYCLES.first.premove,
					san: "bxc3",
					from: "b2",
					to: "c3",
				},
			});
			if (!pending) continue;
			// A blur aborts the drag mid-gesture (§13.4), which is the one interruption that leaves the
			// press dispatched and the board untouched — it is still the opponent's turn, so the
			// hand's recovery release cannot land anything.
			await h.drive(() => h.site.panelClick());
			expect(await h.until(() => h.executor()?.isRunning() === false, OPPONENT_THINK_MS)).toBe(true);
			expect(h.site.premoveQueued()).toBeNull();
			expect(h.site.board.lastMove()?.uci).toBe(TWO_CYCLES.first.move);
			await h.drive(() => h.site.clickIntoBoard());
			reached = true;

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
			// The predicted reply lands and the premove is nowhere — but an unfinished gesture is no
			// evidence about chess.com, so nothing may be concluded from it. Treating it as proof that
			// the site drops premoves switched the feature off for the rest of the game, on the
			// commonest path at bullet.
			await h.arrive(TWO_CYCLES.first.reply);
			expect(
				await h.until(() => h.site.board.lastMove()?.uci === TWO_CYCLES.first.premove, 30_000)
			).toBe(true);

			// Second opponent turn: the session must try again.
			await h.arrive();
			const mark2 = h.sim.debugger.commandsFor("Input.dispatchMouseEvent").length;
			expect(await h.until(() => pressCount(mark2) > 0, PAST_THE_DELAY_MS)).toBe(true);
		}
		expect(reached).toBe(true);
	}, 180_000);

	it("a half-made gesture the reply interrupts is accounted exactly once, or not at all", async () => {
		let reached = false;
		for (let seed = 0; seed < SEEDS && !reached; seed++) {
			await h?.dispose();
			const { scenario, pending } = await armPremove({ seed, premoves: true, stopAtPress: true });
			if (!pending) continue;
			reached = true;
			// Pressed, not released: the reply arrives mid-drag and `cancelInFlight` aborts it. The
			// hand's recovery release may still land the move (it is legal now) or not; either way the
			// session must account for it exactly once and never twice.
			await h.arrive(scenario.reply);
			expect(await h.until(() => h.executor()?.isRunning() === false, 10_000)).toBe(true);
			await h.advance(200);
			const landed = h.site.board.lastMove()?.uci === scenario.premove;
			// An interrupted-after-press drag is kept, not forgotten: forgetting it would lose the
			// accounting for a move our own input put on the board.
			expect(unscoredRows()).toHaveLength(landed ? 1 : 0);
			const stats = await h.sw.run(
				() => chromeLocalGet(LOCAL_KEYS.sessionStats) as Promise<SessionStats | undefined>
			);
			expect(stats?.moves).toBe(landed ? 2 : 1);
			expect(playedRowsWithoutTelemetry()).toHaveLength(0);
		}
		expect(reached).toBe(true);
	}, 180_000);
});

describe("game session: what a premove may and may not claim (Fix F)", () => {
	it("reports `dispatched`, never `executed`, and never toasts a move as played", async () => {
		let entered = false;
		for (let seed = 0; seed < SEEDS && !entered; seed++) {
			await h?.dispose();
			const { mark, toastMark, scenario } = await armPremove({ seed, premoves: true });
			if (pressCount(mark) === 0) continue;
			entered = true;
			// The hand completed the gesture; that is all that is known. Calling it `executed` would
			// fire the "Played …" toast (`panel-broadcaster.toastFor`) for a move the site may never
			// play — exactly what a premove must never be reported as. (Our own searched move's
			// "Played …" is already in the list, which is why the assertion is from the mark on.)
			const snap = await h.snapshot();
			expect(snap.session.lastExecution?.outcome).toBe("dispatched");
			// The SAN is the one from the position the premove will be played in — it is not a legal
			// move in the position it was sent from, which is the whole point of a premove.
			expect(snap.session.lastExecution?.san).toBe(scenario.san);
			expect(h.toasts.slice(toastMark)).toHaveLength(0);
			expect(h.toasts.slice(0, toastMark).map((t) => t.key)).not.toContain(TOAST_KEYS.played);
		}
		expect(entered).toBe(true);
	}, 180_000);

	it("a premove reason that an unexpected reply leaves legal is never sent to the site", async () => {
		// The default harness position with a flat 900 cp script is the `loss2nd` fixture — a
		// clear-best *quiet* move, which stays legal after any reply and so must never be queued
		// (`PREMOVE.queueReasons`). The proof that one was nevertheless *armed* is that the reactive
		// path plays it the moment the predicted reply lands.
		let fired = false;
		for (let seed = 0; seed < SEEDS && !fired; seed++) {
			await h?.dispose();
			h = await createGameHarness({
				settings: {
					automation: { autoMove: true },
					strength: { matchOpponentRating: false, targetElo: 3000, persona: "blitz" },
				},
				timeControl: { baseMs: 180_000, incMs: 0 },
				script: { bestCp: 900, stepCp: 900 },
				gameId: `premove-loss2nd-${seed}`,
				seed: `loss2nd-${seed}`,
				premoves: true,
			});
			await h.arrive();
			expect(await h.until(() => h.session().currentState() === "live:opponent-turn", 60_000)).toBe(
				true
			);
			await h.arrive();
			const mark = h.sim.debugger.commandsFor("Input.dispatchMouseEvent").length;
			const expected = h.transport.movesFor(h.site.board.fen())[0] as string;
			// Past the whole entry-delay range: nothing is sent to the site, and the site holds nothing.
			await h.advance(PAST_THE_DELAY_MS);
			expect(pressCount(mark)).toBe(0);
			expect(h.site.premoveQueued()).toBeNull();
			await h.arrive(expected);
			const rec = h.session().recommendation();
			if (rec?.chosen.source !== "premove") continue; // this seed drew no premove at all
			fired = true;
			expect(rec.plan.mode).toBe("premove");
		}
		expect(fired).toBe(true);
	}, 180_000);

	it("an unarmed hand never sends one, even with a premove armed for that turn", async () => {
		let reached = false;
		for (let seed = 0; seed < SEEDS && !reached; seed++) {
			await h?.dispose();
			// The hand is disarmed between our own move and the opponent-turn position, so §7.4 still
			// arms a premove for that turn — `armPremove` does not look at the hand — and
			// `enterPremove` is the only thing between an unarmed session and CDP input on the board.
			const { mark, scenario } = await armPremove({
				seed,
				premoves: true,
				afterOurMove: async () => {
					await h.drive(() => void h.session().command("disarm"));
					expect(h.executor()?.isArmed()).toBe(false);
				},
			});
			await h.advance(PAST_THE_DELAY_MS);
			expect(pressCount(mark)).toBe(0);
			expect(h.site.premoveQueued()).toBeNull();
			expect(h.site.board.lastMove()?.uci).toBe(scenario.move);

			// The positive control, and the thing that makes the silence above mean something: arm the
			// hand again and the *same* arm plays the move reactively the moment the reply lands. A seed
			// that drew no premove at all cannot do that, and is skipped.
			await h.drive(() => void h.session().command("armAutoMove"));
			expect(h.executor()?.isArmed()).toBe(true);
			await h.arrive(scenario.reply);
			const rec = h.session().recommendation();
			if (rec?.chosen.source !== "premove") continue;
			reached = true;
			expect(rec.chosen.uci).toBe(scenario.premove);
		}
		expect(reached).toBe(true);
	}, 180_000);

	it("an interrupted gesture the site still received is accounted, and carries the blur", async () => {
		let reached = false;
		for (let seed = 0; seed < SEEDS && !reached; seed++) {
			await h?.dispose();
			// Stopped while the hand holds the piece over the destination. A blur there (§13.4) aborts
			// the drag and the hand's recovery releases *on that square*, so the site receives the
			// gesture from a drag the executor reports as `aborted`, not `dispatched`. Forgetting an
			// interrupted-after-press drag would lose the accounting for a move our own input landed.
			const { scenario, pending } = await armPremove({
				seed,
				premoves: true,
				stopOverDestination: true,
			});
			if (!pending) continue;
			await h.drive(() => h.site.panelClick());
			expect(await h.until(() => h.executor()?.isRunning() === false, OPPONENT_THINK_MS)).toBe(true);
			if (h.site.premoveQueued() === null) continue; // the release did not land on the square
			reached = true;
			const snap = await h.snapshot();
			expect(snap.session.lastExecution?.outcome).toBe("aborted");
			expect(snap.session.lastExecution?.pressed).toBe(true);
			await h.drive(() => h.site.clickIntoBoard());

			await h.arrive(scenario.reply);
			expect(h.site.board.lastMove()?.uci).toBe(scenario.premove);
			expect(await h.until(() => unscoredRows().length === 1, 10_000)).toBe(true);
			const row = unscoredRows()[0];
			expect(row?.mode).toBe("premove");
			expect(playedRowsWithoutTelemetry()).toHaveLength(0);
			const stats = await h.sw.run(
				() => chromeLocalGet(LOCAL_KEYS.sessionStats) as Promise<SessionStats | undefined>
			);
			expect(stats?.moves).toBe(2);
			// §13.2, honestly: the owner's own blur fell inside the window the input was in, so the
			// exported row says so — and it says so on the *opponent's* turn, because that is the
			// period our premove put a window around. It is his behaviour, not our misconduct: the
			// model's per-move rules accept the row, and the window still accounts for the hold even
			// though part of it was spent blurred.
			expect(row?.telemetry?.ac.BlurCount).toBe(1);
			expect(row?.telemetry?.ac.DidBlurOnOpponentTurn).toBe(true);
			expect(row?.telemetry?.ac.DidBlurOnOwnTurn).toBe(false);
			// `TotalBlurTime` can legitimately be 0 here: on the virtual clock the drop follows the
			// blur in the same instant, so the blurred stretch has no duration.
			expect(row?.telemetry?.ac.TotalBlurTime).toBeGreaterThanOrEqual(0);
			const ac = row?.telemetry?.ac;
			expect((ac?.TotalFocusTime ?? 0) + (ac?.TotalBlurTime ?? 0)).toBeGreaterThanOrEqual(
				ac?.MoveHoldTime ?? 0
			);
			assertQueuedPremoveRows();
		}
		expect(reached).toBe(true);
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

	it("`playNow` during the opponent's turn does not send the premove early", async () => {
		let reached = false;
		for (let seed = 0; seed < SEEDS && !reached; seed++) {
			await h?.dispose();
			const { mark, pending } = await armPremove({ seed, premoves: true, stopAtPending: true });
			if (!pending) continue;
			// The guard is only observable in the gap between "now" and the moment the premove was
			// scheduled for, so the test needs a seed whose gap is wider than the hand's own motor
			// path. Without the guard, `playNow` collapses the plan to `instantTiming` and the press
			// lands ~300 ms later; with it, nothing happens until the scheduled moment.
			const fireAt = h.executor()?.pendingMove()?.fireAt ?? 0;
			const slack = fireAt - h.sim.now();
			if (slack < MEASURABLE_SLACK_MS) continue;
			reached = true;
			await h.drive(() => void h.session().command("playNow"));
			await h.advance(slack - EARLY_PRESS_MARGIN_MS);
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
