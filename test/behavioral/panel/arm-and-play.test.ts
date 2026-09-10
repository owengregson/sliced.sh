// test/behavioral/panel/arm-and-play.test.ts — Task 28 Step 1: panel commands drive the real
// executor stack (debugger manager, content link, focus gate, hand ownership, MoveExecutor) through
// the panel handlers, and the broadcaster surfaces the results (snapshot + toasts) over the port.
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
	CDP,
	type GamePortCommand,
	type GamePortMessage,
	MSG,
	PANEL_COMMAND_ERRORS,
	type PanelPortMessage,
	type PanelSnapshot,
	PORT_NAMES,
	TIMINGS,
	TOAST_KEYS,
} from "@core/constants";
import { DEFAULT_SETTINGS } from "@core/constants/defaults";
import { type ConnectedPort, connectPort } from "@core/messaging/ports";
import { installMessageRouter, type MessageRouter } from "@core/messaging/router";
import type { Occupancy, Rect } from "@core/motor/types";
import { defaultScheduler } from "@core/util/scheduler";
import { createPanelStore, type PanelStore } from "@panel/store";
import { ContentLink } from "@service/content-link";
import { DebuggerManager } from "@service/debugger-manager";
import { FocusGate } from "@service/focus-gate";
import { HandOwnership } from "@service/hand-ownership";
import { registerPanelHandlers } from "@service/handlers/panel";
import { Keepalive } from "@service/keepalive";
import { MoveExecutor } from "@service/move-executor";
import { PanelBroadcaster, type SnapshotSources } from "@service/panel-broadcaster";
import { createSimulator, type Simulator } from "@test/sim";
import { bootContentContext, type ContentContext } from "@test/sim/contexts/content-context";
import { bootPanelContext, type PanelContext } from "@test/sim/contexts/panel-context";
import { bootSwContext, type SwContext } from "@test/sim/contexts/sw-context";
import type { Square } from "@typedefs/game";
import type { LicenseState, Settings } from "@typedefs/settings";
import { ALL_SQUARES, BOARD, inside, squareRect } from "../../core/motor/fixtures";
import { FakeSession, fakeSources, makePlan, makeRecommendation } from "./harness";

/**
 * §4.4: these tests are a user who has the assistant *on*, said explicitly rather than inherited
 * from `DEFAULT_SETTINGS` — the acting panel commands (arm, play, re-attach) refuse while the
 * switch is off, so the fixture must not move when the default does.
 */
const SETTINGS: Settings = { ...DEFAULT_SETTINGS, enabled: true };

const START = 1_000_000;
const MS = 1000;
const LICENSE: LicenseState = { status: "valid", checkedAt: START };

let sim: Simulator;
let sw: SwContext;
let content: ContentContext;
let panel: PanelContext;
let store: PanelStore;
let tabId: number;
let keepalive: Keepalive;
let dbg: DebuggerManager;
let link: ContentLink;
let focus: FocusGate;
let ownership: HandOwnership;
let executor: MoveExecutor;
let router: MessageRouter;
let broadcaster: PanelBroadcaster;
let sources: SnapshotSources;
let session: FakeSession;
let port: ConnectedPort<GamePortMessage>;
let toasts: Array<Extract<PanelPortMessage, { kind: "toast" }>>;
let snapshots: PanelSnapshot[];
/** Board commands the fake adapter received. */
let boardCommands: GamePortCommand[];

function startOccupancy(): Partial<Record<Square, Occupancy>> {
	const occ: Partial<Record<Square, Occupancy>> = {};
	for (const sq of ALL_SQUARES) {
		const rank = Number(sq[1]);
		occ[sq] = rank <= 2 ? "own" : rank >= 7 ? "enemy" : "empty";
	}
	return occ;
}

function buildBoard(): void {
	const dom = sim.getTabDom(tabId);
	if (!dom) throw new Error("no dom");
	dom.setHTML(`<div id="board">${ALL_SQUARES.map((sq) => `<div id="${sq}"></div>`).join("")}</div>`);
	const asLayout = (r: Rect) => ({ x: r.left, y: r.top, width: r.width, height: r.height });
	dom.layout("#board", asLayout(BOARD));
	for (const sq of ALL_SQUARES) dom.layout(`#${sq}`, asLayout(squareRect(sq)));
}

/** The content side reduced to what the executor and the preview command need. */
function bootFakeAdapter(): void {
	const dom = sim.getTabDom(tabId);
	if (!dom) throw new Error("no dom");
	const board = dom.query("#board");
	const occupancy = startOccupancy();
	let lastDown: string | null = null;
	let lastUp: string | null = null;
	const pending: Array<{ id: string; from: Square; to: Square; timer: unknown }> = [];
	const settle = (): void => {
		for (const p of [...pending]) {
			if (lastDown === p.from && lastUp === p.to) {
				clearTimeout(p.timer as ReturnType<typeof setTimeout>);
				pending.splice(pending.indexOf(p), 1);
				port.post({ kind: "observeMoveResult", id: p.id, ok: true });
			}
		}
	};
	board.addEventListener("mousedown", (e) => {
		lastDown = (e.target as { id?: string }).id ?? null;
	});
	board.addEventListener("mouseup", (e) => {
		lastUp = (e.target as { id?: string }).id ?? null;
		settle();
	});
	port = connectPort<GamePortMessage, GamePortCommand>(PORT_NAMES.game, {
		scheduler: defaultScheduler,
		onMessage: (cmd) => {
			if (cmd.kind === "geometry") {
				port.post({ kind: "geometryResult", id: cmd.id, boardRect: BOARD, flipped: false });
			} else if (cmd.kind === "boardCheck") {
				const seen: Partial<Record<Square, Occupancy>> = {};
				for (const sq of cmd.squares) {
					const o = occupancy[sq];
					if (o !== undefined) seen[sq] = o;
				}
				port.post({ kind: "boardCheckResult", id: cmd.id, occupancy: seen });
			} else if (cmd.kind === "observeMove") {
				const timer = setTimeout(() => {
					const idx = pending.findIndex((p) => p.id === cmd.id);
					if (idx < 0) return;
					pending.splice(idx, 1);
					port.post({ kind: "observeMoveResult", id: cmd.id, ok: false, reason: "not observed" });
				}, cmd.timeoutMs);
				pending.push({ id: cmd.id, from: cmd.expected.from, to: cmd.expected.to, timer });
				settle();
			} else if (cmd.kind === "highlight" || cmd.kind === "clearHighlight" || cmd.kind === "arrow") {
				boardCommands.push(cmd);
			}
		},
	});
	port.post({ kind: "focus", hasFocus: true, visibility: "visible", at: sim.now() });
	port.post({ kind: "cursor", x: 900, y: 400, t: sim.now(), real: true });
}

beforeEach(async () => {
	sim = createSimulator({ startAt: START });
	sim.time.install();
	tabId = sim.openTab("https://www.chess.com/game/174252022572", { active: true }).tabId;
	buildBoard();
	boardCommands = [];
	toasts = [];
	snapshots = [];
	session = new FakeSession("chesscom");
	sw = await bootSwContext(sim, {
		entry: async () => {
			keepalive = new Keepalive();
			dbg = new DebuggerManager({ keepalive, scheduler: defaultScheduler, now: sim.now });
			await dbg.ready;
			link = new ContentLink({ scheduler: defaultScheduler, now: sim.now });
			focus = new FocusGate(link, { now: sim.now });
			ownership = new HandOwnership(link, { now: sim.now });
			executor = new MoveExecutor({
				tabId,
				site: "chesscom",
				debugger: dbg,
				link,
				focus,
				ownership,
				now: sim.now,
				scheduler: defaultScheduler,
				persona: "balanced",
				tcClass: "blitz",
				style: "drag",
				previewScale: 0,
				gameSeed: "game-1",
			});
			router = installMessageRouter();
			sources = fakeSources({
				sessions: new Map([[tabId, session]]),
				executors: new Map([[tabId, executor]]),
				hand: { debugger: dbg, focus, ownership },
				license: () => LICENSE,
			});
			broadcaster = new PanelBroadcaster(sources, { scheduler: defaultScheduler, now: sim.now });
			broadcaster.observeExecutor(tabId, executor);
			registerPanelHandlers(router, { broadcaster, sources, link, getSettings: () => SETTINGS });
			router.install();
		},
	});
	content = await bootContentContext(sim, tabId, { entry: () => bootFakeAdapter() });
	panel = await bootPanelContext(sim);
	store = await panel.run(() => createPanelStore());
	store.subscribe((s) => snapshots.push(s));
	store.onPortMessage((m) => {
		if (m.kind === "toast") toasts.push(m);
	});
	await sim.time.advance(TIMINGS.panelSnapshotMinIntervalMs);
});
afterEach(async () => {
	store.dispose();
	await panel.teardown();
	await sw.run(() => {
		broadcaster.dispose();
		executor.dispose();
		focus.dispose();
		ownership.dispose();
		link.dispose();
		dbg.dispose();
	});
	await content.teardown();
	await sw.teardown();
	sim.time.uninstall();
	await sim.dispose();
});

const latest = (): PanelSnapshot => snapshots.at(-1) as PanelSnapshot;
/** Let a command's snapshot land: a push inside the throttle interval is deferred to its end. */
const settle = (): Promise<void> => sim.time.advance(TIMINGS.panelSnapshotMinIntervalMs);

/** The panel's typed dispatch (resolves with the reply, rejects with the SW's error). */
function dispatch<T extends Parameters<PanelStore["dispatch"]>[0]>(command: T): Promise<unknown> {
	return panel.run(() => store.dispatch(command));
}

/**
 * A recommendation for the current position, as Task 30's session would produce it. The hand
 * starts `leadMs` from now, so the scheduled state can be observed before it moves.
 */
async function recommend(
	thinkMs = 1200,
	leadMs = 1000
): Promise<{ deadlineMs: number; thinkMs: number }> {
	let plan = makePlan(sim.now(), thinkMs, leadMs);
	await sw.run(() => {
		plan = makePlan(sim.now(), thinkMs, leadMs);
		focus.positionArrived(tabId, sim.now());
		session.recommend(makeRecommendation(plan, sim.now()));
		broadcaster.notify();
	});
	await sim.time.advance(0);
	return { deadlineMs: plan.deadlineMs, thinkMs: plan.thinkMs };
}

const presses = () =>
	sim.debugger.commands.filter(
		(c) =>
			c.method === CDP.inputDispatchMouseEvent &&
			(c.params as { type: string }).type === "mousePressed"
	);
const releases = () =>
	sim.debugger.commands.filter(
		(c) =>
			c.method === CDP.inputDispatchMouseEvent &&
			(c.params as { type: string }).type === "mouseReleased"
	);

describe("panel ↔ service worker: arm and play", () => {
	it("setAutoMove(true) attaches the debugger, schedules the current recommendation for plan.deadlineMs and the snapshot shows autoMove.scheduledAt", async () => {
		const { deadlineMs, thinkMs } = await recommend();
		expect(latest().autoMove).toEqual({ armed: false });
		expect(latest().executor.debuggerAttached).toBe(false);

		await dispatch({ type: MSG.PANEL_SET_AUTO_MOVE, tabId, armed: true });
		await settle();
		expect(dbg.isAttached(tabId)).toBe(true);
		expect(executor.isArmed()).toBe(true);
		expect(executor.pendingMove()?.rec.chosen.uci).toBe("e2e4");
		expect(executor.pendingMove()?.fireAt).toBe(deadlineMs - thinkMs);
		const snap = latest();
		expect(snap.autoMove.armed).toBe(true);
		expect(snap.autoMove.scheduledAt).toBe(deadlineMs);
		expect(snap.autoMove.plan?.thinkMs).toBe(thinkMs);
		expect(snap.executor).toEqual({ debuggerAttached: true });
		expect(snap.session.hand).toBe("resting");
		expect(snap.focus.pageHasFocus).toBe(true);

		// The hand plays on the deadline; the result is surfaced with `at`, and the panel is told.
		await sw.run(() => sim.time.advanceUntilIdle({ maxAdvanceMs: 30_000 }));
		expect(presses()).toHaveLength(1);
		expect(releases()).toHaveLength(1);
		expect(inside(presses()[0]?.params as { x: number; y: number }, squareRect("e2"))).toBe(true);
		expect(inside(releases()[0]?.params as { x: number; y: number }, squareRect("e4"))).toBe(true);
		expect(Math.abs((releases()[0]?.at ?? 0) - deadlineMs)).toBeLessThanOrEqual(60);
		const after = latest();
		expect(after.session.lastExecution).toMatchObject({
			ok: true,
			outcome: "executed",
			tier: "drag",
		});
		expect(typeof after.session.lastExecution?.at).toBe("number");
		expect(after.autoMove.scheduledAt).toBeUndefined();
		expect(after.autoMove.armed).toBe(true);
		expect(after.session.hand).toBe("resting");
		// The toast names a registry key and its arguments; the copy is the panel's (Task 28).
		expect(toasts).toEqual([
			{
				kind: "toast",
				level: "info",
				key: TOAST_KEYS.played,
				args: {
					san: "e2e4",
					elapsedMs: after.session.lastExecution?.elapsedMs ?? 0,
					tier: "drag",
				},
			},
		]);
		expect(snapshots.some((s) => s.session.hand === "moving")).toBe(true);
	});

	it("playNow executes the pending move at once with an instant plan; `executed` → toast on the port", async () => {
		const { deadlineMs } = await recommend(4000);
		await dispatch({ type: MSG.PANEL_SET_AUTO_MOVE, tabId, armed: true });
		await settle();
		expect(latest().autoMove.scheduledAt).toBe(deadlineMs);

		const at = sim.now();
		await dispatch({ type: MSG.PANEL_PLAY_NOW, tabId });
		await sim.time.advance(0);
		expect(executor.pendingMove()).toBeNull();
		await settle();
		expect(latest().autoMove.scheduledAt).toBeUndefined();
		await sw.run(() => sim.time.advanceUntilIdle({ maxAdvanceMs: 30_000 }));
		expect(presses()).toHaveLength(1);
		expect(releases()).toHaveLength(1);
		// well before the plan's deadline: the instant plan drops the pre-touch window
		expect((releases()[0]?.at ?? 0) - at).toBeLessThan(deadlineMs - at - 1000);
		expect(latest().session.lastExecution).toMatchObject({ ok: true, outcome: "executed" });
		expect(toasts).toHaveLength(1);
		expect(toasts[0]).toMatchObject({ key: TOAST_KEYS.played, args: { san: "e2e4" } });
	});

	it("playNow with nothing scheduled plays the current recommendation; without an armed hand it is refused", async () => {
		await recommend();
		await expect(dispatch({ type: MSG.PANEL_PLAY_NOW, tabId })).rejects.toThrow(
			PANEL_COMMAND_ERRORS.notArmed
		);
		expect(sim.debugger.attachments).toHaveLength(0);

		// Arm before the recommendation exists (waiting view), then a recommendation arrives with
		// nothing scheduled by anyone (auto-move logic is the session's): Play now still works.
		await sw.run(() => {
			session.rec = null;
			session.game = { ...session.game, state: "waiting-for-game" };
		});
		await dispatch({ type: MSG.PANEL_SET_AUTO_MOVE, tabId, armed: true });
		await recommend();
		expect(executor.pendingMove()).toBeNull();
		await dispatch({ type: MSG.PANEL_PLAY_NOW, tabId });
		await sw.run(() => sim.time.advanceUntilIdle({ maxAdvanceMs: 30_000 }));
		expect(presses()).toHaveLength(1);
		expect(latest().session.lastExecution?.outcome).toBe("executed");
	});

	it("cancelPending drops a scheduled move (snapshot loses scheduledAt, hand stays armed) and aborts a running one (`aborted` surfaced, no toast)", async () => {
		const { deadlineMs } = await recommend();
		await dispatch({ type: MSG.PANEL_SET_AUTO_MOVE, tabId, armed: true });
		await settle();
		expect(latest().autoMove.scheduledAt).toBe(deadlineMs);

		await dispatch({ type: MSG.PANEL_CANCEL_PENDING, tabId });
		await settle();
		expect(executor.pendingMove()).toBeNull();
		expect(latest().autoMove).toEqual({ armed: true });
		await sw.run(() => sim.time.advanceUntilIdle({ maxAdvanceMs: 30_000 }));
		expect(presses()).toHaveLength(0);
		expect(latest().session.lastExecution).toBeUndefined();

		// Schedule again and cancel mid-drag from the panel.
		const next = await recommend();
		await dispatch({ type: MSG.PANEL_SET_AUTO_MOVE, tabId, armed: true });
		await settle();
		expect(latest().autoMove.scheduledAt).toBe(next.deadlineMs);
		let held = 0;
		let cancel: Promise<unknown> | null = null;
		sim.debugger.respond(CDP.inputDispatchMouseEvent, (params, id) => {
			const p = params as { type: string; buttons: number };
			if (p.type === "mouseMoved" && p.buttons === 1 && ++held === 2 && cancel === null) {
				cancel = dispatch({ type: MSG.PANEL_CANCEL_PENDING, tabId });
			}
			return sim.input.send(id, CDP.inputDispatchMouseEvent, params);
		});
		await sw.run(() => sim.time.advanceUntilIdle({ maxAdvanceMs: 30_000 }));
		await cancel;
		expect(presses()).toHaveLength(1);
		expect(releases()).toHaveLength(1);
		const snap = latest();
		expect(snap.session.lastExecution).toMatchObject({ ok: false, outcome: "aborted" });
		expect(typeof snap.session.lastExecution?.at).toBe("number");
		expect(snap.autoMove).toEqual({ armed: true });
		expect(toasts).toHaveLength(0); // the Live view shows its own "Skipped" toast
	});

	it("setAutoMove(false) disarms: the pending move is dropped and the snapshot reports armed: false", async () => {
		await recommend();
		await dispatch({ type: MSG.PANEL_SET_AUTO_MOVE, tabId, armed: true });
		await settle();
		expect(latest().autoMove.armed).toBe(true);
		await dispatch({ type: MSG.PANEL_SET_AUTO_MOVE, tabId, armed: false });
		await settle();
		expect(executor.isArmed()).toBe(false);
		expect(executor.pendingMove()).toBeNull();
		expect(latest().autoMove).toEqual({ armed: false });
		// The attachment itself is kept for the next arm (§9.2: idle detach is the manager's).
		expect(latest().executor.debuggerAttached).toBe(true);
		await sw.run(() => sim.time.advanceUntilIdle({ maxAdvanceMs: 30_000 }));
		expect(presses()).toHaveLength(0);
	});

	it("commands for a tab without an executor are refused with the registered reason; cancel is idempotent", async () => {
		const other = sim.openTab("https://www.chess.com/game/174252099999", { active: false }).tabId;
		await expect(
			dispatch({ type: MSG.PANEL_SET_AUTO_MOVE, tabId: other, armed: true })
		).rejects.toThrow(PANEL_COMMAND_ERRORS.noExecutor);
		await expect(dispatch({ type: MSG.PANEL_PLAY_NOW, tabId: other })).rejects.toThrow(
			PANEL_COMMAND_ERRORS.noExecutor
		);
		await expect(dispatch({ type: MSG.PANEL_CANCEL_PENDING, tabId: other })).resolves.toBeUndefined();
		await expect(dispatch({ type: MSG.PANEL_CANCEL_PENDING, tabId })).resolves.toBeUndefined();
		expect(sim.debugger.attachments).toHaveLength(0);
	});

	it("detach / reattach act on the tab's debugger: detach disarms and the snapshot shows the hand detached; reattach re-arms with the reattached toast", async () => {
		await recommend();
		await dispatch({ type: MSG.PANEL_SET_AUTO_MOVE, tabId, armed: true });
		await settle();
		expect(latest().executor.debuggerAttached).toBe(true);

		await dispatch({ type: MSG.PANEL_DETACH_DEBUGGER, tabId });
		await settle();
		expect(dbg.isAttached(tabId)).toBe(false);
		expect(executor.isArmed()).toBe(false);
		expect(executor.pendingMove()).toBeNull();
		let snap = latest();
		expect(snap.executor.debuggerAttached).toBe(false);
		expect(snap.session.hand).toBe("detached");
		expect(snap.autoMove).toEqual({ armed: false });

		await dispatch({ type: MSG.PANEL_REATTACH_DEBUGGER, tabId });
		await settle();
		expect(dbg.isAttached(tabId)).toBe(true);
		expect(executor.isArmed()).toBe(true);
		snap = latest();
		expect(snap.executor.debuggerAttached).toBe(true);
		expect(snap.session.hand).toBe("resting");
		expect(snap.autoMove.armed).toBe(true);
		expect(toasts.map((t) => t.key)).toEqual([TOAST_KEYS.reattached]);
		expect(sim.debugger.attachments.filter((a) => a.action === "attach")).toHaveLength(2);
	});

	it("a second window's panel is served its own tab and none of the first tab's toasts", async () => {
		// A second browser window whose active tab has no session at all.
		const otherTab = sim.openTab("https://www.chess.com/game/174252099999", {
			active: true,
			windowId: 2,
		}).tabId;
		const otherPanel = await bootPanelContext(sim);
		sim.windows.setCurrent(otherPanel.id, 2); // what this panel's `windows.getCurrent()` reports
		const otherSnapshots: PanelSnapshot[] = [];
		const otherToasts: Array<Extract<PanelPortMessage, { kind: "toast" }>> = [];
		const otherStore = await otherPanel.run(() => createPanelStore());
		otherStore.subscribe((s) => otherSnapshots.push(s));
		otherStore.onPortMessage((m) => {
			if (m.kind === "toast") otherToasts.push(m);
		});
		try {
			await recommend();
			await settle();
			// Each panel is built for the active tab of *its own* window.
			expect(otherSnapshots.at(-1)?.session.state).toBe("idle");
			expect(otherSnapshots.at(-1)?.session.hand).toBe("detached");
			expect(otherSnapshots.at(-1)?.recommendation).toBeUndefined();
			expect(latest().session.state).toBe("live:my-turn:recommended");
			expect(latest().recommendation?.chosen.uci).toBe("e2e4");

			// The hand plays in window 1: only the panel showing that tab hears about it.
			await dispatch({ type: MSG.PANEL_SET_AUTO_MOVE, tabId, armed: true });
			await sw.run(() => sim.time.advanceUntilIdle({ maxAdvanceMs: 30_000 }));
			await settle();
			expect(latest().session.lastExecution).toMatchObject({ outcome: "executed" });
			expect(toasts.map((t) => t.key)).toEqual([TOAST_KEYS.played]);
			expect(otherToasts).toEqual([]);
			// … and the other window's snapshot never carries the first tab's execution.
			expect(otherSnapshots.at(-1)?.session.lastExecution).toBeUndefined();
			expect(otherTab).not.toBe(tabId);
		} finally {
			otherStore.dispose();
			await otherPanel.teardown();
		}
	});

	it("previewLine highlights the hovered line's first move on the board and restores the chosen move on null", async () => {
		await recommend();
		await dispatch({ type: MSG.PANEL_PREVIEW_LINE, tabId, multipv: 2 });
		await sim.time.advance(0);
		expect(boardCommands.at(-1)).toEqual({ kind: "highlight", from: "d2", to: "d4", style: "both" });
		await dispatch({ type: MSG.PANEL_PREVIEW_LINE, tabId, multipv: null });
		await sim.time.advance(0);
		expect(boardCommands.at(-1)).toEqual({ kind: "highlight", from: "e2", to: "e4", style: "both" });
		// An unknown line clears instead of guessing.
		await dispatch({ type: MSG.PANEL_PREVIEW_LINE, tabId, multipv: 9 });
		await sim.time.advance(0);
		expect(boardCommands.at(-1)).toEqual({ kind: "clearHighlight" });
		expect(boardCommands).toHaveLength(3);
	});
});
