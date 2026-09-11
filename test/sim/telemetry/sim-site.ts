// test/sim/telemetry/sim-site.ts
/**
 * The page half of the telemetry harness: one simulated chess site in a tab —
 * the chess.js board (`sim-board.ts`), the `ac` shadow listening to that
 * page, and the ISOLATED-world content side reduced to what the executor
 * needs over the game port (`geometry`, `boardCheck`, `observeMove`), plus
 * the real `installFocusEdges` and `createCursorTracker` so `focus` and
 * `cursor` messages reach the service worker exactly as Task 21 sends them.
 *
 * happy-dom has no window-focus model (`document.hasFocus()` is always true
 * and nothing blurs a tab), so the site models the one assumption §13.4 rests
 * on: an interaction outside the page (`panelClick()`) blurs the window and
 * `document.hasFocus()` turns false until `clickIntoBoard()`. Real mouse
 * input is injected with `realPointer()` as trusted pointer events that did
 * not come through CDP. Task 30 boots the real service worker against this
 * same page half.
 */

import { installFocusEdges } from "@content/adapters/adapter";
import { type CursorTracker, createCursorTracker } from "@content/cursor-tracker";
import { installKeybinds, type KeybindAction } from "@content/keybinds";
import { type GamePortCommand, type GamePortMessage, MSG, PORT_NAMES } from "@core/constants";
import { DEFAULT_KEYBINDS } from "@core/constants/defaults";
import { type ConnectedPort, connectPort } from "@core/messaging/ports";
import { sendTyped } from "@core/messaging/typed-messages";
import { defaultScheduler } from "@core/util/scheduler";
import type { Simulator } from "@test/sim";
import { bootContentContext, type ContentContext } from "@test/sim/contexts/content-context";
import type { TabDom } from "@test/sim/dom/tab-dom";
import { type AcShadow, createAcShadow } from "@test/sim/telemetry/ac-shadow";
import { SIM_TELEMETRY } from "@test/sim/telemetry/constants";
import { createSimBoard, type SimBoard } from "@test/sim/telemetry/sim-board";
import type {
	Color,
	GameMeta,
	GameResult,
	PageKind,
	PositionSnapshot,
	Site,
	Square,
} from "@typedefs/game";

export interface SimulatedSiteOptions {
	myColor?: Color;
	fen?: string;
	gameId?: string;
	pageKind?: PageKind;
	/** Task 30: forward in-page keybinds to the service worker as `CONTENT_KEYBIND`. */
	sendKeybinds?: boolean;
	/**
	 * The site's own time control, as it reports it on `gameStarted` and every `position`.
	 * **Omitted / null means the site has not answered yet** — `timeControl.get()` is null until
	 * the game actually starts (owner's capture, 2026-09-09), which is the production order: the
	 * first snapshot is taken before the MAIN-world bridge has answered anything. Use
	 * `setTimeControl` to deliver it later, the way the page does.
	 */
	timeControl?: { baseMs: number; incMs: number } | null;
	/**
	 * Whether the site holds a move made on the opponent's turn as a **premove** (chess.com's own
	 * setting, which the extension cannot read). Default `false`: the piece snaps back, which is
	 * what a player with premoves switched off sees and the fallback §7.4 has to cope with.
	 */
	premoves?: boolean;
	/**
	 * Called for every command the service worker sends down the game port, in order, as it
	 * arrives. `commands()` is the same stream sampled after the fact; this hook is for a test that
	 * has to know *when* a command landed relative to what the page was doing (Fix A: is the board
	 * still marked at the moment the hand presses?).
	 */
	onCommand?: (cmd: GamePortCommand) => void;
}

export interface SimulatedSite {
	readonly tabId: number;
	readonly dom: TabDom;
	readonly board: SimBoard;
	readonly shadow: AcShadow;
	readonly content: ContentContext;
	/** The move window opens: the opponent's reply (or the game start) is on the board. */
	arrive(opponentUci: string | null, clocks: { w: number; b: number }): void;
	/** A click/typing in the side panel: the page window blurs (§13.4 design assumption). */
	panelClick(): void;
	/** The user clicks into the board again: the page window regains focus. */
	clickIntoBoard(): void;
	/** The real mouse (not CDP): a trusted pointer event at viewport `(x, y)`. */
	realPointer(type: "pointermove" | "pointerdown" | "pointerup", x: number, y: number): void;
	/** A trusted `keydown` on the page window — the in-page keybind path (§13.4). */
	pressKey(init: { key: string; code: string; shiftKey?: boolean }): void;
	/** Keybind actions the content script's capture-phase listener fired, in order. */
	keybindActions(): KeybindAction[];
	/** `blur` / `focus` events the page window saw. */
	pageFocusEvents(): { blur: number; focus: number };
	lastBlurAt(): number | null;
	/** Every `observeMove` request the executor made. */
	observeRequests(): Array<{ from: Square; to: Square }>;
	/** The premove the site is holding, if any (`premoves` must be on for it to hold one). */
	premoveQueued(): { from: Square; to: Square } | null;
	/** Every command the service worker sent down the game port, in order (Task 30). */
	commands(): GamePortCommand[];
	/** Post a raw feed message (Task 30: reconnect replays, races the board cannot produce). */
	post(msg: GamePortMessage): void;
	/** Task 30: the port `hello` a real content script sends on boot. */
	hello(pageKind?: PageKind): void;
	/** Task 30: `gameStarted` for the current board. */
	startGame(meta?: Partial<GameMeta>): void;
	/** Task 30: `gameEnded`. */
	endGame(result?: GameResult): void;
	/** Task 30: the §13.6 opponent identity. */
	opponent(info: { isBot: boolean; name: string; ratingEstimate: number | null }): void;
	/** §4.3: the site learns its own time control (the game actually started). */
	setTimeControl(tc: { baseMs: number; incMs: number } | null): void;
	/** The game id every `position` / `gameStarted` carries. */
	readonly gameId: string;
	dispose(): Promise<void>;
}

export async function createSimulatedSite(
	sim: Simulator,
	tabId: number,
	options: SimulatedSiteOptions = {}
): Promise<SimulatedSite> {
	const tabDom = sim.getTabDom(tabId);
	if (!tabDom) throw new Error("createSimulatedSite: the tab has no DOM (use sim.openTab)");
	const dom: TabDom = tabDom;
	const site: Site = "chesscom";
	const myColor: Color = options.myColor ?? "w";
	const gameId = options.gameId ?? "sim-game";
	const pageKind: PageKind = options.pageKind ?? "live-game";
	const board = createSimBoard(dom, {
		myColor,
		...(options.fen ? { fen: options.fen } : {}),
		...(options.premoves === true ? { premoves: true } : {}),
	});
	const shadow = createAcShadow(dom, board, { now: sim.now });
	const win = dom.window as unknown as Window;
	const doc = dom.document as unknown as Document;
	const focusEvents = { blur: 0, focus: 0 };
	let pageFocused = true;
	let lastBlurAt: number | null = null;
	const observeRequests: Array<{ from: Square; to: Square }> = [];
	const received: GamePortCommand[] = [];
	Object.defineProperty(doc, "hasFocus", { configurable: true, value: () => pageFocused });
	const countBlur = (): void => {
		focusEvents.blur += 1;
	};
	const countFocus = (): void => {
		focusEvents.focus += 1;
	};
	win.addEventListener("blur", countBlur, true);
	win.addEventListener("focus", countFocus, true);

	let port: ConnectedPort<GamePortMessage> | null = null;
	let tracker: CursorTracker | null = null;
	let removeFocusEdges: () => void = () => {};
	let removeKeybinds: () => void = () => {};
	const keybindActions: KeybindAction[] = [];
	const pending: Array<{
		id: string;
		from: Square;
		to: Square;
		timer: ReturnType<typeof setTimeout>;
	}> = [];

	const settle = (): void => {
		const last = board.lastMove();
		if (!last?.byMe) return;
		for (const p of [...pending]) {
			if (last.from === p.from && last.to === p.to) {
				clearTimeout(p.timer);
				pending.splice(pending.indexOf(p), 1);
				port?.post({ kind: "observeMoveResult", id: p.id, ok: true });
			}
		}
	};
	board.onChange(settle);

	const onCommand = (cmd: GamePortCommand): void => {
		received.push(cmd);
		options.onCommand?.(cmd);
		if (!port) return;
		if (cmd.kind === "geometry") {
			if (cmd.promotion !== undefined) {
				port.post({
					kind: "geometryResult",
					id: cmd.id,
					boardRect: board.boardRect,
					flipped: myColor === "b",
					promotion: null,
				});
				return;
			}
			const squares: Partial<Record<Square, typeof board.boardRect>> = {};
			for (const sq of Object.keys(board.occupancyMap()) as Square[])
				squares[sq] = board.squareRect(sq);
			port.post({
				kind: "geometryResult",
				id: cmd.id,
				boardRect: board.boardRect,
				squares,
				flipped: myColor === "b",
				occupancy: board.occupancyMap(),
			});
		} else if (cmd.kind === "boardCheck") {
			const occupancy: Partial<Record<Square, "own" | "enemy" | "empty">> = {};
			for (const sq of cmd.squares) occupancy[sq] = board.occupancy(sq);
			port.post({ kind: "boardCheckResult", id: cmd.id, occupancy });
		} else if (cmd.kind === "observeMove") {
			observeRequests.push({ from: cmd.expected.from, to: cmd.expected.to });
			const timer = setTimeout(() => {
				const idx = pending.findIndex((p) => p.id === cmd.id);
				if (idx < 0) return;
				pending.splice(idx, 1);
				port?.post({ kind: "observeMoveResult", id: cmd.id, ok: false, reason: "not observed" });
			}, cmd.timeoutMs);
			pending.push({ id: cmd.id, from: cmd.expected.from, to: cmd.expected.to, timer });
			settle();
		}
	};

	const content = await bootContentContext(sim, tabId, {
		entry: () => {
			port = connectPort<GamePortMessage, GamePortCommand>(PORT_NAMES.game, {
				scheduler: defaultScheduler,
				onMessage: onCommand,
			});
			removeFocusEdges = installFocusEdges(win, doc, (edge) => port?.post({ kind: "focus", ...edge }));
			tracker = createCursorTracker({
				window: win,
				onSample: (s) => port?.post({ kind: "cursor", ...s }),
			});
			// The page-scoped half of §13.4's "every in-game control is a shortcut": `global: false`
			// keeps this listener live (with `global` on, `chrome.commands` owns the shortcut instead).
			removeKeybinds = installKeybinds(
				() => ({ ...DEFAULT_KEYBINDS, global: false }),
				(action) => {
					keybindActions.push(action);
					if (options.sendKeybinds !== true) return;
					// The real content script forwards the action to the service worker (Task 21).
					sendTyped({ type: MSG.CONTENT_KEYBIND, action }).catch(() => {});
				},
				{ window: win, now: sim.now }
			);
			// No fabricated initial `focus` post here: the real `installFocusEdges` above reports the
			// current state once at install, exactly as the content script does. Inventing the message
			// in this fake made every simulated game start with focus *known*, which hid a production
			// hold — `FocusGate.hasFocus` staying `null` for a tab that was focused the whole time —
			// for as long as the fabrication existed.
			const rest = SIM_TELEMETRY.restPoint;
			port.post({ kind: "cursor", x: rest.x, y: rest.y, t: sim.now(), real: true });
		},
	});

	let timeControl = options.timeControl ?? null;

	function snapshot(clocks: { w: number; b: number }): PositionSnapshot {
		const last = board.lastMove();
		const s: PositionSnapshot = {
			site,
			gameId,
			fen: board.fen(),
			ply: board.ply(),
			sideToMove: board.chess.turn() as Color,
			myColor,
			// Stated, like the real adapter states it: this FEN is the board's own, so it is exact. The
			// service worker treats an *unstated* provenance as untrusted (§13.4), and a fake that left
			// it out would be exercising a path production never takes.
			approximate: false,
			clocks: { w: { ms: clocks.w, running: true }, b: { ms: clocks.b, running: true } },
			capturedAt: sim.now(),
		};
		if (timeControl) s.timeControl = { ...timeControl };
		if (last) s.lastMove = { from: last.from, to: last.to, san: last.san };
		return s;
	}

	function pointer(type: "pointermove" | "pointerdown" | "pointerup", x: number, y: number): void {
		const target = dom.elementAt(x, y) ?? (dom.document.body as unknown as Element);
		const ev = new dom.window.PointerEvent(type, {
			bubbles: true,
			cancelable: true,
			composed: true,
			clientX: x,
			clientY: y,
			button: 0,
			buttons: type === "pointerdown" ? 1 : 0,
			pointerType: "mouse",
			isPrimary: true,
		});
		Object.defineProperty(ev, "isTrusted", { value: true, configurable: true });
		(target as unknown as { dispatchEvent(e: Event): boolean }).dispatchEvent(ev as unknown as Event);
	}

	return {
		tabId,
		dom,
		board,
		shadow,
		content,
		gameId,
		arrive(opponentUci, clocks) {
			if (opponentUci !== null) board.applyOpponent(opponentUci);
			// The client's move window for *our* next move opens when the opponent's move lands …
			shadow.positionArrived(sim.now());
			// … and a premove the site was holding is submitted inside it, a few ms later, which is
			// the whole reason a premove's `MoveHoldTime` is near zero.
			const premove = board.premoveQueued();
			if (board.firePremove() === "played" && premove)
				shadow.siteSubmitted(premove.from, premove.to, sim.now());
			const s = snapshot(clocks);
			port?.post({ kind: "position", snapshot: s });
			const last = board.lastMove();
			if (last)
				port?.post({
					kind: "moveObserved",
					san: last.san,
					ply: last.ply,
					byMe: last.byMe,
					atMs: sim.now(),
				});
		},
		hello(kind = pageKind) {
			port?.post({ kind: "hello", site, pageKind: kind, adapterVersion: "sim" });
		},
		startGame(meta = {}) {
			port?.post({
				kind: "gameStarted",
				game: {
					gameId,
					site,
					pageKind,
					myColor,
					...(timeControl ? { timeControl: { ...timeControl } } : {}),
					startedAt: sim.now(),
					...meta,
				},
			});
		},
		endGame(result = "1-0") {
			port?.post({ kind: "gameEnded", result });
		},
		setTimeControl(tc) {
			timeControl = tc;
		},
		opponent(info) {
			port?.post({ kind: "opponent", ...info });
		},
		panelClick() {
			if (!pageFocused) return;
			pageFocused = false;
			lastBlurAt = sim.now();
			win.dispatchEvent(new dom.window.Event("blur") as unknown as Event);
		},
		clickIntoBoard() {
			if (pageFocused) return;
			pageFocused = true;
			win.dispatchEvent(new dom.window.Event("focus") as unknown as Event);
		},
		realPointer: pointer,
		pressKey(init) {
			const ev = new dom.window.KeyboardEvent("keydown", {
				bubbles: true,
				cancelable: true,
				composed: true,
				key: init.key,
				code: init.code,
				shiftKey: init.shiftKey ?? false,
			});
			Object.defineProperty(ev, "isTrusted", { value: true, configurable: true });
			win.dispatchEvent(ev as unknown as Event);
		},
		keybindActions: () => [...keybindActions],
		pageFocusEvents: () => ({ ...focusEvents }),
		lastBlurAt: () => lastBlurAt,
		observeRequests: () => [...observeRequests],
		premoveQueued: () => board.premoveQueued(),
		commands: () => [...received],
		post(msg) {
			port?.post(msg);
		},
		async dispose() {
			for (const p of pending.splice(0)) clearTimeout(p.timer);
			removeFocusEdges();
			removeKeybinds();
			tracker?.dispose();
			shadow.dispose();
			win.removeEventListener("blur", countBlur, true);
			win.removeEventListener("focus", countFocus, true);
			port?.disconnect();
			await content.teardown();
		},
	};
}
