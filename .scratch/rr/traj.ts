// Realistic trajectory: 40 own moves, plies 0..78, in-book for ply<16, clock draining.
// Per-ply p50 / fast share, so the in-book plies are diluted by the middlegame exactly as in a real game.
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
const MIDDLEGAME_FEN = "r1bq1rk1/2p1bppp/p1np1n2/1p2p3/4P3/1BP2N1P/PP1P1PP1/RNBQR1K1 w - - 0 10";
const START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
const inference = createTimingInference({
  runtime: () => createOrtRuntime({ importModule: (u: string) => import(u), getUrl: (p: string) => pathToFileURL(path.join(ROOT, p)).href, threads: 1 }),
  store: { get: async (n: string) => new Uint8Array(await Bun.file(path.join(ROOT, MODELS_DIR, n)).arrayBuffer()) },
});
let qid = 0;
const infer = async (inputs: Record<string, unknown>) => {
  const r = await inference.handle({ kind: "timing", id: `q${qid++}`, inputs } as never);
  return r.probs ? { probs: r.probs as number[], band: (r as { band: string }).band } : null;
};
function line(m: number, cp: number, ...pv: string[]) { return { multipv: m, score: { cp }, depth: 10, pvUci: pv, pvSan: [] }; }
const HIST = ["e2e4","e7e5","g1f3","b8c6","f1b5","a7a6","b5a4","g8f6","e1g1","f8e7","f1e1","b7b5","a4b3","d7d6","c2c3","e8g8"];
function ctxFor(ply: number, baseSec: number, clockS: number, nowMs: number): TimingContext {
  const inBookPly = ply < 16;
  return { fen: inBookPly && ply < 4 ? START_FEN : MIDDLEGAME_FEN, ply, moves: HIST.slice(0, ply), myColor: "w",
    chosenMove: inBookPly ? "d2d4" : "a2a4",
    lines: [line(1,20,"d2d4","e5d4"), line(2,10,"a2a4","b5a4"), line(3,-5,"b1a3"), line(4,-30,"h3h4")],
    evalBeforeOppMove: 25, expectedOppReply: null, myClockMs: clockS*1000, oppClockMs: clockS*1000,
    baseSec, incSec: 0, oppThinkMsHistory: [3000,4000,2500], myThinkMsHistory: [],
    site: "chesscom", targetElo: 1650, profile: "balanced", engineReady: true,
    inputMethod: "drag", autoQueen: true, nowMs } as TimingContext;
}
const G = Number(process.env.G ?? 300);
const MOVES = 40;
function pct(xs: number[], q: number) { const s=[...xs].sort((a,b)=>a-b); return s[Math.min(s.length-1, Math.floor(q*s.length))] ?? 0; }
function gmean(xs: number[]) { let s=0; for (const x of xs) s+=Math.log(Math.max(1e-9,x)); return Math.exp(s/xs.length); }

for (const [speed, baseSec] of [["1+0",60],["3+0",180],["10+0",600]] as const) {
  const head = new ChessMimicHead({ infer: infer as never, fallback: new V1ParametricHead(), budgetMs: 600000 });
  const m = new TimingModel(head, DEFAULT_SETTINGS.timing, createRng(`tr-${speed}`));
  const meta: GameMeta = { targetElo: 1650, profile: "balanced", baseSec, incSec: 0, site: "chesscom", gameId: "g" };
  const byMove: { t: number[]; inst: number; prem: number; fast2: number }[] =
    Array.from({ length: MOVES }, () => ({ t: [], inst: 0, prem: 0, fast2: 0 }));
  for (let g = 0; g < G; g++) {
    m.startGame({ ...meta, gameId: `${speed}-g${g}` });
    for (let k = 0; k < MOVES; k++) {
      const ply = 2*k;
      const clockS = baseSec * (1 - 0.95*k/(MOVES-1));
      const c = ctxFor(ply, baseSec, clockS, 1_000_000 + g*1e6 + k*1000);
      await m.prepare(c);
      const plan = m.planMove(c);
      const b = byMove[k]!;
      b.t.push(plan.thinkMs);
      if (plan.mode === "instant") b.inst++; else if (plan.mode === "premove") b.prem++;
      if (plan.thinkMs < 2000) b.fast2++;
    }
  }
  console.log(`\n### ${speed} trajectory (G=${G} games, ${MOVES} own moves, clock drains to 5 %)`);
  console.log("k  ply clock_s  inst%  prem%  sub2s%    p50   gmean");
  for (let k = 0; k < MOVES; k++) {
    const b = byMove[k]!; const clockS = baseSec*(1-0.95*k/(MOVES-1));
    console.log(`${String(k).padStart(2)} ${String(2*k).padStart(3)} ${clockS.toFixed(1).padStart(7)} ${(100*b.inst/G).toFixed(1).padStart(6)} ${(100*b.prem/G).toFixed(1).padStart(6)} ${(100*b.fast2/G).toFixed(1).padStart(7)} ${pct(b.t,0.5).toFixed(0).padStart(6)} ${gmean(b.t).toFixed(0).padStart(7)}`);
  }
}
