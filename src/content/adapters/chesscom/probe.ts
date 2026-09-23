/**
 * The chess.com self-check (§3.4a): which selector ladders match, and whether the independent
 * readings of the board agree with one another.
 */

import type { Color, Site } from "@typedefs/game";
import type { BridgeState } from "../bridge-protocol";
import type { PositionInfo, ProbeReport, SelfCheckResult } from "../contract";
import { placementOf, replayMoves } from "../dom-fen";
import type { MoveList } from "../move-list";
import { SELECTORS as S } from "../selectors";
import {
	checkBoardSanity,
	checkOrientation,
	checkPlacementConsistency,
	checkTurnConsistency,
	probeLadders,
} from "../self-check";
import { rendererOf } from "./board";
import { plyOf } from "./position";

/** Ladders whose miss is a telemetry-worthy `selectorMiss` (the rest are situational). */
export const REQUIRED_LADDERS: ReadonlySet<string> = new Set(["board", "moveList", "playerBottom"]);

const LADDERS: Record<string, readonly string[]> = {
	board: S.board,
	moveList: S.moveList,
	moveNode: S.moveNode,
	moveText: S.moveText,
	moveSelected: S.moveSelected,
	result: S.result,
	clockTime: S.clockTime,
	playerTop: S.playerTop,
	playerBottom: S.playerBottom,
	username: S.username,
	rating: S.rating,
	gameOver: S.gameOver,
	newGame: S.newGame,
	rematch: S.rematch,
	promotionWindow: S.promotionWindow,
	botCard: S.botCard,
};

/** Everything one probe compares, read by the adapter. */
export interface ProbeInputs {
	site: Site;
	doc: Document;
	board: Element | null;
	placement: string | null;
	list: MoveList;
	info: PositionInfo | null;
	bottom: Color | null;
	bridgeState: BridgeState | null;
	turns: { bridge: Color | null; clock: Color | null; parity: Color | null };
	geometry: SelfCheckResult;
	/** `null` when the adapter runs without a bridge at all (DOM mode). */
	bridgeUp: boolean | null;
}

export function probeReportOf(input: ProbeInputs): ProbeReport {
	const { board, placement, list, info, bottom, bridgeState } = input;
	const ladder = probeLadders(LADDERS, input.doc);
	const replay = replayMoves(list.sans.slice(0, plyOf(list)));
	const canvas = board !== null && rendererOf(board) === "canvas";
	const checks = [
		checkBoardSanity(placement ?? (info ? placementOf(info.fen) : null)),
		canvas
			? { name: "placementConsistency", ok: true, detail: "canvas board (no DOM pieces)" }
			: checkPlacementConsistency(replay ? placementOf(replay.fen) : null, placement),
		checkTurnConsistency([
			{ name: "bridge", turn: input.turns.bridge },
			{ name: "clock", turn: input.turns.clock },
			{ name: "parity", turn: input.turns.parity },
		]),
		checkOrientation([
			{
				// the WebGL board never carries the class, so it is no evidence there
				name: "class",
				flipped: canvas ? null : (board?.classList.contains(S.boardFlippedClass) ?? null),
			},
			{
				name: "bridge",
				flipped: typeof bridgeState?.flipped === "boolean" ? bridgeState.flipped : null,
			},
			{ name: "bottomRow", flipped: bottom ? bottom === "b" : null },
		]),
		input.geometry,
		input.bridgeUp === null
			? { name: "apiPresence", ok: false, detail: "no bridge (DOM mode)" }
			: { name: "apiPresence", ok: input.bridgeUp },
	];
	return {
		site: input.site,
		at: Date.now(),
		matched: ladder.matched,
		misses: ladder.misses,
		checks,
	};
}
