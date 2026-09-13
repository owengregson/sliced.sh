import { describe, expect, it } from "bun:test";
import { createRng } from "@core/rng";
import { ChessMimicHead } from "@core/timing/chessmimic-head";
import { computeFeatures } from "@core/timing/features";
import { samplePersona } from "@core/timing/persona-latents";
import { freshState } from "@core/timing/timing-model";
import { V1ParametricHead } from "@core/timing/v1-head";
import { ctx } from "./helpers";

describe("learned conditional timing distribution", () => {
	for (const instantShare of [0.02, 0.2, 0.9]) {
		it(`retains a ${instantShare} instant conditional without a global floor or history quota`, async () => {
			const probs = Array<number>(30).fill(0);
			probs[0] = instantShare;
			probs[4] = 1 - instantShare;
			const c = ctx({ ply: 24, expectedOppReply: null, inBook: false });
			const f = computeFeatures(c);
			const p = samplePersona("conditional", "balanced", 2400);
			const st = freshState("conditional");
			st.fen = c.fen;
			st.plannedMs = Array<number>(100).fill(500);
			const h = new ChessMimicHead({
				infer: async () => ({ probs, band: "2200_3500" }),
				fallback: new V1ParametricHead(),
			});
			await h.prepare(c);
			const rng = createRng(`conditional-${instantShare}`);
			let fast = 0;
			for (let i = 0; i < 4000; i++) if (h.sample(f, p, st, rng, 3).mode === "instant") fast++;
			expect(fast / 4000).toBeGreaterThan(instantShare - 0.025);
			expect(fast / 4000).toBeLessThan(instantShare + 0.025);
		});
	}
	it("normalizes the exact masked mean rather than treating a heavy-tail median as a budget", async () => {
		const probs = Array<number>(30).fill(0);
		probs[1] = 0.7;
		probs[20] = 0.3;
		const c = ctx();
		const f = computeFeatures(c);
		const p = { s_game: 0, iota: 0, pi_p: 0, tau: 0.8, rho_mirror: 0, motor_k: 1 };
		const st = freshState("mean");
		st.knobs.sigmaScale = 0;
		st.fen = c.fen;
		const h = new ChessMimicHead({
			infer: async () => ({ probs, band: "2200_3500" }),
			fallback: new V1ParametricHead(),
		});
		await h.prepare(c);
		expect(h.median(f, p, st, 3)).toBeCloseTo(1.5);
		expect(h.mean(f, p, st, 3)).toBeCloseTo(1.5 * 0.7 + 20.5 * 0.3);
	});
});
