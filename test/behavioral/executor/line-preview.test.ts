// test/behavioral/executor/line-preview.test.ts — the line preview (`LINE_PREVIEW`, owner
// 2026-09-12) end to end in the simulator: the real executor stack (debugger manager, content
// link, focus gate, hand ownership, `MoveExecutor` with the preview forced on) plays a long-think
// recommendation against `createSimulatedSite` — the chess.js board that records chess.com's
// arrows (a right-button drag draws one, the next left press clears them all), the real
// content-side game port, and the `ac` shadow that classifies right-button presses as
// annotations. Everything is read from what the page saw and from the CDP command log.
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { loadPosition } from "@core/chess/fen";
import { playUci } from "@core/chess/san";
import { CDP, EXECUTOR } from "@core/constants/cdp";
import { TELEMETRY_BANDS } from "@core/constants/telemetry";
import { LINE_PREVIEW } from "@core/motor/constants";
import { defaultScheduler } from "@core/util/scheduler";
import { ContentLink } from "@service/content-link";
import { DebuggerManager } from "@service/debugger-manager";
import { FocusGate } from "@service/focus-gate";
import { HandOwnership } from "@service/hand-ownership";
import { Keepalive } from "@service/keepalive";
import { type ExecutionReport, type MoveContext, MoveExecutor } from "@service/move-executor";
import { createSimulator, type Simulator } from "@test/sim";
import { bootSwContext, type SwContext } from "@test/sim/contexts/sw-context";
import { SIM_TELEMETRY } from "@test/sim/telemetry/constants";
import { createSimulatedSite, type SimulatedSite } from "@test/sim/telemetry/sim-site";
import type { EvalLine } from "@typedefs/engine";
import type { Recommendation, Square } from "@typedefs/game";
import type { TimingPlan } from "@typedefs/timing";
import {
	type AcMoveMeta,
	assertHumanShapedAc,
	assertHumanShapedAnnotations,
} from "../../../tools/telemetry-conformance/ac-model";

const START = SIM_TELEMETRY.startAt;
const CLOCKS = { w: 300_000, b: 300_000 };
const RIGHT = CDP.mouse.rightButtons;
const LEFT = CDP.mouse.leftButtons;

let sim: Simulator;
let sw: SwContext;
let tabId: number;
let dbg: DebuggerManager;
let link: ContentLink;
let focus: FocusGate;
let ownership: HandOwnership;
let executor: MoveExecutor;
let page: SimulatedSite;

interface Cmd {
	type: string;
	x: number;
	y: number;
	button: string;
	buttons: number;
	clickCount?: number;
	at: number;
}
const commands = (): Cmd[] =>
	sim.debugger.commandsFor(CDP.inputDispatchMouseEvent).map((c) => {
		const p = (c.params ?? {}) as Record<string, unknown>;
		return {
			type: String(p.type),
			x: Number(p.x),
			y: Number(p.y),
			button: String(p.button),
			buttons: Number(p.buttons ?? 0),
			...(p.clickCount === undefined ? {} : { clickCount: Number(p.clickCount) }),
			at: c.at - START,
		};
	});

const inside = (p: { x: number; y: number }, sq: Square): boolean => {
	const r = page.board.squareRect(sq);
	return p.x >= r.left && p.x <= r.left + r.width && p.y >= r.top && p.y <= r.top + r.height;
};

async function boot(linePreview: "auto" | "force" | "off"): Promise<void> {
	sim = createSimulator({ startAt: START });
	sim.time.install();
	tabId = sim.openTab("https://www.chess.com/game/live/1").tabId;
	sw = await bootSwContext(sim, {
		entry: async () => {
			const keepalive = new Keepalive();
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
				tcClass: "rapid",
				previewScale: 0,
				gameSeed: "line-preview-game",
				linePreview,
			});
		},
	});
	page = await createSimulatedSite(sim, tabId, { myColor: "w" });
	await sim.time.runMicrotasks();
	await sw.run(() => executor.arm());
}

afterEach(async () => {
	await sw.run(() => {
		executor.dispose();
		focus.dispose();
		ownership.dispose();
		link.dispose();
		dbg.dispose();
	});
	await page.dispose();
	await sw.teardown();
	sim.time.uninstall();
	await sim.dispose();
});

/** A long-think plan: orientation 500, scan, decision, approach 1000 — `thinkMs` in all. */
function longPlan(thinkMs: number): TimingPlan {
	const approachMs = 1000;
	const orientationMs = 500;
	const rest = thinkMs - approachMs - orientationMs;
	const decisionMs = Math.round(rest * 0.7);
	return {
		thinkMs,
		mode: "long",
		preMoveHoverMs: thinkMs - approachMs,
		dragDurationMs: 400,
		deadlineMs: sim.now() + thinkMs,
		rationale: [],
		features: {},
		orientationMs,
		window: { orientationMs, scanMs: rest - decisionMs, previewMs: 0, decisionMs, approachMs },
	};
}

function line(multipv: number, pvUci: string[], cp: number): EvalLine {
	return { multipv, score: { cp }, depth: 14, pvUci, pvSan: [] };
}

function recommendation(
	fen: string,
	chosen: string,
	lines: EvalLine[],
	plan: TimingPlan
): Recommendation {
	return {
		chosen: {
			uci: chosen,
			san: chosen,
			from: chosen.slice(0, 2) as Square,
			to: chosen.slice(2, 4) as Square,
			source: "engine-elo",
			rankInLines: 1,
			cpLoss: 0,
			rationale: [],
		},
		lines,
		eval: lines[0]?.score ?? { cp: 0 },
		depth: 14,
		nps: 1_000_000,
		plan,
		computedAt: sim.now(),
		fen,
	};
}

function context(lines: EvalLine[]): MoveContext {
	return {
		myClockMs: CLOCKS.w,
		nReasonable: 2,
		candidates: lines.map((l, i) => ({
			from: (l.pvUci[0] ?? "").slice(0, 2) as Square,
			to: (l.pvUci[0] ?? "").slice(2, 4) as Square,
			uci: l.pvUci[0] ?? "",
			probability: 1 / (i + 1),
		})),
		legalDestinations: (sq) => page.board.legalDestinations(sq),
	};
}

/** Schedule and run the clock until the executor reports; returns the report. */
async function play(rec: Recommendation, ctx: MoveContext): Promise<ExecutionReport> {
	const reports: ExecutionReport[] = [];
	const offs = (["executed", "failed", "aborted", "skipped"] as const).map((ev) =>
		executor.on(ev, (r) => reports.push(r))
	);
	try {
		await sw.run(async () => {
			executor.schedule(rec, rec.plan, ctx);
			const giveUpAt = sim.now() + SIM_TELEMETRY.maxMoveAdvanceMs;
			while (reports.length === 0 && sim.now() < giveUpAt)
				await sim.time.advance(SIM_TELEMETRY.advanceStepMs);
		});
	} finally {
		for (const off of offs) off();
	}
	const report = reports[0];
	if (!report) throw new Error("the executor reported nothing");
	return report;
}

/** A 3-ply legal line from `fen` starting with `first`: our move, their reply, our next move. */
function lineFrom(fen: string, first: string): string[] {
	const board = loadPosition(fen);
	if (!board || !playUci(board, first)) throw new Error(`illegal ${first} in ${fen}`);
	const out = [first];
	for (let i = 0; i < 5; i++) {
		const next = board.moves({ verbose: true })[0];
		if (!next) break;
		board.move(next);
		out.push(`${next.from}${next.to}${next.promotion ?? ""}`);
	}
	return out;
}

const PV1 = ["e2e4", "e7e5", "g1f3", "b8c6"];
const PV2 = ["d2d4", "d7d5", "c2c4"];
const LINES = [line(1, PV1, 30), line(2, PV2, 20)];

describe("executor: the line preview (right-button arrows along the PV on a long think)", () => {
	beforeEach(() => boot("force"));

	it("draws the chosen line as right-button drags from→to in PV order, the site shows the arrows, the move's left press clears them, the move lands", async () => {
		const plan = longPlan(12_000);
		const rec = recommendation(page.board.fen(), "e2e4", LINES, plan);
		await sw.run(() => {
			page.arrive(null, CLOCKS);
			focus.positionArrived(tabId, sim.now());
		});
		const report = await play(rec, context(LINES));
		expect(report.result).toMatchObject({ ok: true, outcome: "executed", tier: "drag", attempts: 1 });
		expect(page.board.lastMove()).toMatchObject({ from: "e2", to: "e4", byMe: true });

		// ── the CDP side: right presses, held right moves, right releases, then the one left drag ──
		const cmds = commands();
		const rightPresses = cmds.filter((c) => c.type === "mousePressed" && c.button === "right");
		const rightReleases = cmds.filter((c) => c.type === "mouseReleased" && c.button === "right");
		const leftPresses = cmds.filter((c) => c.type === "mousePressed" && c.button === "left");
		const leftReleases = cmds.filter((c) => c.type === "mouseReleased" && c.button === "left");
		const arrows = rightPresses.length;
		expect(arrows).toBeGreaterThanOrEqual(LINE_PREVIEW.plies[0]);
		expect(arrows).toBeLessThanOrEqual(TELEMETRY_BANDS.annotation.maxPerMove);
		expect(rightReleases).toHaveLength(arrows);
		expect(leftPresses).toHaveLength(1);
		expect(leftReleases).toHaveLength(1);
		expect(report.result.annotations).toBe(arrows);
		// every arrow: press inside ply.from, release inside ply.to, `buttons: 2` on every held point
		const expectedPlies = [...PV1, ...PV2];
		let ply = 0;
		for (let i = 0; i < arrows; i++) {
			const press = rightPresses[i] as Cmd;
			const release = rightReleases[i] as Cmd;
			// the arrows follow PV1 in order, then (if a second line was drawn) PV2 from its start
			if (i > 0 && inside(press, PV2[0]?.slice(0, 2) as Square) && ply < PV1.length) ply = PV1.length;
			const uci = expectedPlies[ply] as string;
			expect(inside(press, uci.slice(0, 2) as Square)).toBe(true);
			expect(inside(release, uci.slice(2, 4) as Square)).toBe(true);
			expect(press).toMatchObject({ buttons: RIGHT, clickCount: 1 });
			expect(release).toMatchObject({ buttons: 0, clickCount: 1 });
			const held = cmds.slice(cmds.indexOf(press) + 1, cmds.indexOf(release));
			expect(held.length).toBeGreaterThan(0);
			for (const c of held)
				expect(c).toMatchObject({ type: "mouseMoved", button: "right", buttons: RIGHT });
			ply += 1;
		}
		// the first arrow starts with our own move
		expect(inside(rightPresses[0] as Cmd, "e2")).toBe(true);
		expect(inside(rightReleases[0] as Cmd, "e4")).toBe(true);
		// nothing pressed before the first arrow; the left drag comes after the last arrow
		const firstRight = cmds.indexOf(rightPresses[0] as Cmd);
		for (const c of cmds.slice(0, firstRight)) expect(c.buttons).toBe(0);
		const leftPress = leftPresses[0] as Cmd;
		expect(leftPress.at).toBeGreaterThan((rightReleases[arrows - 1] as Cmd).at);
		expect(leftPress).toMatchObject({ buttons: LEFT, clickCount: 1 });
		expect(inside(leftPress, "e2")).toBe(true);
		expect(inside(leftReleases[0] as Cmd, "e4")).toBe(true);
		// the drop lands on the deadline: the preview was budgeted, not squeezed in
		expect(Math.abs((leftReleases[0] as Cmd).at - plan.thinkMs)).toBeLessThanOrEqual(
			SIM_TELEMETRY.deadlineToleranceMs
		);
		// §13.5: one continuous pointer through the whole thing — no teleport into or out of an arrow
		let prev: { x: number; y: number } = {
			x: SIM_TELEMETRY.restPoint.x,
			y: SIM_TELEMETRY.restPoint.y,
		};
		for (const c of cmds) {
			expect(Math.hypot(c.x - prev.x, c.y - prev.y)).toBeLessThanOrEqual(
				TELEMETRY_BANDS.pointer.maxStepPx
			);
			prev = c;
		}
		expect(sim.input.pointer(tabId)?.buttons).toBe(0);

		// ── the site: arrows drawn per right drag, all cleared by the move's own left press ──
		const log = page.board.annotationLog();
		expect(log.filter((a) => a.kind === "arrow")).toHaveLength(arrows);
		expect(log[0]).toEqual({ kind: "arrow", from: "e2", to: "e4" });
		expect(log.at(-1)).toEqual({ kind: "clear" });
		expect(log.filter((a) => a.kind === "clear")).toHaveLength(1);
		expect(page.board.arrows()).toEqual([]);

		// ── the timeline: a `line-preview` phase and one `arrow` note per drag ──
		const timeline = report.result.timeline;
		expect(timeline.some((t) => t.phase === EXECUTOR.timelinePhases.linePreview)).toBe(true);
		expect(timeline.filter((t) => t.phase === EXECUTOR.timelineNotes.arrow)).toHaveLength(arrows);
		expect(report.result.previewedSquares).toEqual([]);
		expect(executor.linePreviewCount()).toBe(1);

		// ── the telemetry: annotations, never selections; the blob is human-shaped ──
		const obs = page.shadow.observations;
		expect(obs).toHaveLength(1);
		const diag = (obs[0] as NonNullable<(typeof obs)[0]>).diag;
		expect(diag.presses).toHaveLength(1);
		expect(diag.presses[0]?.action).toBe("move");
		expect(diag.selections).toEqual(["e2"]);
		expect(diag.annotations).toHaveLength(arrows);
		for (const a of diag.annotations) {
			expect(a.trusted).toBe(true);
			expect(a.square).not.toBeNull();
			expect(a.releaseSquare).not.toBeNull();
			expect(a.releaseSquare).not.toBe(a.square);
			expect(a.movesDuring).toBeGreaterThan(0);
		}
		const meta: AcMoveMeta[] = [
			{ mode: plan.mode, thinkMs: plan.thinkMs, clockMs: CLOCKS.w, nReasonable: 2 },
		];
		const summary = assertHumanShapedAc(
			obs.map((o) => o.ac),
			{ moves: meta }
		);
		expect(summary.multiSelect.count).toBe(0);
		expect(summary.untrusted).toBe(0);
		expect(obs[0]?.ac.DidSelectMultiplePieces).toBe(false);
		assertHumanShapedAnnotations([arrows], meta);
		expect(() =>
			assertHumanShapedAnnotations([arrows], [{ ...meta[0], thinkMs: 1000 } as AcMoveMeta])
		).toThrow(/arrow/);
		expect(page.shadow.pendingSelection()).toBeNull();
	});

	it("cancel() mid-arrow releases the right button where the pointer is, dispatches no left press, and the same move is never previewed twice", async () => {
		const plan = longPlan(12_000);
		const rec = recommendation(page.board.fen(), "e2e4", LINES, plan);
		await sw.run(() => {
			page.arrive(null, CLOCKS);
			focus.positionArrived(tabId, sim.now());
		});
		let held = 0;
		let cancelledAt = 0;
		const off = sim.debugger.respond(CDP.inputDispatchMouseEvent, (params, id) => {
			const p = params as { type: string; buttons: number };
			if (p.type === "mouseMoved" && p.buttons === RIGHT && ++held === 3) {
				cancelledAt = sim.now() - START;
				executor.cancel();
			}
			return sim.input.send(id, CDP.inputDispatchMouseEvent, params);
		});
		const report = await play(rec, context(LINES));
		off();
		expect(cancelledAt).toBeGreaterThan(0);
		expect(report.result).toMatchObject({
			ok: false,
			outcome: "aborted",
			reason: EXECUTOR.reasons.aborted,
			pressed: false,
		});
		expect(report.result.pressedAny).toBe(false);
		const cmds = commands();
		const rightPresses = cmds.filter((c) => c.type === "mousePressed" && c.button === "right");
		const rightReleases = cmds.filter((c) => c.type === "mouseReleased" && c.button === "right");
		expect(rightPresses).toHaveLength(1);
		expect(rightReleases).toHaveLength(1);
		expect(cmds.filter((c) => c.type === "mousePressed" && c.button === "left")).toHaveLength(0);
		// the release is at once, at the current point
		const release = rightReleases[0] as Cmd;
		const before = cmds[cmds.indexOf(release) - 1] as Cmd;
		expect(before).toMatchObject({ type: "mouseMoved", buttons: RIGHT });
		expect({ x: release.x, y: release.y }).toEqual({ x: before.x, y: before.y });
		expect(release.at - cancelledAt).toBeLessThanOrEqual(CDP.stallResyncMs);
		expect(cmds.at(-1)).toBe(release);
		expect(sim.input.pointer(tabId)?.buttons).toBe(0);
		// nothing moved on the board; an arrow to nowhere is at most a stray arrow (the pointer was
		// still over the from-square here, so chess.com would not even draw one)
		expect(page.board.lastMove()).toBeNull();
		expect(page.shadow.observations).toEqual([]);
		expect(page.shadow.pendingSelection()).toBeNull();
		expect(executor.linePreviewCount()).toBe(1);

		// the same move again, with a fresh long plan: the game's allowance for it was spent
		const again = recommendation(page.board.fen(), "e2e4", LINES, longPlan(12_000));
		await sw.run(() => focus.positionArrived(tabId, sim.now()));
		const second = await play(again, context(LINES));
		expect(second.result).toMatchObject({ ok: true, outcome: "executed" });
		expect(second.result.annotations).toBeUndefined();
		expect(commands().filter((c) => c.type === "mousePressed" && c.button === "right")).toHaveLength(
			1
		);
		expect(executor.linePreviewCount()).toBe(1);
		expect(page.board.lastMove()).toMatchObject({ from: "e2", to: "e4" });
	});

	it("a short think never previews, forced or not", async () => {
		const plan = longPlan(LINE_PREVIEW.minThinkMs - 1000);
		const rec = recommendation(page.board.fen(), "e2e4", LINES, plan);
		await sw.run(() => {
			page.arrive(null, CLOCKS);
			focus.positionArrived(tabId, sim.now());
		});
		const report = await play(rec, context(LINES));
		expect(report.result).toMatchObject({ ok: true, outcome: "executed" });
		expect(report.result.annotations).toBeUndefined();
		const cmds = commands();
		expect(cmds.filter((c) => c.button === "right")).toHaveLength(0);
		expect(cmds.filter((c) => c.type === "mousePressed")).toHaveLength(1);
		expect(page.board.annotationLog()).toEqual([]);
		expect(executor.linePreviewCount()).toBe(0);
		expect(page.shadow.observations[0]?.diag.annotations).toEqual([]);
	});

	it(`the per-game cap holds: after ${LINE_PREVIEW.maxPerGame} previewed moves the next long think draws nothing`, async () => {
		await sw.run(() => {
			page.arrive(null, CLOCKS);
			focus.positionArrived(tabId, sim.now());
		});
		const arrowsPerMove: number[] = [];
		const meta: AcMoveMeta[] = [];
		for (let i = 0; i <= LINE_PREVIEW.maxPerGame; i++) {
			const fen = page.board.fen();
			const legal = page.board.legalMoves();
			const first = legal[0] as string;
			const pv = lineFrom(fen, first);
			const alt = legal[1] ? lineFrom(fen, legal[1]) : pv;
			const lines = [line(1, pv, 30), line(2, alt, 20)];
			const plan = longPlan(12_000);
			const before = commands().length;
			const report = await play(recommendation(fen, first, lines, plan), context(lines));
			expect(report.result).toMatchObject({ ok: true, outcome: "executed" });
			const arrows = commands()
				.slice(before)
				.filter((c) => c.type === "mousePressed" && c.button === "right").length;
			arrowsPerMove.push(arrows);
			meta.push({ mode: plan.mode, thinkMs: plan.thinkMs, clockMs: CLOCKS.w, nReasonable: 2 });
			expect(arrows).toBe(report.result.annotations ?? 0);
			// the opponent replies with the line's second ply (legal by construction)
			const reply = pv[1];
			if (!reply) break;
			await sw.run(async () => {
				await sim.time.advance(800);
				page.arrive(reply, CLOCKS);
				focus.positionArrived(tabId, sim.now());
				await sim.time.runMicrotasks();
			});
		}
		expect(arrowsPerMove).toHaveLength(LINE_PREVIEW.maxPerGame + 1);
		for (const n of arrowsPerMove.slice(0, LINE_PREVIEW.maxPerGame))
			expect(n).toBeGreaterThanOrEqual(LINE_PREVIEW.plies[0]);
		expect(arrowsPerMove[LINE_PREVIEW.maxPerGame]).toBe(0);
		expect(executor.linePreviewCount()).toBe(LINE_PREVIEW.maxPerGame);
		assertHumanShapedAnnotations(arrowsPerMove, meta);
		expect(() => assertHumanShapedAnnotations([...arrowsPerMove.slice(0, -1), 2], meta)).toThrow(
			/per game/
		);
		// every move's own left press cleared the arrows: none standing, one clear per previewed move
		expect(page.board.arrows()).toEqual([]);
		expect(page.board.annotationLog().filter((a) => a.kind === "clear")).toHaveLength(
			LINE_PREVIEW.maxPerGame
		);
		assertHumanShapedAc(
			page.shadow.observations.map((o) => o.ac),
			{ moves: meta }
		);
	}, 60_000);
});

describe("executor: the line preview in `auto`", () => {
	beforeEach(() => boot("auto"));

	it("a 1-ply PV (nothing to map out) never previews, whatever the think", async () => {
		const lines = [line(1, ["e2e4"], 30), line(2, ["d2d4"], 20)];
		const rec = recommendation(page.board.fen(), "e2e4", lines, longPlan(12_000));
		await sw.run(() => {
			page.arrive(null, CLOCKS);
			focus.positionArrived(tabId, sim.now());
		});
		const report = await play(rec, context(lines));
		expect(report.result).toMatchObject({ ok: true, outcome: "executed" });
		expect(commands().filter((c) => c.button === "right")).toHaveLength(0);
		expect(executor.linePreviewCount()).toBe(0);
	});
});
