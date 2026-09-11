import { afterEach, expect, it, spyOn } from "bun:test";
import { CDP } from "@core/constants/cdp";
import { DEFAULT_KEYBINDS } from "@core/constants/defaults";
import { MSG } from "@core/constants/messages";
import { ExplorationPlanner } from "@core/motor/exploration";
import { generatePath } from "@core/motor/path-generator";
import type { ExecutionReport } from "@service/move-executor";
import { createGameHarness, type GameHarness } from "./harness";

let h: GameHarness;
let restore: (() => void) | undefined;
afterEach(async () => {
	await h?.dispose();
	restore?.();
	restore = undefined;
});

async function boot(verifyMoves = true, holdAnalysis = false): Promise<void> {
	h = await createGameHarness({
		manualStart: holdAnalysis,
		sendKeybinds: true,
		settings: {
			automation: { autoMove: true },
			timing: { profile: "custom" },
			execution: { previewSelects: "off", verifyMoves },
		},
		head: {
			id: "v1-parametric",
			median: () => 12,
			sample: () => ({ tSec: 12, mode: "normal", why: [] }),
		},
	});
	if (holdAnalysis) {
		h.transport.hold = true;
		await h.drive(() => {
			h.site.hello();
			h.site.startGame();
		});
		expect(await h.until(() => h.executor()?.isArmed() === true, 2000)).toBe(true);
	}
	await h.arrive();
}

function input() {
	return h.sim.debugger.commands
		.filter((c) => c.method === CDP.inputDispatchMouseEvent)
		.map((c) => ({
			...(c.params as { type: string; buttons: number; x: number; y: number }),
			at: c.at,
		}));
}

it("Space interrupts an active generated hover, and repeated page/panel requests still submit one move", async () => {
	const planner = spyOn(ExplorationPlanner.prototype, "plan").mockImplementation(
		(_wait, _candidates, geometry, motor, rng, options) => {
			const rect = geometry.squareRect("g1");
			const target = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
			return [
				{ kind: "rest", dwellMs: 100 },
				{ kind: "hover", path: generatePath(options.cursor, target, rect, motor, rng), dwellMs: 7000 },
			];
		}
	);
	restore = () => planner.mockRestore();
	await boot();
	expect(await h.until(() => h.executor()?.handState() === "exploring", 10_000)).toBe(true);
	await h.advance(700);
	expect(input().filter((p) => p.type === "mouseMoved").length).toBeGreaterThan(5);
	expect(input().filter((p) => p.type === "mousePressed")).toHaveLength(0);
	expect(h.session().view().canPlayNow).toBe(true);
	const at = h.sim.now();
	const deadline = h.session().recommendation()!.plan.deadlineMs;
	await h.pressKey(DEFAULT_KEYBINDS.playMove);
	const request = h.drive(() =>
		h.router._dispatch({ type: MSG.PANEL_PLAY_NOW, tabId: h.tabId }, {})
	);
	expect(await h.until(() => h.site.board.chess.history().length === 1, 2000)).toBe(true);
	expect(h.sim.now() - at).toBeLessThan(2000);
	expect(h.sim.now()).toBeLessThan(deadline);
	expect(await request).toMatchObject({ success: true });
	await h.advance(15_000);
	expect(h.site.board.chess.history()).toHaveLength(1);
	expect(input().filter((p) => p.type === "mousePressed")).toHaveLength(1);
	expect(input().filter((p) => p.type === "mouseReleased")).toHaveLength(1);
});

it.each([true, false])(
	"a held preview stays interruptible (verifyMoves=%s), releases safely and makes the recommended move once",
	async (verifyMoves) => {
		const planner = spyOn(ExplorationPlanner.prototype, "plan").mockImplementation(
			(_wait, _candidates, geometry, motor, rng, options) => {
				const piece = options.committed.from === "g1" ? "b1" : "g1";
				const pieceRect = geometry.squareRect(piece);
				const point = {
					x: pieceRect.left + pieceRect.width / 2,
					y: pieceRect.top + pieceRect.height / 2,
				};
				return [
					{ kind: "rest", dwellMs: 100 },
					{
						kind: "preview",
						dwellMs: 0,
						preview: {
							piece,
							pieceRect,
							style: "click",
							resolve: "switch",
							hoverSquare: piece,
							hoverPoint: point,
							hoverPath: [],
							approach: generatePath(options.cursor, point, pieceRect, motor, rng),
							press: point,
							release: point,
							prePressMs: 0,
							holdMs: 7000,
							dwellMs: 0,
							isCommittedPiece: false,
							totalAfterApproachMs: 7000,
						},
					},
				];
			}
		);
		restore = () => planner.mockRestore();
		await boot(verifyMoves);
		expect(await h.until(() => input().some((p) => p.type === "mousePressed"), 10_000)).toBe(true);
		expect(h.executor()!.handState()).toBe("exploring");
		expect(h.session().view().canPlayNow).toBe(true);
		const expected = h.session().recommendation()!.chosen.uci;
		await h.pressKey(DEFAULT_KEYBINDS.playMove);
		expect(await h.until(() => h.site.board.chess.history().length === 1, 3000)).toBe(true);
		await h.advance(1500);
		expect(h.site.board.lastMove()?.uci).toBe(expected);
		expect(h.site.board.chess.history()).toHaveLength(1);
		const presses = input().filter((p) => p.type === "mousePressed");
		const releases = input().filter((p) => p.type === "mouseReleased");
		expect(presses).toHaveLength(2);
		expect(releases).toHaveLength(2);
		expect(releases[0]).toMatchObject({ x: presses[0]!.x, y: presses[0]!.y });
	}
);

it("a panel fast-forward during active analysis arms the result for immediate execution", async () => {
	await boot(true, true);
	expect(await h.until(() => h.session().currentState() === "live:my-turn:analysing", 1000, 1)).toBe(
		true
	);
	expect(h.session().recommendation()).toBeNull();
	expect(h.session().view().canPlayNow).toBe(true);
	expect(await h.drive(() => h.session().playNowRequested())).toBe(true);
	await h.drive(() => h.transport.release());
	expect(await h.until(() => h.site.board.chess.history().length === 1, 3000)).toBe(true);
	expect(input().filter((p) => p.type === "mousePressed")).toHaveLength(1);
});

it("approach remains interruptible and repeated fast-forward requests share one replacement", async () => {
	await boot();
	const executor = h.executor()!;
	const aborted: ExecutionReport[] = [];
	executor.on("aborted", (r) => aborted.push(r));
	let intercepted = false;
	let shared = false;
	let available = false;
	h.sim.debugger.respond(CDP.inputDispatchMouseEvent, (params, tabId) => {
		const p = params as { type: string; buttons: number };
		if (!intercepted && executor.handState() === "approaching" && p.type === "mouseMoved") {
			intercepted = true;
			available = h.session().view().canPlayNow === true;
			const first = executor.playNow();
			const second = executor.playNow();
			shared = first === second;
		}
		return h.sim.input.send(tabId, CDP.inputDispatchMouseEvent, params);
	});
	expect(await h.until(() => h.site.board.chess.history().length === 1, 20_000)).toBe(true);
	await h.advance(1500);
	expect(intercepted).toBe(true);
	expect(available).toBe(true);
	expect(shared).toBe(true);
	expect(aborted).toHaveLength(1);
	expect(aborted[0]!.result.pressed).toBe(false);
	expect(input().filter((p) => p.type === "mousePressed")).toHaveLength(1);
	expect(input().filter((p) => p.type === "mouseReleased")).toHaveLength(1);
	expect(h.site.board.chess.history()).toHaveLength(1);
});

it("mouse-down in flight and active dragging disable fast-forward without interrupting the piece", async () => {
	await boot();
	const executor = h.executor()!;
	let pressObserved = false;
	let dragObserved = false;
	const availability: boolean[] = [];
	const requests: Array<Promise<unknown>> = [];
	const aborted: ExecutionReport[] = [];
	executor.on("aborted", (r) => aborted.push(r));
	h.sim.debugger.respond(CDP.inputDispatchMouseEvent, (params, tabId) => {
		const p = params as { type: string; buttons: number };
		const firstPress = !pressObserved && p.type === "mousePressed";
		const firstDrag = !dragObserved && p.type === "mouseMoved" && p.buttons === 1;
		if (firstPress || firstDrag) {
			if (firstPress) pressObserved = true;
			if (firstDrag) dragObserved = true;
			availability.push(executor.canFastForward(), h.session().view().canPlayNow === true);
			requests.push(h.session().playNowRequested(), h.session().onKeybind("playMove"));
			void executor.playNow();
		}
		return h.sim.input.send(tabId, CDP.inputDispatchMouseEvent, params);
	});
	expect(await h.until(() => h.site.board.chess.history().length === 1, 20_000)).toBe(true);
	await h.advance(1500);
	expect(pressObserved).toBe(true);
	expect(dragObserved).toBe(true);
	expect(availability).toEqual([false, false, false, false]);
	expect(await Promise.all(requests)).toEqual([false, undefined, false, undefined]);
	// Position acknowledgement may end the completed run; Space itself never produces a second drag.
	expect(aborted.filter((r) => !r.result.pressed)).toHaveLength(0);
	expect(input().filter((p) => p.type === "mousePressed")).toHaveLength(1);
	expect(input().filter((p) => p.type === "mouseReleased")).toHaveLength(1);
	expect(h.site.board.chess.history()).toHaveLength(1);
});
