// test/panel/views/live-harness.ts — mount the Live view against a fake store (dispatch spy),
// with the shell's toast / banner / overlay layers and a full live `PanelSnapshot` builder.
import { DEFAULT_SETTINGS, type PanelSnapshot } from "@core/constants";
import type { TypedMessage } from "@core/messaging/typed-messages";
import { mountBannerSlot } from "@panel/components/banner";
import { mountOverlayLayer } from "@panel/components/popover";
import { mountToastLayer } from "@panel/components/toast";
import type { PanelStore, PortMessageListener } from "@panel/store";
import type { Cleanup, PanelUiState, Router, ViewContext } from "@panel/view";
import { liveView } from "@panel/views/live";
import type { Simulator } from "@test/sim";
import type { Recommendation } from "@typedefs/game";
import { mount } from "../dom";

export const FEN_W = "rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2";
export const FEN_B = "rnbqkbnr/pppp1ppp/8/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R b KQkq - 1 2";

export const THINK_MS = 4200;

export function makeRecommendation(o: Partial<Recommendation> = {}): Recommendation {
	return {
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
				depth: 17,
				pvUci: ["d2d4", "e5d4", "g1f3"],
				pvSan: ["d4", "exd4", "Nf3"],
			},
			{ multipv: 4, score: { cp: 20 }, depth: 17, pvUci: ["b1c3"], pvSan: ["Nc3"] },
		],
		eval: { cp: 134 },
		wdl: [710, 220, 70],
		depth: 18,
		nps: 1_000_000,
		plan: {
			thinkMs: THINK_MS,
			mode: "normal",
			preMoveHoverMs: 0,
			dragDurationMs: 300,
			deadlineMs: THINK_MS,
			rationale: [],
			features: {},
		},
		computedAt: Date.now(),
		fen: FEN_W,
		...o,
	};
}

export interface LiveOverrides {
	state?: PanelSnapshot["session"]["state"];
	myColor?: "w" | "b";
	sideToMove?: "w" | "b";
	clocks?: PanelSnapshot["session"]["clocks"];
	hand?: PanelSnapshot["session"]["hand"];
	recommendation?: Recommendation | null;
	settings?: Partial<PanelSnapshot["settings"]>;
	autoMove?: PanelSnapshot["autoMove"];
	executor?: PanelSnapshot["executor"];
	engine?: Partial<PanelSnapshot["engine"]>;
	stats?: Partial<PanelSnapshot["stats"]>;
	focus?: Partial<PanelSnapshot["focus"]>;
	opponent?: PanelSnapshot["opponent"] | null;
	lastExecution?: PanelSnapshot["session"]["lastExecution"];
}

/** A live game, my turn, with a recommendation — the §4.4 wireframe. */
export function liveSnapshot(o: LiveOverrides = {}): PanelSnapshot {
	const state = o.state ?? "live:my-turn:recommended";
	const myColor = o.myColor ?? "w";
	const live = state.startsWith("live:");
	const rec = o.recommendation === null ? undefined : (o.recommendation ?? makeRecommendation());
	const session: PanelSnapshot["session"] = {
		state,
		gameId: live ? "g1" : null,
		site: "lichess",
		pageKind: "live-game",
		myColor,
		sideToMove: o.sideToMove ?? myColor,
		ply: 3,
		clocks:
			o.clocks === undefined
				? { w: { ms: 192_000, running: true }, b: { ms: 178_000, running: false } }
				: o.clocks,
		hand: o.hand ?? "resting",
	};
	if (o.lastExecution) session.lastExecution = o.lastExecution;
	const snap: PanelSnapshot = {
		license: { status: "valid", checkedAt: 1 },
		site: "lichess",
		pageKind: "live-game",
		session,
		engine: {
			state: "searching",
			variant: "smallnet",
			threads: 1,
			nnue: [],
			version: "18",
			...o.engine,
		},
		executor: o.executor ?? { debuggerAttached: false },
		// The assistant is on during a game (DEFAULT_SETTINGS ships it off).
		settings: { ...DEFAULT_SETTINGS, enabled: true, ...o.settings },
		autoMove: o.autoMove ?? { armed: false },
		stats: { games: 6, moves: 210, avgThinkMs: 3100, ...o.stats },
		focus: {
			pageHasFocus: true,
			blurSeenThisMove: false,
			handsOff: live,
			realPointerEventsDuringHand: 0,
			...o.focus,
		},
	};
	if (rec) snap.recommendation = rec;
	if (o.opponent !== null)
		snap.opponent = o.opponent ?? {
			isBot: false,
			name: "IM_Pawnstar",
			ratingEstimate: 1843,
			derivedTargetElo: 1893,
		};
	return snap;
}

/** Same snapshot outside hands-off: the game is over but the projection still renders. */
export function idleSnapshot(o: LiveOverrides = {}): PanelSnapshot {
	return liveSnapshot({ state: "game-over", ...o });
}

export interface FakeStore extends PanelStore {
	readonly calls: TypedMessage[];
	emit(snapshot: PanelSnapshot): void;
	port(message: Parameters<PortMessageListener>[0]): void;
	/** Reject the next dispatches (executor unreachable). */
	failNext: boolean;
}

export function fakeStore(initial: PanelSnapshot | null): FakeStore {
	let snapshot = initial;
	const subs = new Set<(s: PanelSnapshot) => void>();
	const ports = new Set<PortMessageListener>();
	const calls: TypedMessage[] = [];
	const store: FakeStore = {
		calls,
		failNext: false,
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
			ports.add(cb);
			return () => void ports.delete(cb);
		},
		dispatch(command) {
			calls.push(command);
			if (store.failNext) return Promise.reject(new Error("unreachable"));
			return Promise.resolve(undefined as never);
		},
		refresh() {},
		dispose() {},
		emit(next) {
			snapshot = next;
			for (const cb of [...subs]) cb(next);
		},
		port(message) {
			for (const cb of [...ports]) cb(message);
		},
	};
	return store;
}

const fakeRouter: Router = {
	switch: () => Promise.resolve(),
	resolve: () => Promise.resolve(),
	current: "live",
};

export interface LiveHarness {
	app: HTMLElement;
	content: HTMLElement;
	root: HTMLElement;
	store: FakeStore;
	tabId: number;
	ui: PanelUiState;
	cleanup: Cleanup;
	q<T extends HTMLElement = HTMLElement>(selector: string): T;
	qa<T extends HTMLElement = HTMLElement>(selector: string): T[];
	toasts(): HTMLElement[];
	banners(): HTMLElement[];
	teardown(): void;
}

/** Mount with the shell's layers around it (`.sl-app > banner / content / toasts / overlay`). */
export async function mountLive(
	sim: Simulator,
	snapshot: PanelSnapshot,
	options: { tab?: boolean } = {}
): Promise<LiveHarness> {
	const tab =
		options.tab === false ? null : sim.openTab("https://lichess.org/abcdefgh", { active: true });
	const app = mount(document.createElement("main"));
	app.className = "sl-app";
	const topbar = document.createElement("header");
	topbar.className = "sl-topbar";
	const bannerSlot = document.createElement("div");
	bannerSlot.className = "sl-app__banner";
	const content = document.createElement("div");
	content.className = "sl-app__content";
	const toasts = document.createElement("div");
	toasts.className = "sl-app__toasts";
	const overlay = document.createElement("div");
	overlay.className = "sl-app__overlay";
	app.append(topbar, bannerSlot, content, toasts, overlay);
	// `.sl-app` is min-height 100vh and grows with its content: its box is never the viewport.
	// A content box far taller/wider than any viewport proves the layout code ignores it.
	Object.defineProperty(app, "clientHeight", { configurable: true, value: 4000 });
	Object.defineProperty(app, "clientWidth", { configurable: true, value: 4000 });
	const unmountToasts = mountToastLayer(toasts);
	const unmountBanners = mountBannerSlot(bannerSlot);
	const unmountOverlay = mountOverlayLayer(overlay);
	const store = fakeStore(snapshot);
	const controller = new AbortController();
	const ui: PanelUiState = { tab: "game", updateAvailable: false, updateDismissed: false };
	const ctx: ViewContext = {
		router: fakeRouter,
		container: content,
		store,
		snapshot,
		ui,
		signal: controller.signal,
	};
	const cleanup = await liveView.mount(ctx);
	await sim.time.advance(0);
	const root = content.querySelector<HTMLElement>(".sl-live");
	if (!root) throw new Error("live view did not render .sl-live");
	const q = <T extends HTMLElement = HTMLElement>(selector: string): T => {
		const el = root.querySelector<T>(selector);
		if (!el) throw new Error(`live harness: no element matches ${selector}`);
		return el;
	};
	return {
		app,
		content,
		root,
		store,
		tabId: tab?.tabId ?? -1,
		ui,
		cleanup,
		q,
		qa: <T extends HTMLElement = HTMLElement>(selector: string): T[] => [
			...root.querySelectorAll<T>(selector),
		],
		toasts: () => [...toasts.querySelectorAll<HTMLElement>(".sl-toast")],
		banners: () => [...bannerSlot.querySelectorAll<HTMLElement>(".sl-banner")],
		teardown() {
			cleanup();
			controller.abort();
			unmountOverlay();
			unmountBanners();
			unmountToasts();
			app.remove();
		},
	};
}

/** Every interactive control the hands-off lock must cover (§13.4). */
export const INTERACTIVE_SELECTOR =
	'button, a[href], input, [role="switch"], [role="slider"], [role="tab"], [tabindex]';
