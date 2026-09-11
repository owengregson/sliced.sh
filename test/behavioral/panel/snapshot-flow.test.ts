// test/behavioral/panel/snapshot-flow.test.ts — Task 28 Step 1: the panel port + PANEL_GET_SNAPSHOT
// against the real broadcaster, panel handlers, license gate and panel store in the simulator.
// Session state comes from hand-driven fakes (Task 30 supplies the real registry).
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { LicenseClient, LicenseResult } from "@core/auth/license-client";
import { DEFAULT_SETTINGS, MSG, type PanelSnapshot, TIMINGS } from "@core/constants";
import { installMessageRouter, type MessageRouter } from "@core/messaging/router";
import { setSettings } from "@core/storage/settings-storage";
import { defaultScheduler } from "@core/util/scheduler";
import { bootShell, type PanelShell } from "@panel/shell";
import { createPanelStore, type PanelStore } from "@panel/store";
import { registerLicenseHandlers } from "@service/handlers/license";
import { registerPanelHandlers } from "@service/handlers/panel";
import { LicenseGate } from "@service/license-gate";
import {
	type ExecutorHandle,
	PanelBroadcaster,
	type SnapshotSources,
} from "@service/panel-broadcaster";
import { createSimulator, type Simulator } from "@test/sim";
import { bootPanelContext, type PanelContext } from "@test/sim/contexts/panel-context";
import { bootSwContext, type SwContext } from "@test/sim/contexts/sw-context";
import type { Settings } from "@typedefs/settings";
import { FakeSession, fakeSources, makePlan, makeRecommendation } from "./harness";

/**
 * §4.4: these tests are a user who has the assistant *on*, said explicitly rather than inherited
 * from `DEFAULT_SETTINGS` — the acting panel commands (arm, play, re-attach) refuse while the
 * switch is off, so the fixture must not move when the default does.
 */
const SETTINGS: Settings = { ...DEFAULT_SETTINGS, enabled: true };

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
let executors: Map<number, ExecutorHandle>;
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
	tabId = sim.openTab("https://www.chess.com/game/174252022572", { active: true }).tabId;
	session = new FakeSession("chesscom");
	sessions = new Map([[tabId, session]]);
	executors = new Map();
	sw = await bootSwContext(sim, {
		entry: async () => {
			router = installMessageRouter();
			gate = new LicenseGate({ client, forceValid: false, now: sim.now });
			sources = fakeSources({ sessions, executors, license: () => gate.getState() });
			broadcaster = new PanelBroadcaster(sources, { scheduler: defaultScheduler, now: sim.now });
			registerPanelHandlers(router, { broadcaster, sources, link: null, getSettings: () => SETTINGS });
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
		expect(snap?.site).toBe("chesscom");
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
		expect(snap?.settings.enabled).toBe(DEFAULT_SETTINGS.enabled);
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

	it("playNow plays the move `pendingMove()` reports, including a replacement parked behind a cancelled run", async () => {
		const plan = makePlan(sim.now());
		const rec = makeRecommendation(plan, sim.now(), { from: "d2", to: "d4" });
		const played: Array<{ uci: string | null; deadlineMs: number | null }> = [];
		// A parked replacement is reported by `pendingMove()` but is *not* what the no-arg
		// `playNow()` consumes (that one only takes `this.pending`) — the handler must name it.
		const parked: ExecutorHandle = {
			isArmed: () => true,
			pendingMove: () => ({ rec, fireAt: sim.now() }),
			runningMove: () => null,
			handView: () => "resting",
			on: () => () => {},
			arm: async () => {},
			disarm: () => {},
			schedule: () => {},
			cancel: () => {},
			whenIdle: async () => {},
			playNow: async (r, p) => {
				played.push({ uci: r?.chosen.uci ?? null, deadlineMs: p?.deadlineMs ?? null });
				return null;
			},
		};
		executors.set(tabId, parked);
		// `PANEL_PLAY_NOW` asks the *session* to play it (one re-plan, one `MoveContext`), so the
		// stand-in session needs the hand — and it is the session that must name the parked move.
		session.hand = parked;
		await connectPanel();
		await sim.time.advance(0);
		const reply = (await panel?.send({ type: MSG.PANEL_PLAY_NOW, tabId })) as { success: boolean };
		expect(reply.success).toBe(true);
		expect(played).toEqual([{ uci: "d2d4", deadlineMs: plan.deadlineMs }]);
	});

	it("a snapshot built earlier but resolved later never overwrites a newer one", async () => {
		const seen = await connectPanel();
		await sim.time.advance(TIMINGS.panelSnapshotMinIntervalMs);
		await sw.run(() => setSettings({ engine: { multiPv: 3 } }));
		await sim.time.advance(TIMINGS.panelSnapshotMinIntervalMs);
		expect(seen.at(-1)?.settings.engine.multiPv).toBe(3);

		// Storage and `tabs.query` have no ordering guarantee: make the next build's two reads
		// answer with what they saw *now*, 5× the throttle interval late.
		const local = sim.chrome.storage.local;
		const real = local.get.bind(local);
		const LATE_MS = TIMINGS.panelSnapshotMinIntervalMs * 5;
		let late = 2;
		local.get = ((keys: string, cb: (items: Record<string, unknown>) => void) => {
			if (late <= 0) return real(keys, cb);
			late -= 1;
			return real(keys, (items: Record<string, unknown>) => void setTimeout(() => cb(items), LATE_MS));
		}) as typeof local.get;
		try {
			await sw.run(() => broadcaster.notify()); // the slow build (multiPv 3)
			await sim.time.advance(0);
			expect(late).toBe(0); // both of its reads are in flight and deferred
			await sw.run(() => setSettings({ engine: { multiPv: 8 } })); // a fast build follows
			await sim.time.advance(TIMINGS.panelSnapshotMinIntervalMs);
			expect(seen.at(-1)?.settings.engine.multiPv).toBe(8);
			const beforeLate = seen.length;
			await sim.time.advance(LATE_MS);
			// The stale build resolved last and was dropped: the panel keeps the newer snapshot.
			expect(seen.length).toBe(beforeLate);
			expect(seen.at(-1)?.settings.engine.multiPv).toBe(8);
			expect(currentStore()?.snapshot?.settings.engine.multiPv).toBe(8);
		} finally {
			local.get = real;
		}
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
		expect(currentStore()?.snapshot?.site).toBe("chesscom");
		expect(broadcaster.connections()).toBe(1);
	});
});
