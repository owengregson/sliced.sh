// test/service/move-executor/verifier.test.ts — Step 4: `verifyMove` over the game port's `observeMove`.
import { describe, expect, it } from "bun:test";
import { CONTENT_LINK_ERRORS } from "@core/constants";
import type { ReplyFor, RequestInput } from "@service/content-link";
import { type VerifierLink, verifyMove } from "@service/move-executor/verifier";

function link(
	answer: (cmd: RequestInput<"observeMove">, timeoutMs: number) => Promise<ReplyFor<"observeMove">>
): VerifierLink & { calls: Array<RequestInput<"observeMove">> } {
	const calls: Array<RequestInput<"observeMove">> = [];
	return {
		calls,
		request: (_tabId, cmd, timeoutMs) => {
			calls.push(cmd);
			return answer(cmd, timeoutMs);
		},
	};
}

describe("verifyMove", () => {
	it("resolves ok when the adapter observed the move, and forwards the expected move + budget", async () => {
		const l = link(async (cmd, timeoutMs) => ({
			kind: "observeMoveResult",
			id: "x",
			ok: cmd.expected.from === "e2" && timeoutMs === 1200,
		}));
		const r = await verifyMove(l, 7, { from: "e2", to: "e4" }, 1200);
		expect(r).toEqual({ outcome: "ok" });
		expect(l.calls).toEqual([{ kind: "observeMove", expected: { from: "e2", to: "e4" } }]);
	});

	it("reports rejected (with the adapter's reason) when the piece snapped back", async () => {
		const l = link(async () => ({
			kind: "observeMoveResult",
			id: "x",
			ok: false,
			reason: "snapped back",
		}));
		expect(await verifyMove(l, 7, { from: "e2", to: "e4", promotion: "q" }, 400)).toEqual({
			outcome: "rejected",
			reason: "snapped back",
		});
		expect(l.calls[0]?.expected).toEqual({ from: "e2", to: "e4", promotion: "q" });
	});

	it("maps a link timeout to 'timeout' and any other failure to 'unavailable'", async () => {
		const slow = link(() => Promise.reject(new Error(CONTENT_LINK_ERRORS.timeout)));
		expect(await verifyMove(slow, 7, { from: "e2", to: "e4" }, 400)).toEqual({ outcome: "timeout" });
		const gone = link(() => Promise.reject(new Error(CONTENT_LINK_ERRORS.noPort)));
		expect(await verifyMove(gone, 7, { from: "e2", to: "e4" }, 400)).toEqual({
			outcome: "unavailable",
			reason: CONTENT_LINK_ERRORS.noPort,
		});
	});
});
