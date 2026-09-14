import { afterEach, describe, expect, it } from "bun:test";
import { applyMoves, legalMoves } from "@core/chess/san";
import type { GamePortCommand } from "@core/constants/messages";
import { MOVE_QUALITY } from "@core/constants/move-quality";
import type { Square } from "@typedefs/game";
import { createGameHarness, type GameHarness } from "./harness";
import { isPonderSearch, positionKey } from "./scripted-engine";

const BEFORE = "4k3/8/8/8/8/8/8/4KR2 w - - 0 1";
const DEEP = MOVE_QUALITY.minDepth + 4;
const FULL_STRENGTH_TARGET = 3_400;
type Effects = Extract<GamePortCommand, { kind: "effects" }>;

let h: GameHarness;
afterEach(async () => {
	await h?.dispose();
});

function marks(mine: boolean): Effects[] {
	return h
		.commands()
		.filter(
			(command): command is Effects =>
				command.kind === "effects" && command.mine === mine && command.quality !== undefined
		);
}

function searchedPosition(): string | null {
	const command = h.transport.positions.at(-1);
	const match = command
		? /^position fen (\S+ \S+ \S+ \S+ \S+ \S+)(?: moves (.*))?$/.exec(command)
		: null;
	if (!match?.[1]) return null;
	return applyMoves(match[1], match[2]?.split(" ").filter(Boolean) ?? []);
}

async function waitingAnalysis(fen: string): Promise<void> {
	const ready = await h.until(
		() =>
			isPonderSearch(h.transport.goLines.at(-1) ?? "") &&
			positionKey(searchedPosition() ?? "") === positionKey(fen),
		5_000
	);
	expect(ready).toBe(true);
}

/** Complete, legal MultiPV frame for the still-running search; deliberately no bestmove. */
function frame(fen: string, depth: number, cp: number): string[] {
	const option = [...h.transport.sent]
		.reverse()
		.find((line) => line.startsWith("setoption name MultiPV value "));
	const width = Number(option?.split(" ").at(-1) ?? 1);
	const roots = h.transport.movesFor(fen).slice(0, width);
	expect(roots).toHaveLength(Math.min(width, legalMoves(fen).length));
	return roots.map(
		(uci, index) =>
			`info depth ${depth} seldepth ${depth + 2} multipv ${index + 1} score cp ${cp - index * 20} nodes 10000 nps 100000 time 100 pv ${uci}`
	);
}

async function deepenWithoutAnotherMove(fen: string, mine: boolean, square: Square): Promise<void> {
	const history = h.site.board.chess.history();
	await waitingAnalysis(fen);
	expect(marks(mine)).toHaveLength(0);
	await h.drive(() => h.transport.feed(...frame(fen, MOVE_QUALITY.minDepth - 1, 41)));
	await h.advance(100);
	expect(marks(mine)).toHaveLength(0);
	const complete = frame(fen, DEEP, 17);
	expect(complete.length).toBeGreaterThan(1);
	await h.drive(() => h.transport.feed(complete[0]!));
	await h.advance(100);
	expect(marks(mine)).toHaveLength(0);
	await h.drive(() => h.transport.feed(...complete.slice(1)));
	expect(await h.until(() => marks(mine).length === 1, 1_000)).toBe(true);
	expect(marks(mine)[0]?.quality?.square).toBe(square);
	expect(h.site.board.chess.history()).toEqual(history);
	expect(h.site.board.fen()).toBe(fen);
	expect(h.session().view().evaluation?.eval).toEqual({ cp: 17 });
}

describe("board ratings from ongoing analysis", () => {
	it("rates our move from an opponent-turn ponder update while the opponent stays still", async () => {
		h = await createGameHarness({
			myColor: "w",
			fen: BEFORE,
			timeControl: { baseMs: 900_000, incMs: 0 },
			script: { depth: DEEP, holdPonder: true },
			settings: {
				automation: { autoMove: false, boardEffects: true, moveQualityChips: true },
				strength: { matchOpponentRating: false, targetElo: FULL_STRENGTH_TARGET },
			},
		});
		await h.arrive();
		expect(await h.until(() => h.session().recommendation() !== null, 5_000)).toBe(true);
		const recommendation = h.session().recommendation()!;
		expect(recommendation.lines[0]?.depth).toBeGreaterThanOrEqual(MOVE_QUALITY.minDepth);
		const played = legalMoves(BEFORE).find(
			(uci) => !recommendation.lines.some((line) => line.pvUci[0] === uci)
		);
		expect(played).toBeDefined();
		await h.drive(() => {
			expect(h.site.board.submit(played!.slice(0, 2) as Square, played!.slice(2, 4) as Square)).toBe(
				true
			);
		});
		await h.arrive();
		const after = h.site.board.fen();
		expect(h.site.board.chess.history()).toHaveLength(1);
		await deepenWithoutAnotherMove(after, true, played!.slice(2, 4) as Square);
	});

	it("rates the opponent's move when panel analysis deepens beyond the shallow initial reply search", async () => {
		h = await createGameHarness({
			myColor: "b",
			fen: BEFORE,
			script: {
				depth: MOVE_QUALITY.minDepth - 1,
				holdPonder: true,
				prefer: new Map([[positionKey(BEFORE), ["f1f2", "f1f3", "f1f4"]]]),
			},
			settings: {
				automation: { autoMove: false, boardEffects: true, moveQualityChips: true },
				strength: { matchOpponentRating: false, targetElo: FULL_STRENGTH_TARGET },
			},
		});
		await h.arrive();
		await waitingAnalysis(BEFORE);
		const before = frame(BEFORE, DEEP, 30);
		expect(before.every((line) => !line.endsWith("pv f1f8"))).toBe(true);
		await h.drive(() => h.transport.feed(...before));
		await h.advance(100);
		await h.arrive("f1f8");
		expect(await h.until(() => h.session().recommendation() !== null, 5_000)).toBe(true);
		expect(h.session().recommendation()?.depth).toBeLessThan(MOVE_QUALITY.minDepth);
		expect(h.executor()?.isArmed()).toBe(false);
		await deepenWithoutAnotherMove(h.site.board.fen(), false, "f8");
	});
});
