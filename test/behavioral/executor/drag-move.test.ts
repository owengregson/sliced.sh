// test/behavioral/executor/drag-move.test.ts — Step 6: the service-worker half end to end in the simulator.
// A booted SW (debugger manager, content link, focus gate, hand ownership, executor) plays a
// recommendation against a content context whose fake adapter answers `geometry` / `observeMove`
// / `focus` over the game port; the tab's happy-dom sees the trusted-equivalent pointer sequence.
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
	CDP,
	DEBUGGER_KEEPALIVE_REASON,
	EXECUTOR,
	type GamePortCommand,
	type GamePortMessage,
	PORT_NAMES,
} from "@core/constants";
import { type ConnectedPort, connectPort } from "@core/messaging/ports";
import type { Pt, Rect } from "@core/motor/types";
import { defaultScheduler } from "@core/util/scheduler";
import { ContentLink } from "@service/content-link";
import { DebuggerManager } from "@service/debugger-manager";
import { FocusGate } from "@service/focus-gate";
import { HandOwnership } from "@service/hand-ownership";
import { Keepalive } from "@service/keepalive";
import { type ExecutionReport, MoveExecutor } from "@service/move-executor";
import { createSimulator, type Simulator } from "@test/sim";
import { bootContentContext, type ContentContext } from "@test/sim/contexts/content-context";
import { bootSwContext, type SwContext } from "@test/sim/contexts/sw-context";
import type { Recommendation, Square } from "@typedefs/game";
import type { TimingPlan } from "@typedefs/timing";
import { BOARD, inside, squareRect } from "../../core/motor/fixtures";

const START = 1_000_000;
const START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
const FORBIDDEN_METHODS = ["Page.bringToFront", "Emulation.setFocusEmulationEnabled"];

let sim: Simulator;
let sw: SwContext;
let content: ContentContext;
let tabId: number;
let keepalive: Keepalive;
let dbg: DebuggerManager;
let link: ContentLink;
let focus: FocusGate;
let ownership: HandOwnership;
let executor: MoveExecutor;
let port: ConnectedPort<GamePortMessage>;
let tabsUpdateCalls: number;
let windowsUpdateCalls: number;
/** What the fake adapter saw / answered. */
let adapter: {
	observeRequests: Array<{ from: Square; to: Square }>;
	lastDown: string | null;
	lastUp: string | null;
};

const ALL: Square[] = [];
for (const f of "abcdefgh") for (let r = 1; r <= 8; r++) ALL.push(`${f}${r}` as Square);

function buildBoard(): void {
	const dom = sim.getTabDom(tabId);
	if (!dom) throw new Error("no dom");
	dom.setHTML(`<div id="board">${ALL.map((sq) => `<div id="${sq}"></div>`).join("")}</div>`);
	const asLayout = (r: Rect) => ({ x: r.left, y: r.top, width: r.width, height: r.height });
	dom.layout("#board", asLayout(BOARD));
	for (const sq of ALL) dom.layout(`#${sq}`, asLayout(squareRect(sq)));
}

/** The content side of Task 30's adapter, reduced to what the executor needs. */
function bootFakeAdapter(): void {
	const dom = sim.getTabDom(tabId);
	if (!dom) throw new Error("no dom");
	const board = dom.query("#board");
	const pending: Array<{ id: string; from: Square; to: Square; timer: unknown }> = [];
	const settle = (): void => {
		for (const p of [...pending]) {
			if (adapter.lastDown === p.from && adapter.lastUp === p.to) {
				clearTimeout(p.timer as ReturnType<typeof setTimeout>);
				pending.splice(pending.indexOf(p), 1);
				port.post({ kind: "observeMoveResult", id: p.id, ok: true });
			}
		}
	};
	board.addEventListener("mousedown", (e) => {
		adapter.lastDown = (e.target as { id?: string }).id ?? null;
	});
	board.addEventListener("mouseup", (e) => {
		adapter.lastUp = (e.target as { id?: string }).id ?? null;
		settle();
	});
	port = connectPort<GamePortMessage, GamePortCommand>(PORT_NAMES.game, {
		scheduler: defaultScheduler,
		onMessage: (cmd) => {
			if (cmd.kind === "geometry") {
				port.post({ kind: "geometryResult", id: cmd.id, boardRect: BOARD, flipped: false });
			} else if (cmd.kind === "observeMove") {
				adapter.observeRequests.push({ from: cmd.expected.from, to: cmd.expected.to });
				const timer = setTimeout(() => {
					const idx = pending.findIndex((p) => p.id === cmd.id);
					if (idx < 0) return;
					pending.splice(idx, 1);
					port.post({ kind: "observeMoveResult", id: cmd.id, ok: false, reason: "not observed" });
				}, cmd.timeoutMs);
				pending.push({ id: cmd.id, from: cmd.expected.from, to: cmd.expected.to, timer });
				settle();
			}
		},
	});
	port.post({ kind: "focus", hasFocus: true, visibility: "visible", at: sim.now() });
	port.post({ kind: "cursor", x: 900, y: 400, t: sim.now(), real: true });
}

beforeEach(async () => {
	sim = createSimulator({ startAt: START });
	sim.time.install();
	tabId = sim.openTab("https://lichess.org/abcd1234").tabId;
	buildBoard();
	adapter = { observeRequests: [], lastDown: null, lastUp: null };
	tabsUpdateCalls = 0;
	windowsUpdateCalls = 0;
	const realUpdate = sim.chrome.tabs.update;
	sim.chrome.tabs.update = ((...args: unknown[]) => {
		tabsUpdateCalls += 1;
		return (realUpdate as (...a: unknown[]) => unknown)(...args);
	}) as typeof sim.chrome.tabs.update;
	(sim.chrome.windows as unknown as Record<string, unknown>).update = () => {
		windowsUpdateCalls += 1;
	};
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
				site: "lichess",
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
		},
	});
	content = await bootContentContext(sim, tabId, { entry: () => bootFakeAdapter() });
	await sim.time.runMicrotasks();
});
afterEach(async () => {
	await sw.run(() => {
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

function recommendation(plan: TimingPlan): Recommendation {
	return {
		chosen: {
			uci: "e2e4",
			san: "e4",
			from: "e2",
			to: "e4",
			source: "engine-elo",
			rankInLines: 0,
			cpLoss: 0,
			rationale: [],
		},
		lines: [
			{ multipv: 1, score: { cp: 30 }, depth: 12, pvUci: ["e2e4", "e7e5"], pvSan: ["e4", "e5"] },
			{ multipv: 2, score: { cp: 20 }, depth: 12, pvUci: ["d2d4", "d7d5"], pvSan: ["d4", "d5"] },
		],
		eval: { cp: 30 },
		depth: 12,
		nps: 1_000_000,
		plan,
		computedAt: sim.now(),
		fen: START_FEN,
	};
}

const plan1200 = (): TimingPlan => ({
	thinkMs: 1200,
	mode: "normal",
	preMoveHoverMs: 600,
	dragDurationMs: 300,
	deadlineMs: sim.now() + 1200,
	rationale: [],
	features: {},
});

interface Cmd {
	method: string;
	type: string;
	x: number;
	y: number;
	buttons: number;
	at: number;
}
const commands = (): Cmd[] =>
	sim.debugger.commands.map((c) => {
		const p = (c.params ?? {}) as Record<string, unknown>;
		return {
			method: c.method,
			type: p.type as string,
			x: p.x as number,
			y: p.y as number,
			buttons: p.buttons as number,
			at: c.at - START,
		};
	});

describe("executor: a scheduled drag move end to end", () => {
	it("attaches at arm time, plays the move on the deadline with a realistic CDP sequence, verifies it and reports `executed`", async () => {
		const reports: ExecutionReport[] = [];
		const hands: string[] = [];
		await sw.run(async () => {
			executor.on("executed", (r) => reports.push(r));
			executor.on("hand", (s) => hands.push(s));
			await executor.arm();
			focus.positionArrived(tabId, sim.now());
			const plan = plan1200();
			executor.schedule(recommendation(plan), plan);
		});
		expect(dbg.isAttached(tabId)).toBe(true);
		expect(keepalive.reasons()).toEqual([DEBUGGER_KEEPALIVE_REASON]);
		// the hand starts from the real cursor the content script reported before arming
		expect(ownership.position(tabId)).toEqual({ x: 900, y: 400 });
		expect(executor.pendingMove()?.rec.chosen.uci).toBe("e2e4");

		await sw.run(() => sim.time.advanceUntilIdle({ maxAdvanceMs: 30_000 }));

		expect(reports).toHaveLength(1);
		const result = (reports[0] as ExecutionReport).result;
		expect(result).toMatchObject({ ok: true, outcome: "executed", tier: "drag", attempts: 1 });
		expect(executor.pendingMove()).toBeNull();
		expect(executor.isRunning()).toBe(false);

		const cmds = commands();
		expect(cmds.length).toBeGreaterThan(8);
		for (const c of cmds) {
			expect(c.method).toBe(CDP.inputDispatchMouseEvent);
			expect(FORBIDDEN_METHODS).not.toContain(c.method);
		}
		for (const c of sim.debugger.commands) expect("timestamp" in (c.params ?? {})).toBe(false);
		const presses = cmds.filter((c) => c.type === "mousePressed");
		const releases = cmds.filter((c) => c.type === "mouseReleased");
		expect(presses).toHaveLength(1);
		expect(releases).toHaveLength(1);
		const press = presses[0] as Cmd;
		const release = releases[0] as Cmd;
		expect(inside(press, squareRect("e2"))).toBe(true);
		expect(inside(release, squareRect("e4"))).toBe(true);
		const held = cmds.slice(cmds.indexOf(press) + 1, cmds.indexOf(release));
		expect(held.length).toBeGreaterThan(3);
		for (const c of held) expect(c).toMatchObject({ type: "mouseMoved", buttons: 1 });
		for (const c of cmds.slice(0, cmds.indexOf(press))) expect(c.buttons).toBe(0);
		// timing: press after the pre-touch window, drop on the deadline
		expect(press.at).toBeGreaterThanOrEqual(600);
		expect(Math.abs(release.at - 1200)).toBeLessThanOrEqual(60);
		// continuity from the arm-time start
		let prev: Pt = { x: 900, y: 400 };
		for (const c of cmds) {
			expect(Math.hypot(c.x - prev.x, c.y - prev.y)).toBeLessThanOrEqual(30);
			prev = c;
		}
		// the page saw a trusted-equivalent drag: down on e2, up on e4, and the adapter verified it
		const domEvents = sim.input.events;
		expect(domEvents.find((e) => e.type === "mousedown")?.target).toBe("e2");
		expect(domEvents.filter((e) => e.type === "mouseup").at(-1)?.target).toBe("e4");
		expect(adapter.observeRequests).toEqual([{ from: "e2", to: "e4" }]);
		expect(sim.input.pointer(tabId)?.buttons).toBe(0);
		// hand state pill and ownership
		expect(hands[0]).toBe("orientation");
		expect(hands).toContain("dragging");
		expect(hands.at(-1)).toBe("rest");
		expect(executor.handView()).toBe("resting");
		expect(ownership.position(tabId)).toEqual(result.endPoint);
		expect(ownership.realPointerCount(tabId)).toBe(0);
		// never a focus change of any kind
		expect(tabsUpdateCalls).toBe(0);
		expect(windowsUpdateCalls).toBe(0);
		expect(sim.debugger.attachments.filter((a) => a.action === "attach")).toHaveLength(1);
	});

	it("a blur inside the move window skips the move (no press, nothing after the edge) and reports `skipped`", async () => {
		const reports: ExecutionReport[] = [];
		await sw.run(async () => {
			executor.on("skipped", (r) => reports.push(r));
			await executor.arm();
			focus.positionArrived(tabId, sim.now());
			const plan = plan1200();
			executor.schedule(recommendation(plan), plan);
		});
		await sw.run(() => sim.time.advance(300));
		await content.run(async () => {
			port.post({ kind: "focus", hasFocus: false, visibility: "visible", at: sim.now() });
			port.post({ kind: "focus", hasFocus: true, visibility: "visible", at: sim.now() });
		});
		await sim.time.runMicrotasks();
		const edgeAt = sim.now() - START;
		await sw.run(() => sim.time.advanceUntilIdle({ maxAdvanceMs: 30_000 }));
		expect(reports).toHaveLength(1);
		expect((reports[0] as ExecutionReport).result).toMatchObject({
			ok: false,
			outcome: "skipped",
			reason: EXECUTOR.reasons.blurInWindow,
		});
		const cmds = commands();
		expect(cmds.filter((c) => c.type !== "mouseMoved")).toHaveLength(0);
		for (const c of cmds) expect(c.at).toBeLessThanOrEqual(edgeAt);
		expect(adapter.observeRequests).toEqual([]);
		expect(executor.handView()).toBe("paused");
		expect(focus.snapshot(tabId)).toEqual({ pageHasFocus: true, blurSeenThisMove: true });
	});

	it("without an arm-time attachment the move fails with the user-facing reason and nothing is dispatched", async () => {
		const reports: ExecutionReport[] = [];
		await sw.run(async () => {
			executor.on("failed", (r) => reports.push(r));
			focus.positionArrived(tabId, sim.now());
			const plan = plan1200();
			executor.schedule(recommendation(plan), plan);
		});
		await sw.run(() => sim.time.advanceUntilIdle({ maxAdvanceMs: 30_000 }));
		expect(reports).toHaveLength(1);
		expect((reports[0] as ExecutionReport).result).toMatchObject({
			ok: false,
			outcome: "failed",
			reason: EXECUTOR.reasons.notAttached,
		});
		expect(sim.debugger.commands).toHaveLength(0);
		expect(sim.debugger.attachments).toHaveLength(0);
		expect(executor.handView()).toBe("detached");
	});

	it("cancel() mid-drag releases the piece immediately, reports `aborted`, and a replacement playNow() is never dropped", async () => {
		const aborted: ExecutionReport[] = [];
		const executed: ExecutionReport[] = [];
		let plan: TimingPlan = plan1200();
		await sw.run(async () => {
			executor.on("aborted", (r) => aborted.push(r));
			executor.on("executed", (r) => executed.push(r));
			await executor.arm();
			focus.positionArrived(tabId, sim.now());
			plan = plan1200();
			executor.schedule(recommendation(plan), plan);
		});
		let held = 0;
		let cancelledAt = 0;
		let replacement: Promise<unknown> | null = null;
		sim.debugger.respond(CDP.inputDispatchMouseEvent, (params, id) => {
			const p = params as { type: string; buttons: number };
			if (p.type === "mouseMoved" && p.buttons === 1 && ++held === 2) {
				cancelledAt = sim.now() - START;
				executor.cancel();
				// the session's documented replacement flow: cancel(), then play the next move
				replacement = executor.playNow(recommendation(plan), plan);
			}
			return sim.input.send(id, CDP.inputDispatchMouseEvent, params);
		});
		await sw.run(() => sim.time.advanceUntilIdle({ maxAdvanceMs: 30_000 }));
		expect(aborted).toHaveLength(1);
		const first = (aborted[0] as ExecutionReport).result;
		expect(first).toMatchObject({ ok: false, outcome: "aborted", pressed: true, attempts: 1 });
		const cmds = commands();
		const presses = cmds.filter((c) => c.type === "mousePressed");
		const releases = cmds.filter((c) => c.type === "mouseReleased");
		expect(presses).toHaveLength(2);
		expect(releases).toHaveLength(2);
		// the abort released at once, at the current point
		const abortRelease = releases[0] as Cmd;
		const before = cmds[cmds.indexOf(abortRelease) - 1] as Cmd;
		expect(before).toMatchObject({ type: "mouseMoved", buttons: 1 });
		expect({ x: abortRelease.x, y: abortRelease.y }).toEqual({ x: before.x, y: before.y });
		expect(abortRelease.at - cancelledAt).toBeLessThanOrEqual(CDP.stallResyncMs);
		// the cancelled run wound down promptly (its re-check was aborted, not awaited for 1.2 s) and
		// the replacement played: second press inside e2, release inside e4, verified, `executed`
		expect(executed).toHaveLength(1);
		expect((executed[0] as ExecutionReport).result).toMatchObject({ ok: true, outcome: "executed" });
		expect(await replacement).toMatchObject({ ok: true, outcome: "executed" });
		expect(inside(presses[1] as Cmd, squareRect("e2"))).toBe(true);
		expect(inside(releases[1] as Cmd, squareRect("e4"))).toBe(true);
		expect((presses[1] as Cmd).at).toBeGreaterThan(abortRelease.at);
		expect((presses[1] as Cmd).at - abortRelease.at).toBeLessThan(EXECUTOR.recheckTimeoutMs + 1000);
		expect(adapter.observeRequests).toEqual([{ from: "e2", to: "e4" }]);
		expect(sim.input.pointer(tabId)?.buttons).toBe(0);
		expect(executor.isRunning()).toBe(false);
		expect(executor.handView()).toBe("resting");
	});
});
