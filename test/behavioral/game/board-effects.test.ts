// test/behavioral/game/board-effects.test.ts — the board-effect layer end to end through the real
// service-worker stack (owner's briefs, 2026-09-13 / 2026-09-14): every move that lands, either
// side's, produces an effect batch on the game port while `automation.boardEffects` is on, and
// nothing at all while it is off. The rating chip rides on the same command shape; it comes only
// from the move-review engine (`h.reviewTransport`), never from the playing engine.
//
// 2026-09-15: the rays (`automation.boardEffects`) and the chip (`automation.moveQualityChips`) are
// independent switches, so every test states both — the harness fixture has both off.
import { afterEach, describe, expect, it } from "bun:test";
import { applyMoves } from "@core/chess/san";
import { BOARD_EFFECT_LIMITS } from "@core/constants/board-effects";
import type { GamePortCommand } from "@core/constants/messages";
import { MOVE_QUALITY, MOVE_QUALITY_ORDER } from "@core/constants/move-quality";
import { MOVE_CLASSIFICATION, REVIEW } from "@core/constants/review";
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
import { clocksOf, createGameHarness, type GameHarness } from "./harness";
import { positionKey } from "./scripted-engine";

/** The reporter's own counters, reached through the session for the tests. */
const verdictStats = (): ReturnType<BoardEffectsReporter["stats"]> =>
	(h.session() as unknown as { boardEffects: BoardEffectsReporter }).boardEffects.stats();
const droppedTotal = (): number =>
	Object.values(verdictStats().dropped).reduce((sum, n) => sum + n, 0);

let h: GameHarness;
afterEach(async () => {
	await h?.dispose();
});

type EffectsCommand = Extract<GamePortCommand, { kind: "effects" }>;
type SettingsCommand = Extract<GamePortCommand, { kind: "settings" }>;

const batches = (): EffectsCommand[] =>
	h.commands().filter((c): c is EffectsCommand => c.kind === "effects");
const clears = (): number => h.commands().filter((c) => c.kind === "clearEffects").length;
const mateChips = (): number => batches().filter((b) => b.quality?.quality === "mate").length;
const gates = (): SettingsCommand[] =>
	h.commands().filter((c): c is SettingsCommand => c.kind === "settings");

/** White rook on f1, both kings: white's Rf8 is check, and black is to move afterwards. */
const CHECK_FEN = "4k3/8/8/8/8/8/8/4KR2 w - - 0 1";
/** A back-rank mate in one: white's Ra8 is checkmate. */
const MATE_FEN = "6k1/5ppp/8/8/8/8/8/R5K1 w - - 0 1";

/** A review search on a wire: the review shape's depth and movetime. */
const isReviewSearch = (line: string): boolean =>
	line.includes(`depth ${REVIEW.targetDepth}`) && line.includes(`movetime ${REVIEW.movetimeMs}`);
const reviewSearches = (): number => h.reviewTransport.goLines.filter(isReviewSearch).length;

describe("game session: board effects", () => {
	it("gates rating audio on move ratings alone through live settings changes", async () => {
		// Owner, 2026-09-15: board effects used to be folded into this gate, so the `boardEffects:
		// false` step below asserted silence. It now asserts the sounds keep playing — that is the
		// dependency the owner removed.
		h = await createGameHarness({
			settings: {
				automation: {
					autoMove: false,
					boardEffects: true,
					moveQualityChips: true,
					moveRatingSounds: true,
				},
			},
		});
		await h.arrive();
		expect(gates().at(-1)?.moveRatingSounds).toBe(true);
		await h.patch({ automation: { moveQualityChips: false } });
		expect(gates().at(-1)?.moveRatingSounds).toBe(false);
		await h.patch({ automation: { moveQualityChips: true } });
		expect(gates().at(-1)?.moveRatingSounds).toBe(true);
		await h.patch({ automation: { boardEffects: false } });
		expect(gates().at(-1)?.moveRatingSounds).toBe(true);
		expect(gates().at(-1)?.moveRatings).toBe(true);
		expect(gates().at(-1)?.boardEffects).toBe(false);
		await h.patch({ automation: { boardEffects: true }, enabled: false });
		expect(gates().at(-1)?.moveRatingSounds).toBe(false);
	});

	it("boots the review engine when a game page opens, before any position arrives", async () => {
		// The owner's log (2026-09-15): the full network was first asked for at the game's first
		// position, so the first ratings also waited for it to load.
		h = await createGameHarness({
			manualStart: true,
			settings: { automation: { autoMove: false, boardEffects: true, moveQualityChips: true } },
		});
		expect(h.review.status()).toBeNull();
		await h.drive(() => {
			h.site.hello();
		});
		expect(h.review.status()).not.toBeNull();
		expect(reviewSearches()).toBe(0);
	});

	it("leaves the review engine unbooted on a game page while move ratings are off", async () => {
		// 2026-09-15: this used to pin `boardEffects: false` as what kept it unbooted. The rays cost
		// no engine time, so move ratings is what decides.
		h = await createGameHarness({
			manualStart: true,
			settings: { automation: { autoMove: false, boardEffects: true, moveQualityChips: false } },
		});
		await h.drive(() => {
			h.site.hello();
		});
		expect(h.review.status()).toBeNull();
	});

	it("boots the review engine with board effects off and move ratings on", async () => {
		h = await createGameHarness({
			manualStart: true,
			settings: { automation: { autoMove: false, boardEffects: false, moveQualityChips: true } },
		});
		await h.drive(() => {
			h.site.hello();
		});
		expect(h.review.status()).not.toBeNull();
	});

	it("sends what the opponent's move did, and the rating with the same effect list", async () => {
		h = await createGameHarness({
			myColor: "b",
			fen: CHECK_FEN,
			settings: { automation: { autoMove: false, boardEffects: true, moveQualityChips: true } },
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

		// The rating follows independently, without rays that could be replayed on a later board.
		expect(await h.until(() => batches().some((b) => b.quality !== undefined), 20_000)).toBe(true);
		const verdict = batches().find((b) => b.quality !== undefined);
		expect(first?.quality).toBeUndefined();
		expect(verdict?.effects).toEqual([]);
		expect(verdict?.mine).toBe(false);
		expect(verdict?.quality?.square).toBe("f8");
		expect(MOVE_QUALITY_ORDER).toContain(verdict?.quality?.quality ?? ("none" as never));
	});

	it("marks our own move as ours and puts the chip on the square it landed on", async () => {
		h = await createGameHarness({
			myColor: "b",
			fen: CHECK_FEN,
			settings: { automation: { autoMove: false, boardEffects: true, moveQualityChips: true } },
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

	it("reviews our planned move before it lands, then sends its cached chip separately from effects", async () => {
		h = await createGameHarness({
			myColor: "b",
			fen: CHECK_FEN,
			settings: { automation: { autoMove: false, boardEffects: true, moveQualityChips: true } },
		});
		await h.arrive();
		await h.arrive("f1f8");
		expect(await h.until(() => batches().length > 0, 10_000)).toBe(true);
		expect(await h.until(() => h.session().recommendation() !== null, 10_000)).toBe(true);
		const rec = h.session().recommendation();
		expect(rec).not.toBeNull();
		// While the hand would still be waiting out its think time, the review engine searches the
		// position the planned move will produce.
		const planned = applyMoves(h.site.board.fen(), [rec?.chosen.uci ?? ""]);
		expect(planned).not.toBeNull();
		expect(
			await h.until(
				() => h.reviewTransport.positions.some((p) => p.endsWith(` moves f1f8 ${rec?.chosen.uci}`)),
				10_000
			)
		).toBe(true);
		const beforeOurs = batches().length;

		await h.drive(() => {
			h.site.board.submit(rec?.chosen.from as Square, rec?.chosen.to as Square);
		});
		await h.arrive();
		expect(await h.until(() => batches().length > beforeOurs, 10_000)).toBe(true);
		const ours = batches()[beforeOurs];
		expect(ours?.mine).toBe(true);
		expect(ours?.quality).toBeUndefined();
		expect(batches()[beforeOurs + 1]?.quality?.square).toBe(rec?.chosen.to);
		expect(batches()[beforeOurs + 1]?.effects).toEqual([]);
		// Exactly one rating for our move; the first effects delivery did not wait for it.
		await h.advance(2_000);
		expect(
			batches()
				.slice(beforeOurs)
				.filter((b) => b.quality !== undefined)
		).toHaveLength(1);
	});

	it("discards a prepared rating when we play a different move, and rates the one played", async () => {
		h = await createGameHarness({
			myColor: "b",
			fen: CHECK_FEN,
			settings: { automation: { autoMove: false, boardEffects: true, moveQualityChips: true } },
		});
		await h.arrive();
		await h.arrive("f1f8");
		expect(await h.until(() => h.session().recommendation() !== null, 10_000)).toBe(true);
		const planned = h.session().recommendation();
		expect(planned).not.toBeNull();
		// Black in check from f8 has three replies: Kd7, Ke7 and Kxf8. Play one that lands on a
		// different square from the plan, so a reused rating would put the chip in the wrong place.
		const replies: Array<{ from: Square; to: Square }> = [
			{ from: "e8", to: "f8" },
			{ from: "e8", to: "d7" },
			{ from: "e8", to: "e7" },
		];
		const other = replies.find((m) => m.to !== planned?.chosen.to);
		expect(other).toBeDefined();
		const beforeOurs = batches().length;
		await h.drive(() => {
			h.site.board.submit(other?.from as Square, other?.to as Square);
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
		expect(verdicts[0]?.quality?.square).toBe(other?.to);
		expect(verdicts[0]?.quality?.square).not.toBe(planned?.chosen.to);
	});

	it("sends nothing while both switches are off, reviews nothing, and says so in the content gate", async () => {
		h = await createGameHarness({
			myColor: "b",
			fen: CHECK_FEN,
			settings: { automation: { autoMove: false, boardEffects: false, moveQualityChips: false } },
		});
		await h.arrive();
		await h.arrive("f1f8");
		await h.advance(5_000);
		expect(batches()).toEqual([]);
		expect(reviewSearches()).toBe(0);
		expect(gates().at(-1)?.boardEffects).toBe(false);
		expect(gates().at(-1)?.moveRatings).toBe(false);
	});

	it("turns the layer off mid-game when the setting is turned off", async () => {
		// Move ratings stated off: with it on, the chips would keep coming after the rays stop — that
		// is the point of the independence tests below.
		h = await createGameHarness({
			myColor: "b",
			fen: CHECK_FEN,
			settings: { automation: { autoMove: false, boardEffects: true, moveQualityChips: false } },
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
			settings: { automation: { autoMove: false, boardEffects: true, moveQualityChips: true } },
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

	it("lets the checkmating move's chip and sound finish before the game end erases the layer", async () => {
		// The owner (2026-09-15): the last move of a mating sequence played no sound. The page reports
		// the game over in the same instant as the mating position, and the erase that followed at once
		// cancelled the chip's sound (the content script drops a sound its generation no longer owns,
		// and the clear stops the tab's voices).
		h = await createGameHarness({
			myColor: "b",
			fen: MATE_FEN,
			settings: { automation: { autoMove: false, boardEffects: true, moveQualityChips: true } },
		});
		await h.arrive();
		const before = clears();
		await h.drive(() => {
			h.site.arrive("a1a8", clocksOf());
			h.site.endGame("1-0");
		});
		expect(await h.until(() => mateChips() > 0, 2_000)).toBe(true);
		// The chip's whole life and its clip go by with the layer untouched …
		await h.advance(MOVE_QUALITY.chipInMs + MOVE_QUALITY.chipHoldMs + MOVE_QUALITY.chipOutMs);
		expect(clears()).toBe(before);
		// … and the layer is still erased for the finished game.
		expect(await h.until(() => clears() > before, 5_000)).toBe(true);
	});

	it("still rates the checkmating move when the game end reaches the session before its position", async () => {
		h = await createGameHarness({
			myColor: "b",
			fen: MATE_FEN,
			settings: { automation: { autoMove: false, boardEffects: true, moveQualityChips: true } },
		});
		await h.arrive();
		await h.drive(() => {
			h.site.endGame("1-0");
			h.site.arrive("a1a8", clocksOf());
		});
		expect(await h.until(() => mateChips() > 0, 2_000)).toBe(true);
	});

	it("never sends more than the batch cap", async () => {
		h = await createGameHarness({
			myColor: "b",
			// A white queen landing among three loose black rooks: several rays, one batch.
			fen: "3r2k1/8/8/8/r6r/8/8/3QK3 w - - 0 1",
			settings: { automation: { autoMove: false, boardEffects: true, moveQualityChips: true } },
		});
		await h.arrive();
		await h.arrive("d1d4");
		expect(await h.until(() => batches().length > 0, 10_000)).toBe(true);
		const list = batches()[0]?.effects ?? [];
		expect(list.length).toBeGreaterThan(1);
		expect(list.length).toBeLessThanOrEqual(BOARD_EFFECT_LIMITS.maxEffects);
	});

	// ── 2026-09-14, ratings from the review engine alone ─────────────────────────────────────────

	it("rates both sides from the review engine: the playing engine never runs a rating search", async () => {
		h = await createGameHarness({
			myColor: "b",
			fen: CHECK_FEN,
			settings: { automation: { autoMove: false, boardEffects: true, moveQualityChips: true } },
		});
		await h.arrive();
		await h.arrive("f1f8");
		expect(await h.until(() => h.session().recommendation() !== null, 10_000)).toBe(true);
		const rec = h.session().recommendation();
		await h.drive(() => {
			h.site.board.submit(rec?.chosen.from as Square, rec?.chosen.to as Square);
		});
		await h.arrive();
		expect(await h.until(() => verdictStats().delivered === 2, 20_000)).toBe(true);
		expect(droppedTotal()).toBe(0);
		expect(reviewSearches()).toBeGreaterThan(0);
		expect(h.transport.goLines.filter(isReviewSearch)).toEqual([]);
		// Full strength, always: the review engine is never told to limit itself.
		expect(h.reviewTransport.sent.some((line) => line.includes("UCI_LimitStrength value true"))).toBe(
			false
		);
		expect(h.reviewTransport.sent.some((line) => line.includes("UCI_Elo"))).toBe(false);
	});

	it("reviews the opponent's likeliest reply ahead of time, then classifies outside play preparation", async () => {
		h = await createGameHarness({
			myColor: "b",
			fen: CHECK_FEN,
			settings: { automation: { autoMove: false, boardEffects: true, moveQualityChips: true } },
		});
		h.reviewTransport.prefer.set(positionKey(CHECK_FEN), ["f1f8", "f1f2", "f1f3"]);
		await h.arrive();
		// The current position is reviewed first, then the positions its top lines lead to.
		expect(
			await h.until(() => h.reviewTransport.positions.some((p) => p.endsWith(" moves f1f8")), 10_000)
		).toBe(true);
		await h.arrive("f1f8");
		expect(await h.until(() => batches().length > 0, 10_000)).toBe(true);
		expect(batches()[0]?.mine).toBe(false);
		// Ready frames still require potentially expensive sacrifice classification. Rays can
		// ship immediately; classification yields to our response search and resumes afterwards.
		expect(await h.until(() => batches().some((b) => b.quality?.square === "f8"), 10_000)).toBe(true);
		expect(verdictStats().delivered).toBe(1);
	});

	it("never drops a chip silently when the review is too shallow to grade", async () => {
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
				// Every review ends shallower than the classifier grades.
				reviewScript: { depth: MOVE_CLASSIFICATION.minDepth - 1 },
				settings: { automation: { autoMove: false, boardEffects: true, moveQualityChips: true } },
			});
			await h.arrive();
			await h.arrive("f1f8");
			expect(await h.until(() => batches().length > 0, 10_000)).toBe(true);
			expect(reviewSearches()).toBeGreaterThan(0);
			await h.advance(2_000);
			expect(batches().some((b) => b.quality !== undefined)).toBe(false);
			// The game ends with their rating still open: the drop is counted with its reason and
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
				(e) => e.level === "debug" && JSON.stringify(e.args).includes("no rating for the landed move")
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
					automation: { autoMove: true, boardEffects: true, moveQualityChips: true },
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
			await h.arrive(scenario.reply);
			// Two plies landed in one position: their capture first, then our recapture.
			expect(await h.until(() => batches().length >= before + 2, 10_000)).toBe(true);
			const theirs = batches()[before];
			const ours = batches()[before + 1];
			expect(theirs?.mine).toBe(false);
			expect(theirs?.effects).toContainEqual({ kind: "capture", from: "b4", to: "c3" });
			expect(ours?.mine).toBe(true);
			expect(ours?.effects).toContainEqual({ kind: "capture", from: "b2", to: "c3" });
			// Both get a chip on c3, even though the site played ours from a position the session
			// never saw on the board.
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
				await h.until(
					() =>
						batches()
							.slice(before)
							.some((b) => !b.mine && b.quality?.square === "c3"),
					10_000
				)
			).toBe(true);
			expect(verdictStats().delivered).toBeGreaterThanOrEqual(2);
		}
		expect(fired).toBe(true);
	}, 180_000);

	// ── 2026-09-15, "Board effects and move ratings … dont rely on eachother" ────────────────────

	it.each([
		["effects only", true, false],
		["ratings only", false, true],
		["both", true, true],
		["neither", false, false],
	] as const)(
		"%s: the rays follow board effects and the chip follows move ratings",
		async (_name, boardEffects, moveQualityChips) => {
			h = await createGameHarness({
				myColor: "b",
				fen: CHECK_FEN,
				settings: {
					automation: { autoMove: false, boardEffects, moveQualityChips, moveRatingSounds: true },
				},
			});
			await h.arrive();
			await h.arrive("f1f8");
			if (moveQualityChips)
				expect(await h.until(() => batches().some((b) => b.quality !== undefined), 20_000)).toBe(true);
			else await h.advance(5_000);
			const drawn = batches();
			if (boardEffects) expect(drawn[0]?.effects).toEqual([{ kind: "check", from: "f8", to: "e8" }]);
			else expect(drawn.every((b) => b.effects.length === 0)).toBe(true);
			if (moveQualityChips) {
				expect(drawn.find((b) => b.quality)?.quality?.square).toBe("f8");
				expect(reviewSearches()).toBeGreaterThan(0);
			} else {
				expect(drawn.some((b) => b.quality !== undefined)).toBe(false);
				expect(reviewSearches()).toBe(0);
			}
			if (!boardEffects && !moveQualityChips) expect(drawn).toEqual([]);
			// The content gate carries one flag per layer, and the rating sounds follow the chip.
			expect(gates().at(-1)?.boardEffects).toBe(boardEffects);
			expect(gates().at(-1)?.moveRatings).toBe(moveQualityChips);
			expect(gates().at(-1)?.moveRatingSounds).toBe(moveQualityChips);
		}
	);

	it("turning move ratings off mid-game keeps the rays and stops the reviews", async () => {
		h = await createGameHarness({
			myColor: "b",
			fen: CHECK_FEN,
			settings: { automation: { autoMove: false, boardEffects: true, moveQualityChips: true } },
		});
		await h.arrive();
		await h.arrive("f1f8");
		expect(await h.until(() => batches().some((b) => b.quality !== undefined), 20_000)).toBe(true);
		await h.patch({ automation: { moveQualityChips: false } });
		expect(gates().at(-1)?.moveRatings).toBe(false);
		expect(gates().at(-1)?.boardEffects).toBe(true);
		const searched = reviewSearches();
		const drawn = batches().length;
		await h.drive(() => {
			h.site.board.submit("e8", "f8");
		});
		await h.arrive();
		expect(await h.until(() => batches().length > drawn, 10_000)).toBe(true);
		await h.advance(5_000);
		// Our capture's rays went out; no chip followed it, and no further review was issued.
		expect(
			batches()
				.slice(drawn)
				.some((b) => b.effects.length > 0)
		).toBe(true);
		expect(
			batches()
				.slice(drawn)
				.some((b) => b.quality !== undefined)
		).toBe(false);
		expect(reviewSearches()).toBe(searched);
	});

	it("turning board effects off mid-game keeps the chips coming, with no rays", async () => {
		h = await createGameHarness({
			myColor: "b",
			fen: CHECK_FEN,
			settings: { automation: { autoMove: false, boardEffects: true, moveQualityChips: true } },
		});
		await h.arrive();
		await h.arrive("f1f8");
		expect(await h.until(() => batches().some((b) => b.quality !== undefined), 20_000)).toBe(true);
		await h.patch({ automation: { boardEffects: false } });
		expect(gates().at(-1)?.boardEffects).toBe(false);
		expect(gates().at(-1)?.moveRatings).toBe(true);
		const drawn = batches().length;
		await h.drive(() => {
			h.site.board.submit("e8", "f8");
		});
		await h.arrive();
		expect(
			await h.until(
				() =>
					batches()
						.slice(drawn)
						.some((b) => b.quality?.square === "f8"),
				20_000
			)
		).toBe(true);
		// Our capture would have drawn a seize mark: with the rays off every batch is chip-only.
		expect(
			batches()
				.slice(drawn)
				.every((b) => b.effects.length === 0)
		).toBe(true);
	});

	it.each([
		["ratings only", false, true],
		["effects only", true, false],
	] as const)(
		"%s: the game-end erase still waits out the last move's chip and sound",
		async (_name, boardEffects, moveQualityChips) => {
			// The 2026-09-15 delayed clear (`BOARD_EFFECT_GAME_END`) has to hold in every combination.
			h = await createGameHarness({
				myColor: "b",
				fen: MATE_FEN,
				settings: { automation: { autoMove: false, boardEffects, moveQualityChips } },
			});
			await h.arrive();
			const before = clears();
			await h.drive(() => {
				h.site.arrive("a1a8", clocksOf());
				h.site.endGame("1-0");
			});
			if (moveQualityChips) expect(await h.until(() => mateChips() > 0, 2_000)).toBe(true);
			else {
				await h.advance(500);
				expect(mateChips()).toBe(0);
			}
			await h.advance(MOVE_QUALITY.chipInMs + MOVE_QUALITY.chipHoldMs + MOVE_QUALITY.chipOutMs);
			expect(clears()).toBe(before);
			expect(await h.until(() => clears() > before, 5_000)).toBe(true);
		}
	);
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
