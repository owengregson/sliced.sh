// test/sim/telemetry/sim-board.ts
/**
 * The simulated site's board: a happy-dom `#board` with one `<div id="<square>">`
 * per square laid out at `SIM_TELEMETRY.board`, bound to a chess.js game. It is
 * the `SiteModel` the `ac` shadow drives (occupancy / legal destinations from
 * the real rules, moves applied on submission) and the geometry / occupancy
 * source of the content-side fake adapter. Nothing here knows the executor.
 */

import { fileOf, rankOf, squareOf } from "@core/chess/squares";
import type { Occupancy, Rect } from "@core/motor/types";
import type { TabDom } from "@test/sim/dom/tab-dom";
import { SIM_TELEMETRY } from "@test/sim/telemetry/constants";
import type { Color, Square } from "@typedefs/game";
import { Chess } from "chess.js";

export const SIM_SQUARES: Square[] = [];
for (let r = 0; r < 8; r++)
	for (let f = 0; f < 8; f++) {
		const sq = squareOf(f, r);
		if (sq) SIM_SQUARES.push(sq);
	}

export interface LastMove {
	from: Square;
	to: Square;
	san: string;
	uci: string;
	ply: number;
	/** `true` when the page side (our pointer) made it, `false` for the opponent's. */
	byMe: boolean;
}

export interface SimBoard {
	readonly chess: Chess;
	readonly myColor: Color;
	readonly boardRect: Rect;
	squareRect(sq: Square): Rect;
	squareOf(target: EventTarget | null): Square | null;
	/** Relative to `myColor` (what the adapter's `boardCheck` answers). */
	occupancy(sq: Square): Occupancy;
	occupancyMap(): Partial<Record<Square, Occupancy>>;
	/** Legal destinations of the piece on `sq` (empty when it is not our turn or not our piece). */
	legalDestinations(sq: Square): Square[];
	/** Every legal move as UCI (promotions included). */
	legalMoves(): string[];
	/** The page-side move: applied only on our turn; a pawn reaching the last rank queens. */
	submit(from: Square, to: Square): boolean;
	/** The opponent's move arriving over the "socket". */
	applyOpponent(uci: string): void;
	/**
	 * A move the page made while it was *not* our turn: chess.com holds it as a premove and fires
	 * it the instant the opponent moves. `false` when the site would not hold it at all — the
	 * piece snaps back — which is what a player with premoves switched off sees (`premoves`).
	 */
	queuePremove(from: Square, to: Square): boolean;
	/** The premove the site is holding, if any. */
	premoveQueued(): { from: Square; to: Square } | null;
	/**
	 * Resolve a held premove now that the opponent has moved: played when it is legal in the
	 * position they left, dropped when it is not (the site validates it at this moment, not when
	 * it was entered). `null` when nothing was held.
	 */
	firePremove(): "played" | "dropped" | null;
	lastMove(): LastMove | null;
	onChange(cb: (last: LastMove) => void): () => void;
	fen(): string;
	ply(): number;
	isGameOver(): boolean;
}

export function createSimBoard(
	dom: TabDom,
	options: { myColor: Color; fen?: string; premoves?: boolean }
): SimBoard {
	const chess = options.fen ? new Chess(options.fen) : new Chess();
	const { left, top, size } = SIM_TELEMETRY.board;
	const boardRect: Rect = { left, top, width: size, height: size };
	const sq = size / 8;
	const flipped = options.myColor === "b";
	const listeners = new Set<(last: LastMove) => void>();
	let last: LastMove | null = null;
	let premove: { from: Square; to: Square } | null = null;

	function squareRect(s: Square): Rect {
		const f = flipped ? 7 - fileOf(s) : fileOf(s);
		const r = flipped ? rankOf(s) : 7 - rankOf(s);
		return { left: left + f * sq, top: top + r * sq, width: sq, height: sq };
	}

	dom.setHTML(`<div id="board">${SIM_SQUARES.map((s) => `<div id="${s}"></div>`).join("")}</div>`);
	dom.layout("#board", { x: left, y: top, width: size, height: size });
	for (const s of SIM_SQUARES) {
		const r = squareRect(s);
		dom.layout(`#${s}`, { x: r.left, y: r.top, width: r.width, height: r.height });
	}

	function occupancy(s: Square): Occupancy {
		const piece = chess.get(s);
		if (!piece) return "empty";
		return piece.color === options.myColor ? "own" : "enemy";
	}

	const ply = (): number => chess.history().length;

	function record(from: Square, to: Square, san: string, uci: string, byMe: boolean): void {
		last = { from, to, san, uci, ply: ply(), byMe };
		for (const l of [...listeners]) l(last);
	}

	/** The page-side move, shared by the pointer gesture and a premove the site fires. */
	function submitMove(from: Square, to: Square): boolean {
		if (chess.turn() !== options.myColor) return false;
		const candidates = chess.moves({ square: from, verbose: true }).filter((m) => m.to === to);
		const move = candidates.find((m) => m.promotion === "q") ?? candidates[0];
		if (!move) return false;
		chess.move({
			from: move.from,
			to: move.to,
			...(move.promotion ? { promotion: move.promotion } : {}),
		});
		record(from, to, move.san, `${move.from}${move.to}${move.promotion ?? ""}`, true);
		return true;
	}

	return {
		chess,
		myColor: options.myColor,
		boardRect,
		squareRect,
		squareOf(target) {
			const id = (target as { id?: string } | null)?.id ?? "";
			return SIM_SQUARES.includes(id as Square) ? (id as Square) : null;
		},
		occupancy,
		occupancyMap() {
			const out: Partial<Record<Square, Occupancy>> = {};
			for (const s of SIM_SQUARES) out[s] = occupancy(s);
			return out;
		},
		legalDestinations(s) {
			if (chess.turn() !== options.myColor || occupancy(s) !== "own") return [];
			const dests = new Set<Square>();
			for (const m of chess.moves({ square: s, verbose: true })) dests.add(m.to as Square);
			return [...dests];
		},
		legalMoves() {
			return chess.moves({ verbose: true }).map((m) => `${m.from}${m.to}${m.promotion ?? ""}`);
		},
		submit: submitMove,
		queuePremove(from, to) {
			// The site accepts the gesture whenever it is the opponent's turn and the piece is ours;
			// legality is decided when it fires, which is why an unexpected reply can drop it *and*
			// why a premove that stays legal fires anyway.
			if (options.premoves !== true) return false;
			if (chess.turn() === options.myColor) return false;
			if (occupancy(from) !== "own") return false;
			premove = { from, to };
			return true;
		},
		premoveQueued: () => (premove ? { ...premove } : null),
		firePremove() {
			const held = premove;
			if (!held) return null;
			premove = null;
			return submitMove(held.from, held.to) ? "played" : "dropped";
		},
		applyOpponent(uci) {
			const from = uci.slice(0, 2) as Square;
			const to = uci.slice(2, 4) as Square;
			const promotion = uci.charAt(4);
			const move = chess.move({ from, to, ...(promotion ? { promotion } : {}) });
			record(from, to, move.san, uci, false);
		},
		lastMove: () => (last ? { ...last } : null),
		onChange(cb) {
			listeners.add(cb);
			return () => void listeners.delete(cb);
		},
		fen: () => chess.fen(),
		ply,
		isGameOver: () => chess.isGameOver(),
	};
}
