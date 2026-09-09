/**
 * `PonderController` (§6.4, Appendix E §4.2). One `go infinite` at a time per
 * session:
 *
 *   - **opponent's turn** — `go infinite` MultiPV 3 on the opponent's position
 *     at `ponder` priority, capped at `TIMINGS.ponderMaxMs`. Its first line's
 *     first move is `expectedOppReply`, which feeds the timing model's
 *     `ponder_hit` feature and the §7.4 premove candidate.
 *   - **our turn, nothing armed** (§7.5 "panel-only mode") — `go infinite` at
 *     `panel` priority on our own position so the eval bar keeps deepening
 *     after the bounded move search has answered.
 *
 * `stop()` is idempotent and always awaits the `bestmove` before the caller
 * issues the next `position`/`go` (Appendix E §4.4 rule 3); the session calls
 * it before every own-move search and whenever the engine's options change
 * (Task 13's `pendingOptions` — a running ponder would otherwise hold the
 * engine busy and the change would never apply).
 */

import { SEARCH_BUDGET } from "@core/constants/search";
import { TIMINGS } from "@core/constants/timings";
import type { AnalysisHandle, AnalysisRequest, AnalysisResult } from "@core/engine/types";
import { log } from "@core/logger";
import { errorMessage } from "@core/util/errors";
import { newId } from "@core/util/ids";
import type { Scheduler } from "@core/util/scheduler";
import { defaultNow, defaultScheduler } from "@core/util/scheduler";

export type PonderKind = "opponent" | "panel";

export interface PonderEngine {
	analyse(req: AnalysisRequest): AnalysisHandle;
	engineElo(): number | undefined;
}

export interface PonderControllerDeps {
	engine: PonderEngine;
	scheduler?: Scheduler;
	now?: () => number;
	/** Cap on one `go infinite` (default `TIMINGS.ponderMaxMs`). */
	maxMs?: number;
	/** Called when a ponder produced a new expected reply. */
	onExpectedReply?: (uci: string | null) => void;
}

interface Running {
	kind: PonderKind;
	fen: string;
	handle: AnalysisHandle;
	timer: unknown;
	settled: Promise<void>;
}

export class PonderController {
	private readonly engine: PonderEngine;
	private readonly scheduler: Scheduler;
	private readonly now: () => number;
	private readonly maxMs: number;
	private readonly onExpectedReply: ((uci: string | null) => void) | undefined;
	private running: Running | null = null;
	private expected: string | null = null;
	private expectedFen: string | null = null;
	private lastResult: AnalysisResult | null = null;
	private disposed = false;

	constructor(deps: PonderControllerDeps) {
		this.engine = deps.engine;
		this.scheduler = deps.scheduler ?? defaultScheduler;
		this.now = deps.now ?? defaultNow;
		this.maxMs = deps.maxMs ?? TIMINGS.ponderMaxMs;
		this.onExpectedReply = deps.onExpectedReply;
	}

	/** `lines[0].pvUci[0]` of the last ponder on `fen`, or `null`. */
	expectedReply(fen?: string): string | null {
		if (fen !== undefined && this.expectedFen !== fen) return null;
		return this.expected;
	}

	/** The last finished ponder result (the panel's eval while the opponent thinks). */
	result(): AnalysisResult | null {
		return this.lastResult;
	}

	isRunning(): boolean {
		return this.running !== null;
	}

	runningFen(): string | null {
		return this.running?.fen ?? null;
	}

	/**
	 * Start (or keep) a `go infinite` on `fen`. A ponder already running on the
	 * same position and kind is left alone; anything else is stopped first.
	 */
	async start(kind: PonderKind, fen: string, moves: readonly string[] = []): Promise<void> {
		if (this.disposed) return;
		const current = this.running;
		if (current && current.kind === kind && current.fen === fen) return;
		await this.stop();
		if (this.disposed) return;
		const req: AnalysisRequest = {
			id: newId(),
			fen,
			multiPv: kind === "opponent" ? SEARCH_BUDGET.ponderMultiPv : SEARCH_BUDGET.panelMultiPv,
			limit: { infinite: true },
			priority: kind === "opponent" ? "ponder" : "panel",
		};
		if (moves.length > 0) req.moves = [...moves];
		const elo = this.engine.engineElo();
		if (elo !== undefined) req.elo = elo;
		let handle: AnalysisHandle;
		try {
			handle = this.engine.analyse(req);
		} catch (error) {
			log.debug("ponder: refused", { error: errorMessage(error) });
			return;
		}
		const timer = this.scheduler.setTimeout(() => {
			log.debug("ponder: cap reached", { fen, maxMs: this.maxMs });
			void handle.stop();
		}, this.maxMs);
		const settled = handle.result.then(
			(result) => this.settle(fen, result),
			(error: unknown) => {
				log.debug("ponder: failed", { error: errorMessage(error) });
			}
		);
		this.running = { kind, fen, handle, timer, settled };
		log.debug("ponder: started", { kind, fen, at: this.now() });
	}

	/** Stop the running ponder and await its `bestmove` (idempotent). */
	async stop(): Promise<void> {
		const current = this.running;
		if (!current) return;
		this.running = null;
		this.scheduler.clearTimeout(current.timer);
		try {
			await current.handle.stop();
		} catch (error) {
			log.debug("ponder: stop failed", { error: errorMessage(error) });
		}
		await current.settled;
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		void this.stop();
	}

	private settle(fen: string, result: AnalysisResult): void {
		this.lastResult = result;
		const reply = result.final.lines[0]?.pvUci[0] ?? result.bestmove ?? null;
		this.expected = reply;
		this.expectedFen = fen;
		this.onExpectedReply?.(reply);
	}
}
