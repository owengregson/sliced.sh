// test/behavioral/game/board-rating-updates.test.ts — when a landed move's rating ships
// (2026-09-14): as soon as the review engine's frames reach `REVIEW.targetDepth`, or — when the
// review is still short of it — from a `REVIEW.publishDepth` frame once `REVIEW.landedWaitMs` has
// passed. The review engine is held here and its iterations are fed by hand.
import { afterEach, describe, expect, it } from "bun:test";
import type { GamePortCommand } from "@core/constants/messages";
import { REVIEW } from "@core/constants/review";
import { UciEngine } from "@core/engine/uci-client";
import { flush } from "../../fakes/engine-transport";
import { createGameHarness, type GameHarness } from "./harness";
import { positionKey, ScriptedEngineTransport } from "./scripted-engine";

// The rook check is safe. A king on e8 could take it on f8, which is a tactical sacrifice
// candidate and must wait for the separate depth-16 Brilliant evidence gate.
const BEFORE = "k7/8/8/8/8/8/8/4KR2 w - - 0 1";
type Effects = Extract<GamePortCommand, { kind: "effects" }>;

let h: GameHarness;
afterEach(async () => {
	await h?.dispose();
});

const rated = (): Effects[] =>
	h
		.commands()
		.filter(
			(command): command is Effects => command.kind === "effects" && command.quality !== undefined
		);

/** The last `position` the review engine was given, as the moves after the root. */
const reviewedMoves = (): string =>
	/ moves (.*)$/.exec(h.reviewTransport.positions.at(-1) ?? "")?.[1] ?? "";

/** A complete MultiPV iteration for the review search in flight; deliberately no bestmove. */
function iteration(fen: string, depth: number, cp: number): string[] {
	const roots = h.reviewTransport.movesFor(fen).slice(0, REVIEW.multiPv);
	return roots.map(
		(uci, index) =>
			`info depth ${depth} seldepth ${depth + 2} multipv ${index + 1} score cp ${cp - index * 20} nodes 10000 nps 100000 time 100 pv ${uci}`
	);
}

/** Black to move, White's Rf1–f8+ outside the review's lines: its rating needs the position it made. */
async function opponentMoveAwaitingReview(): Promise<string> {
	h = await createGameHarness({
		myColor: "b",
		fen: BEFORE,
		reviewScript: { stopWithReportedEvidence: true },
		settings: { automation: { autoMove: false, boardEffects: true, moveQualityChips: true } },
	});
	h.reviewTransport.prefer.set(positionKey(BEFORE), ["f1f2", "f1f3", "f1f4"]);
	// Reviews of the start position answer at once; everything after it is fed by hand.
	// Foreground preparation may stop review. A stop acknowledges only work already reported,
	// so it cannot create the depth-18 evidence these tests deliberately withhold.
	await h.arrive();
	expect(await h.until(() => h.reviewTransport.goLines.length > 0, 5_000)).toBe(true);
	h.reviewTransport.hold = true;
	await h.arrive("f1f8");
	const after = h.site.board.fen();
	expect(await h.until(() => reviewedMoves() === "f1f8", 5_000)).toBe(true);
	expect(rated()).toHaveLength(0);
	return after;
}

describe("board ratings from the review engine", () => {
	it("publishes the moment the review of the position it made reaches the target depth", async () => {
		const after = await opponentMoveAwaitingReview();
		await h.drive(() => h.reviewTransport.feed(...iteration(after, REVIEW.targetDepth, -40)));
		expect(await h.until(() => rated().length === 1, 1_000, 1)).toBe(true);
		expect(rated()[0]?.quality?.square).toBe("f8");
		expect(rated()[0]?.mine).toBe(false);
	});

	it("waits for the landed window before publishing from a shallower iteration", async () => {
		const after = await opponentMoveAwaitingReview();
		await h.drive(() => h.reviewTransport.feed(...iteration(after, REVIEW.publishDepth - 1, -40)));
		await h.advance(REVIEW.landedWaitMs * 2);
		expect(rated()).toHaveLength(0);
		await h.drive(() => h.reviewTransport.feed(...iteration(after, REVIEW.publishDepth, -40)));
		expect(await h.until(() => rated().length === 1, REVIEW.landedWaitMs, 10)).toBe(true);
		expect(rated()[0]?.quality?.square).toBe("f8");
	});

	it("does not publish a publish-depth iteration before the landed wait is over", async () => {
		const after = await opponentMoveAwaitingReview();
		await h.drive(() => h.reviewTransport.feed(...iteration(after, REVIEW.publishDepth, -40)));
		await h.advance(1);
		expect(rated()).toHaveLength(0);
		expect(await h.until(() => rated().length === 1, REVIEW.landedWaitMs + 100, 10)).toBe(true);
	});
});

describe("manually fed review fixture lifecycle", () => {
	it("acknowledges an empty stopped search without inventing an iteration", async () => {
		const wire = new ScriptedEngineTransport({ depth: 18, stopWithReportedEvidence: true });
		wire.hold = true;
		const output: string[] = [];
		wire.onLine((line) => output.push(line));
		const engine = new UciEngine(wire);
		try {
			await engine.init();
			const search = engine.analyse({ id: "empty", fen: BEFORE, multiPv: 3, limit: { depth: 18 } });
			await flush();
			const before = output.length;
			await search.stop();
			const result = await search.result;
			expect(output.slice(before)).toHaveLength(1);
			expect(output[before]).toStartWith("bestmove ");
			expect(result.final).toMatchObject({ depth: 0, lines: [], complete: false });
			// Stop retired the pending response; release cannot answer it a second time.
			wire.release();
			expect(output.length).toBe(before + 1);
		} finally {
			engine.dispose();
		}
	});

	it("retains completed depth 12 through stop without promoting a partial depth 13", async () => {
		const wire = new ScriptedEngineTransport({ depth: 18, stopWithReportedEvidence: true });
		wire.hold = true;
		const output: string[] = [];
		wire.onLine((line) => output.push(line));
		const engine = new UciEngine(wire);
		try {
			await engine.init();
			const search = engine.analyse({ id: "earned", fen: BEFORE, multiPv: 3, limit: { depth: 18 } });
			await flush();
			for (const [i, move] of ["f1f2", "f1f3", "f1f4"].entries())
				wire.feed(`info depth 12 multipv ${i + 1} score cp ${30 - i * 10} pv ${move}`);
			wire.feed("info depth 13 multipv 1 score cp 40 pv f1f2");
			const before = output.length;
			await search.stop();
			const result = await search.result;
			expect(output.slice(before)).toEqual(["bestmove f1f2"]);
			expect(result.final.depth).toBe(12);
			expect(result.final.complete).toBe(true);
			expect(result.final.lines).toHaveLength(3);
			expect(result.final.lines.every((line) => line.depth === 12)).toBe(true);
			const next = engine.analyse({ id: "fresh", fen: BEFORE, multiPv: 3, limit: { depth: 18 } });
			await flush();
			await next.stop();
			expect((await next.result).final).toMatchObject({ depth: 0, lines: [], complete: false });
		} finally {
			engine.dispose();
		}
	});

	it("does not let a delayed stop callback retire a newer search", async () => {
		const wire = new ScriptedEngineTransport({ stopWithReportedEvidence: true });
		wire.hold = true;
		const output: string[] = [];
		wire.onLine((line) => output.push(line));
		wire.send(`position fen ${BEFORE}`);
		wire.send("go depth 18");
		wire.send("stop");
		wire.feed("bestmove f1f2"); // the old search settles before its queued stop callback
		wire.send("go depth 18");
		await flush();
		expect(output).toEqual(["bestmove f1f2"]);
		wire.send("stop");
		await flush();
		expect(output).toHaveLength(2);
		expect(output.every((line) => line.startsWith("bestmove "))).toBe(true);
	});
});
