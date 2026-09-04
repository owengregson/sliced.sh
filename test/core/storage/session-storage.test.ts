// test/core/storage/session-storage.test.ts
import { beforeEach, describe, expect, it } from "bun:test";
import {
	clearLicenseKey,
	getLicenseKey,
	getLicenseState,
	setLicenseKey,
	setLicenseState,
} from "@core/storage/license-storage";
import {
	clearPersonaForGame,
	clearTabSessionFlags,
	getAutoMoveArmed,
	getDebuggerAttached,
	getPersonaForGame,
	setAutoMoveArmed,
	setDebuggerAttached,
	setPersonaForGame,
} from "@core/storage/session-storage";
import { installFakeChromeStorage } from "../../fakes/chrome-storage";

beforeEach(() => {
	installFakeChromeStorage();
});

describe("session storage", () => {
	it("tracks per-tab flags independently", async () => {
		expect(await getAutoMoveArmed(1)).toBe(false);
		await setAutoMoveArmed(1, true);
		await setDebuggerAttached(2, true);
		expect(await getAutoMoveArmed(1)).toBe(true);
		expect(await getAutoMoveArmed(2)).toBe(false);
		expect(await getDebuggerAttached(2)).toBe(true);
		await clearTabSessionFlags(2);
		expect(await getDebuggerAttached(2)).toBe(false);
		expect(await getAutoMoveArmed(1)).toBe(true);
	});
	it("stores persona latents per game", async () => {
		expect(await getPersonaForGame("g1")).toBeNull();
		const p = { persona: "blitz" as const, latents: { tempo: 0.9 }, sampledAt: 5 };
		await setPersonaForGame("g1", p);
		expect(await getPersonaForGame("g1")).toEqual(p);
		await clearPersonaForGame("g1");
		expect(await getPersonaForGame("g1")).toBeNull();
	});
});

describe("license storage", () => {
	it("defaults to unknown and round-trips", async () => {
		expect(await getLicenseState()).toEqual({ status: "unknown", checkedAt: 0 });
		await setLicenseState({ status: "valid", checkedAt: 10, rawStatus: "invalid" });
		expect((await getLicenseState()).rawStatus).toBe("invalid");
		expect(await getLicenseKey()).toBeNull();
		await setLicenseKey("k");
		expect(await getLicenseKey()).toBe("k");
		await clearLicenseKey();
		expect(await getLicenseKey()).toBeNull();
	});
});
