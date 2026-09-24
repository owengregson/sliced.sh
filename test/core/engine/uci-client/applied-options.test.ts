// test/core/engine/uci-client/applied-options.test.ts
import { describe, expect, it } from "bun:test";
import { AppliedOptions } from "@core/engine/uci-client/applied-options";

describe("AppliedOptions", () => {
	it("sends only changes and moves a changed option to the end of the replay order", () => {
		const sent: string[] = [];
		const opts = new AppliedOptions((line) => sent.push(line));
		opts.apply("Threads", 2);
		opts.apply("Hash", 64);
		opts.apply("Threads", 2);
		opts.apply("Threads", 4);
		expect(sent).toEqual([
			"setoption name Threads value 2",
			"setoption name Hash value 64",
			"setoption name Threads value 4",
		]);
		sent.length = 0;
		opts.replay();
		expect(sent).toEqual(["setoption name Hash value 64", "setoption name Threads value 4"]);
	});

	it("records without sending and keeps an existing option's place", () => {
		const sent: string[] = [];
		const opts = new AppliedOptions((line) => sent.push(line));
		opts.apply("Hash", 16);
		opts.apply("MultiPV", 2);
		opts.record({
			Threads: 1,
			Hash: 32,
			MultiPV: 4,
			UCI_ShowWDL: true,
			UCI_LimitStrength: false,
			UCI_Elo: 1500,
			Ponder: false,
		});
		expect(sent).toHaveLength(2);
		expect(opts.changes({ Hash: 32, MultiPV: 5 })).toEqual([["MultiPV", 5]]);
		sent.length = 0;
		opts.replay();
		expect(sent[0]).toBe("setoption name Hash value 32");
		expect(sent[1]).toBe("setoption name MultiPV value 4");
	});

	it("turns the limiter on for an Elo and off again only when it was on", () => {
		const sent: string[] = [];
		const opts = new AppliedOptions((line) => sent.push(line));
		opts.applyStrength(undefined);
		expect(sent).toEqual([]);
		opts.applyStrength(1600);
		opts.applyStrength(undefined);
		expect(sent).toEqual([
			"setoption name UCI_LimitStrength value true",
			"setoption name UCI_Elo value 1600",
			"setoption name UCI_LimitStrength value false",
		]);
	});
});
