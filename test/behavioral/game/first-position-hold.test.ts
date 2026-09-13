// test/behavioral/game/first-position-hold.test.ts — the board mark must not jump (owner, 2026-09-11).
//
// Two mechanisms, both on the game's first position: the session waits for the site's time
// control before deciding anything (§4.3 delivers it on a republish of the unmoved position, and a
// move decided before it was decided *again* on a different budget), and a same-board re-run
// leaves the mark on the board instead of clearing and redrawing it.
import { afterEach, describe, expect, it } from "bun:test";
import type { GamePortCommand } from "@core/constants/messages";
import { TIMINGS } from "@core/constants/timings";
import { createGameHarness, type GameHarness } from "./harness";
import { isPonderSearch } from "./scripted-engine";

let h: GameHarness;
afterEach(async () => {
	await h?.dispose();
});

const BULLET = { baseMs: 60_000, incMs: 0 };
const ownSearches = (): number =>
	h.transport.goLines.filter((line) => !isPonderSearch(line)).length;

describe("game session: the first position waits for the time control", () => {
	it("decides nothing until the site answers, then once, on the real budget", async () => {
		h = await createGameHarness({
			timeControl: null,
			settings: { automation: { autoMove: false }, timing: { profile: "natural" } },
		});
		await h.arrive(null, { w: BULLET.baseMs, b: BULLET.baseMs });
		await h.advance(TIMINGS.timeControlGraceMs / 2);
		expect(h.session().recommendation()).toBeNull();
		expect(ownSearches()).toBe(0);
		h.site.setTimeControl(BULLET);
		await h.arrive(null, { w: BULLET.baseMs, b: BULLET.baseMs });
		expect(await h.until(() => h.session().recommendation() !== null, 10_000)).toBe(true);
		expect(h.session().recommendation()?.plan.features?.tc_bullet).toBe(1);
		await h.advance(TIMINGS.timeControlGraceMs * 2);
		expect(ownSearches()).toBe(1);
	});

	it("gives up waiting after the grace and decides untimed on a page that never answers", async () => {
		h = await createGameHarness({
			timeControl: null,
			settings: { automation: { autoMove: false }, timing: { profile: "natural" } },
		});
		await h.arrive(null, { w: BULLET.baseMs, b: BULLET.baseMs });
		await h.advance(TIMINGS.timeControlGraceMs + 1);
		expect(await h.until(() => h.session().recommendation() !== null, 10_000)).toBe(true);
		expect(h.session().recommendation()?.plan.features?.tc_untimed).toBe(1);
		expect(ownSearches()).toBe(1);
	});

	it("a same-board re-run leaves the mark on the board rather than clearing and redrawing it", async () => {
		const commands: GamePortCommand["kind"][] = [];
		h = await createGameHarness({
			timeControl: null,
			settings: { automation: { autoMove: false }, timing: { profile: "natural" } },
			onCommand: (cmd) => {
				if (cmd.kind === "highlight" || cmd.kind === "clearHighlight") commands.push(cmd.kind);
			},
		});
		await h.arrive(null, { w: BULLET.baseMs, b: BULLET.baseMs });
		await h.advance(TIMINGS.timeControlGraceMs + 1);
		expect(await h.until(() => h.session().recommendation() !== null, 10_000)).toBe(true);
		expect(await h.until(() => commands.includes("highlight"), 5_000)).toBe(true);
		const marked = commands.length;
		// The control arrives late, on the unmoved position: the pipeline runs again for this board.
		h.site.setTimeControl(BULLET);
		await h.arrive(null, { w: BULLET.baseMs, b: BULLET.baseMs });
		expect(
			await h.until(() => h.session().recommendation()?.plan.features?.tc_bullet === 1, 10_000)
		).toBe(true);
		// (The re-run may be served from the analysis cache; what matters is the mark.)
		expect(commands.slice(marked)).not.toContain("clearHighlight");
	});
});
