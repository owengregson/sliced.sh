/**
 * The bridge wire codec (§13.3 rule 5): payload fields are the single letters of `BRIDGE_WIRE`,
 * and this module translates between them and the adapter's `BridgeState` / draw / effect
 * shapes — `decodePayload` for everything the page posts (replies and events share it),
 * `encodePayload` for everything this side sends.
 */

import { BRIDGE_KINDS, type BridgeState } from "@content/adapters/bridge-protocol";
import { BOARD_EFFECT_KINDS, type BoardEffect } from "@core/constants/board-effects";
import { BRIDGE_ORIENTATION, BRIDGE_WIRE as W } from "@core/constants/bridge";
import {
	type MoveListRating,
	type MoveQualityMark,
	moveQualityIndex,
} from "@core/constants/move-quality";
import type { PromoPiece, Square } from "@typedefs/game";

export interface BridgeCursor {
	x: number;
	y: number;
	t: number;
}

export interface BridgeLegalMove {
	from: Square;
	to: Square;
	promotion?: PromoPiece;
	san?: string;
}

/** A decoded wire object (the envelope, or a payload). */
export type Dict = Record<string, unknown>;

export function isDict(v: unknown): v is Dict {
	return typeof v === "object" && v !== null;
}

export function str(v: unknown): string | undefined {
	return typeof v === "string" ? v : undefined;
}

function decodeLastMove(v: unknown): BridgeState["lastMove"] | undefined {
	if (!isDict(v)) return undefined;
	const from = str(v[W.from]);
	const to = str(v[W.to]);
	if (from === undefined || to === undefined) return undefined;
	const san = str(v[W.san]);
	return san === undefined
		? { from: from as Square, to: to as Square }
		: { from: from as Square, to: to as Square, san };
}

/** Wire state (`getState` reply, `move` / `load` / `state` / `gameover` events) → `BridgeState`. */
export function decodeState(p: unknown): BridgeState | null {
	if (!isDict(p)) return null;
	const out: BridgeState = {};
	const fen = str(p[W.position]);
	if (fen !== undefined) out.fen = fen;
	const turn = p[W.turn];
	if (turn === 1 || turn === 2 || turn === "w" || turn === "b") out.turn = turn;
	const playingAs = p[W.playingAs];
	if (playingAs === 1 || playingAs === 2 || playingAs === "w" || playingAs === "b")
		out.playingAs = playingAs;
	else if (W.playingAs in p) out.playingAs = null;
	const mode = str(p[W.mode]);
	if (mode !== undefined) out.mode = mode;
	if (typeof p[W.flipped] === "boolean") out.flipped = p[W.flipped] as boolean;
	const lastMove = decodeLastMove(p[W.lastMove]);
	if (lastMove) out.lastMove = lastMove;
	const result = str(p[W.result]);
	if (result !== undefined) out.result = result;
	else if (p[W.result] === null) out.result = null;
	if (typeof p[W.gameOver] === "boolean") out.gameOver = p[W.gameOver] as boolean;
	if (p[W.timeControl] !== undefined) out.timeControl = p[W.timeControl];
	if (p[W.timestamps] !== undefined && p[W.timestamps] !== null) out.timestamps = p[W.timestamps];
	return out;
}

function decodeLegalMoves(p: unknown): BridgeLegalMove[] {
	if (!Array.isArray(p)) return [];
	const out: BridgeLegalMove[] = [];
	for (const m of p) {
		if (!isDict(m)) continue;
		const from = str(m[W.from]);
		const to = str(m[W.to]);
		if (from === undefined || to === undefined) continue;
		const move: BridgeLegalMove = { from: from as Square, to: to as Square };
		const promo = str(m[W.promotion]);
		if (promo === "q" || promo === "r" || promo === "b" || promo === "n") move.promotion = promo;
		const san = str(m[W.san]);
		if (san !== undefined) move.san = san;
		out.push(move);
	}
	return out;
}

function decodeCursor(p: unknown): BridgeCursor | null {
	if (!isDict(p)) return null;
	const x = p[W.x];
	const y = p[W.y];
	const t = p[W.at];
	if (typeof x !== "number" || typeof y !== "number") return null;
	return { x, y, t: typeof t === "number" ? t : 0 };
}

/** Page → content payload by kind (replies and events share the codec). */
export function decodePayload(kind: string, p: unknown): unknown {
	switch (kind) {
		case BRIDGE_KINDS.ready:
		case BRIDGE_KINDS.state:
		case BRIDGE_KINDS.move:
		case BRIDGE_KINDS.load:
		case BRIDGE_KINDS.gameover:
		case BRIDGE_KINDS.getState:
			return decodeState(p) ?? {};
		case BRIDGE_KINDS.legalMoves:
			return decodeLegalMoves(p);
		case BRIDGE_KINDS.cursor:
			return decodeCursor(p);
		case BRIDGE_KINDS.draw: {
			const keys = isDict(p) && Array.isArray(p[W.keys]) ? (p[W.keys] as unknown[]) : [];
			return { keys: keys.filter((k): k is string => typeof k === "string") };
		}
		default:
			return p;
	}
}

interface EffectsPayload {
	orientation?: "white" | "black";
	mine?: boolean;
	effects?: BoardEffect[];
	quality?: MoveQualityMark;
}

interface DrawPayload {
	orientation?: "white" | "black";
	highlights?: Array<{ square: Square; color: string }>;
	arrows?: Array<{ from: Square; to: Square; color: string }>;
	/** Draw through the bridge's own SVG overlay even where native markings exist. */
	forceOverlay?: boolean;
}

/** Content → page payload by kind (adapter shapes → wire letters). */
export function encodePayload(kind: string, payload: unknown): unknown {
	switch (kind) {
		case BRIDGE_KINDS.draw: {
			const d: DrawPayload = isDict(payload) ? (payload as DrawPayload) : {};
			return {
				[W.orientation]:
					d.orientation === "black" ? BRIDGE_ORIENTATION.black : BRIDGE_ORIENTATION.white,
				[W.highlights]: (d.highlights ?? []).map((h) => ({ [W.square]: h.square, [W.color]: h.color })),
				[W.arrows]: (d.arrows ?? []).map((a) => ({
					[W.from]: a.from,
					[W.to]: a.to,
					[W.color]: a.color,
				})),
				// Omitted unless asked for: the page reads `!q[forceOverlay]`, so an absent field is
				// the native-markings default and nothing extra is put on the wire.
				...(d.forceOverlay === true ? { [W.forceOverlay]: true } : {}),
			};
		}
		case BRIDGE_KINDS.clear: {
			const keys = isDict(payload) && Array.isArray(payload.keys) ? payload.keys : undefined;
			return keys === undefined ? undefined : { [W.keys]: keys };
		}
		case BRIDGE_KINDS.moveListRatings: {
			const rows = payload as MoveListRating[];
			return rows.map((row) => [row.ply, row.san, moveQualityIndex(row.quality)]);
		}
		case BRIDGE_KINDS.effects: {
			// One letter per kind and one index per verdict: the batch names no chess idea and no
			// category on the wire (§13.3 rule 5). The page reads both out of its bound tables.
			const e: EffectsPayload = isDict(payload) ? (payload as EffectsPayload) : {};
			return {
				[W.orientation]:
					e.orientation === "black" ? BRIDGE_ORIENTATION.black : BRIDGE_ORIENTATION.white,
				[W.mine]: e.mine === true,
				[W.effectList]: (e.effects ?? []).map((effect) => ({
					[W.effectKind]: BOARD_EFFECT_KINDS[effect.kind],
					[W.from]: effect.from,
					[W.to]: effect.to,
				})),
				...(e.quality
					? {
							[W.badge]: {
								[W.square]: e.quality.square,
								[W.badgeIndex]: moveQualityIndex(e.quality.quality),
							},
						}
					: {}),
			};
		}
		case BRIDGE_KINDS.cursorTo: {
			// Viewport CSS px straight from the executor; `x` / `y` are the cursor probe's own
			// wire letters (`BRIDGE_WIRE`), reused rather than given synonyms.
			const p = isDict(payload) ? payload : {};
			return {
				[W.x]: typeof p.x === "number" ? p.x : 0,
				[W.y]: typeof p.y === "number" ? p.y : 0,
				[W.down]: p.down === true,
				// Omitted unless off: the page reads `q[effects] !== false`, so nothing extra travels
				// for the default.
				...(p.effects === false ? { [W.effects]: false } : {}),
			};
		}
		default:
			return payload === undefined ? undefined : payload;
	}
}
