/** Browser-only, deterministic panel fixture. Run with `bun tools/panel-preview.ts`. */
import { DEFAULT_SETTINGS, LOCAL_KEYS, MSG } from "@core/constants";
import type { PanelSnapshot } from "@core/constants/messages";
import { normalizeSettings } from "@core/storage/settings-storage";
import { bootShell } from "@panel/shell";
import type { PanelStore, SnapshotListener } from "@panel/store";
import { makeSnapshot } from "../panel/fixtures";

const query = new URLSearchParams(location.search);
const state = query.get("state") ?? "live";
const local: Record<string, unknown> = {};
const storageListeners = new Set<(changes: Record<string, unknown>, area: string) => void>();
const event = () => ({ addListener() {}, removeListener() {}, hasListener: () => false });
const area = {
	get(key: string, done: (value: Record<string, unknown>) => void) {
		done({ [key]: local[key] });
	},
	set(values: Record<string, unknown>, done: () => void) {
		Object.assign(local, values);
		done();
		for (const listener of storageListeners)
			listener(
				Object.fromEntries(Object.entries(values).map(([key, value]) => [key, { newValue: value }])),
				"local"
			);
	},
	remove(_key: unknown, done: () => void) {
		done();
	},
};
Object.assign(globalThis, {
	chrome: {
		runtime: {
			getURL: (path: string) => `/${path}`,
			connect: () => ({
				postMessage() {},
				disconnect() {},
				onMessage: event(),
				onDisconnect: event(),
			}),
			sendMessage: (_message: unknown, done: (value: unknown) => void) => done({ ok: true, data: [] }),
		},
		storage: {
			local: area,
			session: area,
			onChanged: {
				addListener: (listener: typeof storageListeners extends Set<infer T> ? T : never) =>
					storageListeners.add(listener),
				removeListener: (listener: typeof storageListeners extends Set<infer T> ? T : never) =>
					storageListeners.delete(listener),
			},
		},
		tabs: { query: (_query: unknown, done: (tabs: unknown[]) => void) => done([{ id: 1 }]) },
		tts: { getVoices: (done: (voices: unknown[]) => void) => done([]) },
	},
});

let snapshot: PanelSnapshot = makeSnapshot({
	state: [
		"live",
		"thinking",
		"analysing",
		"executing",
		"lowtime",
		"error",
		"opponent",
		"crashed",
		"disabled",
		"unarmed",
		"cached-opponent",
		"cached-thinking",
		"no-rec",
	].includes(state)
		? "live:my-turn:recommended"
		: "waiting-for-game",
	armed: state !== "unarmed",
});
snapshot.settings = normalizeSettings({
	...DEFAULT_SETTINGS,
	display: {
		...DEFAULT_SETTINGS.display,
		theme: query.get("theme") ?? "dark",
		reducedMotion: query.get("motion") === "reduced" ? "on" : "system",
	},
});
snapshot.session.clocks = { w: { ms: 192000, running: false }, b: { ms: 178000, running: false } };
snapshot.session.myColor = "w";
snapshot.opponent = {
	isBot: true,
	name: "Training opponent",
	ratingEstimate: 1843,
	derivedTargetElo: 1893,
};
snapshot.stats = { games: 6, moves: 210, avgThinkMs: 3100 };
snapshot.executor = { debuggerAttached: true };
const plan = {
	thinkMs: 4200,
	mode: "normal",
	preMoveHoverMs: 0,
	dragDurationMs: 300,
	deadlineMs: 4200,
	rationale: [],
	features: {},
	orientationMs: 250,
	window: { orientationMs: 250, scanMs: 0, previewMs: 0, decisionMs: 0, approachMs: 0 },
} as const;
snapshot.recommendation = {
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
	lines: [
		{
			multipv: 1,
			score: { cp: 134 },
			depth: 18,
			pvUci: ["g1f3", "b8c6", "f1b5"],
			pvSan: ["Nf3", "Nc6", "Bb5"],
		},
		{
			multipv: 2,
			score: { cp: 92 },
			depth: 18,
			pvUci: ["f1c4", "g8f6", "d2d3"],
			pvSan: ["Bc4", "Nf6", "d3"],
		},
		{
			multipv: 3,
			score: { cp: 61 },
			depth: 18,
			pvUci: ["d2d4", "e5d4", "g1f3"],
			pvSan: ["d4", "exd4", "Nf3"],
		},
	],
	eval: { cp: 134 },
	wdl: [710, 220, 70],
	depth: 18,
	nps: 1000000,
	plan: { ...plan, rationale: [] },
	computedAt: Date.now(),
	fen: "rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2",
};
if (state === "analysing" || state === "no-rec") {
	snapshot.session.state = "live:my-turn:analysing";
	if (state === "analysing")
		snapshot.session.evaluation = {
			fen: snapshot.recommendation.fen,
			eval: { cp: 155 },
			wdl: [750, 190, 60],
		};
	delete snapshot.recommendation;
	snapshot.engine.state = "searching";
}
if (state === "opponent") {
	snapshot.session.state = "live:opponent-turn";
	snapshot.session.sideToMove = "b";
	snapshot.session.evaluation = {
		fen: "rnbqkbnr/pppp1ppp/8/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R b KQkq - 1 2",
		eval: { cp: -142 },
		wdl: [60, 190, 750],
	};
}
if (state === "thinking" || state === "lowtime")
	snapshot.autoMove = {
		armed: true,
		scheduledAt: Date.now() + plan.thinkMs,
		plan: { ...plan, rationale: [] },
	};
if (state === "executing") {
	snapshot.session.state = "live:my-turn:executing";
	snapshot.session.hand = "moving";
}
if (state === "lowtime")
	snapshot.session.clocks = { w: { ms: 8700, running: true }, b: { ms: 19300, running: false } };
if (state === "crashed" || state === "error") snapshot.engine.state = "crashed";
if (state === "disabled") snapshot.settings.enabled = false;
if (state === "queue" || state === "queue-searching" || state === "queue-retrying") {
	snapshot.session.state = "game-over";
	snapshot.settings.enabled = true;
	snapshot.settings.automation.autoQueue = true;
	snapshot.session.autoQueue = {
		dueAt: Date.now() + 245_000,
		attempts: state === "queue" ? 0 : 1,
		status: state === "queue-searching" ? "searching" : state === "queue-retrying" ? "retrying" : "break",
	};
}
if (state === "unsupported") {
	snapshot.site = null;
	snapshot.pageKind = "other";
}
if (state === "login") snapshot.license.status = "unknown";
if (state === "expired") snapshot.license.status = "expired";
if (query.has("elo")) snapshot.settings.strength.targetElo = Number(query.get("elo"));
if (query.get("eval") === "off") snapshot.settings.display.evalBar = false;
if (query.has("opponent")) snapshot.opponent.name = query.get("opponent") ?? "";
const listeners = new Set<SnapshotListener>();
const store: PanelStore = {
	get snapshot() {
		return state === "loading" ? null : snapshot;
	},
	connected: true,
	subscribe(listener) {
		listeners.add(listener);
		if (state !== "loading") listener(snapshot);
		return () => {
			listeners.delete(listener);
		};
	},
	onPortMessage: () => () => {},
	dispatch: async (command) =>
		(command.type === MSG.PANEL_EXPORT_TIMING_LOG ? [] : undefined) as never,
	refresh() {},
	dispose() {},
};
const app = document.getElementById("app");
if (!app) throw new Error("Panel fixture requires #app");
if (state === "update") local[LOCAL_KEYS.updateAvailable] = true;
const shell = bootShell(app, { store });
if (state === "settings" || state === "engine") shell.setTab(state);
if (state === "cached-opponent" || state === "cached-thinking") {
	await new Promise((resolve) => setTimeout(resolve, 100));
	delete snapshot.recommendation;
	snapshot.session.state =
		state === "cached-opponent" ? "live:opponent-turn" : "live:my-turn:analysing";
	snapshot.session.sideToMove = state === "cached-opponent" ? "b" : "w";
	for (const listener of listeners) listener(snapshot);
}

if (query.has("search")) {
	await new Promise((resolve) => setTimeout(resolve, 400));
	const input = document.querySelector<HTMLInputElement>(".sl-settings__search");
	if (input) {
		input.value = query.get("search") ?? "";
		input.dispatchEvent(new Event("input", { bubbles: true }));
	}
}
window.addEventListener("beforeunload", () => shell.dispose(), { once: true });
