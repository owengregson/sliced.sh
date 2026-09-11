import { describe, expect, it } from "bun:test";
import { PremoveAttemptLimit } from "@service/game-session/premove-attempts";

const ignored = { completedBeforeReply: true, predicted: false, landed: false };

describe("PremoveAttemptLimit", () => {
	it("allows two consecutive ignored queue entries and blocks the third exact move", () => {
		const limit = new PremoveAttemptLimit();
		expect(limit.canQueue("b2c3")).toBe(true);
		limit.observe("b2c3", ignored);
		expect(limit.canQueue("b2c3")).toBe(true);
		limit.observe("b2c3", ignored);
		expect(limit.canQueue("b2c3")).toBe(false);
		expect(limit.canQueue("d2c3")).toBe(true);
		expect(limit.canQueue("b2a3")).toBe(true);
	});

	it("does not count unentered plans or an opponent move that interrupts the drag", () => {
		const limit = new PremoveAttemptLimit();
		limit.observe("b2c3", ignored);
		for (let i = 0; i < 10; i++) limit.observe("b2c3", { ...ignored, completedBeforeReply: false });
		expect(limit.canQueue("b2c3")).toBe(true);
		limit.observe("b2c3", ignored);
		expect(limit.canQueue("b2c3")).toBe(false);
	});

	it.each([
		{ ...ignored, predicted: true },
		{ ...ignored, landed: true },
		{ ...ignored, completedBeforeReply: false, landed: true },
	])("clears the streak when the prediction held or the move landed: %j", (outcome) => {
		const limit = new PremoveAttemptLimit();
		limit.observe("b2c3", ignored);
		limit.observe("b2c3", outcome);
		limit.observe("b2c3", ignored);
		expect(limit.canQueue("b2c3")).toBe(true);
	});

	it("only a different completed premove starts another sequence", () => {
		const limit = new PremoveAttemptLimit();
		limit.observe("b2c3", ignored);
		limit.observe("b2c3", ignored);
		limit.observe("d2c3", { ...ignored, completedBeforeReply: false });
		expect(limit.canQueue("b2c3")).toBe(false);
		limit.observe("d2c3", ignored);
		expect(limit.canQueue("b2c3")).toBe(true);
		expect(limit.canQueue("d2c3")).toBe(true);
		limit.observe("d2c3", ignored);
		expect(limit.canQueue("d2c3")).toBe(false);
	});

	it("distinguishes promotions and forgets the preceding game's streak", () => {
		const limit = new PremoveAttemptLimit();
		limit.observe("a7b8q", ignored);
		limit.observe("a7b8q", ignored);
		expect(limit.canQueue("a7b8q")).toBe(false);
		expect(limit.canQueue("a7b8n")).toBe(true);
		limit.reset();
		expect(limit.canQueue("a7b8q")).toBe(true);
	});
});
