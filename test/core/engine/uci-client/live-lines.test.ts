// test/core/engine/uci-client/live-lines.test.ts
import { describe, expect, it } from "bun:test";
import { LiveLines } from "@core/engine/uci-client/live-lines";
import { parseInfo } from "@core/engine/uci-parser";

function info(line: string) {
	const parsed = parseInfo(line);
	if (!parsed) throw new Error(line);
	return parsed;
}

describe("LiveLines", () => {
	it("reports the line that completes an iteration and restarts on a deeper one", () => {
		const live = new LiveLines(2);
		expect(live.accept(info("info depth 1 multipv 1 score cp 10 pv e2e4"))).toBe("updated");
		expect(live.accept(info("info depth 1 multipv 2 score cp 5 pv d2d4"))).toBe("completed");
		expect(live.accept(info("info depth 1 multipv 2 score cp 6 pv d2d4"))).toBe("updated");
		expect(live.accept(info("info depth 2 multipv 1 score cp 12 pv e2e4"))).toBe("updated");
		expect(live.complete).toBe(false);
		expect(live.depth).toBe(2);
	});

	it("ignores older depths, PV-less lines, primary interim bounds and bounds over exact scores", () => {
		const live = new LiveLines(2);
		live.accept(info("info depth 3 multipv 2 score cp 5 pv d2d4"));
		expect(live.accept(info("info depth 2 multipv 1 score cp 10 pv e2e4"))).toBe("ignored");
		expect(live.accept(info("info depth 3 nodes 100"))).toBe("ignored");
		expect(live.accept(info("info depth 3 multipv 1 score cp 10 lowerbound pv e2e4"))).toBe(
			"ignored"
		);
		expect(live.accept(info("info depth 3 multipv 2 score cp 9 upperbound pv d2d4"))).toBe("ignored");
		expect(live.latest.get(2)?.score?.value).toBe(5);
	});

	it("never completes with nothing to expect", () => {
		const live = new LiveLines(0);
		live.accept(info("info depth 1 multipv 1 score cp 0 pv e2e4"));
		expect(live.complete).toBe(false);
	});
});
