// test/panel/views/engine.test.ts — Appendix F §4.7: engine rows, nps sparkline, executor rows
// with the execution timeline, Detach/Reattach, the timing rationale log (plan/exec/verify/warn
// rows), Copy/Export/Clear, session reset, the raw license verdict and the live log pane.
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
	LIMITS,
	type LogStreamMessage,
	MSG,
	type PanelPortMessage,
	type PanelSnapshot,
	UI_TIMINGS,
} from "@core/constants";
import type { LogEntry } from "@core/logger";
import type { TypedMessage } from "@core/messaging/typed-messages";
import { COPY } from "@panel/copy";
import type { LoggingBridge, LogStreamListener } from "@panel/logging-bridge";
import { bootShell, type PanelShell } from "@panel/shell";
import type { PanelStore } from "@panel/store";
import type { Cleanup, ViewContext } from "@panel/view";
import { createEngineView, formatNps, rationaleRows } from "@panel/views/engine";
import type { ExecutionResult } from "@typedefs/game";
import type { LogLevel } from "@typedefs/settings";
import type { TimingLogEntry } from "@typedefs/timing";
import { bootPanelDom, click, type PanelDom } from "../dom";
import { makeSnapshot } from "../fixtures";

interface FakeStore extends PanelStore {
	emit(snapshot: PanelSnapshot): void;
	port(message: Exclude<PanelPortMessage, { kind: "snapshot" }>): void;
	dispatched: string[];
	/** Every command as sent (the debugger pair carries the game tab). */
	calls: TypedMessage[];
	responses: Partial<Record<string, unknown>>;
}

function fakeStore(): FakeStore {
	let snapshot: PanelSnapshot | null = null;
	const subs = new Set<(s: PanelSnapshot) => void>();
	const portSubs = new Set<(m: Exclude<PanelPortMessage, { kind: "snapshot" }>) => void>();
	const store: FakeStore = {
		dispatched: [],
		calls: [],
		responses: {},
		get snapshot() {
			return snapshot;
		},
		connected: true,
		subscribe(cb) {
			subs.add(cb);
			if (snapshot) cb(snapshot);
			return () => void subs.delete(cb);
		},
		onPortMessage(cb) {
			portSubs.add(cb);
			return () => void portSubs.delete(cb);
		},
		dispatch(command) {
			store.dispatched.push(command.type);
			store.calls.push(command);
			return Promise.resolve(store.responses[command.type] as never);
		},
		refresh() {},
		dispose() {},
		emit(next) {
			snapshot = next;
			for (const cb of subs) cb(next);
		},
		port(message) {
			for (const cb of portSubs) cb(message);
		},
	};
	return store;
}

interface FakeLogging extends LoggingBridge {
	levels: LogLevel[];
	disposed: boolean;
	push(message: LogStreamMessage): void;
}

function fakeLogging(level: LogLevel): FakeLogging {
	const entries: LogEntry[] = [];
	const subs = new Set<LogStreamListener>();
	let current = level;
	const bridge: FakeLogging = {
		levels: [],
		disposed: false,
		get level() {
			return current;
		},
		get entries() {
			return entries;
		},
		subscribe(cb) {
			subs.add(cb);
			return () => void subs.delete(cb);
		},
		setLevel(next) {
			current = next;
			bridge.levels.push(next);
		},
		clear() {
			entries.length = 0;
		},
		dispose() {
			bridge.disposed = true;
		},
		push(message) {
			if (message.kind === "backlog") entries.splice(0, entries.length, ...message.entries);
			else entries.push(message.entry);
			for (const cb of subs) cb(message);
		},
	};
	return bridge;
}

let dom: PanelDom;
let store: FakeStore;
let logging: FakeLogging | null;
let copied: string[];
let cleanup: Cleanup | null = null;
let shell: PanelShell | null = null;
/** The active game tab the view resolves for the debugger commands. */
let tabId: number;

beforeEach(async () => {
	dom = await bootPanelDom();
	tabId = dom.sim.openTab("https://lichess.org/abcdefgh", { active: true }).tabId;
	store = fakeStore();
	logging = null;
	copied = [];
});
afterEach(async () => {
	cleanup?.();
	cleanup = null;
	shell?.dispose();
	shell = null;
	await dom.teardown();
});

const view = () =>
	createEngineView({
		logging: (level) => {
			logging = fakeLogging(level);
			return logging;
		},
		clipboard: async (text) => {
			copied.push(text);
		},
	});

async function mountView(snapshot: PanelSnapshot): Promise<HTMLElement> {
	const container = document.createElement("div");
	document.body.append(container);
	store.emit(snapshot);
	const ctx: ViewContext = {
		router: { switch: async () => {}, resolve: async () => {}, current: "engine" },
		container,
		store,
		snapshot,
		ui: { tab: "engine", updateAvailable: false, updateDismissed: false },
		signal: new AbortController().signal,
	};
	cleanup = await view().mount(ctx);
	await dom.tick(0);
	return container;
}

const text = (root: ParentNode, selector: string): string =>
	root.querySelector(selector)?.textContent?.trim() ?? "";
const value = (root: ParentNode, row: string): string =>
	text(root, `[data-row="${row}"] .sl-engine__value`);

function engineSnapshot(nps = 1_420_000, depth = 18): PanelSnapshot {
	const s = makeSnapshot();
	s.engine = {
		state: "searching",
		variant: "full",
		threads: 4,
		nnue: ["nn-c288c895ea92.nnue", "nn-37f18f62d772.nnue"],
		version: "17",
		nps,
	};
	s.settings = { ...s.settings, engine: { ...s.settings.engine, hashMb: 256 } };
	s.recommendation = {
		chosen: {
			uci: "g1f3",
			san: "Nf3",
			from: "g1",
			to: "f3",
			source: "engine-elo",
			rankInLines: 1,
			cpLoss: 0,
			rationale: [],
		},
		lines: [],
		eval: { cp: 20 },
		depth,
		nps,
		plan: {
			thinkMs: 4200,
			mode: "normal",
			preMoveHoverMs: 0,
			dragDurationMs: 118,
			deadlineMs: 0,
			rationale: [],
			features: {},
			orientationMs: 250,
			window: { orientationMs: 250, scanMs: 0, previewMs: 0, decisionMs: 0, approachMs: 0 },
		},
		computedAt: 1,
		fen: "",
	};
	return s;
}

function timingEntry(overrides: Partial<TimingLogEntry> = {}): TimingLogEntry {
	return {
		gameId: "g1",
		ply: 12,
		mode: "normal",
		plannedMs: 4200,
		actualMs: null,
		alloc: 2.8,
		clockMs: 181_000,
		comp: 0.3,
		eps: 0.1,
		topTerms: [
			["variance", 1.1],
			["complexity", 0.3],
		],
		persona: "balanced",
		...overrides,
	};
}

describe("engine view — engine rows", () => {
	it("renders version/NNUE, threads/hash, the nps numeral and depth from the snapshot", async () => {
		const root = await mountView(engineSnapshot());
		expect(root.querySelector('[data-view="engine"]')).not.toBeNull();
		expect(text(root, ".sl-engine__version")).toBe(
			COPY.engine.rows.version("17", "nn-c288c895ea92 + nn-37f18f62d772")
		);
		expect(text(root, ".sl-engine__resources")).toBe(COPY.engine.rows.resources(4, 256));
		expect(text(root, ".sl-engine__nps")).toBe("1.42 Mn/s");
		expect(root.querySelector(".sl-engine__nps")?.classList.contains("sl-type-numeral-sm")).toBe(
			true
		);
		expect(text(root, ".sl-engine__depth")).toBe(COPY.engineView.depth(18));
		expect(text(root, ".sl-engine__status .sl-pill__text")).toBe(COPY.engine.thinking(18));
		// Follows later snapshots.
		const s = engineSnapshot(950_000, 22);
		s.engine.state = "ready";
		s.engine.nnue = [];
		store.emit(s);
		await dom.tick(0);
		expect(text(root, ".sl-engine__nps")).toBe("950 kn/s");
		expect(text(root, ".sl-engine__depth")).toBe(COPY.engineView.depth(22));
		expect(text(root, ".sl-engine__version")).toBe(
			COPY.engine.rows.version("17", COPY.engine.rows.nnueLoaded)
		);
		expect(text(root, ".sl-engine__status .sl-pill__text")).toBe(COPY.engine.idle);
	});

	it("formatNps renders Mn/s, kn/s and n/s", () => {
		expect(formatNps(1_420_000)).toBe("1.42 Mn/s");
		expect(formatNps(12_500)).toBe("13 kn/s");
		expect(formatNps(420)).toBe("420 n/s");
		expect(formatNps(undefined)).toBe(COPY.engineView.none);
	});

	it("builds the nps sparkline from successive snapshots, one sample per second, capped at 60", async () => {
		const root = await mountView(engineSnapshot(100_000));
		const line = (): SVGPolylineElement | null => root.querySelector(".sl-engine__spark-line");
		const points = (): string[] => (line()?.getAttribute("points") ?? "").split(" ").filter(Boolean);
		expect(root.querySelector("svg.sl-engine__spark-svg")).not.toBeNull();
		expect(points()).toHaveLength(1);
		// Snapshots inside the sample window do not add points (≤10 Hz snapshots, 1 Hz samples).
		store.emit(engineSnapshot(200_000));
		await dom.tick(0);
		expect(points()).toHaveLength(1);
		for (let i = 0; i < 70; i += 1) {
			await dom.tick(UI_TIMINGS.sparklineSampleMs);
			store.emit(engineSnapshot(100_000 + i * 10_000));
		}
		await dom.tick(0);
		expect(points()).toHaveLength(LIMITS.npsSparklineSamples);
		const before = points().join(" ");
		await dom.tick(UI_TIMINGS.sparklineSampleMs);
		store.emit(engineSnapshot(5_000_000));
		await dom.tick(0);
		expect(points()).toHaveLength(LIMITS.npsSparklineSamples);
		expect(points().join(" ")).not.toBe(before);
		// Colours come from the theme tokens in engine.css, not attributes.
		expect(line()?.getAttribute("stroke")).toBeNull();
		expect(line()?.getAttribute("class")).toBe("sl-engine__spark-line");
	});
});

describe("engine view — executor", () => {
	it("renders debugger/target/input mode/last action with the timeline phases", async () => {
		const s = engineSnapshot();
		s.executor = { debuggerAttached: true };
		s.session = {
			...s.session,
			site: "chesscom",
			gameId: "abc123",
			lastExecution: {
				ok: true,
				outcome: "executed",
				tier: "drag",
				attempts: 1,
				endPoint: { x: 0, y: 0 },
				elapsedMs: 3900,
				timeline: [
					{ phase: "exploration", startMs: 0, endMs: 420 },
					{ phase: "approach", startMs: 420, endMs: 720 },
					{ phase: "drag", startMs: 720, endMs: 838 },
					{ phase: "drop", startMs: 838, endMs: 878 },
				],
			} satisfies ExecutionResult,
		};
		const root = await mountView(s);
		expect(value(root, "debugger")).toBe(COPY.executor.attached);
		expect(value(root, "target")).toBe(COPY.engineView.target("chess.com", "abc123"));
		expect(value(root, "input")).toBe(
			COPY.engineView.inputMode(COPY.execution.drag, COPY.engineView.profiles.natural)
		);
		expect(value(root, "last")).toBe(COPY.engineView.lastAction("drag", "3.9", "executed"));
		const phases = [...root.querySelectorAll(".sl-engine__phase")].map((p) => p.textContent?.trim());
		expect(phases).toEqual([
			COPY.engineView.phase("exploration", 420),
			COPY.engineView.phase("approach", 300),
			COPY.engineView.phase("drag", 118),
			COPY.engineView.phase("drop", 40),
		]);
		// Detached, no execution yet.
		const d = engineSnapshot();
		d.executor = { debuggerAttached: false };
		store.emit(d);
		await dom.tick(0);
		expect(value(root, "debugger")).toBe(COPY.executor.detached);
		expect(value(root, "last")).toBe(COPY.executor.notStarted);
		expect(root.querySelectorAll(".sl-engine__phase")).toHaveLength(0);
	});

	it("Detach / Reattach dispatch; Reattach is primary only while detached; both disabled hands-off", async () => {
		const s = engineSnapshot();
		s.executor = { debuggerAttached: true };
		const root = await mountView(s);
		const detach = root.querySelector<HTMLElement>('[data-cmd="detach"]');
		const reattach = root.querySelector<HTMLElement>('[data-cmd="reattach"]');
		expect(detach?.classList.contains("sl-button--ghost")).toBe(true);
		expect(reattach?.classList.contains("sl-button--primary")).toBe(false);
		expect(reattach?.getAttribute("aria-disabled")).toBe("true"); // already attached
		click(detach as HTMLElement);
		expect(store.dispatched).toEqual([MSG.PANEL_EXPORT_TIMING_LOG, MSG.PANEL_DETACH_DEBUGGER]);
		expect(store.calls.at(-1)).toEqual({ type: MSG.PANEL_DETACH_DEBUGGER, tabId });

		const d = engineSnapshot();
		d.executor = { debuggerAttached: false };
		store.emit(d);
		await dom.tick(0);
		expect(reattach?.classList.contains("sl-button--primary")).toBe(true);
		expect(reattach?.getAttribute("aria-disabled")).toBeNull();
		expect(detach?.getAttribute("aria-disabled")).toBe("true");
		click(reattach as HTMLElement);
		expect(store.dispatched.at(-1)).toBe(MSG.PANEL_REATTACH_DEBUGGER);
		expect(store.calls.at(-1)).toEqual({ type: MSG.PANEL_REATTACH_DEBUGGER, tabId });

		// Hands-off (§13.4): a live game disables every command, whatever the debugger state.
		const live = makeSnapshot({ state: "live:opponent-turn" });
		live.executor = { debuggerAttached: false };
		store.emit(live);
		await dom.tick(0);
		const cmds = ["detach", "reattach", "copy", "export", "clear", "reset"];
		for (const cmd of cmds) {
			expect({
				cmd,
				disabled: root.querySelector(`[data-cmd="${cmd}"]`)?.getAttribute("aria-disabled"),
			}).toEqual({ cmd, disabled: "true" });
		}
		const before = store.dispatched.length;
		for (const cmd of cmds) click(root.querySelector(`[data-cmd="${cmd}"]`) as HTMLElement);
		await dom.tick(0);
		expect(store.dispatched).toHaveLength(before); // no detach/reattach/clear/reset dispatched
		expect(copied).toEqual([]); // Copy inert
		expect(root.querySelector<HTMLElement>('[data-cmd="export"]')?.dataset.url).toBeUndefined();
		expect(root.querySelectorAll(".sl-engine__log-row").length).toBeGreaterThanOrEqual(0);

		// Back to a non-live state: the controls return.
		const d2 = engineSnapshot();
		d2.executor = { debuggerAttached: false };
		store.emit(d2);
		await dom.tick(0);
		expect(reattach?.getAttribute("aria-disabled")).toBeNull();
	});

	it("shows the raw license verdict", async () => {
		const s = engineSnapshot();
		s.license = { status: "valid", rawStatus: "expired", checkedAt: 1 };
		const root = await mountView(s);
		expect(value(root, "license")).toBe(COPY.engineView.licenseVerdict("expired", true));
		const t = engineSnapshot();
		t.license = { status: "valid", rawStatus: "valid", checkedAt: 1 };
		store.emit(t);
		await dom.tick(0);
		expect(value(root, "license")).toBe(COPY.engineView.licenseVerdict("valid", false));
	});
});

describe("engine view — timing rationale log", () => {
	it("rationaleRows maps an entry to plan / exec / verify / warn rows", () => {
		const planned = rationaleRows(timingEntry());
		expect(planned.map((r) => r.kind)).toEqual(["plan"]);
		expect(planned[0]?.lines.length).toBeGreaterThan(1);
		const verified = rationaleRows(timingEntry({ actualMs: 4400 }));
		expect(verified.map((r) => r.kind)).toEqual(["plan", "exec", "verify"]);
		const drifted = rationaleRows(timingEntry({ actualMs: 9000 }));
		expect(drifted.map((r) => r.kind)).toEqual(["plan", "exec", "warn"]);
	});

	it("renders stored entries then appends streamed ones, newest at the bottom, in mono-xs", async () => {
		store.responses[MSG.PANEL_EXPORT_TIMING_LOG] = [
			timingEntry(),
			timingEntry({ ply: 14, actualMs: 4400 }),
		];
		const root = await mountView(engineSnapshot());
		expect(store.dispatched[0]).toBe(MSG.PANEL_EXPORT_TIMING_LOG);
		const log = root.querySelector<HTMLElement>(".sl-engine__log");
		expect(log?.classList.contains("sl-type-mono-xs")).toBe(true);
		const kinds = (): string[] =>
			[...root.querySelectorAll<HTMLElement>(".sl-engine__log-row")].map((r) => r.dataset.kind ?? "");
		expect(kinds()).toEqual(["plan", "plan", "exec", "verify"]);
		const first = root.querySelector<HTMLElement>(".sl-engine__log-row");
		expect(text(first as HTMLElement, ".sl-engine__log-kind")).toBe(COPY.engine.logKinds.plan);
		expect(text(first as HTMLElement, ".sl-engine__log-time")).toBe("3:01");
		expect(root.querySelectorAll(".sl-engine__log-row .sl-engine__log-line").length).toBeGreaterThan(
			4
		);
		store.port({ kind: "timingLog", entry: timingEntry({ ply: 16, actualMs: 9000 }) });
		await dom.tick(0);
		expect(kinds()).toEqual(["plan", "plan", "exec", "verify", "plan", "exec", "warn"]);
		expect(root.querySelector(".sl-engine__log-row:last-child")?.getAttribute("data-kind")).toBe(
			"warn"
		);
	});

	it("Copy writes the JSON to the clipboard, Export opens a data: URL, Clear empties and dispatches", async () => {
		store.responses[MSG.PANEL_EXPORT_TIMING_LOG] = [timingEntry()];
		const root = await mountView(engineSnapshot());
		click(root.querySelector('[data-cmd="copy"]') as HTMLElement);
		await dom.tick(0);
		expect(copied).toHaveLength(1);
		expect(JSON.parse(copied[0] ?? "")).toEqual([timingEntry()]);
		expect(text(document.body, ".sl-toast__text")).toBe(COPY.engineView.copied);

		const exportBtn = root.querySelector<HTMLElement>('[data-cmd="export"]');
		expect(exportBtn?.dataset.action).toBe("open-url");
		click(exportBtn as HTMLElement);
		const url = exportBtn?.dataset.url ?? "";
		expect(url.startsWith("data:application/json")).toBe(true);
		expect(JSON.parse(decodeURIComponent(url.slice(url.indexOf(",") + 1)))).toEqual([timingEntry()]);
		await dom.tick(0);
		expect(exportBtn?.dataset.url).toBeUndefined(); // dropped once the click has bubbled

		click(root.querySelector('[data-cmd="clear"]') as HTMLElement);
		await dom.tick(0);
		expect(root.querySelectorAll(".sl-engine__log-row")).toHaveLength(0);
		expect(store.dispatched.at(-1)).toBe(MSG.PANEL_CLEAR_TIMING_LOG);
		expect(text(root, ".sl-engine__log-empty")).toBe(COPY.engineView.logEmpty);
	});

	it("Export goes through the shell's open-url action (a new tab)", async () => {
		store.responses[MSG.PANEL_EXPORT_TIMING_LOG] = [timingEntry()];
		const app = document.getElementById("app") as HTMLElement;
		shell = bootShell(app, { store, views: { engine: view() } });
		store.emit(engineSnapshot());
		await dom.tick(0);
		shell.setTab("engine");
		await dom.tick(0);
		expect(shell.router.current).toBe("engine");
		const tabsBefore = dom.sim.tabs.all().length;
		click(app.querySelector('[data-cmd="export"]') as HTMLElement);
		await dom.tick(0);
		const tabs = dom.sim.tabs.all();
		expect(tabs).toHaveLength(tabsBefore + 1);
		expect(tabs.at(-1)?.url.startsWith("data:application/json")).toBe(true);
		await dom.tick(0);
		expect(app.querySelector<HTMLElement>('[data-cmd="export"]')?.dataset.url).toBeUndefined();
	});

	it("Export is refused by the shell while hands-off: no tab is created during a live game", async () => {
		store.responses[MSG.PANEL_EXPORT_TIMING_LOG] = [timingEntry()];
		const app = document.getElementById("app") as HTMLElement;
		// During a live game the router mounts `live`, never `engine`; registering this view as the
		// live view exercises the shell's hands-off refusal (§13.4) on this view's Export button.
		shell = bootShell(app, { store, views: { engine: view(), live: view() } });
		store.emit(makeSnapshot({ state: "live:my-turn:recommended" }));
		await dom.tick(0);
		expect(shell.router.current).toBe("live");
		expect(shell.handsOff).toBe(true);
		expect(app.classList.contains("sl-hands-off")).toBe(true);
		const exportBtn = app.querySelector<HTMLElement>('[data-cmd="export"]');
		expect(exportBtn?.getAttribute("aria-disabled")).toBe("true");
		const tabsBefore = dom.sim.tabs.all().length;
		click(exportBtn as HTMLElement);
		await dom.tick(0);
		expect(dom.sim.tabs.all()).toHaveLength(tabsBefore);
		expect(exportBtn?.dataset.url).toBeUndefined();
		// Copy / Clear / Reset are inert too.
		for (const cmd of ["copy", "clear", "reset"])
			click(app.querySelector(`[data-cmd="${cmd}"]`) as HTMLElement);
		await dom.tick(0);
		expect(copied).toEqual([]);
		expect(store.dispatched.filter((t) => t !== MSG.PANEL_EXPORT_TIMING_LOG)).toEqual([]);
	});
});

describe("engine view — session", () => {
	it("renders the session line from stats and Reset session dispatches", async () => {
		const s = engineSnapshot();
		s.stats = { games: 6, moves: 210, avgThinkMs: 3100 };
		const root = await mountView(s);
		expect(text(root, ".sl-engine__session")).toBe(COPY.engineView.session(6, 210, "3.1"));
		click(root.querySelector('[data-cmd="reset"]') as HTMLElement);
		expect(store.dispatched.at(-1)).toBe(MSG.PANEL_RESET_SESSION);
	});
});

describe("engine view — live log pane", () => {
	it("starts at settings.advanced.logLevel, shows streamed entries and filters by level", async () => {
		const s = engineSnapshot();
		s.settings = { ...s.settings, advanced: { ...s.settings.advanced, logLevel: "debug" } };
		const root = await mountView(s);
		expect(logging?.level).toBe("debug");
		const select = root.querySelector<HTMLSelectElement>(".sl-engine__level");
		expect(select?.value).toBe("debug");
		expect(text(root, ".sl-engine__console-empty")).toBe(COPY.engineView.consoleEmpty);
		logging?.push({
			kind: "backlog",
			entries: [
				{ level: "info", args: ["hello", { a: 1 }], meta: { source: "service-worker", timestamp: 1 } },
				{ level: "debug", args: ["verbose"], meta: { source: "panel", timestamp: 2 } },
			],
		});
		logging?.push({
			kind: "entry",
			entry: { level: "warn", args: ["careful"], meta: { source: "service-worker", timestamp: 3 } },
		});
		await dom.tick(0);
		const rows = (): HTMLElement[] => [
			...root.querySelectorAll<HTMLElement>(".sl-engine__console-row"),
		];
		expect(rows().map((r) => r.dataset.level)).toEqual(["info", "debug", "warn"]);
		expect(rows()[0]?.querySelector(".sl-engine__console-text")?.textContent).toBe('hello {"a":1}');
		expect(rows()[1]?.querySelector(".sl-engine__console-source")?.textContent).toBe("panel");
		expect(root.querySelector(".sl-engine__console")?.classList.contains("sl-type-mono-xs")).toBe(
			true
		);

		// Level change → sent to the bridge (source filter) and applied to the pane.
		if (select) {
			select.value = "warn";
			select.dispatchEvent(new Event("change", { bubbles: true }));
		}
		await dom.tick(0);
		expect(logging?.levels).toEqual(["warn"]);
		expect(rows().map((r) => r.dataset.level)).toEqual(["warn"]);
		logging?.push({
			kind: "entry",
			entry: { level: "info", args: ["ignored"], meta: { source: "service-worker", timestamp: 4 } },
		});
		logging?.push({
			kind: "entry",
			entry: { level: "error", args: ["boom"], meta: { source: "service-worker", timestamp: 5 } },
		});
		await dom.tick(0);
		expect(rows().map((r) => r.dataset.level)).toEqual(["warn", "error"]);
	});

	it("cleanup disposes the logging bridge and stops following the store", async () => {
		const root = await mountView(engineSnapshot());
		cleanup?.();
		cleanup = null;
		expect(logging?.disposed).toBe(true);
		expect(root.childElementCount).toBe(0);
		store.emit(engineSnapshot(999_000));
		await dom.tick(0);
		expect(text(root, ".sl-engine__nps")).toBe("");
	});
});
