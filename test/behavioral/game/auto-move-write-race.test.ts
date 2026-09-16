import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { chromeLocalGet } from "@core/chrome/storage";
import { LOCAL_KEYS } from "@core/constants/storage-keys";
import { queueSettingsWrite } from "@service/handlers/settings/write-queue";
import { createGameHarness, type GameHarness } from "./harness";

let h: GameHarness;
let restore: (() => void) | undefined;
let releaseWrite: (() => void) | undefined;
let pending: Promise<unknown>[] = [];

type StoragePort = { set(items: Record<string, unknown>, callback?: () => void): void };

function holdSettingsWrites(count = 1): Array<Record<string, unknown>> {
	const storage = h.sim.chrome.storage.local as unknown as StoragePort;
	const set = storage.set.bind(storage);
	const held: Array<Record<string, unknown>> = [];
	const hold = spyOn(storage, "set").mockImplementation((items, callback) => {
		if (held.length < count && LOCAL_KEYS.settings in items) {
			held.push(items);
			releaseWrite = () => {
				releaseWrite = undefined;
				set(items, callback);
			};
			return;
		}
		set(items, callback);
	});
	restore = () => hold.mockRestore();
	return held;
}

afterEach(async () => {
	// Never leave the shared settings-write queue waiting, even if an assertion fails.
	while (releaseWrite) await h.drive(() => releaseWrite?.());
	if (pending.length) await h.drive(() => Promise.allSettled(pending));
	restore?.();
	await h?.dispose();
	restore = undefined;
	releaseWrite = undefined;
	pending = [];
});

describe("auto-play preference: the latest request wins during a pending storage write", () => {
	for (const initial of [false, true]) {
		it(`${initial ? "off then on" : "on then off"} survives a stale settings getter and the next game`, async () => {
			h = await createGameHarness({ settings: { automation: { autoMove: initial } } });
			expect(await h.until(() => h.executor()?.isArmed() === initial, 1_000)).toBe(true);
			// Delay the actual commit, including onChanged. The session's getter accurately
			// reports the old persisted preference until this first write has completed.
			const held = holdSettingsWrites();
			await h.drive(() => {
				pending.push(h.session().setAutoMove(!initial));
			});
			expect(await h.until(() => held.length === 1, 1_000)).toBe(true);
			expect(h.settings().automation.autoMove).toBe(initial);
			expect(h.executor()?.isArmed()).toBe(!initial);
			await h.drive(() => {
				pending.push(h.session().setAutoMove(initial));
			});
			expect(h.settings().automation.autoMove).toBe(initial);
			expect(h.executor()?.isArmed()).toBe(initial);
			await h.drive(() => releaseWrite?.());
			await h.drive(() => Promise.all(pending));
			const stored = await h.sw.run(() => chromeLocalGet(LOCAL_KEYS.settings));
			const settled = {
				stored: stored?.automation?.autoMove,
				preference: h.settings().automation.autoMove,
				armed: h.executor()?.isArmed(),
			};
			await h.drive(() => h.site.startGame({ gameId: "after-pending-preference-write" }));
			await h.advance(100);
			expect({ ...settled, nextGameArmed: h.executor()?.isArmed() }).toEqual({
				stored: initial,
				preference: initial,
				armed: initial,
				nextGameArmed: initial,
			});
		});
	}

	it("an older generic settings write cannot rearm a new game while the latest off write waits", async () => {
		h = await createGameHarness({ settings: { automation: { autoMove: false } } });
		const held = holdSettingsWrites(2);
		await h.drive(() => {
			pending.push(queueSettingsWrite({ automation: { autoMove: true, highlightMoves: false } }));
		});
		expect(await h.until(() => held.length === 1, 1_000)).toBe(true);
		await h.drive(() => {
			pending.push(h.session().setAutoMove(false));
		});
		await h.drive(() => releaseWrite?.());
		expect(await h.until(() => held.length === 2, 1_000)).toBe(true);
		expect(h.settings().automation.autoMove).toBe(true);
		expect(h.executor()?.isArmed()).toBe(false);
		await h.drive(() => h.site.startGame({ gameId: "between-preference-commits" }));
		await h.advance(100);
		expect(h.executor()?.isArmed()).toBe(false);
		await h.drive(() => releaseWrite?.());
		await h.drive(() => Promise.all(pending));
		expect(h.settings().automation.autoMove).toBe(false);
		expect(h.settings().automation.highlightMoves).toBe(false);
	});

	it("unchanged commands emit no redundant settings writes", async () => {
		h = await createGameHarness({ settings: { automation: { autoMove: false } } });
		const storage = h.sim.chrome.storage.local as unknown as StoragePort;
		const set = storage.set.bind(storage);
		let writes = 0;
		const count = spyOn(storage, "set").mockImplementation((items, callback) => {
			if (LOCAL_KEYS.settings in items) writes++;
			set(items, callback);
		});
		restore = () => count.mockRestore();
		for (const [armed, expectedWrites] of [
			[false, 0],
			[true, 1],
			[true, 1],
			[false, 2],
			[false, 2],
		] as const) {
			await h.drive(() => h.session().setAutoMove(armed));
			expect(writes).toBe(expectedWrites);
			expect(h.executor()?.isArmed()).toBe(armed);
		}
	});

	it("a later external settings change still disarms after the local command settles", async () => {
		h = await createGameHarness({ settings: { automation: { autoMove: false } } });
		await h.drive(() => h.session().setAutoMove(true));
		expect(h.executor()?.isArmed()).toBe(true);
		await h.patch({ automation: { autoMove: false } });
		expect(h.executor()?.isArmed()).toBe(false);
		await h.drive(() => h.site.startGame({ gameId: "after-external-off" }));
		await h.advance(100);
		expect(h.executor()?.isArmed()).toBe(false);
	});

	for (const initial of [false, true]) {
		it(`a failed ${initial ? "off" : "on"} write rejects and keeps this and the next game disarmed until retry`, async () => {
			h = await createGameHarness({ settings: { automation: { autoMove: initial } } });
			expect(await h.until(() => h.executor()?.isArmed() === initial, 1_000)).toBe(true);
			const storage = h.sim.chrome.storage.local as unknown as StoragePort;
			const set = storage.set.bind(storage);
			const fail = spyOn(storage, "set").mockImplementation((items, callback) => {
				if (LOCAL_KEYS.settings in items) throw new Error("preference write failed");
				set(items, callback);
			});
			restore = () => fail.mockRestore();
			await h.drive(() =>
				expect(h.session().setAutoMove(!initial)).rejects.toThrow("preference write failed")
			);
			expect(h.executor()?.isArmed()).toBe(false);
			expect(h.settings().automation.autoMove).toBe(initial);
			await h.drive(() => h.site.startGame({ gameId: "after-preference-write-failure" }));
			await h.advance(100);
			expect(h.executor()?.isArmed()).toBe(false);
			restore();
			restore = undefined;
			await h.drive(() => h.session().setAutoMove(true));
			expect(h.executor()?.isArmed()).toBe(true);
			expect(h.settings().automation.autoMove).toBe(true);
		});
	}

	it("an older write failure cannot disarm a newer successful on command", async () => {
		h = await createGameHarness({ settings: { automation: { autoMove: false } } });
		const held = holdSettingsWrites();
		let oldError: unknown;
		await h.drive(() => {
			pending.push(
				h
					.session()
					.setAutoMove(true)
					.catch((error: unknown) => {
						oldError = error;
					})
			);
		});
		expect(await h.until(() => held.length === 1, 1_000)).toBe(true);
		await h.drive(() => {
			pending.push(h.session().setAutoMove(true));
		});
		await h.drive(() => {
			h.sim.storage.failNextWith("older preference failed");
			releaseWrite?.();
		});
		await h.drive(() => Promise.all(pending));
		expect(String(oldError)).toContain("older preference failed");
		expect(h.executor()?.isArmed()).toBe(true);
		expect(h.settings().automation.autoMove).toBe(true);
	});
});
