// test/behavioral/game/scripted-engine.ts — Task 30 Step 2: the "fake offscreen answering with
// scripted UCI lines" the behavioural tests drive the real `UciEngine` / `EngineController` with.
// It watches `position` / `go` / `stop` on the wire and answers with real `info … multipv …` lines
// over the position's legal moves, so the selection layer and the timing features see a plausible
// search without an engine.
import { applyMoves, legalMoves } from "@core/chess/san";
import { FakeEngineTransport } from "../../fakes/engine-transport";

export interface ScriptOptions {
	depth?: number;
	/** cp of the best line; every next line loses `stepCp`. */
	bestCp?: number;
	stepCp?: number;
	/** Preferred move order for a position (fen without move counters → UCI moves first). */
	prefer?: Map<string, string[]>;
}

const POSITION_RE = /^position fen (\S+ \S+ \S+ \S+ \S+ \S+)(?: moves (.*))?$/;
const MULTIPV_RE = /^setoption name MultiPV value (\d+)$/;

/** `fen` without the halfmove/fullmove counters — the key `prefer` is looked up by. */
export function positionKey(fen: string): string {
	return fen.split(" ").slice(0, 4).join(" ");
}

export class ScriptedEngineTransport extends FakeEngineTransport {
	depth: number;
	bestCp: number;
	stepCp: number;
	readonly prefer: Map<string, string[]>;
	/** Every `go` line the client sent, in order. */
	readonly goLines: string[] = [];
	/** `position` lines, in order. */
	readonly positions: string[] = [];
	/** The engine answers only when `release()` is called (a search that hangs). */
	hold = false;
	private multiPv = 1;
	private fen: string | null = null;
	private pendingGo: string | null = null;
	private infinite = false;

	constructor(options: ScriptOptions = {}) {
		super();
		this.depth = options.depth ?? 14;
		this.bestCp = options.bestCp ?? 30;
		this.stepCp = options.stepCp ?? 25;
		this.prefer = options.prefer ?? new Map();
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
			this.goLines.push(line);
			this.infinite = line.includes("infinite");
			this.pendingGo = line;
			// An infinite search answers only on `stop` (Appendix E §4.2).
			if (!this.infinite && !this.hold) queueMicrotask(() => this.answer());
			return;
		}
		if (line === "stop" && this.pendingGo !== null) queueMicrotask(() => this.answer());
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
		this.pendingGo = null;
		this.infinite = false;
		const fen = this.fen;
		if (fen === null) {
			this.feed("bestmove (none)");
			return;
		}
		const moves = this.movesFor(fen).slice(0, Math.max(1, this.multiPv));
		if (moves.length === 0) {
			this.feed("bestmove (none)");
			return;
		}
		const lines = moves.map((uci, i) => {
			const cp = this.bestCp - i * this.stepCp;
			return (
				`info depth ${this.depth} seldepth ${this.depth + 2} multipv ${i + 1} ` +
				`score cp ${cp} nodes 100000 nps 1000000 time 100 pv ${uci}`
			);
		});
		this.feed(...lines, `bestmove ${moves[0]}`);
	}
}
