// test/behavioral/game/engine-options.test.ts — Task 30 checklist item 10: a settings write that
// leaves `EngineController` with `pendingOptions` must not be starved by an in-flight ponder.
// The controller only applies a diff while the engine is idle, so without the stop the ponder
// holds the engine busy and the change never lands — a deadlock, not a delay.
import { afterEach, describe, expect, it } from "bun:test";
import { createGameHarness, type GameHarness } from "./harness";
import { isPonderSearch } from "./scripted-engine";

let h: GameHarness;
afterEach(async () => {
	await h?.dispose();
});

const optionLines = (name: string): string[] =>
	h.transport.sent.filter((l) => l.startsWith(`setoption name ${name} value`));

describe("game session: engine options vs a live ponder (checklist 10)", () => {
	it("a settings write while the session is pondering stops the search and the diff lands", async () => {
		h = await createGameHarness({
			timeControl: { baseMs: 600_000, incMs: 0 },
			settings: { automation: { autoMove: true } },
			script: { holdPonder: true },
		});
		// Play our move, then explicitly keep the long bounded opponent ponder in flight.
		await h.arrive();
		expect(await h.until(() => h.session().currentState() === "live:opponent-turn", 60_000)).toBe(
			true
		);
		await h.arrive();
		expect(await h.until(() => h.transport.goLines.some(isPonderSearch), 5_000)).toBe(true);
		expect(h.controller.status().state).toBe("searching");
		const hashesBefore = optionLines("Hash").length;

		// A settings write the engine must pick up. The registry stops every session's live ponder,
		// the engine goes idle, and the deferred diff applies.
		await h.patch({ engine: { hashMb: 128 } });
		expect(await h.until(() => h.controller.status().options?.Hash === 128, 5_000)).toBe(true);
		expect(optionLines("Hash").length).toBe(hashesBefore + 1);
		expect(h.controller.status().pendingOptions).toBe(false);
		expect(h.controller.status().state).toBe("idle");
		// The stop went out before the option, and the ponder is no longer live.
		const stopAt = h.transport.sent.lastIndexOf("stop");
		expect(stopAt).toBeGreaterThan(
			h.transport.sent.lastIndexOf(h.transport.sent.filter(isPonderSearch).at(-1) ?? "")
		);
		expect(stopAt).toBeLessThan(h.transport.sent.lastIndexOf("setoption name Hash value 128"));
	});

	it("stopSearches is a no-op when nothing is searching", async () => {
		h = await createGameHarness();
		const before = h.transport.sent.length;
		await h.sw.run(() => h.registry.stopSearches("test"));
		await h.advance(10);
		expect(h.transport.sent.length).toBe(before);
	});
});
