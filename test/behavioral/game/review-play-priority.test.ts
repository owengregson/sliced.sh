import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { applyMoves } from "@core/chess/san";
import { CDP } from "@core/constants/cdp";
import { MAX_STRENGTH } from "@core/constants/max-strength";
import type { AnalysisHandle, AnalysisRequest, AnalysisResult } from "@core/engine/types";
import { BoardEffectsReporter, type ReviewSearcher } from "@service/game-session/board-effects";
import type { ExecutionReport, ExecutorEvent, ExecutorEvents } from "@service/move-executor";
import { createGameHarness, type GameHarness } from "./harness";

/**
 * A deliberately passive reviewer: it records admission, but does not hide reporter bugs by
 * blocking requests itself. Searches remain pending until stopped, so no classification or
 * engine strength assumption affects these session/hand ownership regressions.
 */
class RecordingReviewer implements ReviewSearcher {
	readonly owners = new Set<string>();
	readonly leases: Array<{ owner: string; busy: boolean }> = [];
	readonly requests: Array<{ request: AnalysisRequest; owners: string[]; stopped: boolean }> = [];

	setPlayBusy(owner: string, busy: boolean): void {
		this.leases.push({ owner, busy });
		if (busy) this.owners.add(owner);
		else this.owners.delete(owner);
	}

	warm(): Promise<void> {
		return Promise.resolve();
	}

	analyse(request: AnalysisRequest): AnalysisHandle {
		const entry = { request, owners: [...this.owners], stopped: false };
		this.requests.push(entry);
		let finish!: (result: AnalysisResult) => void;
		const result = new Promise<AnalysisResult>((resolve) => {
			finish = resolve;
		});
		return {
			id: request.id,
			updates: (async function* () {})(),
			result,
			stop: async () => {
				entry.stopped = true;
				finish({
					id: request.id,
					request,
					status: "superseded",
					bestmove: null,
					final: {
						id: request.id,
						depth: 0,
						lines: [],
						nodes: 0,
						nps: 0,
						timeMs: 0,
						complete: false,
					},
				});
			},
		};
	}
}

let h: GameHarness;
const restores: Array<() => void> = [];
afterEach(async () => {
	await h?.dispose();
	for (const restore of restores.splice(0).reverse()) restore();
});

async function setup(autoMove = true, targetElo = 3000): Promise<RecordingReviewer> {
	h = await createGameHarness({
		manualStart: true,
		seed: "review-play-priority",
		gameId: "review-play-priority",
		settings: {
			automation: { autoMove, boardEffects: true, moveQualityChips: true },
			execution: { previewSelectScale: 0 },
			strength: { matchOpponentRating: false, targetElo },
		},
		head: {
			id: "chessmimic",
			median: () => 8,
			mean: () => 8,
			sample: () => ({ tSec: 8, mode: "normal", includesExecution: true, why: [] }),
		},
	});
	const reviewer = new RecordingReviewer();
	// The registry already holds this review port; inject the fake before hello creates a session.
	const admission = spyOn(h.review, "setPlayBusy").mockImplementation((owner, busy) =>
		reviewer.setPlayBusy(owner, busy)
	);
	const analyse = spyOn(h.review, "analyse").mockImplementation((request) =>
		reviewer.analyse(request)
	);
	const warm = spyOn(h.review, "warm").mockImplementation(() => reviewer.warm());
	restores.push(
		() => admission.mockRestore(),
		() => analyse.mockRestore(),
		() => warm.mockRestore()
	);
	h.transport.hold = true;
	await h.drive(() => {
		h.site.hello();
		h.site.startGame();
	});
	if (autoMove) expect(await h.until(() => h.executor()?.isArmed() === true, 2_000)).toBe(true);
	await h.arrive();
	expect(await h.until(() => h.transport.goLines.length > 0, 2_000)).toBe(true);
	expect(reviewer.owners.has(`tab:${h.tabId}`)).toBe(true);
	return reviewer;
}

async function finishSearch(): Promise<void> {
	h.transport.hold = false;
	await h.drive(() => h.transport.release());
	expect(await h.until(() => h.session().recommendation() !== null, 2_000)).toBe(true);
}

function mouseEvents(type: string): number {
	return h.sim.debugger.commands.filter(
		(command) =>
			command.method === CDP.inputDispatchMouseEvent &&
			(command.params as { type: string }).type === type
	).length;
}

describe("game session: review search yields to preparation, not thinking or input", () => {
	it("keeps review paused while max-strength deep preparation is actually searching", async () => {
		const reviewer = await setup(true, 3800);
		await h.drive(() => h.transport.release());
		expect(
			await h.until(
				() =>
					h.transport.goLines.some((line) => line.startsWith(`go depth ${MAX_STRENGTH.searchDepth} `)),
				2_000
			)
		).toBe(true);
		expect(h.session().recommendation()).not.toBeNull();
		const requestsBefore = reviewer.requests.length;
		await h.advance(500);
		expect(reviewer.owners.has(`tab:${h.tabId}`)).toBe(true);
		expect(reviewer.requests).toHaveLength(requestsBefore);
		expect(reviewer.requests.every((request) => request.stopped)).toBe(true);
	});

	it("protects foreground search, keeps review running through input, and retains the original deadline", async () => {
		const reviewer = await setup();
		let approachBusy: boolean | undefined;
		h.executor()?.on("hand", (hand) => {
			if (hand === "approaching") approachBusy = reviewer.owners.has(`tab:${h.tabId}`);
		});
		await h.advance(100);
		expect(h.session().recommendation()).toBeNull();
		expect(reviewer.requests.every((request) => request.stopped)).toBe(true);
		await finishSearch();
		const rec = h.session().recommendation();
		expect(rec).not.toBeNull();
		const originalDeadline = rec?.plan.deadlineMs;
		expect((rec?.plan.deadlineMs ?? 0) - h.sim.now()).toBeGreaterThan(1_000);
		await h.advance(500);
		expect(reviewer.owners.has(`tab:${h.tabId}`)).toBe(false);
		expect(reviewer.requests.length).toBeGreaterThan(0);
		const active = reviewer.requests.at(-1);
		expect(await h.until(() => mouseEvents("mousePressed") > 0, 20_000)).toBe(true);
		expect(approachBusy).toBe(false);
		expect(mouseEvents("mouseReleased")).toBe(0);
		expect(reviewer.owners.has(`tab:${h.tabId}`)).toBe(false);
		expect(active?.stopped).toBe(false);
		expect(h.session().recommendation()?.plan.deadlineMs).toBe(originalDeadline);
		expect(await h.until(() => h.session().currentState() === "live:opponent-turn", 20_000)).toBe(
			true
		);
		expect(h.site.board.lastMove()?.uci).toBe(rec?.chosen.uci);
		expect(mouseEvents("mouseReleased")).toBeGreaterThan(0);
		expect(reviewer.owners.has(`tab:${h.tabId}`)).toBe(false);
		expect(await h.until(() => reviewer.requests.length > 0, 2_000)).toBe(true);
		expect(reviewer.requests.every((request) => request.owners.length === 0)).toBe(true);
	});

	it("resumes on an opponent-turn position even before the old search completes", async () => {
		const reviewer = await setup();
		await h.arrive("e2e4");
		expect(h.session().currentState()).toBe("live:opponent-turn");
		expect(reviewer.owners.has(`tab:${h.tabId}`)).toBe(false);
		expect(await h.until(() => reviewer.requests.length > 0, 2_000)).toBe(true);
		expect(reviewer.requests.every((request) => request.owners.length === 0)).toBe(true);
	});

	it("resumes review when a recommendation needs manual execution", async () => {
		const reviewer = await setup(false);
		expect(reviewer.requests.every((request) => request.stopped)).toBe(true);
		await finishSearch();
		expect(reviewer.owners.has(`tab:${h.tabId}`)).toBe(false);
		expect(await h.until(() => reviewer.requests.length > 0, 2_000)).toBe(true);
	});

	it("stops an active opponent-turn review when the next own-turn search starts", async () => {
		const reviewer = await setup();
		await h.arrive("e2e4");
		expect(await h.until(() => reviewer.requests.length > 0, 2_000)).toBe(true);
		const active = reviewer.requests.at(-1);
		expect(active?.stopped).toBe(false);
		const requestsBefore = reviewer.requests.length;
		const searchesBefore = h.transport.goLines.length;
		await h.arrive("e7e5");
		expect(await h.until(() => h.transport.goLines.length > searchesBefore, 2_000)).toBe(true);
		expect(h.session().recommendation()).toBeNull();
		expect(reviewer.owners.has(`tab:${h.tabId}`)).toBe(true);
		expect(active?.stopped).toBe(true);
		await h.advance(100);
		expect(reviewer.requests).toHaveLength(requestsBefore);
	});

	it("releases the tab lease when the game ends during an unfinished search", async () => {
		const reviewer = await setup();
		await h.drive(() => h.site.endGame("0-1"));
		expect(reviewer.owners.has(`tab:${h.tabId}`)).toBe(false);
		expect(reviewer.leases.at(-1)).toEqual({ owner: `tab:${h.tabId}`, busy: false });
	});

	it("disarming a pressed move clears its input guard without releasing another tab's search lease", async () => {
		const reviewer = await setup();
		const input = spyOn(BoardEffectsReporter.prototype, "setInputBusy");
		restores.push(() => input.mockRestore());
		await finishSearch();
		expect(await h.until(() => mouseEvents("mousePressed") > 0, 20_000)).toBe(true);
		expect(reviewer.owners.has(`tab:${h.tabId}`)).toBe(false);
		expect(input.mock.calls.at(-1)).toEqual([true]);
		reviewer.setPlayBusy("tab:another-game", true);
		await h.patch({ automation: { autoMove: false } });
		expect(await h.until(() => input.mock.calls.at(-1)?.[0] === false, 5_000)).toBe(true);
		expect(reviewer.owners).toEqual(new Set(["tab:another-game"]));
		expect(h.executor()?.isArmed()).toBe(false);
	});

	it("disposing during search clears only this tab's lease", async () => {
		const reviewer = await setup();
		reviewer.setPlayBusy("tab:another-game", true);
		await h.drive(() => h.session().dispose());
		expect(reviewer.owners).toEqual(new Set(["tab:another-game"]));
		expect(reviewer.leases.at(-1)).toEqual({ owner: `tab:${h.tabId}`, busy: false });
	});

	it("a canceled old hand's delayed receipt cannot release the newer position's lease", async () => {
		const reviewer = await setup();
		await finishSearch();
		expect(await h.until(() => mouseEvents("mousePressed") > 0, 20_000)).toBe(true);
		const oldRec = h.executor()?.runningMove()?.rec;
		if (!oldRec) throw new Error("expected a running move");
		type EventPort = { emit(event: ExecutorEvent, payload: ExecutorEvents[ExecutorEvent]): void };
		const emitter = h.executor() as unknown as EventPort;
		const emit = emitter.emit.bind(emitter);
		let delayed: { event: ExecutorEvent; report: ExecutionReport } | null = null;
		const hold = spyOn(emitter, "emit").mockImplementation((event, payload) => {
			if (
				["aborted", "skipped", "failed", "executed"].includes(event) &&
				(payload as ExecutionReport).rec === oldRec
			) {
				delayed = { event, report: payload as ExecutionReport };
				return;
			}
			emit(event, payload);
		});
		restores.push(() => hold.mockRestore());
		const afterOurs = applyMoves(oldRec.fen, [oldRec.chosen.uci]);
		if (!afterOurs) throw new Error("expected a legal move");
		const reply = h.transport.movesFor(afterOurs)[0];
		if (!reply) throw new Error("expected an opponent reply");
		const nextFen = applyMoves(afterOurs, [reply]);
		if (!nextFen) throw new Error("expected a legal reply");
		const searchesBefore = h.transport.goLines.length;
		const reviewsBefore = reviewer.requests.length;
		h.transport.hold = true;
		await h.drive(() => {
			// The board and its position feed agree; a stale simulated board would independently
			// reject the *new* hand and correctly release that lease before our assertion.
			h.site.board.chess.load(nextFen);
			h.site.post({
				kind: "position",
				snapshot: {
					site: "chesscom",
					gameId: h.site.gameId,
					fen: nextFen,
					ply: 2,
					sideToMove: "w",
					myColor: "w",
					clocks: { w: { ms: 280_000, running: true }, b: { ms: 290_000, running: false } },
					timeControl: { baseMs: 300_000, incMs: 2_000 },
					capturedAt: h.sim.now(),
				},
			});
		});
		expect(await h.until(() => h.transport.goLines.length > searchesBefore, 2_000)).toBe(true);
		expect(await h.until(() => delayed !== null, 2_000)).toBe(true);
		const receipt = delayed as { event: ExecutorEvent; report: ExecutionReport } | null;
		if (!receipt) throw new Error("expected a delayed terminal receipt");
		expect(receipt.event).toBe("aborted");
		expect(h.session().recommendation()).toBeNull();
		expect(reviewer.owners.has(`tab:${h.tabId}`)).toBe(true);
		const leasesBefore = reviewer.leases.length;
		await h.drive(() => emit(receipt.event, receipt.report));
		expect(reviewer.owners.has(`tab:${h.tabId}`)).toBe(true);
		expect(reviewer.leases).toHaveLength(leasesBefore);
		expect(reviewer.requests).toHaveLength(reviewsBefore);
	});
});
