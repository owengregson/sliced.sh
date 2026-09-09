// test/behavioral/telemetry/focus-discipline.test.ts — Task 33 Step 1, the automated substitute for
// the manual focus check (docs/qa/focus-discipline.md). happy-dom has no window-focus model, so
// only the rows the simulator can honestly answer are recorded here: a `chrome.commands` shortcut,
// a CDP click on a focused page, a tab switch, the browser losing focus, and the arm-time debugger
// attach. Panel click / typing and the attach infobar are recorded on real Chrome (Task 31 QA).
import { afterEach, describe, expect, it } from "bun:test";
import { onCommand } from "@core/chrome/commands";
import { EXECUTOR } from "@core/constants/cdp";
import { WINDOW_ID_NONE } from "@test/sim/chrome/windows";
import { SIM_TELEMETRY } from "@test/sim/telemetry/constants";
import { runSimulatedGame, type SimulatedGame } from "@test/sim/telemetry/harness";
import type { ExecutionResult } from "@typedefs/game";

let game: SimulatedGame | null = null;
afterEach(async () => {
	await game?.dispose();
	game = null;
});

describe("focus discipline: rows the simulator can record (Step 1)", () => {
	it("row: a chrome.commands shortcut while the page is focused plays the move now with no blur/focus on the page", async () => {
		let playedNowAt = -1;
		let played: ExecutionResult | null | undefined;
		game = await runSimulatedGame({
			seed: "commands-row",
			moves: 2,
			// `onCommand` reaches `chrome.commands` through the typed wrapper, so it only resolves
			// inside the service worker's context — subscribe and unsubscribe there (the harness
			// runs `duringMove` under `sw.context.run`, which installs the simulator's `chrome`).
			duringMove: async ({ index, retryOf, sim, sw, site }) => {
				if (index !== 1 || retryOf !== undefined) return;
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
		// the shortcut reached the executor through `chrome.commands` and owned the pending move
		expect(playedNowAt).toBeGreaterThan(0);
		const move = game.moves[1]!;
		expect(move.result).toMatchObject({ ok: true, outcome: "executed" });
		expect(played).toMatchObject({ ok: true, outcome: "executed" });
		// the shortcut collapsed the think window: the drop landed before the planned deadline …
		const hold = move.observation?.ac.MoveHoldTime ?? Number.POSITIVE_INFINITY;
		expect(hold).toBeLessThan(move.plan.thinkMs);
		expect(move.result.timeline.some((t) => t.phase === "scan" || t.phase === "preview")).toBe(false);
		// … which the same seeded game without the shortcut does not do: it uses the full window
		const control = await runSimulatedGame({ seed: "commands-row", moves: 2 });
		try {
			const same = control.moves[1]!;
			expect(same.plan.thinkMs).toBe(move.plan.thinkMs);
			expect(same.observation?.ac.MoveHoldTime ?? 0).toBeGreaterThan(hold);
		} finally {
			await control.dispose();
		}
		// and the shortcut itself never touched the page: no blur, no focus, no focus-moving API
		expect(game.site.pageFocusEvents()).toEqual({ blur: 0, focus: 0 });
		expect(game.focusApiCalls).toEqual({ tabsUpdate: 0, windowsUpdate: 0, bringToFront: 0 });
		expect(game.acs.every((ac) => ac.BlurCount === 0 && ac.EventTrusted)).toBe(true);
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
