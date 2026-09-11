/**
 * ISOLATED-world content script entry (Task 21, §3.4a, §13.4, V2.1).
 *
 * Boots the site adapter with a `PageBridgeClient`, opens the game port and:
 *   - sends `hello` (`site`, `pageKind`, `adapterVersion`) and `opponent`;
 *   - starts a session on every live game page (`live-game`, `vs-computer`):
 *     `gameStarted` + the current `position` as soon as the board is readable
 *     (a readiness poll at `TIMINGS.contentReadyPollMs` until then), then
 *     every position change (with `capturedAt`), `moveObserved`, `gameEnded`;
 *   - forwards every `focus` / `blur` / `visibilitychange` edge as `focus`;
 *   - reports the board's viewport rect as `boardRect` whenever the page moves
 *     or resizes it (§9.5), so the service worker never drives the hand into
 *     coordinates the page has already left behind;
 *   - re-detects the page kind on `popstate`, on the adapter's game start,
 *     and on a `location.href` change (polled at
 *     `TIMINGS.adapterSelfCheckIntervalMs`, `pushState` / `replaceState`
 *     agnostic) and re-sends `hello` when it changes;
 *   - answers `observeMove` (the verifier: it never touches the board's marks —
 *     the mark of the move being submitted belongs to the hand's whole action),
 *     `geometry` (square/board rects plus colour-aware occupancy; with
 *     `promotion` it waits for the picker on `to` and reports its rect),
 *     `boardCheck` (the executor's colour-aware position guard) and
 *     `cursorProbe` (bridge closure, else the tracker);
 *   - applies `highlight` / `arrow` / `clearHighlight` only while the
 *     `settings` command has turned `highlightMoves` on (off until it arrives);
 *   - installs the in-page keybinds (`keybinds` command updates them; the
 *     initial set comes from the `CONTENT_HELLO` request) and the cursor
 *     tracker (trusted samples on the port; unthrottled while the hand moves);
 *   - ignores `speak` (TTS lives in the service worker, `tts-relay.ts`).
 *
 * `document_start` boot: the manifest injects this script before `<body>`
 * exists. `startContent()` then returns a deferred handle — page kind from
 * the URL, no adapter, nothing sent — and completes the boot once the body
 * appears (`DOMContentLoaded` / `readystatechange` / a poll), so the
 * adapter never sees a body-less document.
 *
 * Every listener / timer is released by `dispose()`. No page storage, no
 * synthetic events, no DOM insertion from this world (§13.3).
 */

import {
	type AdapterPositionSnapshot,
	BRIDGE_KINDS,
	debounced,
	type PageBridge,
	type Rect,
	type SiteAdapter,
	toRect,
} from "@content/adapters/adapter";
import { createChesscomAdapter } from "@content/adapters/chesscom";
import { pageKindFromPath } from "@content/adapters/page-kind";
import { occupancyOf, waitForPromotionRect } from "@content/board-state";
import {
	type CursorSample,
	type CursorTracker,
	createCursorTracker,
} from "@content/cursor-tracker";
import { createFeedPort, type FeedPort } from "@content/feed-port";
import { createHighlights } from "@content/highlights";
import { installKeybinds } from "@content/keybinds";
import { type BridgeCursor, createPageBridgeClient } from "@content/page-bridge-client";
import { detectSite } from "@content/site-detect";
import { relaySpeak } from "@content/tts-relay";
import { createVirtualCursor } from "@content/virtual-cursor";
import { ALL_SQUARES, squareOf } from "@core/chess/squares";
import { EXECUTOR } from "@core/constants/cdp";
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
	/** `null` while the boot is deferred (no `<body>` yet). */
	adapter(): SiteAdapter | null;
	dispose(): void;
}

type ObserveMoveCommand = Extract<GamePortCommand, { kind: "observeMove" }>;
type GeometryCommand = Extract<GamePortCommand, { kind: "geometry" }>;
type BoardCheckCommand = Extract<GamePortCommand, { kind: "boardCheck" }>;

const LIVE_KINDS: ReadonlySet<PageKind> = new Set(["live-game", "vs-computer"]);

interface CursorBinding {
	tracker: CursorTracker;
	onSample?: (sample: CursorSample) => void;
}

const EMPTY_RECT: Rect = toRect({ x: 0, y: 0, width: 0, height: 0 });

/** Boot the content script for the current page; `null` when the host is not a supported site. */
export function startContent(options: ContentOptions = {}): ContentHandle | null {
	const win = options.window ?? window;
	const doc = options.document ?? document;
	const site = detectSite(win.location.hostname);
	if (!site) return null;
	// Install capture at document_start, before page listeners; the board may be parsed much later.
	const cursor: CursorBinding = {
		tracker: createCursorTracker({ window: win, onSample: (sample) => cursor.onSample?.(sample) }),
	};
	if (doc.body) return bootContent(site, win, doc, options, cursor);
	return deferUntilBody(site, win, doc, options, cursor);
}

/** `document_start` path: wait for `<body>` before touching the adapter. */
function deferUntilBody(
	site: Site,
	win: Window,
	doc: Document,
	options: ContentOptions,
	cursorBinding: CursorBinding
): ContentHandle {
	let inner: ContentHandle | null = null;
	let done = false;
	const stop = (): void => {
		if (done) return;
		done = true;
		clearInterval(timer);
		doc.removeEventListener("DOMContentLoaded", tryBoot, true);
		doc.removeEventListener("readystatechange", tryBoot, true);
	};
	const tryBoot = (): void => {
		if (done || !doc.body) return;
		stop();
		inner = bootContent(site, win, doc, options, cursorBinding);
	};
	doc.addEventListener("DOMContentLoaded", tryBoot, true);
	doc.addEventListener("readystatechange", tryBoot, true);
	const timer = setInterval(tryBoot, TIMINGS.contentReadyPollMs);
	return {
		site,
		pageKind: () => inner?.pageKind() ?? pageKindFromPath(win.location.pathname),
		adapter: () => inner?.adapter() ?? null,
		dispose() {
			stop();
			if (inner) inner.dispose();
			else cursorBinding.tracker.dispose();
		},
	};
}

function bootContent(
	site: Site,
	win: Window,
	doc: Document,
	options: ContentOptions,
	cursorBinding: CursorBinding
): ContentHandle {
	const adapterVersion = options.adapterVersion ?? __SL_VERSION__;
	const ownBridge = options.bridge === undefined;
	const bridge = options.bridge ?? createPageBridgeClient({ window: win });
	const adapter = createChesscomAdapter({ document: doc, window: win, bridge });
	const highlights = createHighlights(adapter, false);
	// Fix D: the mirror of the hand's own pointer. Drawn by the MAIN-world bridge (§13.3), driven
	// only by what the service worker dispatched — never by a pointer event read here.
	const virtualCursor = createVirtualCursor(bridge, (shown) => cursor.setVirtualActive(shown));
	let keybinds: Keybinds = { ...DEFAULT_KEYBINDS, global: false };
	let pageKind = adapter.detectPageKind();
	let sessionGameId: string | null = null;
	let disposed = false;
	let port: FeedPort | null = null;
	let readyTimer: ReturnType<typeof setInterval> | null = null;
	const disposers: Array<() => void> = [];

	// ---- outgoing ---------------------------------------------------------------
	const post = (msg: GamePortMessage): void => {
		if (!disposed) port?.post(msg);
	};
	const hello = (): void => post({ kind: "hello", site, pageKind, adapterVersion });
	const opponent = (): void => {
		const op = adapter.getOpponent();
		if (op) post({ kind: "opponent", ...op });
	};
	const cursor = cursorBinding.tracker;
	cursorBinding.onSample = (s) => post({ kind: "cursor", ...s });

	/** `gameStarted` (once per game id) then `position`. */
	const publish = (s: AdapterPositionSnapshot): void => {
		// `approximate` travels with the snapshot: the service worker cannot otherwise tell a FEN the
		// page gave us from one the adapter reconstructed, and a reading derived from the move-list ply
		// is exactly what a first-move decision must not trust (§13.4, the 2026-09-10 ruling).
		const snapshot: PositionSnapshot = s;
		if (snapshot.gameId !== sessionGameId) {
			sessionGameId = snapshot.gameId;
			stopReadyPoll();
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
		else startReadyPoll();
	};

	function startReadyPoll(): void {
		if (readyTimer !== null || disposed) return;
		readyTimer = setInterval(() => startSessionIfLive(), TIMINGS.contentReadyPollMs);
	}
	function stopReadyPoll(): void {
		if (readyTimer === null) return;
		clearInterval(readyTimer);
		readyTimer = null;
	}

	const redetect = (): void => {
		if (disposed) return;
		const kind = adapter.detectPageKind();
		if (kind !== pageKind) {
			pageKind = kind;
			hello();
			opponent();
		}
		if (!LIVE_KINDS.has(pageKind)) stopReadyPoll();
		startSessionIfLive();
	};

	// ---- responders -------------------------------------------------------------
	/**
	 * `observeMove` is the executor's **verifier**, and it must not touch the board's marks.
	 *
	 * It used to clear them first, on §13.3 rule 4 ("no mark may be present at move-submission
	 * time"). The owner has overruled that rule for the mark of the move being submitted
	 * (2026-09-10), and the clear here was the reason it could not hold: `runWithRetry` issues a
	 * `verify` after every attempt and a `recheck` before every retry
	 * (`src/service/move-executor/retry-policy.ts`, the `recheck` before each subsequent attempt and
	 * the `verify` after each), both of which are an `observeMove`, so the second attempt — a whole
	 * second visible action, and since click-to-move was removed a second *drag* — ran with nothing
	 * on the board. The only clear now is
	 * completion: `GameSession.onExecuted` for a move that landed, `onNotExecuted` for an attempt
	 * that finally failed. `highlightMoves` going off still clears, which is a different thing.
	 */
	const observeMove = (cmd: ObserveMoveCommand): void => {
		if (disposed) return;
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
		const reply: GamePortMessage = {
			kind: "geometryResult",
			id,
			boardRect,
			squares: squares as Record<Square, Rect>,
			flipped,
		};
		// The preview planner's deselect choice needs to know what stands where (§9.3a), and the
		// executor's position guard answers from the same read instead of a second round trip.
		const occupancy = occupancyOf(adapter, ALL_SQUARES);
		if (Object.keys(occupancy).length > 0) reply.occupancy = occupancy;
		return reply;
	};

	/** Task 30: `geometry { promotion, to }` — wait for the picker, then answer with its rect. */
	const promotionGeometry = (cmd: GeometryCommand): void => {
		const piece = cmd.promotion;
		const dest = cmd.to;
		const base = geometry(cmd.id);
		if (piece === undefined || dest === undefined || base.kind !== "geometryResult") {
			post({ ...base, promotion: null } as GamePortMessage);
			return;
		}
		void waitForPromotionRect(adapter, dest, piece, {
			timeoutMs: cmd.timeoutMs ?? EXECUTOR.promotionPickerTimeoutMs,
		}).then((rect) => {
			if (disposed) return;
			// The board may have moved while the picker was opening: re-read the rects.
			const fresh = geometry(cmd.id);
			post(fresh.kind === "geometryResult" ? { ...fresh, promotion: rect } : fresh);
		});
	};

	/**
	 * Task 30: the executor's colour-aware pre-dispatch guard (§9.3). Answers at once with
	 * `own` / `enemy` / `empty` for exactly the squares asked, relative to the side the hand
	 * plays; a square the adapter cannot classify is omitted and the executor dispatches nothing.
	 */
	const boardCheck = (cmd: BoardCheckCommand): void => {
		post({ kind: "boardCheckResult", id: cmd.id, occupancy: occupancyOf(adapter, cmd.squares) });
	};

	/** §5.5 `cursor-probe`: the bridge closure's last trusted position, else the tracker's. */
	const cursorProbe = (id: string): void => {
		const answer = (c: BridgeCursor | null): void => {
			const position = c ? { x: c.x, y: c.y, t: c.t, real: true as const } : cursor.report();
			post({ kind: "cursorProbeResult", id, position });
		};
		if (!bridge.isAvailable()) {
			answer(null);
			return;
		}
		bridge
			.call<BridgeCursor | null>(BRIDGE_KINDS.cursor, undefined, TIMINGS.adapterBridgeTimeoutMs)
			.then(answer)
			.catch(() => answer(null));
	};

	const handleCommand = (cmd: GamePortCommand): void => {
		if (disposed) return;
		if (highlights.apply(cmd)) return;
		if (virtualCursor.apply(cmd)) return;
		switch (cmd.kind) {
			case "cursorDelivery":
				post({
					kind: "cursorDelivered",
					id: cmd.id,
					delivered: cursor.virtualPointerDelivered(cmd.pointer),
				});
				return;
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
				if (cmd.promotion !== undefined) promotionGeometry(cmd);
				else post(geometry(cmd.id));
				return;
			case "boardCheck":
				boardCheck(cmd);
				return;
			case "cursorPrepare":
				void virtualCursor.prepare(cmd.pointer).then((ready) => {
					if (!ready || disposed) return;
					cursor.prepareVirtualPointer(cmd.pointer);
					post({ kind: "cursorPrepared", id: cmd.id });
				});
				return;
			case "cursorProbe":
				cursorProbe(cmd.id);
				return;
			default:
				return;
		}
	};

	// ---- wiring -------------------------------------------------------------------
	const ownPort = options.port === undefined;
	port = options.port
		? options.port(handleCommand)
		: createFeedPort({
				onCommand: handleCommand,
				onDisconnect: () => {
					virtualCursor.apply({ kind: "cursorHide" });
					cursor.setVirtualActive(false);
				},
			});
	hello();
	opponent();
	startSessionIfLive();

	disposers.push(adapter.onPositionChange(publish));
	// §9.5: the board moving under the hand is a geometry change the service worker must know about
	// before it commits the rest of a drag to the old coordinate space.
	disposers.push(
		adapter.onBoardRect((rect) =>
			post({
				kind: "boardRect",
				rect: { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
			})
		)
	);
	disposers.push(adapter.onGameStart(() => redetect()));
	disposers.push(adapter.onGameEnd((result) => post({ kind: "gameEnded", result })));
	disposers.push(adapter.onFocusEdge((edge) => post({ kind: "focus", ...edge })));

	// page-kind re-detection: popstate at once, pushState/replaceState via the href poll
	const pending = debounced(redetect, TIMINGS.adapterDebounceMs);
	const onPop = (): void => pending.trigger();
	win.addEventListener("popstate", onPop);
	let lastHref = win.location.href;
	const hrefTimer = setInterval(() => {
		if (win.location.href === lastHref) return;
		lastHref = win.location.href;
		pending.trigger();
	}, TIMINGS.adapterSelfCheckIntervalMs);
	disposers.push(() => {
		pending.cancel();
		clearInterval(hrefTimer);
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
		adapter: () => adapter,
		pageKind: () => pageKind,
		dispose() {
			if (disposed) return;
			disposed = true;
			stopReadyPoll();
			for (const d of disposers.splice(0).reverse()) d();
			// Before the bridge goes: the mirror is page DOM and must not be left behind (§13.3).
			virtualCursor.dispose();
			cursor.dispose();
			adapter.destroy();
			if (ownPort) port?.dispose();
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
