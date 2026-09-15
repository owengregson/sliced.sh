import { describe, expect, it } from "bun:test";
import { applyMoves } from "@core/chess/san";
import { CHESS_START_FEN } from "@core/constants/chess";
import { DEFAULT_SETTINGS } from "@core/constants/defaults";
import { policyQueryIdentity } from "@core/policy/policy-query";
import type { PolicyInferenceInputs } from "@core/policy/types";
import { predictedPolicyInputs } from "@service/game-session/maia-session";
import { type OwnMoveBudgetInput, ownMoveMaiaElo } from "@service/game-session/recommendation";

const fen = applyMoves(CHESS_START_FEN, ["e2e4"]) as string;
const inputs: PolicyInferenceInputs = {
	fen,
	historyFens: [CHESS_START_FEN, fen],
	size: "79m",
	selfElo: 2800,
	oppoElo: 2900,
};
const query = {
	inputs,
	mode: "maia" as const,
	selectionMode: "hybrid" as const,
	history: { fen: CHESS_START_FEN, moves: ["e2e4"] },
};

describe("policy query identity", () => {
	it("keeps actual conditioning and identity stable across tiny clock drift, but changes for material inputs", () => {
		const position: OwnMoveBudgetInput = {
			fen,
			ply: 20,
			targetElo: 1500,
			form: 0,
			myClockMs: 120_000,
			oppClockMs: 150_000,
			timeControl: { baseMs: 180_000, incMs: 2000 },
			tau: 0.5,
			budgetUsedRatio: 1 / 3,
			maia: true,
		};
		const predicted = (patch: Partial<OwnMoveBudgetInput> = {}, opponentElo = 1500) => {
			const current = { ...position, ...patch };
			const answer = predictedPolicyInputs({
				fen,
				history: query.history,
				size: "79m",
				opponentElo,
				position: current,
				settings: DEFAULT_SETTINGS,
			});
			expect(answer).not.toBeNull();
			expect(answer!.inputs.selfElo).toBe(ownMoveMaiaElo(current, DEFAULT_SETTINGS).selfElo);
			expect(Number.isInteger(answer!.inputs.selfElo)).toBe(true);
			return answer!;
		};
		const original = predicted();
		for (const elapsedMs of [0, 1, 10]) {
			const delayed = predicted({ myClockMs: position.myClockMs - elapsedMs });
			expect(delayed.inputs).toEqual(original.inputs);
			expect(delayed.identity).toBe(original.identity);
		}
		for (const changed of [
			predicted({ myClockMs: 100_000 }),
			predicted({ targetElo: 1510 }),
			predicted({}, 1510),
		]) {
			expect(changed.inputs).not.toEqual(original.inputs);
			expect(changed.identity).not.toBe(original.identity);
		}
		// The identity does not silently alias different raw model inputs.
		expect(policyQueryIdentity({ ...query, inputs: { ...inputs, selfElo: 2800.1 } })).not.toBe(
			policyQueryIdentity({ ...query, inputs: { ...inputs, selfElo: 2800.2 } })
		);
	});
	it("distinguishes both ratings, mode, selection settings and every history frame", () => {
		const key = policyQueryIdentity(query);
		for (const changed of [
			{ ...query, inputs: { ...inputs, selfElo: 2801 } },
			{ ...query, inputs: { ...inputs, oppoElo: 2901 } },
			{ ...query, mode: "prior" as const },
			{ ...query, selectionMode: "persona-sampling" as const },
			{ ...query, inputs: { ...inputs, historyFens: [fen] } },
		])
			expect(policyQueryIdentity(changed)).not.toBe(key);
	});

	it("keeps full repetition history even when the model input frames match", () => {
		const moves = ["g1f3", "g8f6", "f3g1", "f6g8"];
		const repeated = applyMoves(CHESS_START_FEN, moves) as string;
		const q = { ...query, inputs: { ...inputs, fen: repeated, historyFens: [repeated] } };
		expect(policyQueryIdentity({ ...q, history: { fen: CHESS_START_FEN, moves } })).not.toBe(
			policyQueryIdentity({ ...q, history: { fen: repeated, moves: [] } })
		);
	});

	it("normalizes a non-usable en-passant spelling without losing history", () => {
		const pageFen = fen.replace(" - 0 1", " e3 0 1");
		expect(
			policyQueryIdentity({
				...query,
				inputs: { ...inputs, fen: pageFen, historyFens: [CHESS_START_FEN, pageFen] },
			})
		).toBe(policyQueryIdentity(query));
	});
});
