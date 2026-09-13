import { afterEach, describe, expect, it } from "bun:test";
import type { AdapterPositionSnapshot, BridgeState } from "@content/adapters/adapter";
import { createChesscomAdapter } from "@content/adapters/chesscom";
import { installWindowGlobals, type TabDom } from "@test/sim/dom/tab-dom";
import {
	FakeBridge,
	loadFixture,
	observerRegistry,
	pageDocument,
	pageWindow,
	waitFor,
} from "./helpers";

const FEN = "rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2";
const TIME_CONTROL = { baseTime: 180_000, increment: 2_000 };
const cleanups: Array<() => void> = [];

afterEach(() => {
	for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

// Clock markup captured during a timed 3+2 /play/computer game, playing black.
function addClockRows(dom: TabDom): void {
	dom.document.body.insertAdjacentHTML(
		"beforeend",
		`<div class="player-row-component player-row-top">
			<div class="move-time-time player-row-move-time">
				<svg class="ticker-icon-component move-time-ticker" style="transform: rotate(4770deg)"></svg>
				<div class="move-time-content move-time-monospace">3:23</div>
			</div>
		</div>
		<div class="player-row-component">
			<div class="move-time-time move-time-dark player-row-move-time">
				<svg class="ticker-icon-component move-time-ticker"></svg>
				<div class="move-time-content move-time-monospace">2:35</div>
			</div>
		</div>`
	);
}

async function boot(
	options: {
		timeControl?: unknown;
		clocks?: boolean;
		url?: string;
		observer?: "polling" | "recording";
	} = {}
) {
	const dom = loadFixture("chesscom-computer", options.url, {
		observer: options.observer ?? "polling",
	});
	cleanups.push(installWindowGlobals(dom.window));
	if (options.clocks !== false) addClockRows(dom);
	let state: BridgeState = {
		fen: FEN,
		playingAs: "b",
		mode: "playing",
		gameOver: false,
		timeControl: options.timeControl === undefined ? TIME_CONTROL : options.timeControl,
	};
	const bridge = new FakeBridge();
	bridge.responses.set("getState", () => state);
	const adapter = createChesscomAdapter({
		document: pageDocument(dom),
		window: pageWindow(dom),
		bridge,
	});
	cleanups.push(() => adapter.destroy());
	await waitFor(() => adapter.getMyColor() === "b");
	return {
		dom,
		adapter,
		update(patch: Partial<BridgeState>) {
			state = { ...state, ...patch };
			bridge.emit("move", state);
		},
	};
}

describe("ChessComAdapter — timed computer clocks", () => {
	it("reads the captured countdowns by color, independent of board orientation", async () => {
		const { dom, adapter } = await boot();
		expect(adapter.getTimeControl()).toEqual({ baseMs: 180_000, incMs: 2_000 });
		expect(adapter.getClock("w")).toEqual({ ms: 203_000, running: true, hasTenths: false });
		expect(adapter.getClock("b")).toEqual({ ms: 155_000, running: false, hasTenths: false });
		const top = dom.query(".player-row-top");
		top.classList.remove("player-row-top");
		dom.document.body.append(top);
		dom.query(".move-time-dark").parentElement?.classList.add("player-row-top");
		expect(adapter.getClock("w")?.ms).toBe(203_000);
		expect(adapter.getClock("b")?.ms).toBe(155_000);
	});

	it("runs only the reconciled side to move and stops both clocks after the game", async () => {
		const { adapter, update } = await boot();
		update({ fen: FEN.replace(" w ", " b ") });
		expect(adapter.getClock("b")?.running).toBe(true);
		expect(adapter.getClock("w")?.running).toBe(false);
		update({ gameOver: true });
		expect(adapter.getClock("b")?.running).toBe(false);
		expect(adapter.getClock("w")?.running).toBe(false);
	});

	it("does not extrapolate countdowns while viewing a historical move", async () => {
		const { dom, adapter } = await boot();
		dom.query(".node-highlight-content.selected").classList.remove("selected");
		dom.query(".node-highlight-content").classList.add("selected");
		expect(adapter.getClock("w")?.running).toBe(false);
		expect(adapter.getClock("b")?.running).toBe(false);
	});

	it("does not invent a running side when neither the bridge nor move list gives a turn", async () => {
		const { dom, adapter, update } = await boot();
		dom.query("wc-simple-move-list").remove();
		update({ fen: "" });
		expect(adapter.getSideToMove()).toBeNull();
		expect(adapter.getClock("w")).toEqual({ ms: 203_000, running: false, hasTenths: false });
		expect(adapter.getClock("b")).toEqual({ ms: 155_000, running: false, hasTenths: false });
	});

	for (const timeControl of [null, { baseTime: 0, increment: 0 }]) {
		it(`ignores elapsed-move counters without a positive time control: ${JSON.stringify(timeControl)}`, async () => {
			const { adapter } = await boot({ timeControl });
			expect(adapter.getTimeControl()).toBeNull();
			expect(adapter.getClock("w")).toBeNull();
			expect(adapter.getClock("b")).toBeNull();
		});
	}

	it("does not apply the computer countdown fallback on other pages", async () => {
		const { adapter } = await boot({ url: "https://www.chess.com/game/123456" });
		expect(adapter.getTimeControl()).toEqual({ baseMs: 180_000, incMs: 2_000 });
		expect(adapter.getClock("w")).toBeNull();
		expect(adapter.getClock("b")).toBeNull();
	});

	it("publishes valid clocks when the time control first arrives", async () => {
		const { adapter, update } = await boot({ timeControl: null });
		const positions: AdapterPositionSnapshot[] = [];
		adapter.onPositionChange((snapshot) => positions.push(snapshot));
		update({ timeControl: TIME_CONTROL });
		await waitFor(() => positions.at(-1)?.clocks.w.ms === 203_000);
		expect(positions.at(-1)?.timeControl).toEqual({ baseMs: 180_000, incMs: 2_000 });
	});

	it("observes countdowns inserted after the board, then their text updates and replacements", async () => {
		const { dom, adapter } = await boot({ clocks: false });
		const positions: AdapterPositionSnapshot[] = [];
		adapter.onPositionChange((snapshot) => positions.push(snapshot));
		addClockRows(dom);
		await waitFor(() => positions.at(-1)?.clocks.w.ms === 203_000);
		const white = dom.query(".player-row-top .move-time-content");
		white.firstChild!.textContent = "3:22";
		await waitFor(() => positions.at(-1)?.clocks.w.ms === 202_000);
		const row = dom.query(".player-row-top");
		row.outerHTML = row.outerHTML.replace("3:22", "3:21");
		await waitFor(() => positions.at(-1)?.clocks.w.ms === 201_000);
		dom.query(".player-row-top .move-time-content").textContent = "59.8";
		await waitFor(() => positions.at(-1)?.clocks.w.ms === 59_800);
		expect(adapter.getClock("w")?.hasTenths).toBe(true);
	});

	it("registers class, child and character-data observers on the actual countdown containers", async () => {
		const { dom } = await boot({ observer: "recording" });
		const registrations = observerRegistry(dom).on(".move-time-time");
		expect(registrations).toHaveLength(2);
		for (const registration of registrations) {
			expect(registration.init).toEqual({
				attributes: true,
				attributeFilter: ["class"],
				childList: true,
				subtree: true,
				characterData: true,
			});
		}
	});
});
