// test/service/move-executor/hand-controller.test.ts — Step 3: the virtual hand's drag / click / promotion
// sequences, timing, the §13.4 focus gate, §13.5 hand ownership and the abort path.
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { debuggerAttach, debuggerSend } from "@core/chrome/debugger";
import { type BoardGeometryReply, CDP, EXECUTOR } from "@core/constants";
import { MOTOR_DEFAULTS, PATH, PROMOTION_LOOK_DELAY_MS } from "@core/motor/constants";
import type {
	ExecutionPlan,
	HandState,
	MotorProfile,
	PathPoint,
	Pt,
	Rect,
} from "@core/motor/types";
import { createRng } from "@core/rng";
import { defaultScheduler } from "@core/util/scheduler";
import type { BoardRectSource } from "@service/board-watch";
import type { FocusVerdict } from "@service/focus-gate";
import { HandOwnership } from "@service/hand-ownership";
import { CdpInputBackend } from "@service/move-executor/cdp-input-backend";
import {
	type GeometryProvider,
	HandController,
	rescalePath,
} from "@service/move-executor/hand-controller";
import { createSimulator, type Simulator } from "@test/sim";
import type { PromoPiece, Square } from "@typedefs/game";
import type { TimingPlan } from "@typedefs/timing";
import { BOARD, geometry, inside, squareRect } from "../../core/motor/fixtures";

const START = 1_000_000;
const START_POINT: Pt = { x: 700, y: 690 }; // resting near the clock band, off the from-square
let sim: Simulator;
let tabId: number;
let ownership: HandOwnership;
let verdict: FocusVerdict;
let tabsUpdateCalls = 0;
let windowsUpdateCalls = 0;
let promotionRect: Rect | null;
let geometryReads: Array<PromoPiece | undefined>;
/** Destination squares the promotion reads carried (Task 30: the picker needs the square). */
let promotionTargets: Array<string | undefined>;
const prevChrome = (globalThis as Record<string, unknown>).chrome;

let promotionReadFails = false;
/** Occupancy the provider reports on the Nth board read (1-based); absent = no occupancy. */
let occupancyByRead: Record<number, BoardGeometryReply["occupancy"]> = {};
let boardReads = 0;
let signalsSeen: Array<AbortSignal | undefined> = [];
const provider: GeometryProvider = {
	async read(_tabId, promotion, signal) {
		geometryReads.push(promotion?.piece);
		promotionTargets.push(promotion?.to);
		signalsSeen.push(signal);
		if (promotion !== undefined && promotionReadFails) throw new Error("timeout");
		const reply: BoardGeometryReply = { boardRect: BOARD, flipped: false };
		if (promotion !== undefined) reply.promotion = promotionRect;
		else {
			boardReads += 1;
			const occ = occupancyByRead[boardReads];
			if (occ) reply.occupancy = occ;
		}
		return reply;
	},
};

beforeEach(async () => {
	sim = createSimulator({ startAt: START });
	sim.time.install();
	tabId = sim.openTab("https://www.chess.com/game/174252022572").tabId;
	(globalThis as Record<string, unknown>).chrome = sim.chrome;
	await debuggerAttach(tabId, CDP.protocolVersion);
	ownership = new HandOwnership();
	ownership.armed(tabId, START_POINT);
	verdict = { ok: true };
	tabsUpdateCalls = 0;
	windowsUpdateCalls = 0;
	promotionRect = null;
	promotionReadFails = false;
	occupancyByRead = {};
	boardReads = 0;
	signalsSeen = [];
	geometryReads = [];
	promotionTargets = [];
	const realUpdate = sim.chrome.tabs.update;
	sim.chrome.tabs.update = ((...args: unknown[]) => {
		tabsUpdateCalls += 1;
		return (realUpdate as (...a: unknown[]) => unknown)(...args);
	}) as typeof sim.chrome.tabs.update;
	(sim.chrome.windows as unknown as Record<string, unknown>).update = () => {
		windowsUpdateCalls += 1;
	};
});
afterEach(async () => {
	sim.time.uninstall();
	(globalThis as Record<string, unknown>).chrome = prevChrome;
	await sim.dispose();
});

const DESTS: Partial<Record<Square, Square[]>> = {
	e2: ["e3", "e4"],
	g1: ["f3", "h3"],
	d2: ["d3", "d4"],
	b1: ["a3", "c3"],
};

function makePlan(over: Partial<ExecutionPlan> = {}, previewScale = 0): ExecutionPlan {
	const from = squareRect("e2");
	const to = squareRect("e4");
	return {
		tabId,
		site: "chesscom",
		from: { x: from.left + from.width / 2, y: from.top + from.height / 2, rect: from, square: "e2" },
		to: { x: to.left + to.width / 2, y: to.top + to.height / 2, rect: to, square: "e4" },
		motor: MOTOR_DEFAULTS,
		expected: { uci: "e2e4", premove: false },
		exploration: {
			candidates: [
				{ from: "e2", to: "e4", probability: 0.7, uci: "e2e4" },
				{ from: "g1", to: "f3", probability: 0.2, uci: "g1f3" },
				{ from: "d2", to: "d4", probability: 0.1, uci: "d2d4" },
			],
			nReasonable: 3,
			myClockMs: 120_000,
			persona: "balanced",
			previewScale,
			legalDestinations: (sq) => DESTS[sq] ?? [],
		},
		...over,
	};
}

function makeTiming(over: Partial<TimingPlan> = {}): TimingPlan {
	const base = {
		thinkMs: 3000,
		mode: "normal" as const,
		preMoveHoverMs: 2000,
		dragDurationMs: 400,
		deadlineMs: START + 3000,
		rationale: [],
		features: {},
		orientationMs: 0,
		...over,
	};
	// The pre-touch window mirrors `preMoveHoverMs` unless a test passes its own phases.
	const window = over.window ?? {
		orientationMs: base.preMoveHoverMs,
		scanMs: 0,
		previewMs: 0,
		decisionMs: 0,
		approachMs: base.dragDurationMs,
	};
	return { ...base, window };
}

interface Ctrl {
	controller: HandController;
	states: HandState[];
	backend: CdpInputBackend;
}

function makeController(
	seed = 1,
	motor: MotorProfile = MOTOR_DEFAULTS,
	board?: BoardRectSource
): Ctrl {
	const backend = new CdpInputBackend(
		(method, params) => debuggerSend(tabId, method, params),
		ownership.position(tabId) ?? START_POINT,
		{ now: sim.now, scheduler: defaultScheduler }
	);
	const states: HandState[] = [];
	const controller = new HandController({
		backend,
		focus: { canExecute: () => verdict },
		ownership,
		geometry: provider,
		rng: createRng(seed),
		now: sim.now,
		scheduler: defaultScheduler,
		onState: (s) => states.push(s),
		...(board ? { board } : {}),
	});
	void motor;
	return { controller, states, backend };
}

interface Cmd {
	type: string;
	x: number;
	y: number;
	button: string;
	buttons: number;
	at: number;
}

const commands = (): Cmd[] =>
	sim.debugger.commands.map((c) => {
		expect(c.method).toBe(CDP.inputDispatchMouseEvent);
		const p = c.params as Record<string, unknown>;
		expect("timestamp" in p).toBe(false);
		return {
			type: p.type as string,
			x: p.x as number,
			y: p.y as number,
			button: p.button as string,
			buttons: p.buttons as number,
			at: c.at - START,
		};
	});

const maxStepPx = (m: MotorProfile) => (m.peakSpeedCapPxPerS * m.sampleIntervalMs) / 1000;

async function run(
	ctrl: Ctrl,
	plan: ExecutionPlan,
	timing: TimingPlan,
	ac = new AbortController()
) {
	const done = ctrl.controller.execute(plan, timing, ac.signal);
	await sim.time.advanceUntilIdle({ maxAdvanceMs: 60_000 });
	return done;
}

describe("HandController drag execution", () => {
	it("records exploration → approach → press inside from → drag moves → release inside to, on time", async () => {
		const ctrl = makeController(7);
		const plan = makePlan();
		const timing = makeTiming();
		const result = await run(ctrl, plan, timing);
		expect(result.ok).toBe(true);
		expect(result.outcome).toBe("executed");
		expect(result.tier).toBe("drag");
		expect(result.attempts).toBe(1);
		const cmds = commands();
		const presses = cmds.filter((c) => c.type === "mousePressed");
		const releases = cmds.filter((c) => c.type === "mouseReleased");
		expect(presses).toHaveLength(1);
		expect(releases).toHaveLength(1);
		const press = presses[0] as Cmd;
		const release = releases[0] as Cmd;
		expect(inside(press, plan.from.rect)).toBe(true);
		expect(inside(release, plan.to.rect)).toBe(true);
		expect(press).toMatchObject({ button: "left", buttons: 1 });
		expect(release).toMatchObject({ button: "left", buttons: 0 });
		// the press comes after the pre-touch window and the whole move lands on thinkMs
		expect(press.at).toBeGreaterThanOrEqual(timing.preMoveHoverMs);
		expect(Math.abs(release.at - timing.thinkMs)).toBeLessThanOrEqual(60);
		expect(Math.abs(result.elapsedMs - timing.thinkMs)).toBeLessThanOrEqual(60);
		// every move before the press is free, every move while held is a drag move
		const pressIdx = cmds.indexOf(press);
		const releaseIdx = cmds.indexOf(release);
		for (const c of cmds.slice(0, pressIdx)) expect(c).toMatchObject({ button: "none", buttons: 0 });
		const held = cmds.slice(pressIdx + 1, releaseIdx);
		expect(held.length).toBeGreaterThan(3);
		for (const c of held) expect(c).toMatchObject({ type: "mouseMoved", button: "left", buttons: 1 });
		// the hand explored before touching and the drag travelled ≥ 3 px
		expect(pressIdx).toBeGreaterThan(5);
		expect(Math.hypot(release.x - press.x, release.y - press.y)).toBeGreaterThan(3);
		// continuity: starts where the hand rested, never teleports, integer coordinates
		let prev: Pt = START_POINT;
		for (const c of cmds) {
			expect(Number.isInteger(c.x) && Number.isInteger(c.y)).toBe(true);
			expect(Math.hypot(c.x - prev.x, c.y - prev.y)).toBeLessThanOrEqual(maxStepPx(plan.motor) + 1);
			prev = c;
		}
		// dispatch cadence: no two commands share a timestamp gap of 0 while moving (except the press/release themselves)
		for (let i = 1; i < cmds.length; i++) {
			const a = cmds[i - 1] as Cmd;
			const b = cmds[i] as Cmd;
			if (a.type === "mouseMoved" && b.type === "mouseMoved") expect(b.at - a.at).toBeGreaterThan(0);
		}
		// post-drop rest: slow idle drift on the dropped piece, free moves only, inside the rest band
		const after = cmds.slice(releaseIdx + 1);
		expect(after.length).toBeGreaterThan(0);
		for (const c of after) expect(c).toMatchObject({ type: "mouseMoved", buttons: 0 });
		const last = cmds.at(-1) as Cmd;
		expect(last.at - release.at).toBeLessThanOrEqual(EXECUTOR.postDropRestMs[1]);
		expect(Math.hypot(last.x - release.x, last.y - release.y)).toBeLessThanOrEqual(
			PATH.idle.maxOffsetPx
		);
		expect(result.endPoint).toEqual({ x: last.x, y: last.y });
		expect(result.pressed).toBe(true);
		expect(ownership.position(tabId)).toEqual(result.endPoint);
		expect(ctrl.backend.position()).toEqual(result.endPoint);
		const phases = result.timeline.map((t) => t.phase);
		for (const p of ["orientation", "decision", "approach", "grab", "drag", "drop", "rest"])
			expect(phases).toContain(p);
		for (const t of result.timeline) expect(t.endMs).toBeGreaterThanOrEqual(t.startMs);
		expect(ctrl.states[0]).toBe("orientation");
		expect(ctrl.states).toContain("dragging");
		expect(ctrl.states.at(-1)).toBe("rest");
		expect(ctrl.controller.state()).toBe("rest");
		// fresh geometry right before the approach (§9.5): at least two reads, none for a promotion
		expect(geometryReads.length).toBeGreaterThanOrEqual(2);
		expect(geometryReads.every((p) => p === undefined)).toBe(true);
		// no tab-activation pre-flight of any kind
		expect(tabsUpdateCalls).toBe(0);
		expect(windowsUpdateCalls).toBe(0);
	});

	it("uses the timing plan's phase window when present and still lands on thinkMs", async () => {
		const ctrl = makeController(11);
		const plan = makePlan();
		const timing = makeTiming({
			thinkMs: 4000,
			preMoveHoverMs: 999_999, // ignored when `window` is present
			window: { orientationMs: 300, scanMs: 1500, previewMs: 0, decisionMs: 800, approachMs: 300 },
			deadlineMs: START + 4000,
		} as Partial<TimingPlan>);
		const result = await run(ctrl, plan, timing);
		expect(result.outcome).toBe("executed");
		const press = commands().find((c) => c.type === "mousePressed") as Cmd;
		expect(press.at).toBeGreaterThanOrEqual(300 + 1500 + 800);
		expect(Math.abs(result.elapsedMs - 4000)).toBeLessThanOrEqual(60);
	});

	it("previews (§9.3a) resolve completely: every extra press is released, none lands on a legal destination of the selected piece, and the committed press is the last one", async () => {
		let found = false;
		for (let seed = 1; seed < 60 && !found; seed++) {
			sim.debugger.clearCommands();
			ownership.armed(tabId, START_POINT);
			const ctrl = makeController(seed);
			const plan = makePlan({}, 2);
			const result = await run(
				ctrl,
				plan,
				makeTiming({ thinkMs: 9000, preMoveHoverMs: 8000, deadlineMs: START + 9000 })
			);
			expect(result.outcome).toBe("executed");
			const cmds = commands();
			const presses = cmds.filter((c) => c.type === "mousePressed");
			const releases = cmds.filter((c) => c.type === "mouseReleased");
			expect(presses.length).toBe(releases.length);
			if (presses.length === 1) continue;
			found = true;
			expect(result.timeline.map((t) => t.phase)).toContain("preview");
			const geo = geometry();
			const squareAt = (p: Pt): Square | null => {
				for (const f of "abcdefgh")
					for (let r = 1; r <= 8; r++) {
						const sq = `${f}${r}` as Square;
						if (inside(p, geo.squareRect(sq))) return sq;
					}
				return null;
			};
			let selected: Square | null = null;
			for (let i = 0; i < presses.length - 1; i++) {
				const p = presses[i] as Cmd;
				const sq = squareAt(p);
				expect(sq).not.toBeNull();
				const banned = selected ? (DESTS[selected] ?? []) : [];
				expect(banned).not.toContain(sq);
				// a preview press is either a piece with moves (select/switch) or a deselect square
				selected = (DESTS[sq as Square] ?? []).length > 0 ? (sq as Square) : null;
			}
			expect(squareAt(presses.at(-1) as Cmd)).toBe("e2");
			expect(inside(releases.at(-1) as Cmd, plan.to.rect)).toBe(true);
		}
		expect(found).toBe(true);
	});
});

describe("HandController preview selections and a reflow (§9.5 / §9.3a)", () => {
	/**
	 * The preview legs used to be the one unguarded press/release pair left in the hand. A reflow
	 * between a preview press and its release leaves the page with `down` on the square it really
	 * pressed and `up` on a stale one — a submitted move — and because `pressedCommitted` is false
	 * nothing re-checks the board afterwards, so `guardPosition` would report a *skip* while a move
	 * had in fact been played. (The planner's "no press on a legal destination of the selected
	 * piece" guarantee holds only in the geometry it planned in, so the press/deselect pair can
	 * become a legal move too.)
	 */
	const MOVED: Rect = {
		left: BOARD.left + 26,
		top: BOARD.top + 58,
		width: BOARD.width,
		height: BOARD.height,
	};

	it("a reflow during a preview releases on the pressed square, submits nothing and aborts", async () => {
		let found = false;
		for (let seed = 1; seed < 60 && !found; seed++) {
			sim.debugger.clearCommands();
			ownership.armed(tabId, START_POINT);
			// The board source reports the reflow as soon as the first press is out: at that moment
			// the hand is holding a button over a real square.
			let moved = false;
			const board = {
				rect: () => (moved ? MOVED : BOARD),
				changedAt: () => START,
			};
			sim.debugger.respond(CDP.inputDispatchMouseEvent, (params, id) => {
				if ((params as { type: string }).type === "mousePressed") moved = true;
				return sim.input.send(id, CDP.inputDispatchMouseEvent, params);
			});
			const ctrl = makeController(seed, MOTOR_DEFAULTS, board);
			const plan = makePlan({}, 2);
			const result = await run(
				ctrl,
				plan,
				makeTiming({ thinkMs: 9000, preMoveHoverMs: 8000, deadlineMs: START + 9000 })
			);
			const cmds = commands();
			const presses = cmds.filter((c) => c.type === "mousePressed");
			// Only the runs where a *preview* press went out first say anything about previews: a
			// run with no preview presses the committed square, which the committed-path tests own.
			if (presses.length === 0) continue;
			const first = presses[0] as Cmd;
			if (inside(first, plan.from.rect)) continue;
			found = true;

			const releases = cmds.filter((c) => c.type === "mouseReleased");
			expect(result.outcome).toBe("aborted");
			expect(result.reason).toBe(EXECUTOR.reasons.boardMoved);
			// A preview press is not the committed press, but it *was* a press: the flag the retry
			// policy reads to decide whether the board must be looked at before reporting.
			expect(result.pressedAny).toBe(true);
			// the button is never left held, and the committed press never happened
			expect(presses).toHaveLength(1);
			expect(releases).toHaveLength(1);
			expect(result.pressed).toBe(false);

			// The release is on the square the press landed on, in the geometry the page has *now* —
			// down and up on one square, which submits nothing on either renderer.
			const geo = geometry();
			const pressedSquare = (["a1"] as Square[])
				.concat(
					"abcdefgh".split("").flatMap((f) => [1, 2, 3, 4, 5, 6, 7, 8].map((r) => `${f}${r}` as Square))
				)
				.find((sq) => inside(first, geo.squareRect(sq)));
			expect(pressedSquare).toBeDefined();
			if (!pressedSquare) return;
			const movedRect = squareRect(pressedSquare, false, MOVED);
			expect(inside(releases[0] as Cmd, movedRect)).toBe(true);
			// §13.5: the escape is a path, not a jump
			let prev: Pt = START_POINT;
			for (const c of cmds) {
				expect(Math.hypot(c.x - prev.x, c.y - prev.y)).toBeLessThanOrEqual(
					maxStepPx(MOTOR_DEFAULTS) + 1
				);
				prev = c;
			}
		}
		expect(found).toBe(true);
	});
});

describe("HandController: the committed touch is always a drag", () => {
	// The plan's `dragDurationMs` is what makes one drag slower than another; a hand whose travel
	// is pinned to `EXECUTOR.minTravelMs` regardless of the plan would still pass every other
	// assertion in this file while moving every piece at exactly the same speed — the robotic
	// failure the timing-shape run cannot see, because its spread comes from the approach fit.
	it("the held leg follows the plan's dragDurationMs, not a fixed floor", async () => {
		const held: number[] = [];
		for (const dragDurationMs of [EXECUTOR.minTravelMs, EXECUTOR.minTravelMs * 8]) {
			sim.debugger.clearCommands();
			const ctrl = makeController(9);
			const timing = makeTiming({
				thinkMs: 8000,
				preMoveHoverMs: 4000,
				dragDurationMs,
				deadlineMs: START + 8000,
				window: {
					orientationMs: 4000,
					scanMs: 0,
					previewMs: 0,
					decisionMs: 0,
					approachMs: dragDurationMs,
				},
			});
			const result = await run(ctrl, makePlan(), timing);
			expect(result.outcome).toBe("executed");
			const cmds = commands();
			const press = cmds.find((c) => c.type === "mousePressed") as Cmd;
			const release = cmds.find((c) => c.type === "mouseReleased") as Cmd;
			held.push(release.at - press.at);
		}
		expect(held[0]).toBeGreaterThan(0);
		// eight times the floor has to show up as a materially longer hold
		expect(held[1] ?? 0).toBeGreaterThan((held[0] ?? 0) * 2);
	});

	// Click-to-move was removed end to end (the owner's live-game report): there is no plan field,
	// no persona weighting and no retry tier that can make the hand commit a move with two clicks.
	// What that means at the page is one press, one release, and the button *held* in between —
	// asserted over seeded moves so no branch of the sampler can sneak a second pair back in.
	it("one press, one release, the button held across the travel — on every seed", async () => {
		for (const seed of [1, 3, 5, 7, 11, 13, 17, 19]) {
			sim.debugger.clearCommands();
			const ctrl = makeController(seed);
			const plan = makePlan();
			const timing = makeTiming();
			const result = await run(ctrl, plan, timing);
			expect(result.outcome).toBe("executed");
			expect(result.tier).toBe("drag");
			const cmds = commands();
			const presses = cmds.filter((c) => c.type === "mousePressed");
			const releases = cmds.filter((c) => c.type === "mouseReleased");
			expect(presses).toHaveLength(1);
			expect(releases).toHaveLength(1);
			const press = presses[0] as Cmd;
			const release = releases[0] as Cmd;
			expect(inside(press, plan.from.rect)).toBe(true);
			expect(inside(release, plan.to.rect)).toBe(true);
			// the held leg: every move between the press and the release reports the button down
			const held = cmds.filter(
				(c) => c.type === "mouseMoved" && c.at >= press.at && c.at <= release.at
			);
			expect(held.length).toBeGreaterThan(0);
			for (const c of held) expect(c.buttons).toBe(1);
			// and nothing is dispatched with the button down once the piece is let go
			for (const c of cmds.filter((c) => c.type === "mouseMoved" && c.at > release.at))
				expect(c.buttons).toBe(0);
		}
	});
});

describe("HandController promotion", () => {
	it("waits the look-delay after the drop, then clicks inside the picker rect", async () => {
		promotionRect = { left: 420, top: 60, width: 80, height: 80 };
		const ctrl = makeController(5);
		const plan = makePlan({ promotion: "q" });
		const result = await run(ctrl, plan, makeTiming());
		expect(result.outcome).toBe("executed");
		const cmds = commands();
		const presses = cmds.filter((c) => c.type === "mousePressed");
		const releases = cmds.filter((c) => c.type === "mouseReleased");
		expect(presses).toHaveLength(2);
		expect(releases).toHaveLength(2);
		const drop = releases[0] as Cmd;
		const pick = presses[1] as Cmd;
		expect(inside(pick, promotionRect)).toBe(true);
		expect(inside(releases[1] as Cmd, promotionRect)).toBe(true);
		const firstMoveAfterDrop = cmds
			.slice(cmds.indexOf(drop) + 1)
			.find((c) => c.type === "mouseMoved") as Cmd;
		expect(firstMoveAfterDrop.at - drop.at).toBeGreaterThanOrEqual(PROMOTION_LOOK_DELAY_MS[0]);
		expect(geometryReads).toContain("q");
		expect(promotionTargets).toContain("e4");
		expect(result.timeline.map((t) => t.phase)).toContain("promote");
	});

	it("treats a picker that never appears (auto-queen) as a completed move", async () => {
		promotionRect = null;
		const ctrl = makeController(5);
		const result = await run(ctrl, makePlan({ promotion: "q" }), makeTiming());
		expect(result.outcome).toBe("executed");
		expect(commands().filter((c) => c.type === "mousePressed")).toHaveLength(1);
	});

	it("a failed picker read never fails the move: the drop stands, a timeline note is recorded, verification decides", async () => {
		promotionRect = { left: 420, top: 60, width: 80, height: 80 };
		promotionReadFails = true;
		const ctrl = makeController(5);
		const result = await run(ctrl, makePlan({ promotion: "q" }), makeTiming());
		expect(result.outcome).toBe("executed");
		expect(result.pressed).toBe(true);
		expect(result.error).toBeUndefined();
		expect(commands().filter((c) => c.type === "mousePressed")).toHaveLength(1);
		expect(geometryReads).toContain("q");
		const note = result.timeline.find(
			(t) => t.phase === EXECUTOR.timelineNotes.promotionGeometryUnavailable
		);
		expect(note).toBeDefined();
		expect(note?.startMs).toBe(note?.endMs);
		expect(ctrl.backend.pressed()).toBe(false);
	});

	it("uses the timing plan's promotionDelayMs as the look-delay when present", async () => {
		promotionRect = { left: 420, top: 60, width: 80, height: 80 };
		const ctrl = makeController(5);
		const result = await run(
			ctrl,
			makePlan({ promotion: "q" }),
			makeTiming({ promotionDelayMs: 700 })
		);
		expect(result.outcome).toBe("executed");
		const cmds = commands();
		const drop = cmds.filter((c) => c.type === "mouseReleased")[0] as Cmd;
		const next = cmds.slice(cmds.indexOf(drop) + 1)[0] as Cmd;
		expect(next.at - drop.at).toBeGreaterThanOrEqual(700);
		expect(next.at - drop.at).toBeLessThan(700 + PROMOTION_LOOK_DELAY_MS[0]);
	});
});

describe("HandController position guard", () => {
	it("skips with 'position-changed' and no press when the fresh read says the piece left the from-square", async () => {
		occupancyByRead = { 1: { e2: "own" }, 2: { e2: "empty", e4: "own" } };
		const ctrl = makeController(7);
		const result = await run(ctrl, makePlan(), makeTiming());
		expect(result).toMatchObject({
			ok: false,
			outcome: "skipped",
			reason: "position-changed",
			attempts: 0,
		});
		expect(commands().filter((c) => c.type !== "mouseMoved")).toHaveLength(0);
		expect(ctrl.controller.state()).toBe("rest");
		expect(ownership.position(tabId)).toEqual(ctrl.backend.position());
	});

	it("proceeds when occupancy confirms our piece on the from-square, and hands its signal to every read", async () => {
		occupancyByRead = { 1: { e2: "own" }, 2: { e2: "own" } };
		const ctrl = makeController(7);
		const result = await run(ctrl, makePlan(), makeTiming());
		expect(result.outcome).toBe("executed");
		expect(signalsSeen.length).toBeGreaterThanOrEqual(2);
		expect(signalsSeen.every((s) => s instanceof AbortSignal)).toBe(true);
	});
});

describe("HandController geometry reads", () => {
	it("reuses the caller's geometry reply for the exploration and reads fresh only before the approach", async () => {
		const ctrl = makeController(7);
		const plan = makePlan({
			geometry: { reply: { boardRect: BOARD, flipped: false }, readAt: sim.now() },
		});
		const result = await run(ctrl, plan, makeTiming());
		expect(result.outcome).toBe("executed");
		expect(geometryReads).toEqual([undefined]);
	});
});

describe("HandController focus gate (§13.4) and hand ownership (§13.5)", () => {
	it("skips with zero CDP commands when the page is not focused", async () => {
		verdict = { ok: false, reason: "unfocused" };
		const ctrl = makeController(2);
		const result = await run(ctrl, makePlan(), makeTiming());
		expect(result).toMatchObject({ ok: false, outcome: "skipped", reason: "unfocused", attempts: 0 });
		expect(sim.debugger.commands).toHaveLength(0);
		expect(ctrl.controller.state()).toBe("rest");
	});

	it("a blur edge inside the move window skips the move and stops every dispatch at the edge", async () => {
		const ctrl = makeController(2);
		const plan = makePlan();
		const done = ctrl.controller.execute(plan, makeTiming(), new AbortController().signal);
		await sim.time.advance(700);
		verdict = { ok: false, reason: "blur-in-window" };
		const edgeAt = sim.now() - START;
		await sim.time.advanceUntilIdle({ maxAdvanceMs: 60_000 });
		const result = await done;
		expect(result).toMatchObject({ ok: false, outcome: "skipped", reason: "blur-in-window" });
		const cmds = commands();
		expect(cmds.filter((c) => c.type === "mousePressed")).toHaveLength(0);
		for (const c of cmds) expect(c.at).toBeLessThanOrEqual(edgeAt);
		expect(ctrl.backend.pressed()).toBe(false);
		expect(ctrl.controller.state()).toBe("rest");
	});

	it("real pointer activity is counted and otherwise ignored: execution proceeds unchanged", async () => {
		const seedA = makeController(9);
		const plan = makePlan();
		const timing = makeTiming();
		const a = await run(seedA, plan, timing);
		const relative = (cmds: Cmd[]): Cmd[] =>
			cmds.map((c) => ({ ...c, at: c.at - (cmds[0]?.at ?? 0) }));
		const cmdsA = relative(commands());
		sim.debugger.clearCommands();
		ownership.armed(tabId, START_POINT);
		const seedB = makeController(9);
		const done = seedB.controller.execute(plan, timing, new AbortController().signal);
		await sim.time.advance(400);
		ownership.realPointerSeen(tabId, sim.now());
		await sim.time.advance(900);
		ownership.realPointerSeen(tabId, sim.now());
		await sim.time.advanceUntilIdle({ maxAdvanceMs: 60_000 });
		const b = await done;
		expect(b.outcome).toBe("executed");
		expect(ownership.realPointerCount(tabId)).toBe(2);
		expect(relative(commands())).toEqual(cmdsA);
		expect(b.endPoint).toEqual(a.endPoint);
	});
});

describe("HandController post-drop rest", () => {
	it("a gate veto during the rest ends the drift and leaves ownership exactly where the hand is", async () => {
		sim.debugger.respond(CDP.inputDispatchMouseEvent, (params, id) => {
			if ((params as { type: string }).type === "mouseReleased")
				verdict = { ok: false, reason: "blur-in-window" };
			return sim.input.send(id, CDP.inputDispatchMouseEvent, params);
		});
		const ctrl = makeController(7);
		const result = await run(ctrl, makePlan(), makeTiming());
		expect(result.outcome).toBe("executed");
		const cmds = commands();
		expect(cmds.at(-1)?.type).toBe("mouseReleased"); // no rest moves after the veto
		expect(ownership.position(tabId)).toEqual(ctrl.backend.position());
		expect(ownership.position(tabId)).toEqual(result.endPoint);
		expect(ctrl.controller.state()).toBe("rest");
	});
});

describe("HandController abort", () => {
	it("an abort mid-drag releases immediately at the current point and reports 'aborted'", async () => {
		const ac = new AbortController();
		let held = 0;
		sim.debugger.respond(CDP.inputDispatchMouseEvent, (params, id) => {
			const p = params as { type: string; buttons: number };
			if (p.type === "mouseMoved" && p.buttons === 1 && ++held === 3) ac.abort();
			return sim.input.send(id, CDP.inputDispatchMouseEvent, params);
		});
		const ctrl = makeController(4);
		const done = ctrl.controller.execute(makePlan(), makeTiming(), ac.signal);
		await sim.time.advanceUntilIdle({ maxAdvanceMs: 60_000 });
		const result = await done;
		expect(result).toMatchObject({ ok: false, outcome: "aborted", reason: "aborted", tier: "drag" });
		const cmds = commands();
		const last = cmds.at(-1) as Cmd;
		const prev = cmds.at(-2) as Cmd;
		expect(last.type).toBe("mouseReleased");
		expect(prev).toMatchObject({ type: "mouseMoved", buttons: 1 });
		expect({ x: last.x, y: last.y }).toEqual({ x: prev.x, y: prev.y });
		expect(last.at - prev.at).toBeLessThanOrEqual(CDP.stallResyncMs);
		expect(ctrl.backend.pressed()).toBe(false);
		expect(ctrl.controller.state()).toBe("rest");
		expect(sim.input.pointer(tabId)?.buttons).toBe(0);
		expect(result.pressed).toBe(true);
		expect(result.attempts).toBe(1);
	});

	it("an abort before the touch ends the exploration without any press", async () => {
		const ac = new AbortController();
		const ctrl = makeController(4);
		const done = ctrl.controller.execute(makePlan(), makeTiming(), ac.signal);
		await sim.time.advance(500);
		ac.abort();
		await sim.time.advanceUntilIdle({ maxAdvanceMs: 60_000 });
		const result = await done;
		expect(result.outcome).toBe("aborted");
		expect(commands().filter((c) => c.type !== "mouseMoved")).toHaveLength(0);
		expect(result.elapsedMs).toBeLessThanOrEqual(520);
		expect(result.pressed).toBe(false);
	});
});

describe("rescalePath speed floor", () => {
	const profile = (): MotorProfile => ({ ...MOTOR_DEFAULTS });

	/**
	 * The approach leg is re-timed to its window budget, so the only thing stopping a short
	 * budget from teleporting the cursor is the per-step floor at the profile's peak speed.
	 * Deleting that floor leaves the executor's own suites green (the budgets they use are
	 * never tight enough to bind), so it is asserted directly here.
	 */
	it("never re-times a step faster than the profile's peak speed, however small the budget", () => {
		const m = profile();
		// 10 points, 100 px apart: 1000 px of travel the profile cannot cross faster than
		// 1000 / peakSpeedCapPxPerS seconds, no matter what target duration is asked for.
		const path: PathPoint[] = [];
		for (let i = 1; i <= 10; i += 1) path.push({ x: i * 100, y: 0, dtMs: 20 });
		const from: Pt = { x: 0, y: 0 };

		const scaled = rescalePath(path, 1, m, from);

		let prev = from;
		for (const p of scaled) {
			const step = Math.hypot(p.x - prev.x, p.y - prev.y);
			prev = p;
			const fastestLegalMs = (step / m.peakSpeedCapPxPerS) * 1000;
			expect(p.dtMs).toBeGreaterThanOrEqual(fastestLegalMs);
			expect(step / (p.dtMs / 1000)).toBeLessThanOrEqual(m.peakSpeedCapPxPerS + 1e-6);
		}
		// The floor is what makes the result longer than the 1 ms that was asked for.
		const total = scaled.reduce((a, p) => a + p.dtMs, 0);
		expect(total).toBeGreaterThan((1000 / m.peakSpeedCapPxPerS) * 1000 - 1e-6);
	});

	it("still honours a generous budget without inflating it to the floor", () => {
		const m = profile();
		const path: PathPoint[] = [{ x: 10, y: 0, dtMs: 10 }];
		const scaled = rescalePath(path, 10 * EXECUTOR.travelScaleClamp[1], m, { x: 0, y: 0 });
		expect(scaled[0]?.dtMs).toBeCloseTo(10 * EXECUTOR.travelScaleClamp[1], 6);
	});
});
