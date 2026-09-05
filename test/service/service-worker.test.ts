// test/service/service-worker.test.ts — boots the real SW entry in the simulator.
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { LicenseClient, LicenseResult } from "@core/auth/license-client";
import { ALARM_NAMES, LOCAL_KEYS, MSG, type PanelSnapshot } from "@core/constants";
import { bootstrapServiceSystems, type ServiceSystems } from "@service/bootstrap";
import { createSimulator, type Simulator } from "@test/sim";
import { bootPanelContext, type PanelContext } from "@test/sim/contexts/panel-context";
import { bootSwContext, type SwContext } from "@test/sim/contexts/sw-context";
import type { LicenseState } from "@typedefs/settings";

let sim: Simulator;
let sw: SwContext;
let panel: PanelContext;
let systems: ServiceSystems;
const validations: string[] = [];
const client: LicenseClient = {
	async validate(key): Promise<LicenseResult> {
		validations.push(key);
		return { status: key === "GOLD" ? "valid" : "invalid" };
	},
};

beforeAll(async () => {
	sim = createSimulator();
	sw = await bootSwContext(sim, {
		entry: async () => {
			systems = bootstrapServiceSystems({ licenseClient: client });
			await import("@service/service-worker");
		},
	});
	await sim.time.runMicrotasks();
	panel = await bootPanelContext(sim);
});
afterAll(async () => {
	await panel.teardown();
	await sw.teardown();
	await sim.dispose();
});

describe("service worker entry", () => {
	it("registers its lifecycle and message listeners synchronously at boot", () => {
		const counts = sim.runtime.listenerCounts();
		expect(counts.installed).toBe(1);
		expect(counts.startup).toBe(1);
		expect(counts.message).toBe(1);
		expect(sim.sidePanel.state.behavior.openPanelOnActionClick).toBe(true);
	});
	it("validated the license at startup", () => {
		expect(validations).toEqual([""]);
		expect(systems.license.isUnlocked()).toBe(true);
	});
	it("round-trips PANEL_LOGIN from a panel context", async () => {
		const reply = (await panel.send({ type: MSG.PANEL_LOGIN, key: "GOLD" })) as {
			success: boolean;
			response: LicenseState;
		};
		expect(reply.success).toBe(true);
		expect(reply.response.status).toBe("valid");
		expect(reply.response.rawStatus).toBe("valid");
		expect(sim.storage.data.local[LOCAL_KEYS.licenseKey]).toBe("GOLD");
		expect(validations).toEqual(["", "GOLD"]);
	});
	it("round-trips PANEL_GET_SNAPSHOT (idle sources until Task 30 wires the registry)", async () => {
		const reply = (await panel.send({ type: MSG.PANEL_GET_SNAPSHOT })) as {
			success: boolean;
			response: PanelSnapshot;
		};
		expect(reply.success).toBe(true);
		expect(reply.response.session.state).toBe("idle");
		expect(reply.response.site).toBeNull();
		expect(reply.response.license.status).toBe("valid");
		expect(reply.response.engine.state).toBe("booting");
		expect(reply.response.autoMove).toEqual({ armed: false });
		expect(reply.response.executor).toEqual({ debuggerAttached: false });
	});
	it("round-trips PANEL_RECHECK_LICENSE and PANEL_LOGOUT", async () => {
		const recheck = (await panel.send({ type: MSG.PANEL_RECHECK_LICENSE })) as {
			success: boolean;
			response: LicenseState;
		};
		expect(recheck.success).toBe(true);
		expect(validations).toEqual(["", "GOLD", "GOLD"]);
		const logout = (await panel.send({ type: MSG.PANEL_LOGOUT })) as {
			success: boolean;
			response: LicenseState;
		};
		expect(logout.success).toBe(true);
		expect(logout.response.rawStatus).toBe("invalid");
		expect(logout.response.status).toBe("valid"); // force-valid build
		expect(sim.storage.data.local[LOCAL_KEYS.licenseKey]).toBeUndefined();
	});
	it("round-trips PANEL_SET_ENABLED through the serialised settings writer", async () => {
		const replies = await Promise.all([
			panel.send({ type: MSG.PANEL_SET_ENABLED, enabled: true }),
			panel.send({ type: MSG.PANEL_SET_ENABLED, enabled: false }),
			panel.send({ type: MSG.PANEL_SET_ENABLED, enabled: true }),
		]);
		for (const r of replies) expect(r).toMatchObject({ success: true });
		const settings = sim.storage.data.local[LOCAL_KEYS.settings] as { enabled: boolean };
		expect(settings.enabled).toBe(true);
	});
	it("prints forwarded MSG.LOG envelopes without failing the sender", async () => {
		const reply = await panel.send({
			type: MSG.LOG,
			level: "debug",
			args: ["hello from the panel"],
			meta: { source: "panel", timestamp: sim.now() },
		});
		expect(reply).toMatchObject({ success: true });
	});
	it("applies the side-panel policy to new tabs", async () => {
		const chess = sim.openTab("https://www.chess.com/play");
		const other = sim.openTab("https://example.com/");
		await sim.time.runMicrotasks();
		expect(sim.sidePanel.optionsFor(chess.tabId).enabled).toBe(true);
		expect(sim.sidePanel.optionsFor(other.tabId).enabled).toBe(false);
	});
	it("revalidates the license on its alarm and keeps the keepalive alarm harmless", async () => {
		const before = validations.length;
		const alarm = sim.alarms.list().find((a) => a.name === ALARM_NAMES.licenseRevalidate);
		expect(alarm).toBeDefined();
		await sim.time.advance(alarm!.scheduledTime - sim.now() + 1);
		await sim.time.runMicrotasks();
		expect(validations.length).toBe(before + 1);
		await systems.keepalive.hold("test");
		await sim.time.advance(60_000);
		expect(sim.alarms.fired().some((a) => a.name === ALARM_NAMES.keepalive)).toBe(true);
		await systems.keepalive.release("test");
	});
	it("handles a keyboard command without a session registry", () => {
		expect(() => sim.commands.trigger("play-move")).not.toThrow();
	});
});
