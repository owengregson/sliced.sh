// tools/hover/latency.test.ts — reply-latency measurement (anticipatory hover, 2026-09-24).
//
// This drives the whole service-worker game stack on the simulator (`createGameHarness`): the
// real session, timing model, executor and hand. It measures the time from the opponent's move
// reaching the board to the release of our answer. The answer is an obvious recapture after a
// 3 s opponent think, and each time control runs four variants:
//   - `model`: the production plan, premoves off
//   - `premove`: premoves on, with a dominant reply so §7.4 queues the recapture
//   - `floor`: every non-premove plan forced to a 1 ms instant think, so what is measured is the
//     hand's own physical floor from wherever it is
//   - `anticipated`: the plan the timing model makes once it is wired to `hoverSquare()`,
//     emulated by `anticipation-wiring.ts` as a zero-decision anticipated reply
//     (`anticipatedExecution`) whenever the hand is hovering over the recapturing piece
//
// It is skipped unless `HOVER_MEASURE=1`, because it plays many games:
//   HOVER_MEASURE=1 HOVER_OUT=<file.json> HOVER_N=60 bun test tools/hover/latency.test.ts
import { describe, expect, it, spyOn } from "bun:test";
import { writeFileSync } from "node:fs";
import { CDP } from "@core/constants/cdp";
import { TimingModel } from "@core/timing/timing-model";
import type { Square } from "@typedefs/game";
import type { TimingPlan } from "@typedefs/timing";
import { emulateAnticipatedPlanning } from "../../test/behavioral/game/anticipation-wiring";
import { createGameHarness, type GameHarness } from "../../test/behavioral/game/harness";
import { positionKey } from "../../test/behavioral/game/scripted-engine";

const ENABLED = process.env.HOVER_MEASURE === "1";
const N = Number(process.env.HOVER_N ?? 30);

/** White: Ke1, Nc3, b2. Black: Ke8, Bb4. We shuffle the king; they take on c3; we recapture. */
const FEN = "4k3/8/8/8/1b6/2N5/1P6/4K3 w - - 0 1";
const OUR_FIRST = "e1f1";
const REPLY = "b4c3";
const RECAPTURE = "b2c3";
const AFTER_REPLY = "4k3/8/8/8/8/2b5/1P6/5K2 w - - 0 2";

export type Variant = "model" | "premove" | "floor" | "anticipated";

export interface LatencySample {
	seed: number;
	tc: string;
	variant: Variant;
	elo: number;
	/** Opponent move on the board → our releasing mouseReleased (0: a queued premove fired). */
	latencyMs: number | null;
	mode: string | null;
	thinkMs: number | null;
	orientationMs: number | null;
	approachMs: number | null;
	anticipated: number | null;
	source: string | null;
	/** Opponent move on the board → the hand's first pointer event (its realised reaction). */
	firstMoveMs: number | null;
	/** `MoveExecutor.hoverSquare()` when the reply arrived. */
	hoverSquare: string | null;
	/** Where the hand was at arrival, in squares from the recapturing pawn's centre. */
	handSquaresFromPiece: number | null;
	uci: string | null;
}

function instantPlan(
	plan: TimingPlan,
	nowMs: number,
	parts: { orientationMs: number; approachMs: number; dragMs: number }
): TimingPlan {
	const thinkMs = parts.orientationMs + parts.approachMs;
	return {
		...plan,
		mode: "instant",
		thinkMs,
		deadlineMs: nowMs + thinkMs,
		orientationMs: parts.orientationMs,
		preMoveHoverMs: parts.orientationMs,
		dragDurationMs: parts.dragMs,
		window: {
			orientationMs: parts.orientationMs,
			scanMs: 0,
			previewMs: 0,
			decisionMs: 0,
			approachMs: parts.approachMs,
		},
	};
}

async function measureOne(
	seed: number,
	tc: { baseMs: number; incMs: number; name: string },
	elo: number,
	variant: Variant
): Promise<LatencySample> {
	let h: GameHarness | null = null;
	let hoverAtArrival: Square | null = null;
	const original = TimingModel.prototype.planMove;
	const restore =
		variant === "anticipated"
			? emulateAnticipatedPlanning(() => hoverAtArrival, `${seed}`)
			: variant === "floor"
				? (() => {
						const spy = spyOn(TimingModel.prototype, "planMove").mockImplementation(function (
							this: TimingModel,
							ctx
						) {
							const plan = original.call(this, ctx);
							return plan.mode === "premove"
								? plan
								: instantPlan(plan, ctx.nowMs, {
										orientationMs: 0,
										approachMs: 1,
										dragMs: plan.dragDurationMs,
									});
						});
						return () => spy.mockRestore();
					})()
				: null;
	const premove = variant === "premove";
	try {
		h = await createGameHarness({
			myColor: "w",
			fen: FEN,
			seed: `hover-${tc.name}-${seed}`,
			gameId: `hover-${seed}`,
			timeControl: { baseMs: tc.baseMs, incMs: tc.incMs },
			premoves: premove,
			settings: {
				automation: { autoMove: true },
				strength: { matchOpponentRating: false, targetElo: elo },
				timing: { premoveTendency: premove ? 1 : 0 },
				display: { virtualCursor: true },
			},
			script: {
				pvDepth: 2,
				// A dominant reply earns the §7.4 premove; close lines keep the reply reactive.
				...(premove ? { bestCp: 900, stepCp: 900 } : { bestCp: 40, stepCp: 15 }),
				prefer: new Map([
					[positionKey(FEN), [OUR_FIRST]],
					[positionKey("4k3/8/8/8/1b6/2N5/1P6/5K2 b - - 1 1"), [REPLY]],
					[positionKey(AFTER_REPLY), [RECAPTURE]],
				]),
			},
		});
		const g = h;
		const clocks = { w: tc.baseMs, b: tc.baseMs };
		await g.arrive(null, clocks);
		const events = () => g.sim.debugger.commandsFor(CDP.inputDispatchMouseEvent);
		await g.until(() => g.session().currentState() === "live:opponent-turn", 60_000);
		await g.arrive(null, clocks);
		await g.advance(3000);
		const last = events().at(-1)?.params ?? null;
		hoverAtArrival = g.executor()?.hoverSquare() ?? null;
		const arrivedAt = g.sim.now();
		await g.arrive(REPLY, clocks);
		const moved = () => g.site.board.fen().split(" ")[0] !== AFTER_REPLY.split(" ")[0];
		await g.until(moved, 20_000, 5);
		const released = events().filter((c) => c.params?.type === "mouseReleased" && c.at >= arrivedAt);
		const rec = g.session().recommendation();
		const plan = rec?.plan;
		let handSquares: number | null = null;
		if (last) {
			const r = g.site.board.squareRect("b2");
			handSquares =
				Math.hypot(Number(last.x) - (r.left + r.width / 2), Number(last.y) - (r.top + r.height / 2)) /
				r.width;
		}
		return {
			seed,
			tc: tc.name,
			variant,
			elo,
			latencyMs: moved() ? (released.at(-1)?.at ?? arrivedAt) - arrivedAt : null,
			mode: plan?.mode ?? null,
			thinkMs: plan?.thinkMs ?? null,
			orientationMs: plan?.window.orientationMs ?? null,
			approachMs: plan?.window.approachMs ?? null,
			anticipated: plan?.features.anticipated ?? null,
			source: rec?.chosen.source ?? null,
			firstMoveMs: (() => {
				const first = events().find((c) => c.at >= arrivedAt);
				return first ? first.at - arrivedAt : null;
			})(),
			hoverSquare: hoverAtArrival,
			handSquaresFromPiece: handSquares,
			uci: rec?.chosen.uci ?? null,
		};
	} finally {
		await h?.dispose();
		restore?.();
	}
}

const TCS = [
	{ name: "blitz3+0", baseMs: 180_000, incMs: 0 },
	{ name: "bullet1+0", baseMs: 60_000, incMs: 0 },
];
const VARIANTS: Variant[] = (process.env.HOVER_VARIANTS?.split(",") as Variant[] | undefined) ?? [
	"model",
	"premove",
	"floor",
	"anticipated",
];

describe.skipIf(!ENABLED)("reply latency (measurement)", () => {
	it("measures opponent-move-to-release latency of an obvious recapture", async () => {
		const out: LatencySample[] = [];
		for (const tc of TCS)
			for (const variant of VARIANTS)
				for (let seed = 0; seed < N; seed++) out.push(await measureOne(seed, tc, 2700, variant));
		if (process.env.HOVER_OUT) writeFileSync(process.env.HOVER_OUT, JSON.stringify(out, null, 1));
		expect(out.length).toBeGreaterThan(0);
	}, 3_600_000);
});
