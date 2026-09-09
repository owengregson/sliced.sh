// test/behavioral/telemetry/focus-discipline.test.ts — Task 33 Step 1, the automated substitute for
// the manual focus check (docs/qa/focus-discipline.md). happy-dom has no window-focus model, so
// only the rows the simulator can honestly answer are recorded here: a `chrome.commands` shortcut,
// an in-page keybind, a CDP click on a focused page, a tab switch, the browser losing focus, and
// the debugger attaching at arm time and detaching on disarm. Panel click / typing, and Chrome's
// own behaviour behind rows 5 and 6, are recorded on real Chrome (Task 31 QA).
import { afterEach, describe, expect, it } from "bun:test";
import { onCommand } from "@core/chrome/commands";
import { EXECUTOR } from "@core/constants/cdp";
import { WINDOW_ID_NONE } from "@test/sim/chrome/windows";
import { SIM_TELEMETRY } from "@test/sim/telemetry/constants";
import {
	runSimulatedGame,
	type SimulatedGame,
	type SimulatedMove,
} from "@test/sim/telemetry/harness";
import type { ExecutionResult } from "@typedefs/game";

const SHORTCUT = SIM_TELEMETRY.shortcut;

/** The exploration phases of a move's timeline (`scan` hovers and `preview` selections). */
const exploration = (m: SimulatedMove): string[] =>
	m.result.timeline.filter((t) => t.phase === "scan" || t.phase === "preview").map((t) => t.phase);

/** When the touch began, relative to the start of the move window. */
const approachStart = (m: SimulatedMove): number =>
	m.result.timeline.find((t) => t.phase === "approach")?.startMs ?? Number.POSITIVE_INFINITY;

let game: SimulatedGame | null = null;
afterEach(async () => {
	await game?.dispose();
	game = null;
});

describe("focus discipline: rows the simulator can record (Step 1)", () => {
	it("row: a chrome.commands shortcut while the page is focused plays a long normal move now, with no blur/focus on the page", async () => {
		let playedNowAt = -1;
		let played: ExecutionResult | null | undefined;
		// The shortcut has to land on a move that would otherwise take a *long* think, or "it
		// collapsed the window" is unfalsifiable: an instant/premove plan skips exploration and
		// drops at the motor floor whether the shortcut fires or not. So search for the first
		// `normal` move whose plan is at least `shortcut.minThinkMs` and fire there.
		let shortcutAt = -1;
		game = await runSimulatedGame({
			seed: "commands-row",
			moves: SHORTCUT.searchMoves,
			// `onCommand` reaches `chrome.commands` through the typed wrapper, so it only resolves
			// inside the service worker's context — subscribe and unsubscribe there (the harness
			// runs `duringMove` under `sw.context.run`, which installs the simulator's `chrome`).
			duringMove: async ({ index, retryOf, plan, sim, sw, site }) => {
				if (retryOf !== undefined || shortcutAt >= 0) return;
				if (plan.mode !== "normal" || plan.thinkMs < SHORTCUT.minThinkMs) return;
				shortcutAt = index;
				// the lifecycle's `commands.onCommand` → session → executor path, reduced to the executor
				const off = onCommand((command) => {
					if (command !== "play-best-move") return;
					playedNowAt = sim.now();
					void sw.executor.playNow().then((r) => {
						played = r;
					});
				});
				try {
					sim.commands.trigger("play-best-move", sim.tabs.toApi(site.tabId));
					await sim.time.runMicrotasks();
				} finally {
					off();
				}
			},
		});
		// a qualifying move existed and the shortcut reached the executor through `chrome.commands`
		expect(shortcutAt).toBeGreaterThanOrEqual(0);
		expect(playedNowAt).toBeGreaterThan(0);
		const move = game.moves[shortcutAt]!;
		// stated explicitly, so a future seed change fails here instead of quietly re-vacating the row
		expect(move.plan.mode).toBe("normal");
		expect(move.plan.thinkMs).toBeGreaterThanOrEqual(SHORTCUT.minThinkMs);
		expect(move.result).toMatchObject({ ok: true, outcome: "executed" });
		expect(played).toMatchObject({ ok: true, outcome: "executed" });
		// the shortcut collapsed the think window: no exploration, the touch starts at once, and the
		// drop lands in a fraction of the planned think
		const hold = move.observation?.ac.MoveHoldTime ?? Number.POSITIVE_INFINITY;
		expect(hold).toBeLessThan(move.plan.thinkMs * SHORTCUT.maxHoldFraction);
		expect(exploration(move)).toEqual([]);
		expect(approachStart(move)).toBeLessThanOrEqual(SIM_TELEMETRY.collapsedPreTouchMs);
		// … which the same seeded game without the shortcut does not do: same plan, but it explores
		// and holds the piece for the whole window
		const control = await runSimulatedGame({ seed: "commands-row", moves: SHORTCUT.searchMoves });
		try {
			const same = control.moves[shortcutAt]!;
			expect(same.plan.thinkMs).toBe(move.plan.thinkMs);
			expect(exploration(same).length).toBeGreaterThan(0);
			expect(approachStart(same)).toBeGreaterThan(SIM_TELEMETRY.collapsedPreTouchMs);
			expect(same.observation?.ac.MoveHoldTime ?? 0).toBeGreaterThan(hold);
		} finally {
			await control.dispose();
		}
		// and the shortcut itself never touched the page: no blur, no focus, no focus-moving API
		expect(game.site.pageFocusEvents()).toEqual({ blur: 0, focus: 0 });
		expect(game.focusApiCalls).toEqual({ tabsUpdate: 0, windowsUpdate: 0, bringToFront: 0 });
		expect(game.acs.every((ac) => ac.BlurCount === 0 && ac.EventTrusted)).toBe(true);
	});

	it("row: an in-page keybind captured by the content script fires without any blur or focus on the page", async () => {
		game = await runSimulatedGame({ seed: "keybind-row", moves: 2 });
		const site = game.site;
		expect(site.keybindActions()).toEqual([]);
		// the content script's capture-phase `keydown` listener owns the page-scoped shortcuts
		// (§13.4); a keypress never moves focus, so the window sees no blur/focus edge at all
		await game.sw.context.run(async () => {
			site.pressKey({ key: " ", code: "Space" });
			site.pressKey({ key: "x", code: "KeyX", shiftKey: true });
			await game!.sim.time.runMicrotasks();
		});
		expect(site.keybindActions()).toEqual(["playMove", "disable"]);
		expect(site.pageFocusEvents()).toEqual({ blur: 0, focus: 0 });
		expect(game.focusApiCalls).toEqual({ tabsUpdate: 0, windowsUpdate: 0, bringToFront: 0 });
		expect(game.acs.every((ac) => ac.BlurCount === 0 && ac.DidToggle === false)).toBe(true);
	});

	it("row: a CDP click on an already-focused page produces pointer events only — no focus or blur event", async () => {
		game = await runSimulatedGame({ seed: "cdp-click-row", moves: 2 });
		expect(game.moves.every((m) => m.result.ok)).toBe(true);
		const types = new Set(game.sim.input.events.map((e) => e.type));
		expect(types.has("pointerdown")).toBe(true);
		expect(types.has("pointerup")).toBe(true);
		expect(types.has("focus") || types.has("blur")).toBe(false);
		expect(game.site.pageFocusEvents()).toEqual({ blur: 0, focus: 0 });
		expect(game.acs.every((ac) => ac.BlurCount === 0)).toBe(true);
	});

	it("row: switching to another tab during the think window makes the executor wait (`hidden`), and the move plays after a fresh window on the game tab", async () => {
		let other = -1;
		game = await runSimulatedGame({
			seed: "tab-switch-row",
			moves: 2,
			duringMove: async ({ index, retryOf, sim, site }) => {
				if (index !== 1 || retryOf !== undefined) return;
				await sim.time.advance(300);
				other = sim.openTab("https://example.org/", { active: true }).tabId;
				await sim.time.runMicrotasks();
				// the user comes back to the game tab: the page regains focus and the window re-opens
				await sim.time.advance(SIM_TELEMETRY.refocusPauseMs);
				site.panelClick(); // (any page-blur while the other tab was active) …
				sim.tabs.activate(site.tabId);
			},
		});
		const skipped = game.moves.find((m) => m.index === 1 && !m.result.ok);
		expect(skipped?.result).toMatchObject({
			ok: false,
			outcome: "skipped",
			reason: EXECUTOR.reasons.hidden,
		});
		expect(skipped?.commands.filter((c) => c.type !== "mouseMoved")).toHaveLength(0);
		const replay = game.moves.find((m) => m.index === 1 && m.retryOf !== undefined);
		expect(replay?.result).toMatchObject({ ok: true, outcome: "executed" });
		expect(game.focusApiCalls.tabsUpdate).toBe(0);
		expect(other).toBeGreaterThan(0);
	});

	it("row: the browser window losing focus (windows.onFocusChanged NONE) makes the executor wait (`unfocused`)", async () => {
		game = await runSimulatedGame({
			seed: "window-blur-row",
			moves: 2,
			duringMove: async ({ index, retryOf, sim, site }) => {
				if (index !== 1 || retryOf !== undefined) return;
				await sim.time.advance(300);
				sim.windows.setFocus(WINDOW_ID_NONE);
				site.panelClick(); // the page blurs with the window
				await sim.time.runMicrotasks();
				await sim.time.advance(SIM_TELEMETRY.refocusPauseMs);
				sim.windows.setFocus(1);
			},
		});
		const skipped = game.moves.find((m) => m.index === 1 && !m.result.ok);
		expect(skipped?.result).toMatchObject({
			ok: false,
			outcome: "skipped",
			reason: EXECUTOR.reasons.unfocused,
		});
		expect(skipped?.commands.filter((c) => c.type !== "mouseMoved")).toHaveLength(0);
		const replay = game.moves.find((m) => m.index === 1 && m.retryOf !== undefined);
		expect(replay?.result).toMatchObject({ ok: true, outcome: "executed" });
		expect(game.focusApiCalls).toEqual({ tabsUpdate: 0, windowsUpdate: 0, bringToFront: 0 });
	});

	it("row: the debugger detaches when the hand is disarmed, with no blur or focus on the page", async () => {
		game = await runSimulatedGame({ seed: "detach-row", moves: 2 });
		expect(game.sim.debugger.attachments.filter((a) => a.action === "detach")).toEqual([]);
		const detachedAt = game.sim.now();
		await game.sw.context.run(async () => {
			game!.sw.executor.disarm();
			await game!.sw.debugger.detach(game!.tabId);
		});
		await game.sim.time.runMicrotasks();
		// the infobar goes away (a layout change, never a focus change) and the page is none the wiser
		const detaches = game.sim.debugger.attachments.filter((a) => a.action === "detach");
		expect(detaches).toHaveLength(1);
		expect(detaches[0]!.at).toBeGreaterThanOrEqual(detachedAt);
		expect(game.sw.debugger.isAttached(game.tabId)).toBe(false);
		expect(game.site.pageFocusEvents()).toEqual({ blur: 0, focus: 0 });
		expect(game.focusApiCalls).toEqual({ tabsUpdate: 0, windowsUpdate: 0, bringToFront: 0 });
		expect(game.acs.every((ac) => ac.BlurCount === 0 && ac.DidToggle === false)).toBe(true);
	});

	it("row: the debugger attaches once, at arm time, before the first move window — never inside one", async () => {
		game = await runSimulatedGame({ seed: "attach-row", moves: 3 });
		const attaches = game.sim.debugger.attachments.filter((a) => a.action === "attach");
		expect(attaches).toHaveLength(1);
		const firstWindow = game.observations[0]?.diag.positionAt ?? Number.NEGATIVE_INFINITY;
		expect(attaches[0]!.at).toBeLessThanOrEqual(firstWindow);
		for (const obs of game.observations) {
			const inWindow = game.sim.debugger.attachments.filter(
				(a) => a.at > (obs.diag.positionAt ?? 0) && a.at <= obs.diag.submittedAt
			);
			expect(inWindow).toEqual([]);
		}
		expect(game.site.pageFocusEvents()).toEqual({ blur: 0, focus: 0 });
	});
});
