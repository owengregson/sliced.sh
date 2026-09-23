/**
 * One queued or running analysis: owns its handle, accumulates the engine's `info` lines into
 * the live view and the coherent frames, and settles the result on `bestmove`.
 */

import { applyMoves, legalMoves } from "@core/chess/san";
import type {
	AnalysisHandle,
	AnalysisPriority,
	AnalysisRequest,
	AnalysisResult,
	AnalysisStatus,
	AnalysisUpdate,
} from "../types";
import type { Bestmove, Info } from "../uci-parser";
import { UpdateCoalescer } from "./coalescer";
import { FEATURE_DEPTH, FrameCapture } from "./frame-capture";
import { LiveLines } from "./live-lines";
import { Mailbox } from "./mailbox";
import type { UciScheduler } from "./scheduler";
import { SearchMetrics, UpdateBuilder } from "./update-builder";

export const PRIORITY_RANK: Readonly<Record<AnalysisPriority, number>> = {
	move: 0,
	ponder: 1,
	panel: 2,
};

export interface PendingContext {
	sched: UciScheduler;
	coalesceMs: number;
	stop(p: PendingSearch): Promise<void>;
}

/** The legal root moves of the searched position, narrowed to `searchmoves` when given. */
function legalRootsOf(positionFen: string | null, searchmoves: string[] | undefined): Set<string> {
	const restricted = searchmoves?.length ? new Set(searchmoves) : undefined;
	return new Set(
		(positionFen === null ? [] : legalMoves(positionFen)).filter(
			(move) => restricted === undefined || restricted.has(move)
		)
	);
}

export class PendingSearch {
	readonly priority: AnalysisPriority;
	readonly rank: number;
	status: AnalysisStatus = "complete";
	finished = false;
	deadline: unknown;
	readonly result: Promise<AnalysisResult>;
	readonly done: Promise<void>;
	private resolveResult: (r: AnalysisResult) => void = () => {};
	private readonly mailbox = new Mailbox<AnalysisUpdate>();
	private readonly metrics = new SearchMetrics();
	private readonly live: LiveLines;
	private readonly frames: FrameCapture;
	private readonly updates: UpdateBuilder;
	private readonly coalescer: UpdateCoalescer<AnalysisUpdate>;

	constructor(
		readonly req: AnalysisRequest,
		private readonly ctx: PendingContext
	) {
		this.priority = req.priority ?? "move";
		this.rank = PRIORITY_RANK[this.priority];
		const positionFen = req.moves?.length ? applyMoves(req.fen, req.moves) : req.fen;
		const legalRoots = legalRootsOf(positionFen, req.searchmoves);
		const expectedMultiPv = Math.min(req.multiPv, legalRoots.size);
		this.updates = new UpdateBuilder(req.id, positionFen, this.metrics);
		this.live = new LiveLines(expectedMultiPv);
		this.frames = new FrameCapture(
			legalRoots,
			expectedMultiPv,
			req.featureDepth ?? FEATURE_DEPTH,
			(entries, depth, complete) =>
				this.updates.build(entries, depth, complete, this.live.last?.seldepth)
		);
		this.coalescer = new UpdateCoalescer(ctx.sched, ctx.coalesceMs, this.mailbox, () =>
			this.liveUpdate()
		);
		this.result = new Promise((resolve) => {
			this.resolveResult = resolve;
		});
		this.done = this.result.then(() => undefined);
	}

	handle(): AnalysisHandle {
		return {
			id: this.req.id,
			updates: this.mailbox,
			result: this.result,
			stop: () => this.ctx.stop(this),
		};
	}

	push(info: Info): void {
		if (this.finished) return;
		this.metrics.absorb(info);
		this.frames.capture(info);
		const change = this.live.accept(info);
		if (change === "completed") this.coalescer.emit();
		else if (change === "updated") this.coalescer.schedule();
	}

	clearDeadline(): void {
		if (this.deadline === undefined) return;
		this.ctx.sched.clearTimeout(this.deadline);
		this.deadline = undefined;
	}

	/** The live view as one update (may mix depths across multipv slots). */
	private liveUpdate(): AnalysisUpdate {
		const live = this.live;
		return this.updates.build(
			live.latest,
			live.depth,
			live.latest.size > 0 && live.complete,
			live.last?.seldepth
		);
	}

	finish(bm: Bestmove): void {
		if (this.finished) return;
		this.finished = true;
		this.coalescer.cancel();
		this.clearDeadline();
		// Live updates may mix depths. A recommendation instead gets the last coherent cycle;
		// if none completed, retain its best usable partial and explicitly mark it incomplete.
		const final = {
			...(this.frames.completed ??
				this.frames.partial ??
				this.updates.build(new Map(), 0, false, this.live.last?.seldepth)),
			...this.metrics.totals,
		};
		const result: AnalysisResult = {
			id: this.req.id,
			bestmove: bm.bestmove,
			final,
			status: this.status,
			request: this.req,
		};
		if (bm.ponder !== undefined) result.ponder = bm.ponder;
		if (this.req.elo !== undefined) result.engineElo = this.req.elo;
		if (this.frames.atFeatureDepth) result.atFeatureDepth = this.frames.atFeatureDepth;
		this.mailbox.put(final);
		this.mailbox.close();
		this.resolveResult(result);
	}

	fail(): void {
		this.status = "failed";
		this.finish({ bestmove: null });
	}
}
