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
import { type GamePortCommand, type GamePortMessage, PORT_NAMES } from "@core/constants";
import { DEFAULT_KEYBINDS } from "@core/constants/defaults";
import { type ConnectedPort, connectPort } from "@core/messaging/ports";
import { defaultScheduler } from "@core/util/scheduler";
import type { Simulator } from "@test/sim";
import { bootContentContext, type ContentContext } from "@test/sim/contexts/content-context";
import type { TabDom } from "@test/sim/dom/tab-dom";
import { type AcShadow, createAcShadow } from "@test/sim/telemetry/ac-shadow";
import { SIM_TELEMETRY } from "@test/sim/telemetry/constants";
import { createSimBoard, type SimBoard } from "@test/sim/telemetry/sim-board";
import type { Color, PositionSnapshot, Site, Square } from "@typedefs/game";

export interface SimulatedSiteOptions {
	site?: Site;
	myColor?: Color;
	fen?: string;
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
	const site: Site = options.site ?? "chesscom";
	const myColor: Color = options.myColor ?? "w";
	const board = createSimBoard(dom, { myColor, ...(options.fen ? { fen: options.fen } : {}) });
	const shadow = createAcShadow(dom, board, { now: sim.now });
	const win = dom.window as unknown as Window;
	const doc = dom.document as unknown as Document;
	const focusEvents = { blur: 0, focus: 0 };
	let pageFocused = true;
	let lastBlurAt: number | null = null;
	const observeRequests: Array<{ from: Square; to: Square }> = [];
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
				},
				{ window: win, now: sim.now }
			);
			port.post({ kind: "focus", hasFocus: true, visibility: "visible", at: sim.now() });
			const rest = SIM_TELEMETRY.restPoint;
			port.post({ kind: "cursor", x: rest.x, y: rest.y, t: sim.now(), real: true });
		},
	});

	function snapshot(clocks: { w: number; b: number }): PositionSnapshot {
		const last = board.lastMove();
		const s: PositionSnapshot = {
			site,
			gameId: "sim-game",
			fen: board.fen(),
			ply: board.ply(),
			sideToMove: board.chess.turn() as Color,
			myColor,
			clocks: { w: { ms: clocks.w, running: true }, b: { ms: clocks.b, running: true } },
			capturedAt: sim.now(),
		};
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
		arrive(opponentUci, clocks) {
			if (opponentUci !== null) board.applyOpponent(opponentUci);
			shadow.positionArrived(sim.now());
			port?.post({ kind: "position", snapshot: snapshot(clocks) });
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
