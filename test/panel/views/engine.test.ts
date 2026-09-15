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
import { DEFAULT_SETTINGS } from "@core/constants/defaults";
import { MAIA_INPUT } from "@core/constants/maia";
import { TIMING_STATISTICS } from "@core/constants/telemetry";
import type { LogEntry } from "@core/logger";
import type { TypedMessage } from "@core/messaging/typed-messages";
import { COPY, SETTINGS_COPY } from "@panel/copy";
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
	tabId = dom.sim.openTab("https://www.chess.com/game/174252011111", { active: true }).tabId;
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

	it("names the selection model from the snapshot: Maia-3 79M at every target through 3000", async () => {
		// 2026-09-13: one shipped size, so the label reads 79M across the whole human range.
		const s = engineSnapshot();
		s.settings = { ...s.settings, strength: { ...s.settings.strength, targetElo: 1200 } };
		const root = await mountView(s);
		expect(text(root, ".sl-engine__selection")).toBe(COPY.engineView.selection.maia("79M"));
		const t = engineSnapshot();
		t.settings = { ...t.settings, strength: { ...t.settings.strength, targetElo: 1650 } };
		store.emit(t);
		await dom.tick(0);
		expect(text(root, ".sl-engine__selection")).toBe(COPY.engineView.selection.maia("79M"));
		const u = engineSnapshot();
		u.settings = { ...u.settings, strength: { ...u.settings.strength, targetElo: 3000 } };
		store.emit(u);
		await dom.tick(0);
		expect(text(root, ".sl-engine__selection")).toBe(COPY.engineView.selection.maia("79M"));
	});

	it("names the assisted range and the actual loaded engine network", async () => {
		const root = await mountView(engineSnapshot());
		for (const [targetElo, variant, label] of [
			[3000, "smallnet", COPY.engineView.selection.maia("79M")],
			[3001, "smallnet", COPY.engineView.selection.maiaPriorSmall],
			[3200, "smallnet", COPY.engineView.selection.maiaPriorSmall],
			[3100, "full", COPY.engineView.selection.maiaPriorFull],
			[3201, "full", COPY.engineView.selection.stockfishFull],
			[3201, "smallnet", COPY.engineView.selection.stockfishSmall],
		] as const) {
			const next = engineSnapshot();
			next.settings.strength.targetElo = targetElo;
			next.engine.variant = variant;
			store.emit(next);
			await dom.tick(0);
			expect(text(root, ".sl-engine__selection")).toBe(label);
		}
	});

	it("follows the derived target: a matched opponent decides the model, not the slider", async () => {
		const s = engineSnapshot();
		s.settings = { ...s.settings, strength: { ...s.settings.strength, targetElo: 3400 } };
		const root = await mountView(s);
		expect(text(root, ".sl-engine__selection")).toBe(COPY.engineView.selection.stockfishFull);
		// A matched opponent moves the target the session actually plays at.
		const t = engineSnapshot();
		t.settings = { ...t.settings, strength: { ...t.settings.strength, targetElo: 3400 } };
		t.opponent = { isBot: false, name: "opp", ratingEstimate: 1500, derivedTargetElo: 1500 };
		store.emit(t);
		await dom.tick(0);
		expect(text(root, ".sl-engine__selection")).toBe(COPY.engineView.selection.maia("79M"));
	});

	/** A snapshot whose recommendation carries a Maia-3 answer (a new `computedAt` = a new move). */
	function policySnapshot(
		ms: number,
		computedAt: number,
		overrides: { targetElo?: number; p?: number; source?: "maia" | "sampled" } = {}
	): PanelSnapshot {
		const s = engineSnapshot();
		s.settings = {
			...s.settings,
			strength: { ...s.settings.strength, targetElo: overrides.targetElo ?? 1650 },
		};
		if (s.recommendation) {
			s.recommendation.computedAt = computedAt;
			s.recommendation.fen = "fen";
			s.recommendation.chosen.source = overrides.source ?? "maia";
			const p = overrides.p ?? 0.42;
			s.recommendation.chosen.maiaProb = p;
			s.recommendation.maia = { size: "79m", wdl: [0.28, 0.4, 0.32], ms, p };
		}
		return s;
	}

	it("the human-model block: Off outside Maia's range, waiting without an answer, the answer's pick/WDL/latency", async () => {
		const off = engineSnapshot();
		off.settings = { ...off.settings, strength: { ...off.settings.strength, targetElo: 3201 } };
		const root = await mountView(off);
		expect(text(root, ".sl-engine__policy-name")).toBe(COPY.engineView.policy.inactive);
		expect(text(root, ".sl-engine__policy-status .sl-pill__text")).toBe(COPY.engineView.policy.off);
		expect(text(root, ".sl-engine__policy-latency")).toBe(COPY.engineView.none);
		const waiting = engineSnapshot();
		waiting.settings = {
			...waiting.settings,
			strength: { ...waiting.settings.strength, targetElo: 1650 },
		};
		store.emit(waiting);
		await dom.tick(0);
		expect(text(root, ".sl-engine__policy-name")).toBe(COPY.engineView.policy.name("79M"));
		expect(text(root, ".sl-engine__policy-status .sl-pill__text")).toBe(
			COPY.engineView.policy.waiting
		);
		store.emit(policySnapshot(48, 10));
		await dom.tick(0);
		expect(text(root, ".sl-engine__policy-status .sl-pill__text")).toBe(
			COPY.engineView.policy.answered
		);
		expect(text(root, ".sl-engine__policy-latency")).toBe(COPY.engineView.policy.latency("48"));
		expect(text(root, ".sl-engine__policy-meta")).toBe(COPY.engineView.policy.pick("42"));
		expect(text(root, ".sl-engine__policy-detail")).toBe(
			COPY.engineView.policy.wdl("32", "40", "28")
		);
		// The model answered but the selector fell back to the engine policy for this move.
		store.emit(policySnapshot(48, 11, { source: "sampled" }));
		await dom.tick(0);
		expect(text(root, ".sl-engine__policy-detail")).toBe(COPY.engineView.policy.fallback);
		expect(text(root, ".sl-engine__policy-meta")).toBe(COPY.engineView.none);
	});

	it("shows the assisted policy but hides a stale Maia answer after crossing 3200", async () => {
		const root = await mountView(policySnapshot(48, 1, { targetElo: 3200, source: "sampled" }));
		expect(text(root, ".sl-engine__selection")).toBe(COPY.engineView.selection.maiaPriorFull);
		expect(text(root, ".sl-engine__policy-status .sl-pill__text")).toBe(
			COPY.engineView.policy.answered
		);
		store.emit(policySnapshot(48, 1, { targetElo: 3201, source: "sampled" }));
		await dom.tick(0);
		expect(text(root, ".sl-engine__selection")).toBe(COPY.engineView.selection.stockfishFull);
		expect(text(root, ".sl-engine__policy-status .sl-pill__text")).toBe(COPY.engineView.policy.off);
		expect(text(root, ".sl-engine__policy-meta")).toBe(COPY.engineView.none);
	});

	it("the human-model sparkline takes one inference-time point per answered recommendation, capped", async () => {
		const root = await mountView(policySnapshot(48, 1));
		const line = (): SVGPolylineElement | null =>
			root.querySelector(".sl-engine__spark--policy .sl-engine__spark-line");
		const points = (): string[] => (line()?.getAttribute("points") ?? "").split(" ").filter(Boolean);
		expect(root.querySelector(".sl-engine__policy-spark svg.sl-engine__spark-svg")).not.toBeNull();
		expect(root.querySelector(".sl-engine__policy-spark")?.getAttribute("aria-label")).toBe(
			COPY.engineView.policy.sparkline
		);
		expect(points()).toHaveLength(1);
		// The same recommendation re-broadcast (snapshots repeat it) adds nothing.
		store.emit(policySnapshot(48, 1));
		await dom.tick(0);
		expect(points()).toHaveLength(1);
		// A recommendation without a Maia answer adds nothing either.
		const plain = engineSnapshot();
		plain.settings = { ...plain.settings, strength: { ...plain.settings.strength, targetElo: 1650 } };
		if (plain.recommendation) plain.recommendation.computedAt = 2;
		store.emit(plain);
		await dom.tick(0);
		expect(points()).toHaveLength(1);
		for (let i = 0; i < LIMITS.policySparklineSamples + 10; i += 1) {
			store.emit(policySnapshot(40 + i, 100 + i));
			await dom.tick(0);
		}
		expect(points()).toHaveLength(LIMITS.policySparklineSamples);
		// The engine's own sparkline is untouched by the policy samples.
		const engineLine = root.querySelector(
			".sl-engine__spark:not(.sl-engine__spark--policy) .sl-engine__spark-line"
		);
		expect((engineLine?.getAttribute("points") ?? "").split(" ").filter(Boolean)).toHaveLength(1);
		expect(line()?.getAttribute("stroke")).toBeNull();
	});

	it("names the small-net fallback on the version row while the full build is crashed out", async () => {
		const s = engineSnapshot();
		s.engine = {
			...s.engine,
			variant: "smallnet",
			nnue: ["nn-4ca89e4b3abf.nnue"],
			fallbackFrom: "full",
		};
		const root = await mountView(s);
		expect(text(root, ".sl-engine__version")).toBe(
			`${COPY.engine.rows.version("17", "nn-4ca89e4b3abf")} · ${COPY.engine.rows.fallback}`
		);
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
		expect(value(root, "target")).toBe(COPY.engineView.target("abc123"));
		expect(value(root, "input")).toBe(
			COPY.engineView.inputMode(
				SETTINGS_COPY.options.inputMode[DEFAULT_SETTINGS.execution.inputMode],
				COPY.engineView.profiles.natural
			)
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

	it("Detach / Reattach dispatch and follow debugger state during live games", async () => {
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

		// Live controls retain their own availability rules instead of a blanket session lock.
		const live = makeSnapshot({ state: "live:opponent-turn" });
		live.executor = { debuggerAttached: false };
		store.emit(live);
		await dom.tick(0);
		expect(detach?.getAttribute("aria-disabled")).toBe("true");
		for (const cmd of ["reattach", "copy", "export", "clear", "reset"])
			expect(root.querySelector(`[data-cmd="${cmd}"]`)?.getAttribute("aria-disabled")).toBeNull();
		const before = store.dispatched.length;
		click(reattach as HTMLElement);
		expect(store.dispatched).toHaveLength(before + 1);
		expect(store.dispatched.at(-1)).toBe(MSG.PANEL_REATTACH_DEBUGGER);
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
	it("does not restore pre-clear history when the initial export finishes late", async () => {
		let resolveHistory: (rows: TimingLogEntry[]) => void = () => {};
		store.responses[MSG.PANEL_EXPORT_TIMING_LOG] = new Promise<TimingLogEntry[]>((resolve) => {
			resolveHistory = resolve;
		});
		const root = await mountView(engineSnapshot());
		click(root.querySelector('[data-cmd="clear"]') as HTMLElement);
		resolveHistory([timingEntry()]);
		await dom.tick(0);
		expect(root.querySelectorAll(".sl-engine__log-row")).toHaveLength(0);
		store.port({ kind: "timingLog", entry: timingEntry({ ply: 16 }) });
		await dom.tick(0);
		expect(root.querySelectorAll(".sl-engine__log-row")).toHaveLength(1);
	});
	it("shows the actual timing source, fallback reason and effective context", () => {
		const lines = rationaleRows(
			timingEntry({
				model: { head: "v1-parametric", requestedHead: "chessmimic", fallbackReason: "timeout" },
				targetElo: 1650,
				opponentClockMs: 120_000,
				rationale: ["clock cap"],
			})
		)[0]?.lines;
		expect(lines).toContain("model v1-parametric");
		expect(lines).toContain("fallback: timeout");
		expect(lines).toContain("target 1650 · opponent 120.0s");
		expect(lines).toContain("clock cap");
	});
	it("replaces a streamed plan with its execution receipt instead of duplicating the move", async () => {
		store.responses[MSG.PANEL_EXPORT_TIMING_LOG] = [timingEntry()];
		const root = await mountView(engineSnapshot());
		store.port({ kind: "timingLog", entry: timingEntry({ actualMs: 4400 }) });
		await dom.tick(0);
		expect(
			[...root.querySelectorAll<HTMLElement>(".sl-engine__log-row")].map((r) => r.dataset.kind)
		).toEqual(["plan", "exec", "verify"]);
	});
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

	it("keeps Export, Copy, Clear and Reset available in the engine panel during a live game", async () => {
		store.responses[MSG.PANEL_EXPORT_TIMING_LOG] = [timingEntry()];
		const app = document.getElementById("app") as HTMLElement;
		shell = bootShell(app, { store, views: { engine: view() } });
		shell.setTab("engine");
		store.emit(makeSnapshot({ state: "live:my-turn:recommended" }));
		await dom.tick(0);
		expect(shell.router.current).toBe("engine");
		expect(shell.handsOff).toBe(false);
		expect(app.classList.contains("sl-hands-off")).toBe(false);
		const exportBtn = app.querySelector<HTMLElement>('[data-cmd="export"]');
		expect(exportBtn?.getAttribute("aria-disabled")).toBeNull();
		const tabsBefore = dom.sim.tabs.all().length;
		click(exportBtn as HTMLElement);
		await dom.tick(0);
		expect(dom.sim.tabs.all()).toHaveLength(tabsBefore + 1);
		expect(dom.sim.tabs.all().at(-1)?.url.startsWith("data:application/json")).toBe(true);
		expect(exportBtn?.dataset.url).toBeUndefined();
		for (const cmd of ["copy", "clear", "reset"])
			click(app.querySelector(`[data-cmd="${cmd}"]`) as HTMLElement);
		await dom.tick(0);
		expect(copied).toHaveLength(1);
		expect(store.dispatched).toContain(MSG.PANEL_CLEAR_TIMING_LOG);
		expect(store.dispatched).toContain(MSG.PANEL_RESET_SESSION);
	});
});

describe("engine view — session", () => {
	it("renders the session line from stats and Reset session dispatches", async () => {
		const s = engineSnapshot();
		s.stats = {
			games: 6,
			moves: 210,
			avgThinkMs: 3100,
			timingVersion: TIMING_STATISTICS.version,
			timingSamples: 20,
		};
		const root = await mountView(s);
		expect(text(root, ".sl-engine__session")).toBe(COPY.engineView.session(6, 210, "3.1"));
		click(root.querySelector('[data-cmd="reset"]') as HTMLElement);
		expect(store.dispatched.at(-1)).toBe(MSG.PANEL_RESET_SESSION);
	});
	it("does not present the legacy hand-only average as a measured turn time", async () => {
		const s = engineSnapshot();
		s.stats = { games: 6, moves: 210, avgThinkMs: 2100 };
		const root = await mountView(s);
		expect(text(root, ".sl-engine__session")).toBe(COPY.engineView.session(6, 210, null));
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

// ── 2026-09-13: the Human-model block's fidelity meters (§3.2) and the H7.1 history warning ────
describe("engine view — human-model meters", () => {
	/** A live snapshot at `ply` whose recommendation carries the given `rec.maia` fields. */
	function metersSnapshot(
		maia: NonNullable<NonNullable<PanelSnapshot["recommendation"]>["maia"]>,
		ply = 20,
		source: "maia" | "sampled" = "maia"
	): PanelSnapshot {
		const s = engineSnapshot();
		s.settings = { ...s.settings, strength: { ...s.settings.strength, targetElo: 1650 } };
		s.session = { ...s.session, state: "live:my-turn:recommended", ply };
		if (s.recommendation) {
			s.recommendation.computedAt = ply;
			s.recommendation.fen = "fen";
			s.recommendation.chosen.source = source;
			s.recommendation.chosen.maiaProb = maia.p ?? 0.4;
			s.recommendation.maia = maia;
		}
		return s;
	}
	const meter = (root: ParentNode, row: string): HTMLElement | null =>
		root.querySelector<HTMLElement>(`[data-meter="${row}"]`);
	const meterValue = (root: ParentNode, row: string): string =>
		text(root, `[data-meter="${row}"] .sl-engine__value`);

	it("hides the list without an answer and shows history and the rating asked at with one", async () => {
		const root = await mountView(engineSnapshot());
		const list = root.querySelector<HTMLElement>(".sl-engine__policy-meters");
		expect(list?.hidden).toBe(true);
		expect(root.querySelector<HTMLElement>(".sl-engine__policy-warning")?.hidden).toBe(true);
		store.emit(
			metersSnapshot({
				size: "79m",
				wdl: [0.28, 0.4, 0.32],
				ms: 48,
				p: 0.4,
				historyPlies: 8,
				selfElo: 1587.4,
			})
		);
		await dom.tick(0);
		expect(list?.hidden).toBe(false);
		const { meters } = COPY.engineView.policy;
		expect(text(root, '[data-meter="history"] .sl-engine__key')).toBe(meters.history);
		expect(meterValue(root, "history")).toBe(
			COPY.engineView.policy.historyValue(8, MAIA_INPUT.history)
		);
		expect(meterValue(root, "selfElo")).toBe(COPY.engineView.policy.eloValue(1587));
		// The draw's own meters are absent: their rows are hidden, not blank.
		for (const row of ["entropy", "railed", "unscored", "kl", "rank", "candidates"])
			expect(meter(root, row)?.hidden, row).toBe(true);
	});

	it("renders the draw's meters — entropy, railed and unscored mass, KL, rank of survivors — and the H3 pair when present", async () => {
		const root = await mountView(
			metersSnapshot({
				size: "79m",
				wdl: [0.28, 0.4, 0.32],
				p: 0.4,
				historyPlies: 8,
				selfElo: 1600,
				meters: {
					selfElo: 1600,
					entropy: 0.4567,
					railedMass: 0.123,
					unscoredMass: 0.05,
					klFromMaia: 0.01234,
					rank: 2,
					survivors: 9,
				},
			})
		);
		const { policy } = COPY.engineView;
		expect(meterValue(root, "entropy")).toBe("0.46");
		expect(meterValue(root, "railed")).toBe(policy.pctValue("12"));
		expect(meterValue(root, "unscored")).toBe(policy.pctValue("5"));
		expect(meterValue(root, "kl")).toBe("0.012");
		expect(meterValue(root, "rank")).toBe(policy.rankValue(2, 9));
		expect(meter(root, "candidates")?.hidden).toBe(true);
		store.emit(
			metersSnapshot({
				size: "79m",
				wdl: [0.28, 0.4, 0.32],
				p: 0.4,
				historyPlies: 8,
				selfElo: 1600,
				meters: {
					selfElo: 1600,
					entropy: 0.2,
					railedMass: 0,
					unscoredMass: 0,
					klFromMaia: 0,
					rank: 0,
					survivors: 4,
					candidates: 3,
					verifyDepth: 10,
				},
			})
		);
		await dom.tick(0);
		expect(meter(root, "candidates")?.hidden).toBe(false);
		expect(meterValue(root, "candidates")).toBe(policy.candidatesValue(3, 10));
		expect(meterValue(root, "rank")).toBe(COPY.engineView.none);
	});

	it("warns when the query carried fewer plies than the model's window past the opening, and not before", async () => {
		const short = {
			size: "79m" as const,
			wdl: [0.3, 0.4, 0.3] as [number, number, number],
			historyPlies: 1,
			selfElo: 1200,
		};
		const root = await mountView(metersSnapshot(short, MAIA_INPUT.history + 4));
		const warning = root.querySelector<HTMLElement>(".sl-engine__policy-warning");
		expect(warning?.hidden).toBe(false);
		expect(warning?.textContent).toBe(COPY.engineView.policy.historyWarning);
		// Inside the opening a short window is expected.
		store.emit(metersSnapshot(short, MAIA_INPUT.history));
		await dom.tick(0);
		expect(warning?.hidden).toBe(true);
		// A full window past the opening: no warning.
		store.emit(metersSnapshot({ ...short, historyPlies: MAIA_INPUT.history }, 30));
		await dom.tick(0);
		expect(warning?.hidden).toBe(true);
		// The rows render when the model answered but the engine policy chose (H15's prior, a fallback).
		store.emit(metersSnapshot({ ...short, historyPlies: MAIA_INPUT.history }, 30, "sampled"));
		await dom.tick(0);
		expect(meterValue(root, "history")).toBe(
			COPY.engineView.policy.historyValue(MAIA_INPUT.history, MAIA_INPUT.history)
		);
	});
});
