import { afterEach, expect, it, spyOn } from "bun:test";
import type { SiteAdapter } from "@content/adapters/adapter";
import { createChesscomAdapter } from "@content/adapters/chesscom";
import { CDP } from "@core/constants/cdp";
import { AbortedError } from "@core/util/scheduler";
import type { ContentLink, ReplyFor, RequestInput } from "@service/content-link";
import type { ExecutionReport } from "@service/move-executor";
import { FakeBridge, pageDocument, pageWindow } from "../../content/adapters/helpers";
import { createGameHarness, type GameHarness } from "./harness";

let h: GameHarness;
let adapter: SiteAdapter | undefined;
let restore: (() => void) | undefined;
afterEach(async () => {
	restore?.();
	adapter?.destroy();
	await h?.dispose();
});

it("the actual canvas adapter verifies the completed move on a fresh check after position delivery cancels its first reply", async () => {
	h = await createGameHarness({
		settings: {
			automation: { autoMove: true },
			execution: { verifyMoves: true, previewSelects: "off" },
		},
	});
	const dom = h.sim.getTabDom(h.tabId)!;
	dom.query("#board").classList.add("board");
	const bridge = new FakeBridge();
	bridge.responses.set("getState", () => ({
		fen: h.site.board.fen(),
		mode: "playing",
		playingAs: 1,
	}));
	adapter = createChesscomAdapter({ document: pageDocument(dom), window: pageWindow(dom), bridge });
	const actualAdapter = adapter;
	const request = h.link.request.bind(h.link);
	let checks = 0;
	let interrupted = 0;
	const seenBefore: Array<string | undefined> = [];
	// Only the reply producer is replaced: production verifyMove, cancellation and retry policy
	// still run, and the result is computed by the real adapter against the same live board.
	const mocked = spyOn(h.link, "request").mockImplementation(((tabId, cmd, timeoutMs, signal) => {
		if (cmd.kind !== "observeMove") return request(tabId, cmd, timeoutMs, signal);
		const observe = cmd as unknown as RequestInput<"observeMove">;
		const first = ++checks === 1;
		seenBefore.push(observe.expected.beforeFen);
		return new Promise<ReplyFor<"observeMove">>((resolve, reject) => {
			const abort = () => {
				interrupted += 1;
				reject(new AbortedError());
			};
			signal?.addEventListener("abort", abort, { once: true });
			if (first) h.site.arrive(null, { w: 179_000, b: 180_000 });
			void actualAdapter.observeMove(observe.expected, timeoutMs).then((ok) => {
				signal?.removeEventListener("abort", abort);
				resolve({ kind: "observeMoveResult", id: `real-${checks}`, ok });
			});
		});
	}) as ContentLink["request"]);
	restore = () => mocked.mockRestore();
	const executed: ExecutionReport[] = [];
	const failed: ExecutionReport[] = [];
	h.executor()!.on("executed", (r) => executed.push(r));
	h.executor()!.on("failed", (r) => failed.push(r));
	await h.arrive();
	expect(await h.until(() => executed.length + failed.length > 0, 30_000)).toBe(true);
	expect(interrupted).toBe(1);
	expect(checks).toBe(2);
	expect(failed).toHaveLength(0);
	expect(executed).toHaveLength(1);
	expect(seenBefore).toEqual([executed[0]!.rec.fen, executed[0]!.rec.fen]);
	expect(h.site.board.lastMove()?.uci).toBe(executed[0]!.rec.chosen.uci);
	await h.advance(100);
	expect((await h.snapshot()).stats.moves).toBe(1);
	expect(
		h.sim.debugger.commands.filter(
			(c) => c.method === CDP.inputDispatchMouseEvent && c.params?.type === "mousePressed"
		)
	).toHaveLength(1);
});
