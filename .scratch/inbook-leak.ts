// The cap's design exemption: §7.4-eligible positions (in_book, recapture, ponder hit, only move)
// bypass the cap entirely. How wide is that channel, and what does it let through in a 10+0 opening?
import path from "node:path";
import { pathToFileURL } from "node:url";
import { DEFAULT_SETTINGS } from "@core/constants/defaults";
import { MODELS_DIR } from "@core/constants/models";
import { createRng } from "@core/rng";
import { ChessMimicHead, instantShareCap } from "@core/timing/chessmimic-head";
import { computeFeatures } from "@core/timing/features";
import { TIMING_CONSTANTS } from "@core/timing/constants";
import { TimingModel } from "@core/timing/timing-model";
import type { GameMeta, TimingContext } from "@core/timing/types";
import { V1ParametricHead } from "@core/timing/v1-head";
import { createOrtRuntime } from "@offscreen/ort-loader";
import { createTimingInference } from "@offscreen/timing-inference";
const ROOT = path.resolve(import.meta.dir, "..");
console.log("features.bookMaxPly =", TIMING_CONSTANTS.features.bookMaxPly);
const inf = createTimingInference({ runtime: () => createOrtRuntime({ importModule: (u: string) => import(u), getUrl: (p: string) => pathToFileURL(path.join(ROOT, p)).href, threads: 1 }), store: { get: async (n: string) => new Uint8Array(await Bun.file(path.join(ROOT, MODELS_DIR, n)).arrayBuffer()) } });
let qid = 0;
const infer = async (i: Record<string, unknown>) => { const r = await inf.handle({ kind: "timing", id: `q${qid++}`, inputs: i } as never); return r.probs ? { probs: r.probs as number[], band: (r as { band: string }).band } : null; };
function line(m: number, cp: number, ...pv: string[]) { return { multipv: m, score: { cp }, depth: 10, pvUci: pv, pvSan: [] }; }
// after 1.e4 e5 2.Nf3 Nc6 3.Bb5 a6 4.Ba4 Nf6 5.0-0 Be7 6.Re1 b5 -> ply 12, white to move
const OPEN_FEN = "r1bqk2r/2ppbppp/p1n2n2/1p2p3/B3P3/5N2/PPPP1PPP/RNBQR1K1 w - - 0 7";
const HIST = ["e2e4","e7e5","g1f3","b8c6","f1b5","a7a6","b5a4","g8f6","e1g1","f8e7","f1e1","b7b5"];
const N = 2000;
for (const [baseSec, clockS] of [[600, 480], [600, 600], [180, 144], [60, 48]] as const)
	for (const ply of [8, 12, 16, 20] as const)
		for (const pick of ["top", "second"] as const) {
			const head = new ChessMimicHead({ infer: infer as never, fallback: new V1ParametricHead(), budgetMs: 600000 });
			const m = new TimingModel(head, DEFAULT_SETTINGS.timing, createRng(`ib-${baseSec}-${ply}-${pick}`));
			const meta: GameMeta = { targetElo: 1650, profile: "balanced", baseSec, incSec: 0, site: "chesscom", gameId: "g" };
			const c = { fen: OPEN_FEN, ply, moves: [...HIST], myColor: "w", chosenMove: pick === "top" ? "a4b3" : "d2d3",
				lines: [line(1,20,"a4b3","d7d6"), line(2,10,"d2d3","e8g8"), line(3,-5,"c2c3"), line(4,-30,"h2h3")],
				evalBeforeOppMove: 25, expectedOppReply: null, myClockMs: clockS*1000, oppClockMs: clockS*1000,
				baseSec, incSec: 0, oppThinkMsHistory: [3000,4000,2500], myThinkMsHistory: [], site: "chesscom",
				targetElo: 1650, profile: "balanced", engineReady: true, inputMethod: "drag", autoQueen: true, nowMs: 1e6 } as TimingContext;
			const f = computeFeatures(c);
			let fast = 0, sub2 = 0;
			for (let i = 0; i < N; i++) { if (i % 40 === 0) { m.startGame({ ...meta, gameId: `g${i}` }); await m.prepare(c); }
				const p = m.planMove(c); if (p.mode === "instant" || p.mode === "premove") fast++; if (p.thinkMs < 2000) sub2++; }
			console.log(`base ${baseSec}s clk ${clockS}s ply ${ply} ${pick.padEnd(6)} in_book=${f.in_book} elig=${f.premove_eligible} cap=${(100*instantShareCap(f,"1500_1600")).toFixed(1)}%  fast ${(100*fast/N).toFixed(1)}%  sub-2s ${(100*sub2/N).toFixed(1)}%`);
		}
