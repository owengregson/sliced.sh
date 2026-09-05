/**
 * ISOLATED-world content script entry (Task 21, §3.4a, §13.4, V2.1).
 *
 * Boots the site adapter with a `PageBridgeClient`, opens the game port and:
 *   - sends `hello` (`site`, `pageKind`, `adapterVersion`) and `opponent`;
 *   - starts a session on every live game page (`live-game`, `vs-computer`):
 *     `gameStarted` + the current `position` as soon as the board is readable,
 *     then every position change (with `capturedAt`), `moveObserved`,
 *     `gameEnded`;
 *   - forwards every `focus` / `blur` / `visibilitychange` edge as `focus`;
 *   - re-detects the page kind on `popstate` and document mutations
 *     (debounced) and re-sends `hello` when it changes;
 *   - answers `observeMove` (highlights cleared first) and `geometry`;
 *   - applies `highlight` / `arrow` / `clearHighlight` only while the
 *     `settings` command has turned `highlightMoves` on (default off);
 *   - installs the in-page keybinds (`keybinds` command updates them; the
 *     initial set comes from the `CONTENT_HELLO` request) and the cursor
 *     tracker (trusted samples on the port);
 *   - ignores `speak` (TTS lives in the service worker, `tts-relay.ts`).
 *
 * Every listener / timer is released by `dispose()`. No page storage, no
 * synthetic events, no DOM insertion from this world (§13.3).
 */

import {
	type AdapterPositionSnapshot,
	debounced,
	type PageBridge,
	type Rect,
	type SiteAdapter,
	toRect,
} from "@content/adapters/adapter";
import { createChesscomAdapter } from "@content/adapters/chesscom";
import { createLichessAdapter } from "@content/adapters/lichess";
import { createCursorTracker } from "@content/cursor-tracker";
import { createFeedPort, type FeedPort } from "@content/feed-port";
import { createHighlights } from "@content/highlights";
import { installKeybinds } from "@content/keybinds";
import { createPageBridgeClient } from "@content/page-bridge-client";
import { detectSite } from "@content/site-detect";
import { relaySpeak } from "@content/tts-relay";
import { squareOf } from "@core/chess/squares";
import type { GamePortCommand, GamePortMessage } from "@core/constants/messages";
import { MSG } from "@core/constants/messages";
import { TIMINGS } from "@core/constants/timings";
import { log } from "@core/logger";
import { sendTyped } from "@core/messaging/typed-messages";
import type { PageKind, PositionSnapshot, Site, Square } from "@typedefs/game";
import { DEFAULT_KEYBINDS, type Keybinds } from "@typedefs/settings";

export interface ContentOptions {
	window?: Window;
	document?: Document;
	/** Injected bridge (tests); default: a `PageBridgeClient` on `window`. */
	bridge?: PageBridge & { dispose?: () => void };
	/** Injected game port factory (tests); default: `createFeedPort`. */
	port?: (onCommand: (cmd: GamePortCommand) => void) => FeedPort;
	adapterVersion?: string;
}

export interface ContentHandle {
	readonly site: Site;
	pageKind(): PageKind;
	adapter: SiteAdapter;
	dispose(): void;
}

const LIVE_KINDS: ReadonlySet<PageKind> = new Set(["live-game", "vs-computer"]);

const EMPTY_RECT: Rect = toRect({ x: 0, y: 0, width: 0, height: 0 });

function stripApproximate(s: AdapterPositionSnapshot): PositionSnapshot {
	const { approximate: _approximate, ...snapshot } = s;
	return snapshot;
}

/** Boot the content script for the current page; `null` when the host is not a supported site. */
export function startContent(options: ContentOptions = {}): ContentHandle | null {
	const win = options.window ?? window;
	const doc = options.document ?? document;
	const site = detectSite(win.location.hostname);
	if (!site) return null;
	const adapterVersion = options.adapterVersion ?? __SL_VERSION__;

	const ownBridge = options.bridge === undefined;
	const bridge = options.bridge ?? createPageBridgeClient({ window: win });
	const adapter =
		site === "chesscom"
			? createChesscomAdapter({ document: doc, window: win, bridge })
			: createLichessAdapter({ document: doc, window: win, bridge });
	const highlights = createHighlights(adapter, false);
	let keybinds: Keybinds = { ...DEFAULT_KEYBINDS, global: false };
	let pageKind = adapter.detectPageKind();
	let sessionGameId: string | null = null;
	let disposed = false;
	const disposers: Array<() => void> = [];

	const handleCommand = (cmd: GamePortCommand): void => {
		if (disposed) return;
		if (highlights.apply(cmd)) return;
		switch (cmd.kind) {
			case "keybinds":
				keybinds = cmd.keybinds;
				return;
			case "settings":
				highlights.setEnabled(cmd.highlightMoves);
				return;
			case "startNewGame":
				if (!adapter.tryStartNewGame("new")) adapter.tryStartNewGame("rematch");
				return;
			case "speak":
				relaySpeak(cmd);
				return;
			case "observeMove":
				observeMove(cmd);
				return;
			case "geometry":
				post(geometry(cmd.id));
				return;
			default:
				return;
		}
	};

	const ownPort = options.port === undefined;
	const port = options.port
		? options.port(handleCommand)
		: createFeedPort({ onCommand: handleCommand });
	const post = (msg: GamePortMessage): void => {
		if (!disposed) port.post(msg);
	};
	const cursor = createCursorTracker({
		window: win,
		onSample: (s) => post({ kind: "cursor", ...s }),
	});

	const hello = (): void => post({ kind: "hello", site, pageKind, adapterVersion });
	const opponent = (): void => {
		const op = adapter.getOpponent();
		if (op) post({ kind: "opponent", ...op });
	};

	/** `gameStarted` (once per game id) then `position`. */
	const publish = (s: AdapterPositionSnapshot): void => {
		const snapshot = stripApproximate(s);
		if (snapshot.gameId !== sessionGameId) {
			sessionGameId = snapshot.gameId;
			post({
				kind: "gameStarted",
				game: {
					gameId: snapshot.gameId,
					site,
					pageKind,
					myColor: snapshot.myColor,
					...(snapshot.timeControl ? { timeControl: snapshot.timeControl } : {}),
					startedAt: snapshot.capturedAt,
				},
			});
			opponent();
		}
		post({ kind: "position", snapshot });
		if (snapshot.lastMove && snapshot.lastMove.san !== "") {
			post({
				kind: "moveObserved",
				san: snapshot.lastMove.san,
				ply: snapshot.ply,
				byMe: snapshot.myColor !== null && snapshot.sideToMove !== snapshot.myColor,
				atMs: snapshot.capturedAt,
			});
		}
	};

	/** V2.1: every live game page starts a session as soon as the board is readable. */
	const startSessionIfLive = (): void => {
		if (sessionGameId !== null || !LIVE_KINDS.has(pageKind)) return;
		const s = adapter.readSnapshot();
		if (s) publish(s);
	};

	const redetect = (): void => {
		if (disposed) return;
		const kind = adapter.detectPageKind();
		if (kind !== pageKind) {
			pageKind = kind;
			hello();
			opponent();
		}
		startSessionIfLive();
	};

	const observeMove = (cmd: Extract<GamePortCommand, { kind: "observeMove" }>): void => {
		highlights.clearForExecution();
		cursor.beginHand();
		adapter
			.observeMove(cmd.expected, cmd.timeoutMs)
			.then((ok) => {
				const real = cursor.endHand();
				if (real > 0) log.debug("content: real pointer events during hand", real);
				post(
					ok
						? { kind: "observeMoveResult", id: cmd.id, ok }
						: { kind: "observeMoveResult", id: cmd.id, ok, reason: "not-landed" }
				);
			})
			.catch((error: unknown) => {
				cursor.endHand();
				post({
					kind: "observeMoveResult",
					id: cmd.id,
					ok: false,
					reason: error instanceof Error ? error.message : String(error),
				});
			});
	};

	const geometry = (id: string): GamePortMessage => {
		const boardRect = adapter.getBoardRect();
		const flipped = adapter.isFlipped();
		if (!boardRect || !(boardRect.width > 0)) {
			return { kind: "geometryResult", id, boardRect: EMPTY_RECT, flipped };
		}
		const squares: Partial<Record<Square, Rect>> = {};
		for (let file = 0; file < 8; file += 1) {
			for (let rank = 0; rank < 8; rank += 1) {
				const sq = squareOf(file, rank);
				const r = sq ? adapter.squareRect(sq) : null;
				if (sq && r) squares[sq] = r;
			}
		}
		return {
			kind: "geometryResult",
			id,
			boardRect,
			squares: squares as Record<Square, Rect>,
			flipped,
		};
	};

	// ---- wiring -------------------------------------------------------------
	hello();
	opponent();
	startSessionIfLive();

	disposers.push(adapter.onPositionChange(publish));
	disposers.push(adapter.onGameStart(() => redetect()));
	disposers.push(adapter.onGameEnd((result) => post({ kind: "gameEnded", result })));
	disposers.push(adapter.onFocusEdge((edge) => post({ kind: "focus", ...edge })));

	const pending = debounced(redetect, TIMINGS.adapterDebounceMs);
	const ObserverCtor =
		(win as unknown as { MutationObserver?: typeof MutationObserver }).MutationObserver ??
		MutationObserver;
	const observer = new ObserverCtor(() => pending.trigger());
	observer.observe(doc.documentElement, { childList: true, subtree: true });
	const onPop = (): void => pending.trigger();
	win.addEventListener("popstate", onPop);
	disposers.push(() => {
		pending.cancel();
		observer.disconnect();
		win.removeEventListener("popstate", onPop);
	});

	disposers.push(
		installKeybinds(
			() => keybinds,
			(action) => {
				sendTyped({ type: MSG.CONTENT_KEYBIND, action }).catch((error: unknown) => {
					log.debug("content: keybind not delivered", error);
				});
			},
			{ window: win }
		)
	);
	sendTyped({ type: MSG.CONTENT_HELLO })
		.then((reply) => {
			if (!disposed && reply && reply.keybinds) keybinds = reply.keybinds;
		})
		.catch(() => {
			// SW asleep or absent: keep the defaults until a `keybinds` command arrives
		});

	return {
		site,
		adapter,
		pageKind: () => pageKind,
		dispose() {
			if (disposed) return;
			disposed = true;
			for (const d of disposers.splice(0).reverse()) d();
			cursor.dispose();
			adapter.destroy();
			if (ownPort) port.dispose();
			if (ownBridge) bridge.dispose?.();
		},
	};
}

let current: ContentHandle | null = null;

/** The handle of the auto-booted content script (bundle entry), if any. */
export function currentContent(): ContentHandle | null {
	return current;
}

// Bundle entry: boot once on a supported page (the guard keeps test imports inert).
if (typeof window !== "undefined" && typeof document !== "undefined" && current === null) {
	current = startContent();
}
