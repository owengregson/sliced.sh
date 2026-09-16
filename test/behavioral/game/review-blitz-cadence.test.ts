import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { CDP } from "@core/constants/cdp";
import { REVIEW } from "@core/constants/review";
import { BoardEffectsReporter } from "@service/game-session/board-effects";
import { createGameHarness, type GameHarness } from "./harness";
import { isPonderSearch } from "./scripted-engine";

let h: GameHarness;
const restores: Array<() => void> = [];
const timers = new Set<ReturnType<typeof setTimeout>>();
afterEach(async () => {
	for (const timer of timers) clearTimeout(timer);
	timers.clear();
	await h?.dispose();
	for (const restore of restores.splice(0).reverse()) restore();
});

/** Search latency is controlled; admission, classification, executor and board receipts are real. */
describe("review admission at 3+0 game cadence", () => {
	it("continues delivering ratings across 1–3 second turns with opponent exploration and no idle flush", async () => {
		const cadence = [1, 2, 3, 1, 3, 2];
		let ownSeconds = cadence[0]!;
		const rated: Array<{ at: number; mine: boolean }> = [];
		const gateEvents: Array<{ at: number; play: boolean; input: boolean; until: number | null }> = [];
		let play = false;
		let input = false;
		let until: number | null = null;
		const record = () => gateEvents.push({ at: h.sim.now(), play, input, until });
		const oldPlay = BoardEffectsReporter.prototype.setPlayBusy;
		const playSpy = spyOn(BoardEffectsReporter.prototype, "setPlayBusy").mockImplementation(function (
			this: BoardEffectsReporter,
			busy
		) {
			play = busy;
			record();
			oldPlay.call(this, busy);
		});
		const oldInput = BoardEffectsReporter.prototype.setInputBusy;
		const inputSpy = spyOn(BoardEffectsReporter.prototype, "setInputBusy").mockImplementation(
			function (this: BoardEffectsReporter, busy) {
				input = busy;
				record();
				oldInput.call(this, busy);
			}
		);
		const oldUntil = BoardEffectsReporter.prototype.setAvailableUntil;
		const untilSpy = spyOn(BoardEffectsReporter.prototype, "setAvailableUntil").mockImplementation(
			function (this: BoardEffectsReporter, at) {
				until = at;
				record();
				oldUntil.call(this, at);
			}
		);
		restores.push(
			() => playSpy.mockRestore(),
			() => inputSpy.mockRestore(),
			() => untilSpy.mockRestore()
		);
		h = await createGameHarness({
			manualStart: true,
			seed: "review-blitz-cadence",
			gameId: "review-blitz-cadence",
			timeControl: { baseMs: 180_000, incMs: 0 },
			settings: {
				automation: { autoMove: true, boardEffects: true, moveQualityChips: true },
				strength: { targetElo: 2500, matchOpponentRating: false },
			},
			script: { depth: 14, bestCp: 30, stepCp: 25 },
			reviewScript: {
				depth: REVIEW.targetDepth,
				bestCp: 0,
				stepCp: 0,
				stopWithReportedEvidence: true,
			},
			head: {
				id: "chessmimic",
				median: () => ownSeconds,
				mean: () => ownSeconds,
				sample: () => ({ tSec: ownSeconds, mode: "normal", includesExecution: true, why: [] }),
			},
			onCommand: (command) => {
				if (command.kind === "effects" && command.quality)
					rated.push({ at: h.sim.now(), mine: command.mine });
			},
		});
		const wire = h.reviewTransport;
		wire.hold = true;
		let generation = 0;
		let completed = 0;
		const send = wire.send.bind(wire);
		const latency = spyOn(wire, "send").mockImplementation((line) => {
			if (line === "stop") generation++;
			send(line);
			if (!line.startsWith("go ")) return;
			const token = ++generation;
			const timer = setTimeout(() => {
				timers.delete(timer);
				if (token !== generation) return;
				completed++;
				wire.release();
			}, 600);
			timers.add(timer);
		});
		restores.push(() => latency.mockRestore());
		// Repeated foreground preparation must suspend/resume review without leaking its owner.
		const playing = h.transport;
		playing.hold = true;
		let playGeneration = 0;
		const playSend = playing.send.bind(playing);
		const preparation = spyOn(playing, "send").mockImplementation((line) => {
			if (line === "stop") playGeneration++;
			playSend(line);
			if (!line.startsWith("go ") || isPonderSearch(line)) return;
			const token = ++playGeneration;
			const timer = setTimeout(() => {
				timers.delete(timer);
				if (token === playGeneration) playing.release();
			}, 150);
			timers.add(timer);
		});
		restores.push(() => preparation.mockRestore());
		await h.drive(() => {
			h.site.hello();
			h.site.startGame();
		});
		await h.arrive();
		expect(await h.until(() => h.executor()?.isArmed() === true, 1000)).toBe(true);
		let opponentMovements = 0;
		const progress: number[] = [];
		for (let round = 0; round < cadence.length; round++) {
			const ownPly = round * 2 + 1;
			expect(await h.until(() => h.site.board.ply() === ownPly, 12_000)).toBe(true);
			await h.arrive();
			const before = h.sim.debugger.commands.length;
			await h.advance(cadence[round]! * 1000);
			opponentMovements += h.sim.debugger.commands
				.slice(before)
				.filter(
					(command) =>
						command.method === CDP.inputDispatchMouseEvent &&
						command.params?.type === "mouseMoved" &&
						command.params?.buttons === 0
				).length;
			progress.push(rated.length);
			expect(h.executor()?.isArmed()).toBe(true);
			ownSeconds = cadence[round + 1] ?? 2;
			const reply = h.site.board.legalMoves()[0];
			if (!reply) throw new Error("cadence fixture ended unexpectedly");
			await h.arrive(reply);
		}
		const openWindows = gateEvents.filter(
			(event) => !event.play && !event.input && (event.until === null || event.until > event.at)
		);
		expect(completed).toBeGreaterThan(6);
		expect(opponentMovements).toBeGreaterThan(0);
		expect(openWindows.length).toBeGreaterThan(6);
		expect(gateEvents.filter((event) => event.play).length).toBeGreaterThan(6);
		expect(progress[1]).toBeGreaterThan(0);
		for (let round = 2; round < progress.length; round++)
			expect(progress[round]).toBeGreaterThan(progress[round - 1]!);
		expect(rated.filter((rating) => rating.mine).length).toBeGreaterThan(0);
		expect(rated.filter((rating) => !rating.mine).length).toBeGreaterThan(0);
	});
});
