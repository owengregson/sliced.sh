import { describe, expect, it } from "bun:test";
import { CHESS_START_FEN } from "@core/constants/chess";
import { commandForKeybind, commandForShortcut } from "@service/game-session/session/commands";
import { instantPlan, unsearchedRecommendation } from "@service/game-session/session/instant-plan";
import { MoveHistory } from "@service/game-session/session/move-history";
import {
	boardKeyOf,
	claimsFirstMove,
	isGameFirstMove,
	legalDestinations,
	motorTcClass,
	positionFeedKey,
	uciOf,
} from "@service/game-session/session/position-rules";
import type { ChosenMove, PositionSnapshot } from "@typedefs/game";

const AFTER_E4 = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1";
const MIDGAME_CLAIMING_MOVE_ONE =
	"r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 0 1";

function snapshot(over: Partial<PositionSnapshot> = {}): PositionSnapshot {
	return {
		site: "chesscom",
		gameId: "g",
		fen: CHESS_START_FEN,
		ply: 0,
		sideToMove: "w",
		myColor: "w",
		approximate: false,
		clocks: { w: { ms: 60_000, running: true }, b: { ms: 60_000, running: false } },
		capturedAt: 0,
		...over,
	} as PositionSnapshot;
}

describe("position rules", () => {
	it("a first move needs both the counters and the placement", () => {
		expect(claimsFirstMove(CHESS_START_FEN)).toBe(true);
		expect(claimsFirstMove(AFTER_E4)).toBe(true);
		expect(claimsFirstMove(MIDGAME_CLAIMING_MOVE_ONE)).toBe(false);
	});

	it("the §13.4 first-move scope also demands an explicitly exact reading", () => {
		expect(isGameFirstMove(snapshot())).toBe(true);
		expect(isGameFirstMove(snapshot({ approximate: true }))).toBe(false);
		const unstated = snapshot();
		delete unstated.approximate;
		expect(isGameFirstMove(unstated)).toBe(false);
		expect(isGameFirstMove(snapshot({ fen: MIDGAME_CLAIMING_MOVE_ONE }))).toBe(false);
	});

	it("board identity ignores the counters", () => {
		expect(boardKeyOf(AFTER_E4)).toBe(boardKeyOf(AFTER_E4.replace(" 0 1", " 3 9")));
	});

	it("the feed key separates the colour, the clock and the provenance of one ply", () => {
		const base = positionFeedKey(snapshot());
		expect(positionFeedKey(snapshot({ myColor: null }))).not.toBe(base);
		expect(positionFeedKey(snapshot({ timeControl: { baseMs: 60_000, incMs: 0 } }))).not.toBe(base);
		expect(positionFeedKey(snapshot({ approximate: true }))).not.toBe(base);
		expect(positionFeedKey(snapshot())).toBe(base);
	});

	it("resolves moves and destinations", () => {
		expect(uciOf(CHESS_START_FEN, "e2", "e4")).toBe("e2e4");
		expect(uciOf(CHESS_START_FEN, "e2", "e5")).toBeNull();
		expect(legalDestinations(CHESS_START_FEN, "g1").sort()).toEqual(["f3", "h3"]);
		expect(motorTcClass("untimed")).toBe("classical");
		expect(motorTcClass("bullet")).toBe("bullet");
	});
});

describe("instant plans", () => {
	it("is a premove-mode plan whose only window is the approach", () => {
		const plan = instantPlan({ windowMs: 80, deadlineMs: 1080, rationale: ["r"], clockRace: 0.5 });
		expect(plan).toEqual({
			thinkMs: 80,
			mode: "premove",
			preMoveHoverMs: 0,
			dragDurationMs: 0,
			deadlineMs: 1080,
			rationale: ["r"],
			features: { clockRace: 0.5 },
			orientationMs: 0,
			window: { orientationMs: 0, scanMs: 0, previewMs: 0, decisionMs: 0, approachMs: 80 },
		});
		const chosen = { uci: "e2e4" } as ChosenMove;
		const rec = unsearchedRecommendation(chosen, plan, 1000, CHESS_START_FEN);
		expect(rec).toMatchObject({ chosen, lines: [], eval: { cp: 0 }, depth: 0, nps: 0, plan });
	});
});

describe("command names", () => {
	it("maps shortcuts and keybinds onto session commands", () => {
		expect(commandForShortcut("play-best-move")).toBe("playNow");
		expect(commandForShortcut("disable-assistant")).toBe("disable");
		expect(commandForShortcut("nope")).toBeUndefined();
		expect(commandForKeybind("speakMove")).toBe("speakMove");
		expect(commandForKeybind("global")).toBeUndefined();
	});
});

describe("move history", () => {
	it("tracks moves and the opponent's think from the positions it is shown", () => {
		const h = new MoveHistory();
		const start = snapshot({ capturedAt: 1000 });
		const afterMine = snapshot({
			fen: AFTER_E4,
			ply: 1,
			sideToMove: "b",
			lastMove: { from: "e2", to: "e4", san: "e4" },
			capturedAt: 2000,
		});
		h.track(null, start);
		h.track(start, afterMine);
		expect(h.moves).toEqual(["e2e4"]);
		expect(h.lastMyMoveAt).toBe(2000);
		const afterTheirs = snapshot({
			fen: "rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq e6 0 2",
			ply: 2,
			sideToMove: "w",
			lastMove: { from: "e7", to: "e5", san: "e5" },
			capturedAt: 3500,
		});
		h.track(afterMine, afterTheirs);
		expect(h.moves).toEqual(["e2e4", "e7e5"]);
		expect(h.oppThinkMs).toEqual([1500]);
		expect(h.historyFor(afterTheirs.fen)).toEqual({ fen: CHESS_START_FEN, moves: ["e2e4", "e7e5"] });
		h.reset();
		expect(h.moves).toEqual([]);
		expect(h.historyFor(CHESS_START_FEN)).toEqual({ fen: CHESS_START_FEN, moves: [] });
	});
});
