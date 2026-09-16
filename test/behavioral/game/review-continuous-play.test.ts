import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { CDP } from "@core/constants/cdp";
import type { GamePortCommand } from "@core/constants/messages";
import { MOVE_QUALITY } from "@core/constants/move-quality";
import { REVIEW } from "@core/constants/review";
import * as moveQuality from "@core/engine/move-quality";
import { CdpInputBackend } from "@service/move-executor/cdp-input-backend";
import type { Square } from "@typedefs/game";
import { createGameHarness, type GameHarness } from "./harness";

const REVIEW_LATENCY_MS = 500;
const OPPONENT_REPLY_MS = 200;
const FEEDBACK_BUDGET_MS = 2_500;
const OWN_TURN_SECONDS = 8;
const ROUNDS = 4;

type Effects = Extract<GamePortCommand, { kind: "effects" }>;
interface RatedMove {
	command: Effects;
	at: number;
}
interface LandedMove {
	mine: boolean;
	to: Square;
	ply: number;
	at: number;
}
interface ReviewSearch {
	position: string;
	startedAt: number;
	completedAt: number | null;
	cancelled: boolean;
}

let h: GameHarness;
const restores: Array<() => void> = [];
const timers = new Set<ReturnType<typeof setTimeout>>();
afterEach(async () => {
	for (const timer of timers) clearTimeout(timer);
	timers.clear();
	for (const restore of restores.splice(0).reverse()) restore();
	await h?.dispose();
});

/** Real review queue/UCI client, with only the independent backend's response latency simulated. */
function boundReviewLatency(latencyMs = REVIEW_LATENCY_MS): ReviewSearch[] {
	const wire = h.reviewTransport;
	wire.hold = true;
	const send = wire.send.bind(wire);
	const searches: ReviewSearch[] = [];
	let active: ReviewSearch | null = null;
	const delayed = spyOn(wire, "send").mockImplementation((line) => {
		if (line === "stop" && active) {
			active.cancelled = true;
			active = null;
			wire.sent.push(line);
			// The scripted transport normally fabricates a full-depth answer on stop. This
			// backend has not finished its first iteration yet: acknowledge without inventing
			// usable evidence before the bounded latency has elapsed.
			queueMicrotask(() => {
				const depth = wire.depth;
				wire.depth = 0;
				wire.release();
				wire.depth = depth;
			});
			return;
		}
		send(line);
		if (!line.startsWith("go ")) return;
		const search: ReviewSearch = {
			position: wire.positions.at(-1) ?? "",
			startedAt: h.sim.now(),
			completedAt: null,
			cancelled: false,
		};
		searches.push(search);
		active = search;
		const timer = setTimeout(() => {
			timers.delete(timer);
			// A cancelled position must never release a newer search's pending answer.
			if (active !== search) return;
			active = null;
			search.completedAt = h.sim.now();
			wire.release();
		}, latencyMs);
		timers.add(timer);
	});
	restores.push(() => delayed.mockRestore());
	return searches;
}

async function startFixture(
	autoMove = true,
	holdSearch = false,
	ownTurnSeconds = OWN_TURN_SECONDS,
	reviewLatencyMs = REVIEW_LATENCY_MS
) {
	const ratings: RatedMove[] = [];
	const landed: LandedMove[] = [];
	h = await createGameHarness({
		manualStart: true,
		seed: "continuous-review",
		gameId: "continuous-review",
		timeControl: { baseMs: 600_000, incMs: 0 },
		settings: {
			automation: { autoMove, boardEffects: true, moveQualityChips: true },
			execution: { previewSelectScale: 0 },
			strength: { targetElo: 3000, matchOpponentRating: false },
		},
		// Deliberately different engines: playing frames are shallow and cannot grade moves.
		script: { depth: 14, bestCp: 200, stepCp: 25 },
		reviewScript: { depth: REVIEW.targetDepth, bestCp: 0, stepCp: 0 },
		head: {
			id: "chessmimic",
			median: () => ownTurnSeconds,
			mean: () => ownTurnSeconds,
			sample: () => ({
				tSec: ownTurnSeconds,
				mode: "normal",
				includesExecution: true,
				why: [],
			}),
		},
		onCommand: (command) => {
			if (command.kind === "effects" && command.quality) ratings.push({ command, at: h.sim.now() });
		},
	});
	const searches = boundReviewLatency(reviewLatencyMs);
	h.transport.hold = holdSearch;
	h.site.board.onChange((move) => {
		landed.push({ mine: move.byMe, to: move.to, ply: move.ply, at: h.sim.now() });
	});
	await h.drive(() => {
		h.site.hello();
		h.site.startGame();
	});
	if (autoMove) expect(await h.until(() => h.executor()?.isArmed() === true, 1_000)).toBe(true);
	await h.arrive();
	return { ratings, landed, searches };
}

describe("review feedback during continuous automatic play", () => {
	it("rates recent landed moves inside long active think windows instead of flushing them after disarm", async () => {
		const { ratings, landed, searches } = await startFixture();
		const windows: Array<{ ply: number; recentRatings: number; allRatings: number }> = [];
		for (let round = 0; round < ROUNDS; round++) {
			const ownPly = round * 2 + 1;
			expect(await h.until(() => h.site.board.ply() === ownPly, 20_000)).toBe(true);
			await h.arrive();
			await h.advance(OPPONENT_REPLY_MS);
			// Prefer a fresh destination so a later piece does not legitimately replace an older chip.
			const occupiedDestinations = new Set<string>(landed.map((move) => move.to));
			const reply = h.site.board
				.legalMoves()
				.find((uci) => !occupiedDestinations.has(uci.slice(2, 4)));
			if (!reply) throw new Error("fixture ran out of distinct opponent destinations");
			await h.arrive(reply);
			const ply = ownPly + 1;
			expect(
				await h.until(() => h.session().recommendation()?.fen === h.site.board.fen(), 1_000)
			).toBe(true);
			const rec = h.session().recommendation();
			const originalDeadline = rec?.plan.deadlineMs;
			expect((rec?.plan.deadlineMs ?? 0) - h.sim.now()).toBeGreaterThan(FEEDBACK_BUDGET_MS);
			// Ordinary clock-only arrivals must not keep resetting the review opportunity.
			for (let tick = 0; tick < 10; tick++) {
				await h.advance(FEEDBACK_BUDGET_MS / 10);
				await h.arrive(null, { w: 590_000 - round * 10_000 - tick * 250, b: 590_000 });
				expect(h.session().recommendation()?.plan.deadlineMs).toBe(originalDeadline);
			}
			expect(h.site.board.ply()).toBe(ply);
			expect(h.executor()?.isArmed()).toBe(true);
			const recent = landed.filter((move) => move.ply === ownPly || move.ply === ply);
			windows.push({
				ply,
				recentRatings: recent.filter((move) =>
					ratings.some(
						(rating) =>
							rating.command.mine === move.mine &&
							rating.command.quality?.square === move.to &&
							rating.at >= move.at
					)
				).length,
				allRatings: ratings.length,
			});
		}
		const beforeIdle = ratings.length;
		// Diagnostic control: the very same review engine can finish the evidence once play stops.
		await h.patch({ automation: { autoMove: false } });
		await h.advance(10_000);
		expect(ratings.length).toBeGreaterThan(0);
		for (const rating of ratings) {
			expect(
				landed.some(
					(move) =>
						move.mine === rating.command.mine &&
						move.to === rating.command.quality?.square &&
						move.at <= rating.at
				)
			).toBe(true);
		}
		expect(
			searches
				.filter((search) => search.completedAt !== null)
				.every(
					(search) =>
						search.position.startsWith("position fen ") &&
						(search.completedAt ?? 0) - search.startedAt === REVIEW_LATENCY_MS
				)
		).toBe(true);
		expect(h.reviewTransport.sent.some((line) => line.includes("UCI_Elo"))).toBe(false);
		expect(h.reviewTransport.sent.some((line) => line.includes("UCI_LimitStrength value true"))).toBe(
			false
		);
		// Keep the idle-flush count in the failure: it distinguishes starvation from missing evidence.
		expect({ windows, beforeIdle, afterIdle: ratings.length }).toMatchObject({
			windows: windows.map((window) => ({ ply: window.ply, recentRatings: 2 })),
			beforeIdle: landed.length,
		});
	});

	it("caches bounded review results during a pressed gesture and defers new classification until input ends", async () => {
		const { searches } = await startFixture(true, false, 1, 2_000);
		let pressedAt: number | null = null;
		let critical = false;
		const criticalWindows: Array<{ from: number; to: number | null }> = [];
		const classifications: Array<{ at: number; fen: string; depth: number }> = [];
		const classify = moveQuality.classifyMoveQuality;
		const classified = spyOn(moveQuality, "classifyMoveQuality").mockImplementation((input) => {
			classifications.push({ at: h.sim.now(), fen: input.fen, depth: input.before.depth });
			return classify(input);
		});
		// Real CDP input reaches the simulated board. Only its acknowledgment is delayed,
		// leaving the button down while a non-immediate independent engine result arrives.
		const press = CdpInputBackend.prototype.press;
		const delayedPress = spyOn(CdpInputBackend.prototype, "press").mockImplementation(async function (
			this: CdpInputBackend,
			...args
		) {
			await press.apply(this, args);
			pressedAt = h.sim.now();
			await new Promise<void>((resolve) => {
				const timer = setTimeout(() => {
					timers.delete(timer);
					resolve();
				}, 2_500);
				timers.add(timer);
			});
		});
		restores.push(
			() => classified.mockRestore(),
			() => delayedPress.mockRestore()
		);
		h.executor()?.on("inputCritical", (update) => {
			if (update.busy && !critical) criticalWindows.push({ from: h.sim.now(), to: null });
			if (!update.busy && critical) {
				const window = criticalWindows.at(-1);
				if (window) window.to = h.sim.now();
			}
			critical = update.busy;
		});
		expect(await h.until(() => h.session().recommendation() !== null, 1_000)).toBe(true);
		const originalFen = h.session().recommendation()?.fen;
		const originalDeadline = h.session().recommendation()?.plan.deadlineMs;
		expect(await h.until(() => pressedAt !== null, 5_000)).toBe(true);
		expect(critical).toBe(true);
		const search = searches.find((item) => !item.cancelled && item.completedAt === null);
		expect(search).toBeDefined();
		expect(await h.until(() => search?.completedAt !== null, 2_000)).toBe(true);
		const releases = h.sim.debugger.commands.filter(
			(command) =>
				command.method === CDP.inputDispatchMouseEvent && command.params?.type === "mouseReleased"
		);
		expect(releases).toHaveLength(0);
		expect(search?.cancelled).toBe(false);
		expect((search?.completedAt ?? 0) - (search?.startedAt ?? 0)).toBe(2_000);
		expect(search?.completedAt).toBeGreaterThan(pressedAt ?? 0);
		expect(critical).toBe(true);
		expect(classifications).toHaveLength(0);
		expect(h.session().recommendation()?.plan.deadlineMs).toBe(originalDeadline);
		expect(await h.until(() => !critical && classifications.length > 0, 5_000)).toBe(true);
		// The session listener precedes this observer: classification may resume synchronously
		// on the closing event, whose timestamp is the exclusive end of the protected interval.
		expect(
			classifications.every(
				(call) =>
					!criticalWindows.some((window) => call.at >= window.from && call.at < (window.to ?? Infinity))
			)
		).toBe(true);
		expect(
			classifications.some((call) => call.fen === originalFen && call.depth === REVIEW.targetDepth)
		).toBe(true);
		expect(
			searches.filter(
				(item) =>
					item.position === search?.position && item.startedAt >= (search?.completedAt ?? Infinity)
			)
		).toEqual([]);
	});

	it("resuming after six fast arrivals publishes only the newest two plies, never an old backlog", async () => {
		const { ratings, landed } = await startFixture(false, true);
		// Move preparation stays pending across own-turn snapshots. Opponent-turn gaps are
		// shorter than a review search, so none of these six moves has usable review evidence.
		for (const uci of ["e2e4", "e7e5", "g1f3", "b8c6", "f1b5", "a7a6"]) {
			await h.arrive(uci);
			await h.advance(50);
		}
		expect(landed).toHaveLength(6);
		expect(ratings).toHaveLength(0);
		h.transport.hold = false;
		await h.drive(() => h.transport.release());
		expect(await h.until(() => h.session().recommendation() !== null, 1_000)).toBe(true);
		expect(await h.until(() => ratings.length >= MOVE_QUALITY.landedWindow, 5_000)).toBe(true);
		await h.advance(5_000);
		const allowed = landed
			.slice(-MOVE_QUALITY.landedWindow)
			.map((move) => move.to)
			.sort();
		expect(ratings.map((rating) => rating.command.quality?.square).sort()).toEqual(allowed);
	});
});
