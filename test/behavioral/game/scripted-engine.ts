// test/behavioral/game/scripted-engine.ts — Task 30 Step 2: the "fake offscreen answering with
// scripted UCI lines" the behavioural tests drive the real `UciEngine` / `EngineController` with.
// It watches `position` / `go` / `stop` on the wire and answers with real `info … multipv …` lines
// over the position's legal moves, so the selection layer and the timing features see a plausible
// search without an engine.
import { applyMoves, legalMoves } from "@core/chess/san";
import { TIMINGS } from "@core/constants/timings";
import { FakeEngineTransport } from "../../fakes/engine-transport";

export interface ScriptOptions {
	depth?: number;
	/** Manually fed searches stop with bestmove only, preserving only previously reported evidence. */
	stopWithReportedEvidence?: boolean;
	/** Keep the explicitly long ponder request in flight until stop/release, for lifecycle tests. */
	holdPonder?: boolean;
	/** `2`: every line's PV carries the reply too — the preferred one, else the first legal (what a ponder's answer reads). */
	pvDepth?: 1 | 2;
	/** cp of the best line; every next line loses `stepCp`. */
	bestCp?: number;
	stepCp?: number;
	/** Preferred move order for a position (fen without move counters → UCI moves first). */
	prefer?: Map<string, string[]>;
	/**
	 * 2026-09-12: report `score mate N` on every position's best line instead of centipawns
	 * (UCI POV: negative = the side to move gets mated). Later lines get mated one move sooner
	 * each (or mate one move later each when positive), floored at ±1, so "every line is lost"
	 * holds the way a real search reports a forced mate. `mateFor` overrides it per position.
	 */
	mateIn?: number;
	mateFor?: Map<string, number>;
	/**
	 * With a negative `mateIn`: the best line keeps its centipawn score (the escape) and only the
	 * lower lines are mated — the coherent frame a real search reports when one move survives.
	 */
	escapeBest?: boolean;
}

const POSITION_RE = /^position fen (\S+ \S+ \S+ \S+ \S+ \S+)(?: moves (.*))?$/;
const MULTIPV_RE = /^setoption name MultiPV value (\d+)$/;
/** The `searchmoves` tail of a `go` line (the UCI client emits it last). */
const SEARCHMOVES_RE = /\bsearchmoves ((?:[a-h][1-8][a-h][1-8][qrbn]? ?)+)$/;

/** Session pondering has an explicit long wall-clock limit; short move searches do not. */
export function isPonderSearch(line: string): boolean {
	return (
		line.startsWith("go ") &&
		(line.includes("infinite") || Number(/\bmovetime (\d+)/.exec(line)?.[1]) === TIMINGS.ponderMaxMs)
	);
}

/** `fen` without the halfmove/fullmove counters — the key `prefer` is looked up by. */
export function positionKey(fen: string): string {
	return fen.split(" ").slice(0, 4).join(" ");
}

export class ScriptedEngineTransport extends FakeEngineTransport {
	depth: number;
	bestCp: number;
	stepCp: number;
	readonly prefer: Map<string, string[]>;
	mateIn: number | undefined;
	readonly mateFor: Map<string, number>;
	escapeBest: boolean;
	/** Every `go` line the client sent, in order. */
	readonly goLines: string[] = [];
	/** `position` lines, in order. */
	readonly positions: string[] = [];
	/** The engine answers only when `release()` is called (a search that hangs). */
	hold = false;
	private multiPv = 1;
	private fen: string | null = null;
	private pendingGo: string | null = null;
	private searchGeneration = 0;
	private reportedBestmove: string | null = null;
	private infinite = false;
	private readonly stopWithReportedEvidence: boolean;
	private readonly holdPonder: boolean;
	private readonly pvDepth: 1 | 2;

	constructor(options: ScriptOptions = {}) {
		super();
		this.depth = options.depth ?? 14;
		this.stopWithReportedEvidence = options.stopWithReportedEvidence ?? false;
		this.holdPonder = options.holdPonder ?? false;
		this.pvDepth = options.pvDepth ?? 1;
		this.bestCp = options.bestCp ?? 30;
		this.stepCp = options.stepCp ?? 25;
		this.prefer = options.prefer ?? new Map();
		this.mateIn = options.mateIn;
		this.mateFor = options.mateFor ?? new Map();
		this.escapeBest = options.escapeBest ?? false;
	}

	/** The `score …` clause of line `i` (0 = best) for `fen`. */
	private scoreFor(fen: string, i: number): string {
		const cp = this.bestCp - i * this.stepCp;
		const mate = this.mateFor.get(positionKey(fen)) ?? this.mateIn;
		if (mate === undefined || (this.escapeBest && i === 0)) return `cp ${cp}`;
		const n = mate < 0 ? -Math.max(1, -mate - i) : Math.max(1, mate) + i;
		return `mate ${n}`;
	}

	override send(line: string): void {
		super.send(line);
		const multipv = MULTIPV_RE.exec(line);
		if (multipv) {
			this.multiPv = Number(multipv[1]);
			return;
		}
		const position = POSITION_RE.exec(line);
		if (position) {
			this.positions.push(line);
			const base = position[1] ?? "";
			const moves = (position[2] ?? "").split(" ").filter((m) => m !== "");
			this.fen = moves.length > 0 ? applyMoves(base, moves) : base;
			return;
		}
		if (line.startsWith("go")) {
			const generation = ++this.searchGeneration;
			this.reportedBestmove = null;
			this.goLines.push(line);
			this.infinite = line.includes("infinite");
			this.pendingGo = line;
			// An infinite search answers only on `stop` (Appendix E §4.2).
			if (!this.infinite && !this.hold && !(this.holdPonder && isPonderSearch(line)))
				queueMicrotask(() => {
					if (generation === this.searchGeneration) this.answer();
				});
			return;
		}
		if (line === "stop" && this.pendingGo !== null) {
			const generation = this.searchGeneration;
			queueMicrotask(() => {
				if (generation !== this.searchGeneration || this.pendingGo === null) return;
				if (!this.stopWithReportedEvidence) this.answer();
				else {
					// A legal bestmove acknowledges stop; it is not a scored iteration. UciEngine
					// retains the complete frames already fed, including none before the first one.
					const best = this.reportedBestmove ?? (this.fen ? this.movesFor(this.fen)[0] : null);
					this.feed(`bestmove ${best ?? "(none)"}`);
				}
			});
		}
	}

	override feed(...lines: string[]): void {
		for (const line of lines) {
			if (this.pendingGo !== null) {
				if (line.startsWith("info ") && !/\bmultipv (?:[2-9]|\d{2,})\b/.test(line)) {
					const best = /\bpv ([a-h][1-8][a-h][1-8][qrbn]?)\b/.exec(line)?.[1];
					if (best) this.reportedBestmove = best;
				}
				if (line.startsWith("bestmove ")) {
					this.pendingGo = null;
					this.infinite = false;
				}
			}
			super.feed(line);
		}
	}

	/** Answer a search that was held (`hold = true`). */
	release(): void {
		if (this.pendingGo !== null) this.answer();
	}

	/** The moves the engine would report for `fen`, best first. */
	movesFor(fen: string): string[] {
		const legal = legalMoves(fen);
		const preferred = this.prefer.get(positionKey(fen)) ?? [];
		const head = preferred.filter((m) => legal.includes(m));
		return [...head, ...legal.filter((m) => !head.includes(m))];
	}

	private answer(): void {
		if (this.pendingGo === null) return;
		const go = this.pendingGo;
		const requestedDepth = Number(/\bdepth (\d+)/.exec(go)?.[1]);
		const depth = Number.isFinite(requestedDepth) ? Math.min(this.depth, requestedDepth) : this.depth;
		this.pendingGo = null;
		this.infinite = false;
		const fen = this.fen;
		if (fen === null) {
			this.feed("bestmove (none)");
			return;
		}
		// `go … searchmoves a b c` (H10's Maia-shaped search, the extra referee search): a real engine
		// reports only those roots, in its own order — the preferred order here, restricted.
		const restricted = SEARCHMOVES_RE.exec(go)?.[1]?.split(" ") ?? [];
		const roots =
			restricted.length > 0
				? this.movesFor(fen).filter((m) => restricted.includes(m))
				: this.movesFor(fen);
		const moves = roots.slice(0, Math.max(1, this.multiPv));
		if (moves.length === 0) {
			this.feed("bestmove (none)");
			return;
		}
		const lines = moves.map((uci, i) => {
			const after = this.pvDepth === 2 ? applyMoves(fen, [uci]) : null;
			const reply = after === null ? undefined : this.movesFor(after)[0];
			const pv = reply === undefined ? uci : `${uci} ${reply}`;
			return (
				`info depth ${depth} seldepth ${depth + 2} multipv ${i + 1} ` +
				`score ${this.scoreFor(fen, i)} nodes 100000 nps 1000000 time 100 pv ${pv}`
			);
		});
		this.feed(...lines, `bestmove ${moves[0]}`);
	}
}
