// test/page/helpers.ts
/**
 * Shared helpers for evaluating emitted page programs in happy-dom: the
 * program text runs as a function whose free identifiers (`window`,
 * `document`, `location`, `MutationObserver`, `customElements`, …) are bound
 * to one happy-dom window, so nothing leaks into the test process globals
 * and `Object.keys(window)` can be compared before/after.
 */

import { SPOOF_PURPOSES } from "@core/constants/spoof";
import { deriveToken } from "@core/spoof";
import { Window } from "happy-dom";
import { FORBIDDEN_PAGE_SUBSTRINGS, findForbiddenSubstrings } from "../../scripts/check-constants";

export const SEED = "page-test-seed";

export const TOKENS_FOR_SEED = {
	key: deriveToken(SEED, SPOOF_PURPOSES.messageKey),
	page: deriveToken(SEED, SPOOF_PURPOSES.pageToken),
	content: deriveToken(SEED, SPOOF_PURPOSES.contentToken),
	overlayClass: deriveToken(SEED, SPOOF_PURPOSES.overlayClass),
} as const;

/** The seven §13.3 rule 5 words, from the build lint (`scripts/check-constants.ts`), once. */
export const FORBIDDEN = FORBIDDEN_PAGE_SUBSTRINGS;

/** Substrings of the seven forbidden words present in `code` (case-sensitive, as §13.3 lists them). */
export const forbiddenIn = findForbiddenSubstrings;

export function makeWindow(url: string): Window {
	const win = new Window({ url });
	win.document.documentElement.innerHTML = "<head></head><body></body>";
	return win;
}

export interface Posted {
	data: Record<string, unknown>;
	origin: string;
}

/** Replace `win.postMessage` with a recorder; returns the log and the restore. */
export function recordPosts(win: Window): { posts: Posted[]; restore(): void } {
	const posts: Posted[] = [];
	const original = win.postMessage;
	win.postMessage = ((data: unknown, origin: string) => {
		posts.push({ data: data as Record<string, unknown>, origin });
	}) as typeof win.postMessage;
	return {
		posts,
		restore() {
			win.postMessage = original;
		},
	};
}

/** Evaluate program text with the page globals bound to `win` (plus any extras). */
export function runProgram(
	code: string,
	win: Window,
	extra: Record<string, unknown> = {},
	asExpression = false
): unknown {
	const bindings: Record<string, unknown> = {
		window: win,
		document: win.document,
		location: win.location,
		MutationObserver: win.MutationObserver,
		customElements: win.customElements,
		...extra,
	};
	const names = Object.keys(bindings);
	const values = names.map((n) => bindings[n]);
	const body = asExpression ? `return ${code}` : code;
	return new Function(...names, body)(...values);
}

/** Deliver a content → page envelope to the window's message listeners (same source and origin). */
export function sendToPage(win: Window, data: Record<string, unknown>): void {
	win.dispatchEvent(
		new win.MessageEvent("message", {
			data,
			source: win,
			origin: win.location.origin,
		})
	);
}

/** A content-side command envelope for the given seed. */
export function command(kind: string, id: string, payload?: unknown): Record<string, unknown> {
	const env: Record<string, unknown> = {
		[TOKENS_FOR_SEED.key]: TOKENS_FOR_SEED.content,
		k: kind,
		i: id,
	};
	if (payload !== undefined) env.p = payload;
	return env;
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export async function waitFor(pred: () => boolean, timeoutMs = 1_000): Promise<void> {
	const end = Date.now() + timeoutMs;
	while (!pred()) {
		if (Date.now() > end) throw new Error("waitFor: timed out");
		await sleep(5);
	}
}

/** Posts from the page side (tagged with the page token) of a given kind. */
export function postsOf(posts: Posted[], kind: string): Posted[] {
	return posts.filter(
		(p) => p.data[TOKENS_FOR_SEED.key] === TOKENS_FOR_SEED.page && p.data.k === kind
	);
}

export interface FakeMarking {
	type: string;
	data: Record<string, unknown>;
}

/** A minimal `wc-chess-board.game` (Appendix C §1.7 surface the bridge touches). */
export function fakeGame(fen = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1") {
	const handlers = new Map<string, Array<() => void>>();
	const added: FakeMarking[] = [];
	const removed: string[] = [];
	const game = {
		fen,
		over: false,
		getFEN: () => game.fen,
		getTurn: () => 2,
		getPlayingAs: () => 1,
		getMode: () => ({ name: "playing" }),
		getOptions: () => ({ flipped: false, moveMethod: "drag" }),
		getLastMove: () => ({ from: "e2", to: "e4", san: "e4", promotion: undefined }),
		getLegalMoves: () => [
			{ from: "e7", to: "e5", san: "e5", piece: "p", color: 2 },
			{ from: "a7", to: "a8", san: "a8=Q", promotion: "q", piece: "p", color: 2 },
		],
		getHistorySANs: () => ["e4"],
		isGameOver: () => game.over,
		getResult: () => (game.over ? "1-0" : undefined),
		timeControl: { get: () => ({ base: 180_000, inc: 2_000 }) },
		timestamps: { get: () => [1_800, 1_800] },
		markings: {
			added,
			removed,
			addOne(m: FakeMarking) {
				added.push(m);
				return m.type === "arrow"
					? `arrow|${String(m.data.from)}${String(m.data.to)}`
					: `highlight|${String(m.data.square)}`;
			},
			removeOne(key: string) {
				removed.push(key);
			},
		},
		on(type: string, cb: () => void) {
			const list = handlers.get(type) ?? [];
			list.push(cb);
			handlers.set(type, list);
		},
		emit(type: string) {
			for (const cb of handlers.get(type) ?? []) cb();
		},
		subscribed: () => [...handlers.keys()],
	};
	return game;
}

export type FakeGame = ReturnType<typeof fakeGame>;
