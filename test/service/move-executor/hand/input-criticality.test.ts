import { describe, expect, it } from "bun:test";
import { InputCriticality } from "@service/move-executor/hand/input-criticality";

describe("InputCriticality", () => {
	it("publishes only busy edges, whichever flag caused them", () => {
		const busy: boolean[] = [];
		const input = new InputCriticality(null, (b) => busy.push(b));
		input.setTravelling(true);
		input.setPressed(true);
		input.setTravelling(false);
		input.setPressed(false);
		input.commit();
		input.setPressed(true);
		input.setPressed(false);
		input.finish();
		expect(busy).toEqual([true, false, true, false]);
	});

	it("narrows the deadline for a pause, restores it after, and clears it on finish", () => {
		const deadlines: (number | null)[] = [];
		const input = new InputCriticality((at) => deadlines.push(at), null);
		input.setDeadline(1000);
		input.pauseUntil(800);
		input.resumeDeadline();
		input.pauseUntil(1200);
		input.finish();
		input.pauseUntil(500);
		expect(deadlines).toEqual([1000, 800, 1000, 1000, null, 500]);
	});
});
