// Analytic/MC check of the ONE mechanism by which the lane can be SLOWER than 2c6b7d3 at the plan
// level: boundByCap lands a bound total in `cap · U(0.75, 1)`, so shrinking the input from just
// above the cap to just below it can RAISE the realised total. Both branches simulated in one
// process; only the factor differs (compressionFactor = pre-lane, paceFactor = post-lane).
import { createRng } from "@core/rng";
import { TIMING_CONSTANTS as C } from "@core/timing/constants";
import { computeFeatures } from "@core/timing/features";
import { boundByCap, compressionFactor, hardCapSec, urgencyFactor } from "@core/timing/pressure";
import type { TimingContext } from "@core/timing/types";

const MIDDLEGAME_FEN = "r1bq1rk1/2p1bppp/p1np1n2/1p2p3/4P3/1BP2N1P/PP1P1PP1/RNBQR1K1 w - - 0 10";
function line(m: number, cp: number, ...pv: string[]) { return { multipv: m, score: { cp }, depth: 10, pvUci: pv, pvSan: [] }; }
function ctxFor(baseSec: number, clockS: number, incSec = 0): TimingContext {
	return { fen: MIDDLEGAME_FEN, ply: 40, moves: [], myColor: "w", chosenMove: "d2d4",
		lines: [line(1,20,"d2d4","e5d4"), line(2,10,"a2a4","b5a4"), line(3,-5,"b1a3"), line(4,-30,"h3h4")],
		evalBeforeOppMove: 25, expectedOppReply: null, myClockMs: clockS*1000, oppClockMs: clockS*1000,
		baseSec, incSec, oppThinkMsHistory: [3000,4000,2500], myThinkMsHistory: [], site: "chesscom",
		targetElo: 1650, profile: "balanced", engineReady: true, inputMethod: "drag", autoQueen: true, nowMs: 1e6 } as TimingContext;
}
const FLOOR = Math.max(C.minNormalMs / 1000, 0.6);
const N = 60000;
const rng = createRng("cj");
function run(medianS: number, sigma: number, baseSec: number, clockS: number, incSec: number) {
	const f = computeFeatures(ctxFor(baseSec, clockS, incSec));
	const comp = compressionFactor(f);
	const pace = Math.min(comp, urgencyFactor(f));
	const cap = hardCapSec(f);
	const emerg = clockS * 1000 < C.replan.emergencyClockMs;
	let sumPre = 0, sumPost = 0; const pre: number[] = [], post: number[] = [];
	for (let i = 0; i < N; i++) {
		const raw = medianS * Math.exp(sigma * rng.normal());
		const physical = 0.45 + 0.5 * rng.next();
		const a = boundByCap(Math.max(raw * comp, physical), cap, FLOOR, emerg, rng).totalSec;
		const b = boundByCap(Math.max(raw * pace, physical), cap, FLOOR, emerg, rng).totalSec;
		sumPre += a; sumPost += b; pre.push(a); post.push(b);
	}
	pre.sort((x,y)=>x-y); post.sort((x,y)=>x-y);
	return { comp, pace, cap, meanPre: sumPre/N, meanPost: sumPost/N, p50Pre: pre[N>>1] ?? 0, p50Post: post[N>>1] ?? 0 };
}
const worst: Array<[string, number, number]> = [];
for (const [name, baseSec, medianS, incSec] of [["1+0",60,2,0],["3+0",180,4,0],["10+0",600,8,0],["3+2",180,4,2],["5+3",300,5,3]] as const)
	for (let i = 1; i <= 120; i++) {
		const clockS = (baseSec * i) / 120;
		for (const m of [medianS, medianS * 2, medianS / 2]) {
			const r = run(m, 0.95, baseSec, clockS, incSec);
			const rm = r.meanPost / r.meanPre, rp = r.p50Post / Math.max(1e-9, r.p50Pre);
			if (rm > 1.001 || rp > 1.001)
				worst.push([`${name} clk=${clockS.toFixed(2)}s m=${m}s comp=${r.comp.toFixed(3)} pace=${r.pace.toFixed(3)} cap=${r.cap.toFixed(2)}s  mean ${(1000*r.meanPre).toFixed(0)}->${(1000*r.meanPost).toFixed(0)} (${rm.toFixed(3)}x)  p50 ${(1000*r.p50Pre).toFixed(0)}->${(1000*r.p50Post).toFixed(0)} (${rp.toFixed(3)}x)`, rm, rp]);
		}
	}
worst.sort((a,b)=>Math.max(b[1],b[2])-Math.max(a[1],a[2]));
console.log(`cells where the post-lane distribution is SLOWER: ${worst.length} of ${5*120*3}`);
for (const w of worst.slice(0, 18)) console.log("  " + w[0]);
