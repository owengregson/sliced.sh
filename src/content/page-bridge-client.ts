/**
 * `PageBridgeClient` — the ISOLATED-world end of the MAIN ⇄ ISOLATED bridge
 * (Task 21), implementing the adapter's `PageBridge`.
 *
 * Wire (§13.3 rule 5): `window.postMessage({ [key]: token, k, i?, p? },
 * location.origin)` both ways, where `key = deriveToken(seed,
 * SPOOF_PURPOSES.messageKey)`; the page posts `token = deriveToken(seed,
 * pageToken)`, this side posts `deriveToken(seed, contentToken)`, and each
 * side accepts only the other's value — no direction field, no product
 * name. Payload fields are the single letters of `BRIDGE_WIRE`; this module
 * is the codec between them and the adapter's `BridgeState` / draw shapes.
 *
 * `call` correlates replies by `i` and rejects on timeout; `on` subscribes
 * to unsolicited page events; `isAvailable()` turns true once the page side
 * has posted `ready` (or answered anything). A `getState` probe is posted at
 * construction so a bridge that started before this listener existed is
 * still discovered.
 */

import { BRIDGE_KINDS, type BridgeState, type PageBridge } from "@content/adapters/adapter";
import { BRIDGE_ORIENTATION, BRIDGE_WIRE as W } from "@core/constants/bridge";
import { SPOOF_PURPOSES } from "@core/constants/spoof";
import { TIMINGS } from "@core/constants/timings";
import { deriveToken } from "@core/spoof";
import type { PromoPiece, Square } from "@typedefs/game";

export interface PageBridgeClient extends PageBridge {
	/** Fire-and-forget command: no id, no pending entry, no reply (Fix D's pointer mirror). */
	notify(kind: string, payload?: unknown): void;
	/** Remove the message listener and reject every pending call. */
	dispose(): void;
}

export interface PageBridgeClientOptions {
	window?: Window;
	/** Spoof seed (default: the build define `__SL_SPOOF_SEED__`). */
	seed?: string;
	/** Default per-call timeout (default `TIMINGS.adapterBridgeTimeoutMs`). */
	timeoutMs?: number;
}

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

type Dict = Record<string, unknown>;

function isDict(v: unknown): v is Dict {
	return typeof v === "object" && v !== null;
}

function str(v: unknown): string | undefined {
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
	if (typeof p[W.gameOver] === "boolean") out.gameOver = p[W.gameOver] as boolean;
	if (p[W.timeControl] !== undefined && p[W.timeControl] !== null)
		out.timeControl = p[W.timeControl];
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
		case BRIDGE_KINDS.cursorTo: {
			// Viewport CSS px straight from the executor; `x` / `y` are the cursor probe's own
			// wire letters (`BRIDGE_WIRE`), reused rather than given synonyms.
			const p = isDict(payload) ? payload : {};
			return {
				[W.x]: typeof p.x === "number" ? p.x : 0,
				[W.y]: typeof p.y === "number" ? p.y : 0,
				[W.down]: p.down === true,
			};
		}
		default:
			return payload === undefined ? undefined : payload;
	}
}

interface Pending {
	resolve(value: unknown): void;
	reject(reason: Error): void;
	timer: ReturnType<typeof setTimeout>;
}

export function createPageBridgeClient(options: PageBridgeClientOptions = {}): PageBridgeClient {
	const win = options.window ?? window;
	const seed = options.seed ?? __SL_SPOOF_SEED__;
	const key = deriveToken(seed, SPOOF_PURPOSES.messageKey);
	const own = deriveToken(seed, SPOOF_PURPOSES.contentToken);
	const accept = deriveToken(seed, SPOOF_PURPOSES.pageToken);
	const defaultTimeout = options.timeoutMs ?? TIMINGS.adapterBridgeTimeoutMs;
	const pending = new Map<string, Pending>();
	const listeners = new Map<string, Set<(payload: unknown) => void>>();
	let available = false;
	let disposed = false;
	let serial = 0;

	const emit = (kind: string, payload: unknown): void => {
		for (const cb of listeners.get(kind) ?? []) cb(payload);
	};

	const markAvailable = (payload: unknown): void => {
		if (available) return;
		available = true;
		emit(BRIDGE_KINDS.ready, payload);
	};

	const onMessage = (ev: MessageEvent): void => {
		if (ev.source !== win || ev.origin !== win.location.origin) return;
		const data: unknown = ev.data;
		if (!isDict(data) || data[key] !== accept) return;
		const kind = str(data[W.kind]);
		if (kind === undefined) return;
		const payload = decodePayload(kind, data[W.payload]);
		const id = str(data[W.id]);
		if (id !== undefined) {
			const p = pending.get(id);
			if (p) {
				pending.delete(id);
				clearTimeout(p.timer);
				markAvailable(payload);
				p.resolve(payload);
				return;
			}
		}
		if (kind === BRIDGE_KINDS.ready) {
			markAvailable(payload);
			return;
		}
		emit(kind, payload);
	};
	win.addEventListener("message", onMessage);

	const send = (kind: string, id: string | undefined, payload: unknown): void => {
		const envelope: Dict = { [key]: own, [W.kind]: kind };
		if (id !== undefined) envelope[W.id] = id;
		const encoded = encodePayload(kind, payload);
		if (encoded !== undefined) envelope[W.payload] = encoded;
		win.postMessage(envelope, win.location.origin);
	};

	const client: PageBridgeClient = {
		isAvailable: () => available && !disposed,
		call<T = unknown>(kind: string, payload?: unknown, timeoutMs?: number): Promise<T> {
			if (disposed) return Promise.reject(new Error("bridge: disposed"));
			const id = String(++serial);
			return new Promise<T>((resolve, reject) => {
				const timer = setTimeout(() => {
					pending.delete(id);
					reject(new Error(`bridge: ${kind} timed out`));
				}, timeoutMs ?? defaultTimeout);
				pending.set(id, { resolve: (v) => resolve(v as T), reject, timer });
				try {
					send(kind, id, payload);
				} catch (error) {
					pending.delete(id);
					clearTimeout(timer);
					reject(error instanceof Error ? error : new Error(String(error)));
				}
			});
		},
		notify(kind, payload) {
			if (disposed) return;
			// No id, so the page side has nothing to correlate a reply to and posts none.
			send(kind, undefined, payload);
		},
		on(kind, cb) {
			let set = listeners.get(kind);
			if (!set) {
				set = new Set();
				listeners.set(kind, set);
			}
			set.add(cb);
			return () => {
				set?.delete(cb);
			};
		},
		dispose() {
			if (disposed) return;
			disposed = true;
			available = false;
			win.removeEventListener("message", onMessage);
			for (const [id, p] of pending) {
				clearTimeout(p.timer);
				p.reject(new Error("bridge: disposed"));
				pending.delete(id);
			}
			listeners.clear();
		},
	};

	// Discovery probe: a bridge that posted `ready` before this listener existed answers this.
	client.call(BRIDGE_KINDS.getState, undefined, defaultTimeout).catch(() => {
		// no page side yet — `ready` will arrive when it starts
	});
	return client;
}
