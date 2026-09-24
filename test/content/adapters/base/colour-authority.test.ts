import { describe, expect, it } from "bun:test";
import { ColourAuthority } from "@content/adapters/base/colour-authority";
import { LIMITS } from "@core/constants/limits";

const authority = (): ColourAuthority => new ColourAuthority(() => "chesscom");

describe("ColourAuthority", () => {
	it("states any colour while none has been delivered", () => {
		const c = authority();
		expect(c.stated("b", () => null)).toBe("b");
		expect(c.stated(null, () => null)).toBeNull();
	});

	it("lets only the site's own answer overturn a delivered colour", () => {
		const c = authority();
		c.deliver("w");
		expect(c.stated("b", () => null)).toBe("w"); // a render flip keeps what was told
		expect(c.stated(null, () => null)).toBe("w"); // losing sight of the clocks is no evidence
		expect(c.stated("b", () => "b")).toBe("b");
	});

	it("reports a colour learned from nothing only on the game already followed", () => {
		const c = authority();
		expect(c.triggers("w", false)).toEqual({ changed: false, withdrawn: false, learned: true });
		expect(c.triggers("w", true)).toEqual({ changed: false, withdrawn: false, learned: false });
	});

	it("withholds the colour once the per-game corrections are spent, and a new game resets it", () => {
		const c = authority();
		c.deliver("w");
		for (let i = 0; i < LIMITS.colourCorrectionsPerGame; i += 1) {
			const next = i % 2 === 0 ? "b" : "w";
			c.enforceCap(next);
			expect(c.triggers(next, false).changed).toBe(true);
			c.deliver(next);
		}
		const told = c.delivered;
		const other = told === "w" ? "b" : "w";
		c.enforceCap(other);
		expect(c.publishable({ myColor: other }).myColor).toBeNull();
		expect(c.stated(other, () => other)).toBeNull();
		expect(c.triggers(null, false).withdrawn).toBe(true);
		c.deliver(null);
		expect(c.triggers(null, false).withdrawn).toBe(false);
		c.newGame();
		expect(c.stated("b", () => null)).toBe("b");
	});
});
