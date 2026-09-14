// test/behavioral/game/board-effects.test.ts — the board-effect layer end to end through the real
// service-worker stack (owner's brief, 2026-09-13): every move that lands, either side's, produces
// an effect batch on the game port while `automation.boardEffects` is on, and nothing at all while
// it is off. The quality chip follows on the same command shape once the full-strength verdict
// arrives.
import { afterEach, describe, expect, it } from "bun:test";
import { applyMoves } from "@core/chess/san";
import { BOARD_EFFECT_LIMITS } from "@core/constants/board-effects";
import type { GamePortCommand } from "@core/constants/messages";
import { MOVE_QUALITY, MOVE_QUALITY_ORDER } from "@core/constants/move-quality";
import {
	__setLogSinkOutsideServiceWorker,
	clearLogSink,
	getLogLevel,
	type LogEntry,
	setLogLevel,
	setLogSink,
} from "@core/logger";
import { type BoardEffectsReporter, landedPlies } from "@service/game-session/board-effects";
import type { Square } from "@typedefs/game";
import { createGameHarness, type GameHarness } from "./harness";
import { positionKey } from "./scripted-engine";

/** The reporter's own counters, reached through the session for the tests. */
const verdictStats = (): ReturnType<BoardEffectsReporter["stats"]> =>
	(h.session() as unknown as { boardEffects: BoardEffectsReporter }).boardEffects.stats();
const droppedTotal = (): number =>
	Object.values(verdictStats().dropped).reduce((sum, n) => sum + n, 0);

/**
 * A target above `LIMITS.engineEloMax`: the own-move search then carries no `elo` (full
 * strength), which is the precondition for classifying our move from its own referee lines.
 */
const FULL_STRENGTH_TARGET = 3_400;

let h: GameHarness;
afterEach(async () => {
	await h?.dispose();
});

type EffectsCommand = Extract<GamePortCommand, { kind: "effects" }>;
type SettingsCommand = Extract<GamePortCommand, { kind: "settings" }>;

const batches = (): EffectsCommand[] =>
	h.commands().filter((c): c is EffectsCommand => c.kind === "effects");
const clears = (): number => h.commands().filter((c) => c.kind === "clearEffects").length;
const gates = (): SettingsCommand[] =>
	h.commands().filter((c): c is SettingsCommand => c.kind === "settings");

/** White rook on f1, both kings: white's Rf8 is check, and black is to move afterwards. */
const CHECK_FEN = "4k3/8/8/8/8/8/8/4KR2 w - - 0 1";

/** The classifier's own searches on the wire: full strength at its fixed movetime. */
const verdictSearches = (): number =>
	h.transport.goLines.filter((line) => line.includes(`movetime ${MOVE_QUALITY.movetimeMs}`)).length;

describe("game session: board effects", () => {
	it("sends what the opponent's move did, and the verdict when it arrives", async () => {
		h = await createGameHarness({
			myColor: "b",
			fen: CHECK_FEN,
			settings: { automation: { autoMove: false, boardEffects: true } },
		});
		// The first position of the game has no move behind it: nothing to report.
		await h.arrive();
		expect(batches()).toEqual([]);

		// White plays Rf1–f8+, which is a check from the destination onto our king.
		await h.arrive("f1f8");
		expect(await h.until(() => batches().length > 0, 10_000)).toBe(true);
		const first = batches()[0];
		expect(first?.mine).toBe(false);
		expect(first?.effects).toEqual([{ kind: "check", from: "f8", to: "e8" }]);
		expect(first?.quality).toBeUndefined();

		// The verdict follows as a second command carrying the *same* effect list, so the page adds
		// the chip without replaying the rays.
		expect(await h.until(() => batches().some((b) => b.quality !== undefined), 20_000)).toBe(true);
		const verdict = batches().find((b) => b.quality !== undefined);
		expect(verdict?.effects).toEqual(first?.effects);
		expect(verdict?.mine).toBe(false);
		expect(verdict?.quality?.square).toBe("f8");
		expect(MOVE_QUALITY_ORDER).toContain(verdict!.quality!.quality);
	});

	it("marks our own move as ours and puts the chip on the square it landed on", async () => {
		h = await createGameHarness({
			myColor: "b",
			fen: CHECK_FEN,
			settings: { automation: { autoMove: false, boardEffects: true } },
		});
		await h.arrive();
		await h.arrive("f1f8");
		expect(await h.until(() => batches().length > 0, 10_000)).toBe(true);
		const beforeOurs = batches().length;

		// We answer the check by taking the rook with the king.
		await h.drive(() => {
			h.site.board.submit("e8", "f8");
		});
		await h.arrive();
		expect(await h.until(() => batches().length > beforeOurs, 10_000)).toBe(true);
		const ours = batches()[beforeOurs];
		expect(ours?.mine).toBe(true);
		expect(ours?.effects).toEqual([{ kind: "capture", from: "e8", to: "f8" }]);
		expect(
			await h.until(
				() =>
					batches()
						.slice(beforeOurs)
						.some((b) => b.quality !== undefined),
				20_000
			)
		).toBe(true);
		expect(batches().find((b) => b.mine && b.quality)?.quality?.square).toBe("f8");
	});

	it("classifies our planned move before it lands, so the chip ships inside the first batch", async () => {
		h = await createGameHarness({
			myColor: "b",
			fen: CHECK_FEN,
			settings: { automation: { autoMove: false, boardEffects: true } },
		});
		await h.arrive();
		await h.arrive("f1f8");
		expect(await h.until(() => batches().length > 0, 10_000)).toBe(true);
		// The recommendation for our reply becomes final while the hand would still be waiting out
		// its think time — and that is when the verdict search for it runs, on an idle engine.
		expect(await h.until(() => h.session().recommendation() !== null, 10_000)).toBe(true);
		const rec = h.session().recommendation();
		expect(rec).not.toBeNull();
		const searchesBeforeLanding = verdictSearches();
		expect(searchesBeforeLanding).toBeGreaterThan(0);
		const beforeOurs = batches().length;

		// We play exactly the planned move: the first batch already carries its verdict, on the
		// square it landed on, with no new classification search.
		await h.drive(() => {
			h.site.board.submit(rec!.chosen.from, rec!.chosen.to);
		});
		await h.arrive();
		expect(await h.until(() => batches().length > beforeOurs, 10_000)).toBe(true);
		const ours = batches()[beforeOurs];
		expect(ours?.mine).toBe(true);
		expect(ours?.quality?.square).toBe(rec!.chosen.to);
		expect(MOVE_QUALITY_ORDER).toContain(ours!.quality!.quality);
		expect(verdictSearches()).toBe(searchesBeforeLanding);
		// Exactly one verdict for our move: nothing follows as a second command.
		await h.advance(2_000);
		expect(
			batches()
				.slice(beforeOurs)
				.filter((b) => b.quality !== undefined)
		).toHaveLength(1);
	});

	it("discards a prepared verdict when we play a different move, and classifies the one played", async () => {
		h = await createGameHarness({
			myColor: "b",
			fen: CHECK_FEN,
			settings: { automation: { autoMove: false, boardEffects: true } },
		});
		await h.arrive();
		await h.arrive("f1f8");
		expect(await h.until(() => h.session().recommendation() !== null, 10_000)).toBe(true);
		const planned = h.session().recommendation();
		expect(planned).not.toBeNull();
		// Black in check from f8 has three replies: Kd7, Ke7 and Kxf8. Play one that lands on a
		// different square from the plan, so a reused verdict would put the chip in the wrong place.
		const replies: Array<{ from: Square; to: Square }> = [
			{ from: "e8", to: "f8" },
			{ from: "e8", to: "d7" },
			{ from: "e8", to: "e7" },
		];
		const other = replies.find((m) => m.to !== planned!.chosen.to);
		expect(other).toBeDefined();
		const beforeOurs = batches().length;
		await h.drive(() => {
			h.site.board.submit(other!.from, other!.to);
		});
		await h.arrive();
		expect(await h.until(() => batches().length > beforeOurs, 10_000)).toBe(true);
		expect(
			await h.until(
				() =>
					batches()
						.slice(beforeOurs)
						.some((b) => b.quality !== undefined),
				20_000
			)
		).toBe(true);
		const verdicts = batches()
			.slice(beforeOurs)
			.filter((b) => b.quality !== undefined);
		expect(verdicts).toHaveLength(1);
		expect(verdicts[0]?.mine).toBe(true);
		expect(verdicts[0]?.quality?.square).toBe(other!.to);
		expect(verdicts[0]?.quality?.square).not.toBe(planned!.chosen.to);
	});

	it("sends nothing while the setting is off, and says so in the content gate", async () => {
		h = await createGameHarness({
			myColor: "b",
			fen: CHECK_FEN,
			settings: { automation: { autoMove: false, boardEffects: false } },
		});
		await h.arrive();
		await h.arrive("f1f8");
		// Long enough for a verdict search to have finished twice over.
		await h.advance(5_000);
		expect(batches()).toEqual([]);
		expect(gates().at(-1)?.boardEffects).toBe(false);
	});

	it("turns the layer off mid-game when the setting is turned off", async () => {
		h = await createGameHarness({
			myColor: "b",
			fen: CHECK_FEN,
			settings: { automation: { autoMove: false, boardEffects: true } },
		});
		await h.arrive();
		await h.arrive("f1f8");
		expect(await h.until(() => batches().length > 0, 10_000)).toBe(true);
		expect(gates().at(-1)?.boardEffects).toBe(true);
		const drawn = batches().length;

		await h.patch({ automation: { boardEffects: false } });
		expect(gates().at(-1)?.boardEffects).toBe(false);
		// Nothing further is drawn for the next move either.
		await h.drive(() => {
			h.site.board.submit("e8", "f8");
		});
		await h.arrive();
		await h.advance(5_000);
		expect(batches().length).toBe(drawn);
	});

	it("erases the layer when the game ends", async () => {
		h = await createGameHarness({
			myColor: "b",
			fen: CHECK_FEN,
			settings: { automation: { autoMove: false, boardEffects: true } },
		});
		await h.arrive();
		await h.arrive("f1f8");
		expect(await h.until(() => batches().length > 0, 10_000)).toBe(true);
		const before = clears();
		await h.drive(() => {
			h.site.endGame("0-1");
		});
		expect(await h.until(() => clears() > before, 5_000)).toBe(true);
	});

	it("never sends more than the batch cap", async () => {
		h = await createGameHarness({
			myColor: "b",
			// A white queen landing among three loose black rooks: several rays, one batch.
			fen: "3r2k1/8/8/8/r6r/8/8/3QK3 w - - 0 1",
			settings: { automation: { autoMove: false, boardEffects: true } },
		});
		await h.arrive();
		await h.arrive("d1d4");
		expect(await h.until(() => batches().length > 0, 10_000)).toBe(true);
		const list = batches()[0]?.effects ?? [];
		expect(list.length).toBeGreaterThan(1);
		expect(list.length).toBeLessThanOrEqual(BOARD_EFFECT_LIMITS.maxEffects);
	});

	// ── 2026-09-13, "move ratings occasionally don't ever show up" ─────────────────────────────

	it("classifies our move from the referee lines it already has: no dedicated search at full strength", async () => {
		h = await createGameHarness({
			myColor: "b",
			fen: CHECK_FEN,
			settings: {
				automation: { autoMove: false, boardEffects: true },
				strength: { matchOpponentRating: false, targetElo: FULL_STRENGTH_TARGET },
			},
		});
		// The opponent-turn ponder ranks Rf8+ first, so their move is among its lines.
		h.transport.prefer.set(positionKey(CHECK_FEN), ["f1f8"]);
		await h.arrive();
		await h.arrive("f1f8");
		expect(await h.until(() => batches().length > 0, 10_000)).toBe(true);
		// Their move: the ponder's lines of the position before it answer inside the first batch.
		expect(batches()[0]?.mine).toBe(false);
		expect(batches()[0]?.quality?.square).toBe("f8");
		expect(await h.until(() => h.session().recommendation() !== null, 10_000)).toBe(true);
		const rec = h.session().recommendation();
		expect(rec).not.toBeNull();
		// The recommendation's own lines were searched with no `elo`: nothing more to ask for.
		expect(verdictSearches()).toBe(0);
		const beforeOurs = batches().length;
		await h.drive(() => {
			h.site.board.submit(rec!.chosen.from, rec!.chosen.to);
		});
		await h.arrive();
		expect(await h.until(() => batches().length > beforeOurs, 10_000)).toBe(true);
		const ours = batches()[beforeOurs];
		expect(ours?.mine).toBe(true);
		expect(ours?.quality?.square).toBe(rec!.chosen.to);
		expect(verdictSearches()).toBe(0);
		expect(verdictStats().delivered).toBe(2);
		expect(droppedTotal()).toBe(0);
	});

	it("classifies the opponent's move from the ponder lines and our own-move search, with no dedicated search", async () => {
		h = await createGameHarness({
			myColor: "b",
			fen: CHECK_FEN,
			settings: {
				automation: { autoMove: false, boardEffects: true },
				strength: { matchOpponentRating: false, targetElo: FULL_STRENGTH_TARGET },
			},
		});
		// The ponder's three lines do not include Rf8+: their move needs a "played" score, which
		// the own-move search of the position after it (the next recommendation) provides.
		h.transport.prefer.set(positionKey(CHECK_FEN), ["f1f2", "f1f3", "f1f4"]);
		await h.arrive();
		await h.arrive("f1f8");
		expect(await h.until(() => batches().length > 0, 10_000)).toBe(true);
		expect(batches()[0]?.quality).toBeUndefined();
		expect(await h.until(() => batches().some((b) => b.quality !== undefined), 20_000)).toBe(true);
		const verdict = batches().find((b) => b.quality !== undefined);
		expect(verdict?.mine).toBe(false);
		expect(verdict?.quality?.square).toBe("f8");
		expect(verdict?.effects).toEqual(batches()[0]?.effects);
		expect(h.session().recommendation()).not.toBeNull();
		expect(verdictSearches()).toBe(0);
		expect(verdictStats().delivered).toBe(1);
	});

	it("still runs the dedicated search when the lines are unusable, and never drops a chip silently", async () => {
		const entries: LogEntry[] = [];
		const sink = (entry: LogEntry): void => {
			entries.push(entry);
		};
		const level = getLogLevel();
		setLogLevel("debug");
		__setLogSinkOutsideServiceWorker(true);
		setLogSink(sink);
		try {
			h = await createGameHarness({
				myColor: "b",
				fen: CHECK_FEN,
				// Every frame the scripted engine answers is shallower than `MOVE_QUALITY.minDepth`.
				script: { depth: MOVE_QUALITY.minDepth - 1 },
				settings: { automation: { autoMove: false, boardEffects: true } },
			});
			await h.arrive();
			await h.arrive("f1f8");
			expect(await h.until(() => batches().length > 0, 10_000)).toBe(true);
			expect(await h.until(() => h.session().recommendation() !== null, 10_000)).toBe(true);
			// The ponder's frame and the referee's are both too shallow: the dedicated full-strength
			// search is the fallback, issued once the engine is idle.
			expect(verdictSearches()).toBeGreaterThan(0);
			await h.advance(2_000);
			expect(batches().some((b) => b.quality !== undefined)).toBe(false);
			// The game ends with their verdict still open: the drop is counted with its reason and
			// logged at debug with the same reason — never silent.
			await h.drive(() => {
				h.site.endGame("0-1");
			});
			await h.advance(100);
			const stats = verdictStats();
			expect(stats.delivered).toBe(0);
			expect(stats.dropped.shallow).toBe(1);
			expect(stats.delivered + droppedTotal()).toBe(1); // one landed move, accounted for
			const dropped = entries.filter(
				(e) => e.level === "debug" && JSON.stringify(e.args).includes("no chip for the landed move")
			);
			expect(dropped).toHaveLength(1);
			expect(JSON.stringify(dropped[0]?.args)).toContain('"reason":"shallow"');
			expect(JSON.stringify(dropped[0]?.args)).toContain('"uci":"f1f8"');
		} finally {
			clearLogSink(sink);
			__setLogSinkOutsideServiceWorker(false);
			setLogLevel(level);
		}
	});

	// ── 2026-09-13, "move ratings don't show up for premoves" ──────────────────────────────────

	it("chips both plies when a queued premove fires on the opponent's reply", async () => {
		// The queued-premove scenario (`premove-queued.test.ts`): white Ke1, Nc3, b2 against Ke8,
		// Bb4. We shuffle the king, the opponent is expected to take on c3, bxc3 is the recapture
		// the session enters on the site during their turn; the site fires it the instant Bxc3
		// lands, so both plies arrive in one position.
		const scenario = {
			fen: "4k3/8/8/8/1b6/2N5/1P6/4K3 w - - 0 1",
			move: "e1f1",
			reply: "b4c3",
			premove: "b2c3",
		};
		const afterMove = applyMoves(scenario.fen, [scenario.move]) as string;
		const afterReply = applyMoves(afterMove, [scenario.reply]) as string;
		// §7.4's premove is a per-game draw: seeds are tried until one queues it.
		let fired = false;
		for (let seed = 0; seed < 12 && !fired; seed++) {
			await h?.dispose();
			h = await createGameHarness({
				settings: {
					automation: { autoMove: true, boardEffects: true },
					strength: { matchOpponentRating: false, targetElo: 3000, persona: "blitz" },
				},
				timeControl: { baseMs: 180_000, incMs: 0 },
				script: { bestCp: 900, stepCp: 900 },
				fen: scenario.fen,
				gameId: `effects-premove-${seed}`,
				seed: `effects-premove-${seed}`,
				premoves: true,
			});
			h.transport.prefer.set(positionKey(scenario.fen), [scenario.move]);
			h.transport.prefer.set(positionKey(afterMove), [scenario.reply]);
			h.transport.prefer.set(positionKey(afterReply), [scenario.premove]);
			await h.arrive();
			expect(await h.until(() => h.session().currentState() === "live:opponent-turn", 60_000)).toBe(
				true
			);
			// The opponent is to move: the window a premove is entered in.
			await h.arrive();
			if (!(await h.until(() => h.site.premoveQueued() !== null, 4_000))) continue;
			await h.until(() => h.executor()?.isRunning() === false, 4_000);
			await h.advance(50);
			fired = true;
			const before = batches().length;
			const searchesBefore = verdictSearches();
			await h.arrive(scenario.reply);
			// Two plies landed in one position: their capture first, then our recapture.
			expect(await h.until(() => batches().length >= before + 2, 10_000)).toBe(true);
			const theirs = batches()[before];
			const ours = batches()[before + 1];
			expect(theirs?.mine).toBe(false);
			expect(theirs?.effects).toContainEqual({ kind: "capture", from: "b4", to: "c3" });
			expect(ours?.mine).toBe(true);
			expect(ours?.effects).toContainEqual({ kind: "capture", from: "b2", to: "c3" });
			// Both get a chip on c3: theirs from the ponder lines of the position before it, ours
			// from the premove candidate's own search of the position it was played in (a cache
			// hit at the session's strength) — no new search for either.
			expect(
				await h.until(
					() =>
						batches()
							.slice(before)
							.some((b) => b.mine && b.quality?.square === "c3"),
					10_000
				)
			).toBe(true);
			expect(
				batches()
					.slice(before)
					.some((b) => !b.mine && b.quality?.square === "c3")
			).toBe(true);
			expect(verdictSearches()).toBe(searchesBefore);
			expect(verdictStats().delivered).toBeGreaterThanOrEqual(2);
		}
		expect(fired).toBe(true);
	}, 180_000);
});

describe("landedPlies", () => {
	const START = "4k3/8/8/8/1b6/2N5/1P6/4K3 b - - 1 1";

	it("reads one ply from the site's last-move marking", () => {
		expect(
			landedPlies(START, { from: "b4", to: "c3" }, applyMoves(START, ["b4c3"]) as string)
		).toEqual(["b4c3"]);
	});

	it("recovers the opponent's reply when our premove landed in the same position", () => {
		const both = applyMoves(START, ["b4c3", "b2c3"]) as string;
		expect(landedPlies(START, { from: "b2", to: "c3" }, both)).toEqual(["b4c3", "b2c3"]);
	});

	it("answers null when neither reading reaches the board", () => {
		expect(landedPlies(START, { from: "b2", to: "c3" }, START)).toBeNull();
		expect(landedPlies(START, { from: "h1", to: "h8" }, START)).toBeNull();
	});
});
