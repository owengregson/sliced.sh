import path from "node:path";
import { pathToFileURL } from "node:url";
import { DEFAULT_SETTINGS } from "@core/constants/defaults";
import { MODELS_DIR } from "@core/constants/models";
import { createRng } from "@core/rng";
import { ChessMimicHead } from "@core/timing/chessmimic-head";
import { TimingModel } from "@core/timing/timing-model";
import type { GameMeta, TimingContext } from "@core/timing/types";
import { V1ParametricHead } from "@core/timing/v1-head";
import { createOrtRuntime } from "@offscreen/ort-loader";
import { createTimingInference } from "@offscreen/timing-inference";
const ROOT = path.resolve(import.meta.dir, "..");
const START = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
const inf = createTimingInference({ runtime: () => createOrtRuntime({ importModule: (u: string) => import(u), getUrl: (p: string) => pathToFileURL(path.join(ROOT, p)).href, threads: 1 }), store: { get: async (n: string) => new Uint8Array(await Bun.file(path.join(ROOT, MODELS_DIR, n)).arrayBuffer()) } });
let qid = 0;
const infer = async (i: Record<string, unknown>) => { const r = await inf.handle({ kind: "timing", id: `q${qid++}`, inputs: i } as never); return r.probs ? { probs: r.probs as number[], band: (r as { band: string }).band } : null; };
function line(m: number, cp: number, ...pv: string[]) { return { multipv: m, score: { cp }, depth: 10, pvUci: pv, pvSan: [] }; }
for (const [name, baseSec] of [["1+0", 60], ["3+0", 180], ["10+0", 600]] as const) {
	const head = new ChessMimicHead({ infer: infer as never, fallback: new V1ParametricHead(), budgetMs: 600000 });
	const m = new TimingModel(head, DEFAULT_SETTINGS.timing, createRng("p0"));
	const meta: GameMeta = { targetElo: 1650, profile: "balanced", baseSec, incSec: 0, site: "chesscom", gameId: "g" };
	const c = { fen: START, ply: 0, moves: [], myColor: "w", chosenMove: "e2e4",
		lines: [line(1,20,"e2e4","e7e5"), line(2,12,"d2d4"), line(3,5,"g1f3"), line(4,0,"c2c4")],
		evalBeforeOppMove: 25, expectedOppReply: null, myClockMs: baseSec*1000, oppClockMs: baseSec*1000,
		baseSec, incSec: 0, oppThinkMsHistory: [], myThinkMsHistory: [], site: "chesscom",
		targetElo: 1650, profile: "balanced", engineReady: true, inputMethod: "drag", autoQueen: true, nowMs: 1e6 } as TimingContext;
	const pre: number[] = []; const instant: number[] = []; let n = 0;
	for (let i = 0; i < 2000; i++) { if (i % 40 === 0) { m.startGame({ ...meta, gameId: `g${i}` }); await m.prepare(c); } const p = m.planMove(c); n++;
		if (p.mode === "premove") pre.push(p.thinkMs); if (p.mode === "instant") instant.push(p.thinkMs); }
	pre.sort((a,b)=>a-b); instant.sort((a,b)=>a-b);
	console.log(`${name} ply0: premove ${(100*pre.length/n).toFixed(1)}% thinkMs min ${pre[0]?.toFixed(0)} p50 ${pre[Math.floor(pre.length/2)]?.toFixed(0)} max ${pre[pre.length-1]?.toFixed(0)} | instant ${(100*instant.length/n).toFixed(1)}% p50 ${instant[Math.floor(instant.length/2)]?.toFixed(0)}`);
}
