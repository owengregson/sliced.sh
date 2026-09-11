import { afterEach, beforeEach, expect, it } from "bun:test";
import { COPY } from "@panel/copy";
import { bootPanelDom, type PanelDom } from "../dom";
import {
	type LiveHarness,
	liveSnapshot,
	makeRecommendation,
	mountLive,
	THINK_MS,
} from "./live-harness";

let dom: PanelDom;
let h: LiveHarness | null = null;
beforeEach(async () => {
	dom = await bootPanelDom();
});
afterEach(async () => {
	h?.teardown();
	h = null;
	await dom.teardown();
});

it("keeps both clocks and evaluation ahead of one move phase across the live lifecycle", async () => {
	h = await mountLive(dom.sim, liveSnapshot());
	const board = h.q(".sl-live__board");
	const chip = h.q(".sl-live__eval-chip");
	const states = [
		["waiting", liveSnapshot({ state: "live:opponent-turn", sideToMove: "b" })],
		["analysing", liveSnapshot({ state: "live:my-turn:analysing", recommendation: null })],
		[
			"thinking",
			liveSnapshot({
				autoMove: { armed: true, scheduledAt: Date.now() + THINK_MS, plan: makeRecommendation().plan },
			}),
		],
		["executing", liveSnapshot({ state: "live:my-turn:executing", autoMove: { armed: true } })],
		["error", liveSnapshot({ engine: { state: "crashed" } })],
		["reading", liveSnapshot({ myColor: null, recommendation: null })],
	] as const;
	for (const [phase, snapshot] of states) {
		h.store.emit(snapshot);
		expect(h.root.dataset.phase).toBe(phase);
		expect(h.q(".sl-live__title").textContent).toBe(COPY.move.progress[phase].title);
		expect(h.q(".sl-move").dataset.phase).toBe(phase);
		expect(h.q(".sl-live__board")).toBe(board);
		expect(h.q(".sl-live__eval-chip")).toBe(chip);
		expect(board.querySelectorAll(".sl-live__clock")).toHaveLength(2);
		expect(board.nextElementSibling?.classList.contains("sl-live__move")).toBe(true);
		expect(h.q(".sl-live__eval").hidden).toBe(false);
	}
});

it("counts down the actual schedule and removes stale progress when the schedule is withdrawn", async () => {
	const snapshot = liveSnapshot({
		autoMove: { armed: true, scheduledAt: Date.now() + THINK_MS, plan: makeRecommendation().plan },
	});
	h = await mountLive(dom.sim, snapshot);
	const bar = h.q(".sl-move__progress-track");
	expect(bar.hidden).toBe(false);
	expect(h.q(".sl-move__progress-value").textContent).toBe("4.2s");
	await dom.tick(1000);
	expect(h.q(".sl-move__progress-value").textContent).toBe("3.2s");
	// The visual tick can trail the clock by one paint interval.
	expect(Number(bar.getAttribute("aria-valuenow"))).toBeGreaterThanOrEqual(22);
	expect(Number(bar.getAttribute("aria-valuenow"))).toBeLessThanOrEqual(24);
	h.store.emit(snapshot);
	expect(h.q(".sl-move__progress-value").textContent).toBe("3.2s");
	h.store.emit(liveSnapshot({ autoMove: { armed: true } }));
	expect(h.root.dataset.phase).toBe("ready");
	expect(bar.hidden).toBe(true);
	expect(bar.hasAttribute("aria-valuenow")).toBe(false);
	expect(h.q(".sl-move").classList.contains("sl-move--counting")).toBe(false);
});

it("preserves executing state across repeated snapshots and clears it on the next turn", async () => {
	h = await mountLive(dom.sim, liveSnapshot());
	for (let i = 0; i < 3; i++) {
		h.store.emit(liveSnapshot({ state: "live:my-turn:executing", autoMove: { armed: true } }));
		expect(h.q(".sl-button__label").textContent).toBe(COPY.move.executing);
		expect(h.q(".sl-move__progress-value").textContent).toBe(COPY.move.progress.executing.value);
		expect(h.q(".sl-move__progress-track").hidden).toBe(true);
	}
	h.store.emit(liveSnapshot({ state: "live:opponent-turn", sideToMove: "b" }));
	expect(h.q(".sl-move__action .sl-button").getAttribute("aria-busy")).toBe("false");
	expect(h.q(".sl-move__san").textContent).toBe("Nc6");
	expect(h.q(".sl-move__progress-value").textContent).toBe(COPY.move.progress.waiting.value);
});
