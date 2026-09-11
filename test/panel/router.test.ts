// test/panel/router.test.ts — view resolution table (Part I §10.4, Appendix F §3.1) and the
// one-view-at-a-time mount/cleanup contract (Appendix H.6).
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { isHandsOff, isLiveGame, resolveView } from "@panel/router";
import { type PanelUiState, VIEW_NAMES, type View, type ViewName } from "@panel/view";
import { createSimulator, type Simulator } from "@test/sim";
import { bootPanelContext, type PanelContext } from "@test/sim/contexts/panel-context";
import { makeSnapshot } from "./fixtures";

const ui = (patch: Partial<PanelUiState> = {}): PanelUiState => ({
	tab: "game",
	updateAvailable: false,
	updateDismissed: false,
	...patch,
});

describe("resolveView", () => {
	it("covers all eight views", () => {
		expect(VIEW_NAMES).toEqual([
			"login",
			"expired",
			"unsupported",
			"waiting",
			"live",
			"settings",
			"engine",
			"update",
		]);
	});

	const table: Array<[string, Parameters<typeof makeSnapshot>[0], PanelUiState, ViewName]> = [
		["unknown license → login", { license: "unknown" }, ui(), "login"],
		["network error → login", { license: "network_error" }, ui(), "login"],
		[
			"login even when settings tab selected",
			{ license: "unknown" },
			ui({ tab: "settings" }),
			"login",
		],
		["invalid → expired", { license: "invalid" }, ui(), "expired"],
		["expired → expired", { license: "expired" }, ui(), "expired"],
		["ip_limit → expired", { license: "ip_limit" }, ui(), "expired"],
		[
			"expired keeps Settings › Account reachable",
			{ license: "expired" },
			ui({ tab: "settings" }),
			"settings",
		],
		["expired hides engine", { license: "expired" }, ui({ tab: "engine" }), "expired"],
		["update flag, no live game → update", {}, ui({ updateAvailable: true }), "update"],
		[
			"update flag but live game → live",
			{ state: "live:opponent-turn" },
			ui({ updateAvailable: true }),
			"live",
		],
		[
			"update dismissed → normal routing",
			{},
			ui({ updateAvailable: true, updateDismissed: true }),
			"waiting",
		],
		[
			"update flag on unsupported site → update",
			{ site: null },
			ui({ updateAvailable: true }),
			"update",
		],
		["no site → unsupported", { site: null }, ui(), "unsupported"],
		["site, no game → waiting", {}, ui(), "waiting"],
		["game over → waiting", { state: "game-over" }, ui(), "waiting"],
		["idle → waiting", { state: "idle" }, ui(), "waiting"],
		["live opponent turn → live", { state: "live:opponent-turn" }, ui(), "live"],
		["live analysing → live", { state: "live:my-turn:analysing" }, ui(), "live"],
		["live recommended → live", { state: "live:my-turn:recommended" }, ui(), "live"],
		["live executing → live", { state: "live:my-turn:executing" }, ui(), "live"],
		["settings tab → settings", {}, ui({ tab: "settings" }), "settings"],
		["engine tab → engine", {}, ui({ tab: "engine" }), "engine"],
		[
			"settings tab on unsupported site → settings",
			{ site: null },
			ui({ tab: "settings" }),
			"settings",
		],
		[
			"settings tab with update flag → update wins",
			{},
			ui({ tab: "settings", updateAvailable: true }),
			"update",
		],
		[
			"live game keeps the settings tab available",
			{ state: "live:opponent-turn" },
			ui({ tab: "settings" }),
			"settings",
		],
		[
			"live game keeps the engine tab available",
			{ state: "live:my-turn:recommended" },
			ui({ tab: "engine" }),
			"engine",
		],
	];

	for (const [name, overrides, state, expected] of table) {
		it(name, () => {
			expect(resolveView(makeSnapshot(overrides), state)).toBe(expected);
		});
	}
});

describe("isHandsOff / isLiveGame", () => {
	it("recognises live games without disabling panel interaction", () => {
		for (const state of [
			"live:opponent-turn",
			"live:my-turn:analysing",
			"live:my-turn:recommended",
			"live:my-turn:executing",
		] as const) {
			expect(isLiveGame(makeSnapshot({ state }))).toBe(true);
			expect(isHandsOff(makeSnapshot({ state }))).toBe(false);
		}
		for (const state of ["idle", "waiting-for-game", "game-over"] as const) {
			expect(isLiveGame(makeSnapshot({ state }))).toBe(false);
			expect(isHandsOff(makeSnapshot({ state }))).toBe(false);
		}
	});
});

describe("PanelRouter", () => {
	let sim: Simulator;
	let panel: PanelContext;

	beforeEach(async () => {
		sim = createSimulator();
		panel = await bootPanelContext(sim);
	});
	afterEach(async () => {
		await panel.teardown();
		await sim.dispose();
	});

	it("mounts one view at a time, runs the previous cleanup, aborts its signal, and reports current", async () => {
		const { PanelRouter } = await import("@panel/router");
		const events: string[] = [];
		const stub = (name: ViewName): View => ({
			mount(ctx) {
				events.push(`mount:${name}`);
				const el = document.createElement("section");
				el.dataset.view = name;
				ctx.container.append(el);
				ctx.signal.addEventListener("abort", () => events.push(`abort:${name}`));
				return () => events.push(`cleanup:${name}`);
			},
		});
		const views = Object.fromEntries(VIEW_NAMES.map((n) => [n, stub(n)])) as Record<ViewName, View>;
		const container = document.createElement("div");
		document.body.append(container);
		const router = new PanelRouter(container, views);
		expect(router.current).toBeNull();
		await router.switch("waiting");
		expect(router.current).toBe("waiting");
		expect(container.querySelectorAll("section")).toHaveLength(1);
		await router.switch("waiting"); // no-op
		await router.switch("live");
		expect(events).toEqual(["mount:waiting", "cleanup:waiting", "abort:waiting", "mount:live"]);
		expect(container.querySelector("section")?.dataset.view).toBe("live");
		router.dispose();
		expect(router.current).toBeNull();
		expect(events.at(-1)).toBe("abort:live");
		expect(container.children).toHaveLength(0);
	});

	it("applies a snapshot + ui state through resolve() and only remounts on change", async () => {
		const { PanelRouter } = await import("@panel/router");
		let mounts = 0;
		const view: View = {
			mount: () => {
				mounts += 1;
				return () => {};
			},
		};
		const views = Object.fromEntries(VIEW_NAMES.map((n) => [n, view])) as Record<ViewName, View>;
		const router = new PanelRouter(document.createElement("div"), views);
		await router.resolve(makeSnapshot(), ui());
		expect(router.current).toBe("waiting");
		await router.resolve(makeSnapshot(), ui());
		expect(mounts).toBe(1);
		await router.resolve(makeSnapshot({ state: "live:opponent-turn" }), ui({ tab: "engine" }));
		expect(router.current).toBe("engine");
		expect(mounts).toBe(2);
		router.dispose();
	});
});
