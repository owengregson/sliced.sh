// test/service/side-panel-policy.test.ts
import { beforeEach, describe, expect, it } from "bun:test";
import {
	hostTestFromMatchPattern,
	isChessHost,
	PANEL_PAGE_PATH,
	SidePanelPolicy,
} from "@service/side-panel-policy";
import { createSimulator, type Simulator } from "@test/sim";

let sim: Simulator;
beforeEach(() => {
	sim = createSimulator();
	(globalThis as Record<string, unknown>).chrome = sim.chrome;
});

const settle = () => sim.time.runMicrotasks();

describe("isChessHost", () => {
	it("derives the host test from SITE_MATCHES.chesscom / lichess", () => {
		expect(isChessHost("https://www.chess.com/play/online")).toBe(true);
		expect(isChessHost("https://chess.com/")).toBe(true);
		expect(isChessHost("https://lichess.org/abc123")).toBe(true);
		expect(isChessHost("http://sub.lichess.org/")).toBe(true);
		expect(isChessHost("https://example.com/chess.com")).toBe(false);
		expect(isChessHost("https://notchess.com/")).toBe(false);
		expect(isChessHost("https://chess.com.evil.io/")).toBe(false);
		expect(isChessHost("chrome://extensions")).toBe(false);
		expect(isChessHost(undefined)).toBe(false);
		expect(isChessHost("not a url")).toBe(false);
	});
	it("hostTestFromMatchPattern fails closed on an unparseable pattern", () => {
		expect(hostTestFromMatchPattern("garbage")("chess.com")).toBe(false);
		expect(hostTestFromMatchPattern("")("chess.com")).toBe(false);
		expect(hostTestFromMatchPattern("*://*/*")("anything.example")).toBe(true);
		expect(hostTestFromMatchPattern("https://lichess.org/*")("lichess.org")).toBe(true);
		expect(hostTestFromMatchPattern("https://lichess.org/*")("www.lichess.org")).toBe(false);
		expect(hostTestFromMatchPattern("*://*.chess.com/*")("chess.com")).toBe(true);
		expect(hostTestFromMatchPattern("*://*.chess.com/*")("www.chess.com")).toBe(true);
	});
});

describe("SidePanelPolicy", () => {
	it("enables the panel for a chess.com tab on tabs.onUpdated and disables it for example.com", async () => {
		const policy = new SidePanelPolicy();
		policy.install();
		await settle();
		const chess = sim.openTab("https://www.chess.com/play/online");
		const other = sim.openTab("https://example.com/");
		await settle();
		expect(sim.sidePanel.optionsFor(chess.tabId)).toMatchObject({
			enabled: true,
			path: PANEL_PAGE_PATH,
		});
		expect(sim.sidePanel.optionsFor(other.tabId)).toMatchObject({ enabled: false });
		expect(PANEL_PAGE_PATH).toBe("pages/panel.html");
		policy.dispose();
	});
	it("follows navigations in both directions", async () => {
		const policy = new SidePanelPolicy();
		policy.install();
		const tab = sim.openTab("https://example.com/");
		await settle();
		expect(sim.sidePanel.optionsFor(tab.tabId).enabled).toBe(false);
		sim.tabs.navigate(tab.tabId, "https://lichess.org/");
		await settle();
		expect(sim.sidePanel.optionsFor(tab.tabId)).toMatchObject({
			enabled: true,
			path: PANEL_PAGE_PATH,
		});
		sim.tabs.navigate(tab.tabId, "https://example.org/");
		await settle();
		expect(sim.sidePanel.optionsFor(tab.tabId).enabled).toBe(false);
		policy.dispose();
	});
	it("sets openPanelOnActionClick once and disables the global default", async () => {
		const policy = new SidePanelPolicy();
		policy.install();
		policy.install();
		await settle();
		expect(sim.sidePanel.state.behavior).toEqual({ openPanelOnActionClick: true });
		expect(sim.sidePanel.state.global.enabled).toBe(false);
	});
	it("reconciles tabs that already exist at install time", async () => {
		const chess = sim.openTab("https://lichess.org/");
		const other = sim.openTab("https://example.com/");
		const policy = new SidePanelPolicy();
		policy.install();
		await settle();
		expect(sim.sidePanel.optionsFor(chess.tabId).enabled).toBe(true);
		expect(sim.sidePanel.optionsFor(other.tabId).enabled).toBe(false);
		policy.dispose();
	});
	it("re-evaluates on tabs.onActivated", async () => {
		const policy = new SidePanelPolicy();
		policy.install();
		const a = sim.openTab("https://www.chess.com/", { active: true });
		const b = sim.openTab("https://example.com/", { active: true });
		await settle();
		sim.sidePanel.state.byTab.delete(a.tabId); // pretend Chrome forgot the per-tab option
		sim.tabs.activate(a.tabId);
		await settle();
		expect(sim.sidePanel.optionsFor(a.tabId).enabled).toBe(true);
		expect(sim.sidePanel.optionsFor(b.tabId).enabled).toBe(false);
		policy.dispose();
	});
	it("keeps the panel enabled everywhere while the user has opened it globally", async () => {
		const policy = new SidePanelPolicy();
		policy.install();
		policy.setGlobalOpen(true);
		await settle();
		const other = sim.openTab("https://example.com/");
		await settle();
		expect(sim.sidePanel.optionsFor(other.tabId)).toMatchObject({
			enabled: true,
			path: PANEL_PAGE_PATH,
		});
		policy.setGlobalOpen(false);
		await settle();
		expect(sim.sidePanel.optionsFor(other.tabId).enabled).toBe(false);
		policy.dispose();
	});
	it("dispose stops reacting to tab events", async () => {
		const policy = new SidePanelPolicy();
		policy.install();
		await settle();
		policy.dispose();
		const chess = sim.openTab("https://www.chess.com/");
		await settle();
		expect(sim.sidePanel.state.byTab.has(chess.tabId)).toBe(false);
	});
});
