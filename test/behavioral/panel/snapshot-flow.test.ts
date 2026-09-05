// test/behavioral/panel/snapshot-flow.test.ts — Task 28 Step 1: the panel port + PANEL_GET_SNAPSHOT
// against the real broadcaster, panel handlers, license gate and panel store in the simulator.
// Session state comes from hand-driven fakes (Task 30 supplies the real registry).
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { LicenseClient, LicenseResult } from "@core/auth/license-client";
import { MSG, type PanelSnapshot, TIMINGS } from "@core/constants";
import { installMessageRouter, type MessageRouter } from "@core/messaging/router";
import { setSettings } from "@core/storage/settings-storage";
import { defaultScheduler } from "@core/util/scheduler";
import { bootShell, type PanelShell } from "@panel/shell";
import { createPanelStore, type PanelStore } from "@panel/store";
import { registerLicenseHandlers } from "@service/handlers/license";
import { registerPanelHandlers } from "@service/handlers/panel";
import { LicenseGate } from "@service/license-gate";
import { PanelBroadcaster, type SnapshotSources } from "@service/panel-broadcaster";
import { createSimulator, type Simulator } from "@test/sim";
import { bootPanelContext, type PanelContext } from "@test/sim/contexts/panel-context";
import { bootSwContext, type SwContext } from "@test/sim/contexts/sw-context";
import { FakeSession, fakeSources, makePlan, makeRecommendation } from "./harness";

const START = 1_000_000;
const GOLD = "SL-GOLD-KEY";
const BAD = "SL-BAD-KEY";

let sim: Simulator;
let sw: SwContext;
let panel: PanelContext | null = null;
let store: PanelStore | null = null;
let shell: PanelShell | null = null;
let tabId: number;
let session: FakeSession;
let sessions: Map<number, FakeSession>;
let sources: SnapshotSources;
let broadcaster: PanelBroadcaster;
let router: MessageRouter;
let gate: LicenseGate;
const validations: string[] = [];

const client: LicenseClient = {
	async validate(key): Promise<LicenseResult> {
		validations.push(key);
		if (key === GOLD) return { status: "valid" };
		return key === "" ? { status: "network_error", message: "offline" } : { status: "invalid" };
	},
};

beforeEach(async () => {
	validations.length = 0;
	sim = createSimulator({ startAt: START });
	sim.time.install();
	tabId = sim.openTab("https://lichess.org/abcd1234", { active: true }).tabId;
	session = new FakeSession("lichess");
	sessions = new Map([[tabId, session]]);
	sw = await bootSwContext(sim, {
		entry: async () => {
			router = installMessageRouter();
			gate = new LicenseGate({ client, forceValid: false, now: sim.now });
			sources = fakeSources({ sessions, license: () => gate.getState() });
			broadcaster = new PanelBroadcaster(sources, { scheduler: defaultScheduler, now: sim.now });
			registerPanelHandlers(router, { broadcaster, sources, link: null });
			registerLicenseHandlers(router, { license: gate });
			router.install();
			await gate.ensure();
		},
	});
});
afterEach(async () => {
	shell?.dispose();
	shell = null;
	store?.dispose();
	store = null;
	await panel?.teardown();
	panel = null;
	await sw.run(() => broadcaster.dispose());
	await sw.teardown();
	sim.time.uninstall();
	await sim.dispose();
});

async function connectPanel(): Promise<PanelSnapshot[]> {
	panel = await bootPanelContext(sim);
	const seen: PanelSnapshot[] = [];
	store = await panel.run(() => createPanelStore());
	store.subscribe((s) => seen.push(s));
	return seen;
}
/** Through a function boundary so a `store = null` above does not narrow the later read. */
const currentStore = (): PanelStore | null => store;

describe("panel ↔ service worker: snapshot flow", () => {
	it("a connecting panel receives a snapshot within one tick, built for the active game tab", async () => {
		const seen = await connectPanel();
		await sim.time.advance(0);
		expect(seen.length).toBeGreaterThanOrEqual(1);
		const snap = store?.snapshot;
		expect(snap).not.toBeNull();
		expect(snap?.site).toBe("lichess");
		expect(snap?.pageKind).toBe("live-lobby");
		expect(snap?.session.state).toBe("waiting-for-game");
		expect(snap?.session.hand).toBe("detached");
		expect(snap?.license.status).toBe("network_error");
		expect(snap?.autoMove).toEqual({ armed: false });
		expect(snap?.executor).toEqual({ debuggerAttached: false });
		expect(snap?.focus).toEqual({
			pageHasFocus: false,
			blurSeenThisMove: false,
			handsOff: false,
			realPointerEventsDuringHand: 0,
		});
		expect(snap?.stats).toEqual({ games: 0, moves: 0, avgThinkMs: 0 });
		expect(snap?.engine.state).toBe("booting");
		expect(snap?.settings.enabled).toBe(false);
		expect(snap?.recommendation).toBeUndefined();
		expect(broadcaster.connections()).toBe(1);
	});

	it("PANEL_GET_SNAPSHOT answers the same snapshot the port pushes", async () => {
		await connectPanel();
		await sim.time.advance(0);
		const reply = (await panel?.send({ type: MSG.PANEL_GET_SNAPSHOT })) as {
			success: boolean;
			response: PanelSnapshot;
		};
		expect(reply.success).toBe(true);
		expect(reply.response).toEqual(store?.snapshot as PanelSnapshot);
	});

	it("a position update with a recommendation reaches the panel as `recommendation` (hands-off while live)", async () => {
		const seen = await connectPanel();
		await sim.time.advance(TIMINGS.panelSnapshotMinIntervalMs);
		const before = seen.length;
		await sw.run(() => {
			const plan = makePlan(sim.now());
			session.recommend(makeRecommendation(plan, sim.now()), 7);
			broadcaster.notify();
		});
		await sim.time.advance(0);
		expect(seen.length).toBe(before + 1);
		const snap = seen.at(-1) as PanelSnapshot;
		expect(snap.session.state).toBe("live:my-turn:recommended");
		expect(snap.session.ply).toBe(7);
		expect(snap.session.clocks?.w.ms).toBe(180_000);
		expect(snap.recommendation?.chosen.uci).toBe("e2e4");
		expect(snap.recommendation?.lines).toHaveLength(2);
		expect(snap.recommendation?.plan.thinkMs).toBe(1200);
		expect(snap.focus.handsOff).toBe(true);
		expect(snap.autoMove).toEqual({ armed: false }); // no executor on this tab yet
	});

	it("a burst of notifications is throttled to TIMINGS.panelSnapshotMinIntervalMs with a trailing push carrying the latest state", async () => {
		const seen = await connectPanel();
		await sim.time.advance(TIMINGS.panelSnapshotMinIntervalMs);
		const before = seen.length;
		const step = Math.floor(TIMINGS.panelSnapshotMinIntervalMs / 4);
		await sw.run(() => {
			session.game = { ...session.game, ply: 1 };
			broadcaster.notify();
		});
		await sim.time.advance(0);
		expect(seen.length).toBe(before + 1);
		expect((seen.at(-1) as PanelSnapshot).session.ply).toBe(1);
		for (const ply of [2, 3, 4]) {
			await sim.time.advance(step);
			await sw.run(() => {
				session.game = { ...session.game, ply };
				broadcaster.notify();
			});
		}
		await sim.time.advance(0);
		expect(seen.length).toBe(before + 1); // inside the interval: coalesced
		await sim.time.advance(TIMINGS.panelSnapshotMinIntervalMs);
		expect(seen.length).toBe(before + 2); // exactly one trailing push …
		expect((seen.at(-1) as PanelSnapshot).session.ply).toBe(4); // … with the newest state
		await sim.time.advance(TIMINGS.panelSnapshotMinIntervalMs);
		expect(seen.length).toBe(before + 2);
	});

	it("a settings write in the service worker reaches the panel without an explicit notify", async () => {
		const seen = await connectPanel();
		await sim.time.advance(TIMINGS.panelSnapshotMinIntervalMs);
		const before = seen.length;
		await sw.run(() => setSettings({ enabled: true, engine: { multiPv: 6 } }));
		await sim.time.advance(TIMINGS.panelSnapshotMinIntervalMs);
		expect(seen.length).toBeGreaterThan(before);
		const snap = seen.at(-1) as PanelSnapshot;
		expect(snap.settings.enabled).toBe(true);
		expect(snap.settings.engine.multiPv).toBe(6);
	});

	it("login with a valid key → LicenseState.valid in the next snapshot → the router lands on `waiting`", async () => {
		await connectPanel();
		const app = panel?.document.getElementById("app") as unknown as HTMLElement;
		const s = store as PanelStore;
		shell = (await panel?.run(() => bootShell(app, { store: s }))) ?? null;
		await sim.time.advance(TIMINGS.panelSnapshotMinIntervalMs);
		expect(shell?.router.current).toBe("login");
		expect(validations).toEqual([""]);

		const reply = await panel?.run(() => s.dispatch({ type: MSG.PANEL_LOGIN, key: GOLD }));
		expect(reply?.status).toBe("valid");
		await sim.time.advance(TIMINGS.panelSnapshotMinIntervalMs);
		expect(store?.snapshot?.license.status).toBe("valid");
		expect(shell?.router.current).toBe("waiting");
		expect(validations).toEqual(["", GOLD]);

		// A second transition through the same path: a wrong key → `invalid` → the expired interrupt.
		// (Logout would keep `valid` here: with this client an empty key is a network error, and
		// the gate never lets a network error revoke a valid verdict.)
		await panel?.run(() => s.dispatch({ type: MSG.PANEL_LOGIN, key: BAD }));
		await sim.time.advance(TIMINGS.panelSnapshotMinIntervalMs);
		expect(store?.snapshot?.license.status).toBe("invalid");
		expect(shell?.router.current).toBe("expired");
		expect(validations).toEqual(["", GOLD, BAD]);
	});

	it("with no game tab the snapshot is idle: site null, no session, no executor", async () => {
		sessions.delete(tabId);
		sim.closeTab(tabId);
		await connectPanel();
		await sim.time.advance(0);
		const snap = store?.snapshot;
		expect(snap?.site).toBeNull();
		expect(snap?.pageKind).toBe("other");
		expect(snap?.session.state).toBe("idle");
		expect(snap?.session.gameId).toBeNull();
		expect(snap?.autoMove).toEqual({ armed: false });
		expect(snap?.executor).toEqual({ debuggerAttached: false });
		expect(snap?.recommendation).toBeUndefined();
	});

	it("a panel that disconnects while a push is being built is dropped cleanly", async () => {
		await connectPanel();
		await sim.time.advance(TIMINGS.panelSnapshotMinIntervalMs);
		expect(broadcaster.connections()).toBe(1);
		await sw.run(() => broadcaster.notify()); // the build is now awaiting storage
		store?.dispose();
		store = null;
		await panel?.teardown();
		panel = null;
		await sim.time.advance(TIMINGS.panelSnapshotMinIntervalMs);
		expect(broadcaster.connections()).toBe(0);
		// The broadcaster keeps working for the next panel.
		await connectPanel();
		await sim.time.advance(0);
		expect(currentStore()?.snapshot?.site).toBe("lichess");
		expect(broadcaster.connections()).toBe(1);
	});
});
