// test/behavioral/executor/drag-move.test.ts — Step 6: the service-worker half end to end in the simulator.
// A booted SW (debugger manager, content link, focus gate, hand ownership, executor) plays a
// recommendation against a content context whose fake adapter answers `geometry` / `observeMove`
// / `boardCheck` / `focus` over the game port; the tab's happy-dom sees the trusted-equivalent pointer sequence.
//
// Task 33: the `ac` shadow (`test/sim/telemetry/ac-shadow.ts`) watches the same tab, so every run
// that actually dispatches a move is also held to `assertHumanShapedAc` — the §13.2 human-shape
// model — and every run that must dispatch nothing is checked to have submitted nothing.
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
	CDP,
	DEBUGGER_KEEPALIVE_REASON,
	EXECUTOR,
	type GamePortCommand,
	type GamePortMessage,
	PORT_NAMES,
	TIMINGS,
} from "@core/constants";
import { type ConnectedPort, connectPort } from "@core/messaging/ports";
import type { Occupancy, Pt, Rect } from "@core/motor/types";
import { defaultScheduler } from "@core/util/scheduler";
import { BoardWatch } from "@service/board-watch";
import { ContentLink } from "@service/content-link";
import { DebuggerManager } from "@service/debugger-manager";
import { FocusGate } from "@service/focus-gate";
import { HandOwnership } from "@service/hand-ownership";
import { Keepalive } from "@service/keepalive";
import { type ExecutionReport, MoveExecutor } from "@service/move-executor";
import { createSimulator, type Simulator } from "@test/sim";
import { bootContentContext, type ContentContext } from "@test/sim/contexts/content-context";
import { bootSwContext, type SwContext } from "@test/sim/contexts/sw-context";
import { type AcShadow, createAcShadow, type SiteModel } from "@test/sim/telemetry/ac-shadow";
import type { Recommendation, Square } from "@typedefs/game";
import type { TimingPlan } from "@typedefs/timing";
import {
	type AcMoveMeta,
	assertHumanShapedAc,
} from "../../../tools/telemetry-conformance/ac-model";
import { BOARD, inside, squareRect } from "../../core/motor/fixtures";

const START = 1_000_000;
const START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
// Page focus is maintained natively at arm time; never activate the user's actual tab.
const FORBIDDEN_METHODS = ["Page.bringToFront"];

let sim: Simulator;
let sw: SwContext;
let content: ContentContext;
let tabId: number;
let keepalive: Keepalive;
let dbg: DebuggerManager;
let link: ContentLink;
let focus: FocusGate;
let nativeFocus = false;
let ownership: HandOwnership;
let boardWatch: BoardWatch;
let executor: MoveExecutor;
let port: ConnectedPort<GamePortMessage>;
let shadow: AcShadow;
/** What the shadow's site model saw submitted (`[from, to]` per move). */
let submitted: Array<[Square, Square]>;
let tabsUpdateCalls: number;
let windowsUpdateCalls: number;
/** What the fake adapter saw / answered. */
let adapter: {
	observeRequests: Array<{ from: Square; to: Square }>;
	/** The board rect every `geometry` answer reports (a reflow moves it). */
	boardRect: Rect;
	/** Squares each `boardCheck` asked about. */
	boardChecks: Square[][];
	/** What `boardCheck` answers (defaults to the start position from White's side). */
	occupancy: Partial<Record<Square, Occupancy>>;
	/** Hook run when a `boardCheck` arrives (before the reply); return false to swallow it. */
	onBoardCheck: () => boolean;
	/**
	 * Scripted `observeMove` verdicts, consumed in order: `false` rejects that observation outright
	 * (the adapter looked and the move was not there). An empty list means the normal settle path.
	 */
	observeVerdicts: boolean[];
	/** Hook run when the board `geometry` request arrives (before the reply); return false to swallow it. */
	onGeometry: () => boolean;
	lastDown: string | null;
	lastUp: string | null;
	/** Promotion picker rect the adapter reports (null = never appears). */
	promotionRect: Rect | null;
	/** Hook run when a promotion geometry request arrives (before the reply); return false to swallow it. */
	onPromotionGeometry: () => boolean;
};

const ALL: Square[] = [];
for (const f of "abcdefgh") for (let r = 1; r <= 8; r++) ALL.push(`${f}${r}` as Square);

function startOccupancy(): Partial<Record<Square, Occupancy>> {
	const occ: Partial<Record<Square, Occupancy>> = {};
	for (const sq of ALL) {
		const rank = Number(sq[1]);
		occ[sq] = rank <= 2 ? "own" : rank >= 7 ? "enemy" : "empty";
	}
	return occ;
}

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
				if (cmd.promotion !== undefined) {
					if (!adapter.onPromotionGeometry()) return;
					port.post({
						kind: "geometryResult",
						id: cmd.id,
						boardRect: adapter.boardRect,
						flipped: false,
						promotion: adapter.promotionRect,
					});
					return;
				}
				if (!adapter.onGeometry()) return;
				port.post({ kind: "geometryResult", id: cmd.id, boardRect: adapter.boardRect, flipped: false });
			} else if (cmd.kind === "boardCheck") {
				adapter.boardChecks.push(cmd.squares);
				if (!adapter.onBoardCheck()) return;
				const occupancy: Partial<Record<Square, Occupancy>> = {};
				for (const sq of cmd.squares) {
					const o = adapter.occupancy[sq];
					if (o !== undefined) occupancy[sq] = o;
				}
				port.post({ kind: "boardCheckResult", id: cmd.id, occupancy });
			} else if (cmd.kind === "observeMove") {
				adapter.observeRequests.push({ from: cmd.expected.from, to: cmd.expected.to });
				if (adapter.observeVerdicts.shift() === false) {
					port.post({ kind: "observeMoveResult", id: cmd.id, ok: false, reason: "not observed" });
					return;
				}
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
	nativeFocus = false;
	sim = createSimulator({ startAt: START });
	sim.time.install();
	tabId = sim.openTab("https://www.chess.com/game/174252022572").tabId;
	buildBoard();
	adapter = {
		observeRequests: [],
		boardRect: BOARD,
		boardChecks: [],
		occupancy: startOccupancy(),
		onBoardCheck: () => true,
		observeVerdicts: [],
		onGeometry: () => true,
		lastDown: null,
		lastUp: null,
		promotionRect: null,
		onPromotionGeometry: () => true,
	};
	// The page's own view of the hand (Task 33): the fake `fps` plugin on this tab's DOM. Its site
	// model is the fixture's occupancy plus "any square is a legal destination of an own piece",
	// which is all the selection model needs here (`previewScale: 0`, so no preview presses).
	submitted = [];
	const shadowModel: SiteModel = {
		squareOf: (target) => {
			const id = (target as { id?: string } | null)?.id ?? "";
			return ALL.includes(id as Square) ? (id as Square) : null;
		},
		occupancy: (sq) => adapter.occupancy[sq] ?? "empty",
		legalDestinations: (sq) => (adapter.occupancy[sq] === "own" ? ALL.filter((s) => s !== sq) : []),
		submit: (from, to) => {
			submitted.push([from, to]);
			return true;
		},
	};
	const shadowDom = sim.getTabDom(tabId);
	if (!shadowDom) throw new Error("no dom");
	shadow = createAcShadow(shadowDom, shadowModel, { now: sim.now });
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
			focus = new FocusGate(link, {
				now: sim.now,
				isFocusMaintained: (id) => nativeFocus && dbg.isFocusMaintained(id),
			});
			ownership = new HandOwnership(link, { now: sim.now });
			boardWatch = new BoardWatch(link, { now: sim.now });
			executor = new MoveExecutor({
				tabId,
				site: "chesscom",
				debugger: dbg,
				link,
				focus,
				ownership,
				board: boardWatch,
				now: sim.now,
				scheduler: defaultScheduler,
				persona: "balanced",
				tcClass: "blitz",
				previewScale: 0,
				gameSeed: "game-1",
			});
		},
	});
	content = await bootContentContext(sim, tabId, { entry: () => bootFakeAdapter() });
	await sim.time.runMicrotasks();
});
afterEach(async () => {
	shadow.dispose();
	await sw.run(() => {
		executor.dispose();
		focus.dispose();
		ownership.dispose();
		boardWatch.dispose();
		link.dispose();
		dbg.dispose();
	});
	await content.teardown();
	await sw.teardown();
	sim.time.uninstall();
	await sim.dispose();
});

function recommendation(
	plan: TimingPlan,
	move: { from: Square; to: Square; promotion?: "q" } = { from: "e2", to: "e4" }
): Recommendation {
	const uci = `${move.from}${move.to}${move.promotion ?? ""}`;
	return {
		chosen: {
			uci,
			san: uci,
			from: move.from,
			to: move.to,
			...(move.promotion ? { promotion: move.promotion } : {}),
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
	orientationMs: 600,
	window: { orientationMs: 600, scanMs: 0, previewMs: 0, decisionMs: 0, approachMs: 300 },
});

/**
 * Task 33 / ruling 7: what the page's `fps` shadow saw is held to the shared §13.2 model. The
 * shadow's period opens at `beforeEach` (no clock advance happens before the first
 * `positionArrived`), so its `MoveHoldTime` is the move's elapsed time. The fixture has no clock,
 * so every move is trivial for the preview band — `previewScale` is 0 here anyway.
 */
function assertShadowAc(plan: TimingPlan, expected: Array<[Square, Square]>): void {
	expect(submitted).toEqual(expected);
	const meta: AcMoveMeta[] = shadow.observations.map(() => ({
		mode: plan.mode,
		thinkMs: plan.thinkMs,
		clockMs: 0,
	}));
	const summary = assertHumanShapedAc(
		shadow.observations.map((o) => o.ac),
		{ moves: meta }
	);
	expect(summary.blurCount).toBe(0);
	expect(summary.toggles).toBe(0);
	expect(summary.untrusted).toBe(0);
	expect(summary.focusFieldsSet).toBe(0);
	expect(summary.multiSelect.count).toBe(0);
}

interface Cmd {
	method: string;
	type: string;
	x: number;
	y: number;
	buttons: number;
	at: number;
}
const commands = (): Cmd[] =>
	sim.debugger.commandsFor(CDP.inputDispatchMouseEvent).map((c) => {
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
	it.each([false, true])(
		"keeps the newer delayed arm's focus hold when old cleanup finishes (replacement=%s)",
		async (replacement) => {
			await sw.run(() => executor.arm());
			let finishCleanup = () => {};
			const cleanup = new Promise<void>((resolve) => {
				finishCleanup = resolve;
			});
			const originalWhenIdle = executor.whenIdle.bind(executor);
			executor.whenIdle = () => cleanup;
			const next = replacement
				? new MoveExecutor({
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
						previewScale: 0,
						gameSeed: "replacement",
					})
				: executor;
			let acknowledge = () => {};
			const off = sim.debugger.respond(CDP.focusEmulation, (params) =>
				params?.enabled
					? new Promise<void>((resolve) => {
							acknowledge = resolve;
						})
					: undefined
			);
			let armed: Promise<void> = Promise.resolve();
			await sw.run(async () => {
				executor.disarm();
				if (replacement) executor.dispose();
				armed = next.arm();
				await sim.time.runMicrotasks();
				finishCleanup();
				await sim.time.runMicrotasks();
				expect(ownership.isArmed(tabId)).toBe(false);
				acknowledge();
				await armed;
				await sim.time.runMicrotasks();
			});
			expect(next.isArmed()).toBe(true);
			expect(dbg.isFocusMaintained(tabId)).toBe(true);
			expect(
				sim.debugger.commandsFor(CDP.focusEmulation).map((command) => command.params?.enabled)
			).toEqual([true, true]);
			off();
			executor.whenIdle = originalWhenIdle;
			if (replacement) {
				await sw.run(async () => {
					next.disarm();
					await sim.time.runMicrotasks();
					next.dispose();
				});
			}
		}
	);

	it("restores the native hold when the superseding arm fails while old cleanup is pending", async () => {
		await sw.run(() => executor.arm());
		let finishCleanup = () => {};
		const cleanup = new Promise<void>((resolve) => {
			finishCleanup = resolve;
		});
		const originalWhenIdle = executor.whenIdle.bind(executor);
		executor.whenIdle = () => cleanup;
		let rejectArm: (error: Error) => void = () => {};
		const off = sim.debugger.respond(CDP.focusEmulation, (params) =>
			params?.enabled
				? new Promise<void>((_resolve, reject) => {
						rejectArm = reject;
					})
				: undefined
		);
		let armed: Promise<unknown> = Promise.resolve();
		await sw.run(async () => {
			executor.disarm();
			armed = executor.arm().catch((error: unknown) => error);
			await sim.time.runMicrotasks();
			rejectArm(new Error("focus command failed"));
			await sim.time.runMicrotasks();
			expect(
				sim.debugger.commandsFor(CDP.focusEmulation).map((command) => command.params?.enabled)
			).toEqual([true, true]);
			finishCleanup();
			expect(await armed).toBeInstanceOf(Error);
			await sim.time.runMicrotasks();
		});
		expect(executor.isArmed()).toBe(false);
		expect(dbg.isFocusMaintained(tabId)).toBe(false);
		expect(
			sim.debugger.commandsFor(CDP.focusEmulation).map((command) => command.params?.enabled)
		).toEqual([true, true, false]);
		off();
		executor.whenIdle = originalWhenIdle;
	});

	it("continues an armed move across browser/tab changes with maintained page focus, then releases the hold on stop", async () => {
		nativeFocus = true;
		const reports: ExecutionReport[] = [];
		await sw.run(async () => {
			executor.on("executed", (report) => reports.push(report));
			await executor.arm();
			focus.positionArrived(tabId, sim.now());
			const plan = plan1200();
			executor.schedule(recommendation(plan), plan);
			await sim.time.advance(300);
			sim.openTab("https://example.org/", { active: true });
			sim.windows.setFocus(sim.chrome.windows.WINDOW_ID_NONE);
		});
		await content.run(() =>
			port.post({ kind: "focus", hasFocus: false, visibility: "hidden", at: sim.now() })
		);
		await sw.run(() => sim.time.advanceUntilIdle({ maxAdvanceMs: 30000 }));
		expect(reports).toHaveLength(1);
		expect(reports[0]?.result.ok).toBe(true);
		expect(submitted).toEqual([["e2", "e4"]]);
		expect(tabsUpdateCalls).toBe(0);
		expect(windowsUpdateCalls).toBe(0);
		await sw.run(async () => {
			executor.disarm();
			await sim.time.runMicrotasks();
		});
		expect(dbg.isFocusMaintained(tabId)).toBe(false);
		expect(focus.canExecute(tabId).ok).toBe(false);
	});

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
		expect(sim.debugger.commandsFor(CDP.focusEmulation).map((c) => c.params)).toEqual([
			{ enabled: true },
		]);
		for (const c of sim.debugger.commands) {
			expect([CDP.inputDispatchMouseEvent, CDP.focusEmulation] as string[]).toContain(c.method);
			expect(FORBIDDEN_METHODS).not.toContain(c.method);
		}
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
		// and the page's own `fps` shadow saw one human-shaped move (§13.2)
		assertShadowAc(plan1200(), [["e2", "e4"]]);
		const blob = shadow.observations[0]?.ac;
		expect(blob?.MoveHoldTime).toBeCloseTo(release.at, 6);
		expect(blob?.PointerOffset).toBeGreaterThan(0);
		expect(shadow.observations[0]?.lichessBlur).toBe(0);
		expect(shadow.pendingSelection()).toBeNull();
	});

	it("an unverified first drag is retried as a SECOND DRAG — never a click-click", async () => {
		// Click-to-move was removed end to end, so the retry policy has no "other tier" to fall back
		// to. Driven through the real hand: the first drag lands, the adapter says it does not see the
		// move, the pre-retry re-check says the same, and the hand dispatches a second *drag*. What
		// distinguishes the two forms at the page is the held leg — a click-click would show a
		// press/release pair on the from-square with nothing held, then a second pair on the
		// to-square — so both pairs are checked for a held travel from e2 to e4.
		const reports: ExecutionReport[] = [];
		// the move's own verification and the pre-retry re-check both reject; the retry's verifies
		adapter.observeVerdicts = [false, false];
		await sw.run(async () => {
			for (const ev of ["executed", "failed"] as const) executor.on(ev, (r) => reports.push(r));
			await executor.arm();
			focus.positionArrived(tabId, sim.now());
			const plan = plan1200();
			executor.schedule(recommendation(plan), plan);
		});
		await sw.run(() => sim.time.advanceUntilIdle({ maxAdvanceMs: 30_000 }));

		expect(reports).toHaveLength(1);
		const result = (reports[0] as ExecutionReport).result;
		expect(result).toMatchObject({ ok: true, outcome: "executed", tier: "drag", attempts: 2 });
		// three board reads: the first verification, the pre-retry re-check, the retry's verification
		expect(adapter.observeRequests).toEqual([
			{ from: "e2", to: "e4" },
			{ from: "e2", to: "e4" },
			{ from: "e2", to: "e4" },
		]);
		const cmds = commands();
		const presses = cmds.filter((c) => c.type === "mousePressed");
		const releases = cmds.filter((c) => c.type === "mouseReleased");
		expect(presses).toHaveLength(2);
		expect(releases).toHaveLength(2);
		for (let i = 0; i < 2; i++) {
			const press = presses[i] as Cmd;
			const release = releases[i] as Cmd;
			expect(inside(press, squareRect("e2"))).toBe(true);
			expect(inside(release, squareRect("e4"))).toBe(true);
			const held = cmds.slice(cmds.indexOf(press) + 1, cmds.indexOf(release));
			expect(held.length).toBeGreaterThan(0);
			for (const c of held) expect(c).toMatchObject({ type: "mouseMoved", buttons: 1 });
		}
		// the retry really is a second dispatch, after the registry delay
		expect((presses[1] as Cmd).at - (releases[0] as Cmd).at).toBeGreaterThanOrEqual(
			TIMINGS.executorRetryDelayMs[0]
		);
		// and the page saw two drags from e2 to e4, nothing else
		expect(submitted).toEqual([
			["e2", "e4"],
			["e2", "e4"],
		]);
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
		// the page never saw a submission, so there is no `ac` blob to be shaped at all
		expect(shadow.observations).toEqual([]);
		expect(submitted).toEqual([]);
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
		// the cancelled run looked at the board once (a bounded, fresh re-check: the drop landed
		// off-target, so still `aborted`), the replacement passed its own position guard (a
		// colour-aware `boardCheck`: e2 still ours) and played: press inside e2, release inside
		// e4, verified, `executed`
		expect(executed).toHaveLength(1);
		expect((executed[0] as ExecutionReport).result).toMatchObject({ ok: true, outcome: "executed" });
		expect(await replacement).toMatchObject({ ok: true, outcome: "executed" });
		expect(inside(presses[1] as Cmd, squareRect("e2"))).toBe(true);
		expect(inside(releases[1] as Cmd, squareRect("e4"))).toBe(true);
		expect((presses[1] as Cmd).at).toBeGreaterThan(abortRelease.at);
		expect((presses[1] as Cmd).at - abortRelease.at).toBeGreaterThanOrEqual(
			EXECUTOR.recheckTimeoutMs
		);
		expect((presses[1] as Cmd).at - abortRelease.at).toBeLessThan(EXECUTOR.recheckTimeoutMs + 1000);
		expect(adapter.observeRequests).toEqual([
			{ from: "e2", to: "e4" }, // bounded re-check of the cancelled attempt
			{ from: "e2", to: "e4" }, // the replacement's verification
		]);
		expect(adapter.boardChecks).toEqual([["e2", "e4"]]); // the replacement's position guard
		expect(sim.input.pointer(tabId)?.buttons).toBe(0);
		expect(executor.isRunning()).toBe(false);
		expect(executor.handView()).toBe("resting");
	});

	it("cancel() after the drop landed reports `executed`, and a parked replacement for a DIFFERENT move is dropped as position-changed without any board check", async () => {
		const reports: Array<[string, ExecutionReport]> = [];
		let plan: TimingPlan = plan1200();
		await sw.run(async () => {
			for (const ev of ["executed", "aborted", "skipped", "failed"] as const)
				executor.on(ev, (r) => reports.push([ev, r]));
			await executor.arm();
			focus.positionArrived(tabId, sim.now());
			plan = plan1200();
			executor.schedule(recommendation(plan), plan);
		});
		let cancelledAt = 0;
		let replacement: Promise<unknown> | null = null;
		sim.debugger.respond(CDP.inputDispatchMouseEvent, (params, id) => {
			const result = sim.input.send(id, CDP.inputDispatchMouseEvent, params);
			if ((params as { type: string }).type === "mouseReleased" && replacement === null) {
				cancelledAt = sim.now() - START;
				executor.cancel();
				// d2 is still ours, so only the outcome of the run it waited on can stop this move
				replacement = executor.playNow(recommendation(plan, { from: "d2", to: "d4" }), plan);
			}
			return result;
		});
		await sw.run(() => sim.time.advanceUntilIdle({ maxAdvanceMs: 30_000 }));
		expect(reports.map(([ev]) => ev)).toEqual(["executed", "skipped"]);
		expect((reports[0] as [string, ExecutionReport])[1].rec.chosen.uci).toBe("e2e4");
		expect((reports[1] as [string, ExecutionReport])[1].rec.chosen.uci).toBe("d2d4");
		const first = (reports[0] as [string, ExecutionReport])[1].result;
		expect(first).toMatchObject({ ok: true, outcome: "executed", pressed: true, attempts: 1 });
		expect(first.error).toBeUndefined();
		const second = (reports[1] as [string, ExecutionReport])[1].result;
		expect(second).toMatchObject({
			ok: false,
			outcome: "skipped",
			reason: EXECUTOR.reasons.positionChanged,
			attempts: 0,
		});
		expect(await replacement).toMatchObject({
			outcome: "skipped",
			reason: EXECUTOR.reasons.positionChanged,
		});
		const cmds = commands();
		expect(cmds.filter((c) => c.type === "mousePressed")).toHaveLength(1);
		expect(cmds.filter((c) => c.type === "mouseReleased")).toHaveLength(1);
		// the cancel cut the post-drop rest: nothing after the release, verification bounded; the
		// parked move never reached its own guard — exactly one committed press this position
		expect(cmds.at(-1)?.type).toBe("mouseReleased");
		expect(adapter.observeRequests).toEqual([
			{ from: "e2", to: "e4" }, // short-budget verification of the landed drop
		]);
		expect(adapter.boardChecks).toEqual([]);
		expect(cancelledAt).toBeGreaterThan(0);
		expect(executor.isRunning()).toBe(false);
		expect(executor.pendingMove()).toBeNull();
		// exactly one human-shaped move reached the page — the parked replacement never pressed
		assertShadowAc(plan, [["e2", "e4"]]);
	});

	it("a replacement whose destination the adapter cannot classify is skipped as verification-unavailable (fail closed)", async () => {
		const events: string[] = [];
		let plan: TimingPlan = plan1200();
		adapter.occupancy.e4 = "own";
		delete adapter.occupancy.d5;
		await sw.run(async () => {
			for (const ev of ["executed", "aborted", "skipped", "failed"] as const)
				executor.on(ev, (r) => events.push(`${ev}:${r.rec.chosen.uci}`));
			await executor.arm();
			focus.positionArrived(tabId, sim.now());
			plan = plan1200();
			executor.schedule(recommendation(plan), plan);
		});
		let held = 0;
		let replacement: Promise<unknown> | null = null;
		sim.debugger.respond(CDP.inputDispatchMouseEvent, (params, id) => {
			const p = params as { type: string; buttons: number };
			if (p.type === "mouseMoved" && p.buttons === 1 && ++held === 2) {
				executor.cancel();
				replacement = executor.playNow(recommendation(plan, { from: "e4", to: "d5" }), plan);
			}
			return sim.input.send(id, CDP.inputDispatchMouseEvent, params);
		});
		await sw.run(() => sim.time.advanceUntilIdle({ maxAdvanceMs: 30_000 }));
		expect(await replacement).toMatchObject({
			ok: false,
			outcome: "skipped",
			reason: "verification-unavailable",
		});
		expect(events).toEqual(["aborted:e2e4", "skipped:e4d5"]);
		const presses = commands().filter((c) => c.type === "mousePressed");
		expect(presses).toHaveLength(1);
		expect(adapter.boardChecks).toEqual([["e4", "d5"]]);
	});

	it("a replacement CAPTURE is never vetoed by the enemy piece on its destination (colour-aware guard)", async () => {
		const events: string[] = [];
		let plan: TimingPlan = plan1200();
		adapter.occupancy.e4 = "own";
		adapter.occupancy.d5 = "enemy";
		await sw.run(async () => {
			for (const ev of ["executed", "aborted", "skipped", "failed"] as const)
				executor.on(ev, (r) => events.push(`${ev}:${r.rec.chosen.uci}`));
			await executor.arm();
			focus.positionArrived(tabId, sim.now());
			plan = plan1200();
			executor.schedule(recommendation(plan), plan);
		});
		let held = 0;
		let replacement: Promise<unknown> | null = null;
		sim.debugger.respond(CDP.inputDispatchMouseEvent, (params, id) => {
			const p = params as { type: string; buttons: number };
			if (p.type === "mouseMoved" && p.buttons === 1 && ++held === 2) {
				executor.cancel();
				replacement = executor.playNow(recommendation(plan, { from: "e4", to: "d5" }), plan);
			}
			return sim.input.send(id, CDP.inputDispatchMouseEvent, params);
		});
		await sw.run(() => sim.time.advanceUntilIdle({ maxAdvanceMs: 30_000 }));
		expect(await replacement).toMatchObject({ ok: true, outcome: "executed", attempts: 1 });
		expect(events).toEqual(["aborted:e2e4", "executed:e4d5"]);
		const cmds = commands();
		const presses = cmds.filter((c) => c.type === "mousePressed");
		const releases = cmds.filter((c) => c.type === "mouseReleased");
		expect(presses).toHaveLength(2);
		expect(releases).toHaveLength(2);
		expect(inside(presses[1] as Cmd, squareRect("e4"))).toBe(true);
		expect(inside(releases[1] as Cmd, squareRect("d5"))).toBe(true);
		expect(adapter.boardChecks).toEqual([["e4", "d5"]]);
		expect(adapter.observeRequests).toEqual([
			{ from: "e2", to: "e4" }, // bounded re-check of the cancelled attempt
			{ from: "e4", to: "d5" }, // the capture's verification
		]);
	});

	it("a replacement whose move is already on the board is vetoed by the guard (from-square no longer ours)", async () => {
		const events: string[] = [];
		let plan: TimingPlan = plan1200();
		adapter.occupancy.d2 = "empty";
		adapter.occupancy.d4 = "own";
		await sw.run(async () => {
			for (const ev of ["executed", "aborted", "skipped", "failed"] as const)
				executor.on(ev, (r) => events.push(`${ev}:${r.rec.chosen.uci}:${r.result.reason ?? "-"}`));
			await executor.arm();
			focus.positionArrived(tabId, sim.now());
			plan = plan1200();
			executor.schedule(recommendation(plan), plan);
		});
		let held = 0;
		let replacement: Promise<unknown> | null = null;
		sim.debugger.respond(CDP.inputDispatchMouseEvent, (params, id) => {
			const p = params as { type: string; buttons: number };
			if (p.type === "mouseMoved" && p.buttons === 1 && ++held === 2) {
				executor.cancel();
				replacement = executor.playNow(recommendation(plan, { from: "d2", to: "d4" }), plan);
			}
			return sim.input.send(id, CDP.inputDispatchMouseEvent, params);
		});
		await sw.run(() => sim.time.advanceUntilIdle({ maxAdvanceMs: 30_000 }));
		expect(await replacement).toMatchObject({
			ok: false,
			outcome: "skipped",
			reason: EXECUTOR.reasons.positionChanged,
			attempts: 0,
		});
		expect(events).toEqual([
			`aborted:e2e4:${EXECUTOR.reasons.aborted}`,
			`skipped:d2d4:${EXECUTOR.reasons.positionChanged}`,
		]);
		const cmds = commands();
		expect(cmds.filter((c) => c.type === "mousePressed")).toHaveLength(1);
		expect(cmds.at(-1)?.type).toBe("mouseReleased");
		expect(adapter.boardChecks).toEqual([["d2", "d4"]]);
		expect(adapter.observeRequests).toEqual([{ from: "e2", to: "e4" }]);
	});

	it("cancel() during the replacement's position guard reports `aborted`, not verification-unavailable", async () => {
		const events: string[] = [];
		let plan: TimingPlan = plan1200();
		adapter.onBoardCheck = () => {
			executor.cancel();
			return false;
		};
		await sw.run(async () => {
			for (const ev of ["executed", "aborted", "skipped", "failed"] as const)
				executor.on(ev, (r) => events.push(`${ev}:${r.rec.chosen.uci}:${r.result.reason ?? "-"}`));
			await executor.arm();
			focus.positionArrived(tabId, sim.now());
			plan = plan1200();
			executor.schedule(recommendation(plan), plan);
		});
		let held = 0;
		let replacement: Promise<unknown> | null = null;
		sim.debugger.respond(CDP.inputDispatchMouseEvent, (params, id) => {
			const p = params as { type: string; buttons: number };
			if (p.type === "mouseMoved" && p.buttons === 1 && ++held === 2) {
				executor.cancel();
				replacement = executor.playNow(recommendation(plan, { from: "d2", to: "d4" }), plan);
			}
			return sim.input.send(id, CDP.inputDispatchMouseEvent, params);
		});
		await sw.run(() => sim.time.advanceUntilIdle({ maxAdvanceMs: 30_000 }));
		expect(await replacement).toMatchObject({
			ok: false,
			outcome: "aborted",
			reason: EXECUTOR.reasons.aborted,
			attempts: 0,
		});
		expect(events).toEqual([
			`aborted:e2e4:${EXECUTOR.reasons.aborted}`,
			`aborted:d2d4:${EXECUTOR.reasons.aborted}`,
		]);
		expect(adapter.boardChecks).toEqual([["d2", "d4"]]);
		expect(commands().filter((c) => c.type === "mousePressed")).toHaveLength(1);
		expect(executor.isRunning()).toBe(false);
	});

	it("schedule() replaces a parked replacement (newest wins): the parked move is dropped, the scheduled one plays", async () => {
		const events: string[] = [];
		let plan: TimingPlan = plan1200();
		await sw.run(async () => {
			for (const ev of ["executed", "aborted", "skipped", "failed"] as const)
				executor.on(ev, (r) => events.push(`${ev}:${r.rec.chosen.uci}:${r.result.reason ?? "-"}`));
			await executor.arm();
			focus.positionArrived(tabId, sim.now());
			plan = plan1200();
			executor.schedule(recommendation(plan), plan);
		});
		let held = 0;
		let parkedResult: Promise<unknown> | null = null;
		sim.debugger.respond(CDP.inputDispatchMouseEvent, (params, id) => {
			const p = params as { type: string; buttons: number };
			if (p.type === "mouseMoved" && p.buttons === 1 && ++held === 2) {
				executor.cancel();
				parkedResult = executor.playNow(recommendation(plan), plan);
				expect(executor.pendingMove()?.rec.chosen.uci).toBe("e2e4");
				const next = plan1200();
				executor.schedule(recommendation(next, { from: "d2", to: "d4" }), next);
				expect(executor.pendingMove()?.rec.chosen.uci).toBe("d2d4");
			}
			return sim.input.send(id, CDP.inputDispatchMouseEvent, params);
		});
		await sw.run(() => sim.time.advanceUntilIdle({ maxAdvanceMs: 30_000 }));
		expect(await parkedResult).toMatchObject({
			ok: false,
			outcome: "aborted",
			reason: EXECUTOR.reasons.dropped,
		});
		expect(events).toEqual([
			`aborted:e2e4:${EXECUTOR.reasons.aborted}`,
			`aborted:e2e4:${EXECUTOR.reasons.dropped}`,
			"executed:d2d4:-",
		]);
		const cmds = commands();
		const presses = cmds.filter((c) => c.type === "mousePressed");
		const releases = cmds.filter((c) => c.type === "mouseReleased");
		expect(presses).toHaveLength(2);
		expect(inside(presses[1] as Cmd, squareRect("d2"))).toBe(true);
		expect(inside(releases[1] as Cmd, squareRect("d4"))).toBe(true);
		expect(adapter.boardChecks).toEqual([["d2", "d4"]]);
		expect(executor.pendingMove()).toBeNull();
	});

	it("cancel() during the initial geometry read reports `aborted` (not `no board geometry`) and dispatches nothing", async () => {
		const reports: Array<[string, ExecutionReport]> = [];
		adapter.onGeometry = () => {
			executor.cancel();
			return false;
		};
		await sw.run(async () => {
			for (const ev of ["executed", "aborted", "skipped", "failed"] as const)
				executor.on(ev, (r) => reports.push([ev, r]));
			await executor.arm();
			focus.positionArrived(tabId, sim.now());
			const plan = plan1200();
			executor.schedule(recommendation(plan), plan);
		});
		await sw.run(() => sim.time.advanceUntilIdle({ maxAdvanceMs: 30_000 }));
		expect(reports.map(([ev]) => ev)).toEqual(["aborted"]);
		expect((reports[0] as [string, ExecutionReport])[1].result).toMatchObject({
			ok: false,
			outcome: "aborted",
			reason: EXECUTOR.reasons.aborted,
			attempts: 0,
		});
		expect(commands()).toHaveLength(0);
		expect(adapter.observeRequests).toEqual([]);
		expect(executor.isRunning()).toBe(false);
		expect(executor.handView()).toBe("resting");
	});

	it("disarm() while a replacement is parked drops it: nothing is dispatched after the abort release", async () => {
		const events: string[] = [];
		let plan: TimingPlan = plan1200();
		await sw.run(async () => {
			for (const ev of ["executed", "aborted", "skipped", "failed"] as const)
				executor.on(ev, (r) => events.push(`${ev}:${r.result.reason ?? "-"}`));
			await executor.arm();
			focus.positionArrived(tabId, sim.now());
			plan = plan1200();
			executor.schedule(recommendation(plan), plan);
		});
		let held = 0;
		let replacement: Promise<unknown> | null = null;
		sim.debugger.respond(CDP.inputDispatchMouseEvent, (params, id) => {
			const p = params as { type: string; buttons: number };
			if (p.type === "mouseMoved" && p.buttons === 1 && ++held === 2) {
				executor.cancel();
				replacement = executor.playNow(recommendation(plan), plan);
				expect(executor.pendingMove()?.rec.chosen.uci).toBe("e2e4"); // parked, visible
				executor.disarm();
				expect(executor.pendingMove()).toBeNull();
			}
			return sim.input.send(id, CDP.inputDispatchMouseEvent, params);
		});
		await sw.run(() => sim.time.advanceUntilIdle({ maxAdvanceMs: 30_000 }));
		expect(await replacement).toMatchObject({
			ok: false,
			outcome: "aborted",
			reason: EXECUTOR.reasons.dropped,
			attempts: 0,
		});
		expect(events).toEqual([
			`aborted:${EXECUTOR.reasons.aborted}`,
			`aborted:${EXECUTOR.reasons.dropped}`,
		]);
		const cmds = commands();
		expect(cmds.filter((c) => c.type === "mousePressed")).toHaveLength(1);
		expect(cmds.at(-1)?.type).toBe("mouseReleased");
		expect(adapter.observeRequests).toEqual([{ from: "e2", to: "e4" }]); // only the bounded re-check
		expect(executor.isArmed()).toBe(false);
		expect(executor.isRunning()).toBe(false);
	});

	it("cancel() inside promote() is bounded by the short re-check: the picker read is aborted and the drop verified", async () => {
		adapter.promotionRect = { left: 420, top: 60, width: 80, height: 80 };
		const reports: Array<[string, ExecutionReport, number]> = [];
		let cancelledAt = 0;
		adapter.onPromotionGeometry = () => {
			// the user cancels while the hand looks at the picker: the request is never answered
			cancelledAt = sim.now() - START;
			executor.cancel();
			return false;
		};
		await sw.run(async () => {
			for (const ev of ["executed", "aborted", "skipped", "failed"] as const)
				executor.on(ev, (r) => reports.push([ev, r, sim.now() - START]));
			await executor.arm();
			focus.positionArrived(tabId, sim.now());
			const plan = plan1200();
			executor.schedule(recommendation(plan, { from: "e7", to: "e8", promotion: "q" }), plan);
		});
		await sw.run(() => sim.time.advanceUntilIdle({ maxAdvanceMs: 30_000 }));
		expect(reports).toHaveLength(1);
		const [ev, report, at] = reports[0] as [string, ExecutionReport, number];
		expect(ev).toBe("executed");
		expect(report.result).toMatchObject({ ok: true, outcome: "executed", pressed: true });
		expect(
			report.result.timeline.some(
				(t) => t.phase === EXECUTOR.timelineNotes.promotionGeometryUnavailable
			)
		).toBe(true);
		expect(cancelledAt).toBeGreaterThan(0);
		expect(at - cancelledAt).toBeLessThanOrEqual(EXECUTOR.recheckTimeoutMs + 50);
		const cmds = commands();
		expect(cmds.filter((c) => c.type === "mousePressed")).toHaveLength(1); // no picker click
		expect(adapter.observeRequests).toEqual([{ from: "e7", to: "e8" }]);
		// the aborted picker request was dropped: a late reply to it changes nothing
		expect(link.tabs()).toEqual([tabId]);
		expect(executor.isRunning()).toBe(false);
		expect(executor.pendingMove()).toBeNull();
	});
});

/**
 * §9.5 / the owner's live test (2026-09-09): arming mid-game attaches the debugger, Chrome shows
 * its "is debugging this browser" infobar, and the page — board included — reflows underneath a
 * drag that is already in flight. Every remaining path point is then in the old coordinate space,
 * so the release lands on whatever square the stale path ends over: the owner saw the piece let go
 * halfway and drop on the wrong square.
 *
 * A clean no-move is always better than a move to the wrong square, so a board that moves mid-drag
 * puts the piece back on its origin square and reports an abort with its own reason; the executor's
 * existing re-check then decides, truthfully, that nothing landed.
 */
const MOVED_BOARD: Rect = { left: BOARD.left + 24, top: BOARD.top + 64, width: 640, height: 640 };

/** Relayout the page and the fake adapter onto `rect` (what a reflow does). */
function reflowBoard(rect: Rect): void {
	const dom = sim.getTabDom(tabId);
	if (!dom) throw new Error("no dom");
	const asLayout = (r: Rect) => ({ x: r.left, y: r.top, width: r.width, height: r.height });
	dom.layout("#board", asLayout(rect));
	for (const sq of ALL) dom.layout(`#${sq}`, asLayout(squareRect(sq, false, rect)));
	adapter.boardRect = rect;
}

describe("executor: the board moves under the hand", () => {
	it("a reflow mid-drag releases on the origin square, submits nothing and reports `board-moved`", async () => {
		const reports: Array<[string, ExecutionReport]> = [];
		await sw.run(async () => {
			for (const ev of ["executed", "aborted", "skipped", "failed"] as const)
				executor.on(ev, (r) => reports.push([ev, r]));
			await executor.arm();
			focus.positionArrived(tabId, sim.now());
			const plan = plan1200();
			executor.schedule(recommendation(plan), plan);
		});
		let held = 0;
		let reflowAt = 0;
		sim.debugger.respond(CDP.inputDispatchMouseEvent, (params, id) => {
			const p = params as { type: string; buttons: number };
			// two drag moves in: the piece is held and travelling towards e4
			if (p.type === "mouseMoved" && p.buttons === 1 && ++held === 2) {
				reflowAt = sim.now();
				reflowBoard(MOVED_BOARD);
				port.post({ kind: "boardRect", rect: MOVED_BOARD });
			}
			return sim.input.send(id, CDP.inputDispatchMouseEvent, params);
		});
		await sw.run(() => sim.time.advanceUntilIdle({ maxAdvanceMs: 30_000 }));

		expect(reflowAt).toBeGreaterThan(0);
		expect(reports.map(([ev]) => ev)).toEqual(["aborted"]);
		const result = (reports[0] as [string, ExecutionReport])[1].result;
		expect(result).toMatchObject({
			ok: false,
			outcome: "aborted",
			reason: EXECUTOR.reasons.boardMoved,
			pressed: true,
		});

		const cmds = commands();
		const presses = cmds.filter((c) => c.type === "mousePressed");
		const releases = cmds.filter((c) => c.type === "mouseReleased");
		// the button is never left held and never pressed twice
		expect(presses).toHaveLength(1);
		expect(releases).toHaveLength(1);
		expect(sim.input.pointer(tabId)?.buttons).toBe(0);
		expect(executor.isRunning()).toBe(false);

		// the release is on the origin square *as it now stands*, never on the destination
		const release = releases[0] as Cmd;
		expect(inside(release, squareRect("e2", false, MOVED_BOARD))).toBe(true);
		expect(inside(release, squareRect("e4", false, MOVED_BOARD))).toBe(false);
		expect(inside(release, squareRect("e4"))).toBe(false);
		// what the page itself saw: down on e2, up on e2, and no move submitted at all
		const domEvents = sim.input.events;
		expect(domEvents.find((e) => e.type === "mousedown")?.target).toBe("e2");
		expect(domEvents.filter((e) => e.type === "mouseup").at(-1)?.target).toBe("e2");
		expect(submitted).toEqual([]);
		expect(shadow.pendingSelection()).toBe("e2");

		// §13.5: the escape is a path, not a jump — no step exceeds the profile's cap
		let prev: Pt = { x: 900, y: 400 };
		for (const c of cmds) {
			expect(Math.hypot(c.x - prev.x, c.y - prev.y)).toBeLessThanOrEqual(30);
			prev = c;
		}
	});

	it("a reflow between the plan and the press dispatches nothing at all", async () => {
		// The ~300 ms approach (plus the pre-grab pause) runs *after* the geometry re-read and before
		// the committed press. A reflow landing there would otherwise press a point that is a
		// different square in the new layout, and the escape release on the origin would then read as
		// a drag *from* that wrong square — a wrong move, submitted. Nothing is committed yet, so the
		// right answer is to dispatch nothing more.
		const reports: Array<[string, ExecutionReport]> = [];
		await sw.run(async () => {
			for (const ev of ["executed", "aborted", "skipped", "failed"] as const)
				executor.on(ev, (r) => reports.push([ev, r]));
			await executor.arm();
			focus.positionArrived(tabId, sim.now());
			const plan = plan1200();
			executor.schedule(recommendation(plan), plan);
		});
		let reflowAt = 0;
		sim.debugger.respond(CDP.inputDispatchMouseEvent, (params, id) => {
			const p = params as { type: string; buttons: number; x: number; y: number };
			// the first free move that arrives on the from-square: the approach is landing
			if (
				reflowAt === 0 &&
				p.type === "mouseMoved" &&
				p.buttons === 0 &&
				inside(p, squareRect("e2"))
			) {
				reflowAt = sim.now();
				reflowBoard(MOVED_BOARD);
				port.post({ kind: "boardRect", rect: MOVED_BOARD });
			}
			return sim.input.send(id, CDP.inputDispatchMouseEvent, params);
		});
		await sw.run(() => sim.time.advanceUntilIdle({ maxAdvanceMs: 30_000 }));

		expect(reflowAt).toBeGreaterThan(0);
		expect(reports.map(([ev]) => ev)).toEqual(["aborted"]);
		expect((reports[0] as [string, ExecutionReport])[1].result).toMatchObject({
			ok: false,
			outcome: "aborted",
			reason: EXECUTOR.reasons.boardMoved,
			pressed: false,
		});
		// nothing was pressed, so nothing can have been submitted
		const cmds = commands();
		expect(cmds.filter((c) => c.type === "mousePressed")).toHaveLength(0);
		expect(cmds.filter((c) => c.type === "mouseReleased")).toHaveLength(0);
		expect(sim.input.events.filter((e) => e.type === "mousedown")).toHaveLength(0);
		expect(submitted).toEqual([]);
		expect(sim.input.pointer(tabId)?.buttons).toBe(0);
		expect(executor.isRunning()).toBe(false);
	});

	it("after an arm-time attach the first execution waits for the layout to settle, then plays on the new geometry", async () => {
		const geometryAt: number[] = [];
		adapter.onGeometry = () => {
			geometryAt.push(sim.now());
			return true;
		};
		await sw.run(async () => {
			await executor.arm();
			focus.positionArrived(tabId, sim.now());
		});
		// the infobar appears and the page settles over two frames
		await sw.run(async () => {
			port.post({ kind: "boardRect", rect: BOARD });
			await sim.time.advance(40);
			reflowBoard(MOVED_BOARD);
			port.post({ kind: "boardRect", rect: MOVED_BOARD });
			await sim.time.runMicrotasks();
		});
		const settledAt = sim.now();
		await sw.run(() => {
			const plan = plan1200();
			executor.schedule(recommendation(plan), plan);
		});
		await sw.run(() => sim.time.advanceUntilIdle({ maxAdvanceMs: 30_000 }));

		// geometry was not read until the rect had been still for the stability window
		expect(geometryAt.length).toBeGreaterThan(0);
		expect((geometryAt[0] as number) - settledAt).toBeGreaterThanOrEqual(
			EXECUTOR.attachSettleStableMs
		);
		// and the move then played on the geometry that is actually on the page
		const cmds = commands();
		const press = cmds.find((c) => c.type === "mousePressed") as Cmd;
		const release = cmds.filter((c) => c.type === "mouseReleased").at(-1) as Cmd;
		expect(inside(press, squareRect("e2", false, MOVED_BOARD))).toBe(true);
		expect(inside(release, squareRect("e4", false, MOVED_BOARD))).toBe(true);
		expect(submitted).toEqual([["e2", "e4"]]);
	});
});
