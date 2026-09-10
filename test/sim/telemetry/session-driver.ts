// test/sim/telemetry/session-driver.ts
/**
 * Task 33 ruling 6 / Task 30: the `MoveDriver` that runs the conformance harness **through the
 * `GameSession` orchestrator** instead of poking the executor directly. The page half, the `ac`
 * shadow and every `assertHumanShapedAc` assertion stay exactly as they are.
 *
 * The seam is `GameSessionDeps.createPipeline`: the harness has already produced the
 * recommendation and the `TimingPlan` for the move (its own `TimingModel` over the scripted
 * position), so the driver hands those back as the §3.2 pipeline's answer and lets the session do
 * everything downstream for real — the state machine, the move window, arming and scheduling on
 * the executor, the §8.6 timing-log row and its §13.2 `MoveTelemetryRecord`, and the session
 * stats. What the harness measures (what the *page* saw) is therefore produced by the orchestrator
 * end to end.
 */

import { phase as phaseOf } from "@core/chess/phase";
import { DEFAULT_SETTINGS } from "@core/constants/defaults";
import { createRng } from "@core/rng";
import { createSelectionState, selectMove } from "@core/strength/move-selector";
import type { SelectionState } from "@core/strength/types";
import { buildTimingLogEntry, TimingLogWriter } from "@core/timing/timing-log";
import type { TimingModel } from "@core/timing/timing-model";
import { V1ParametricHead } from "@core/timing/v1-head";
import { defaultScheduler } from "@core/util/scheduler";
import { AutoQueue } from "@service/auto-queue";
import type { GameSessionDeps } from "@service/game-session";
import { GameSession } from "@service/game-session";
import type { RecommendationOutcome } from "@service/game-session/recommendation";
import type { SessionPipeline } from "@service/game-session/session";
import type { ExecutionReport, MoveContext } from "@service/move-executor";
import type { Simulator } from "@test/sim";
import { SIM_TELEMETRY } from "@test/sim/telemetry/constants";
import type { MoveDriver, TelemetrySw } from "@test/sim/telemetry/harness";
import type { GameMeta, PositionSnapshot, Recommendation, Site } from "@typedefs/game";
import type { Settings } from "@typedefs/settings";
import type { TimingLogEntry, TimingPlan } from "@typedefs/timing";

export interface SessionDriverOptions {
	site?: Site;
	gameId?: string;
	settings?: Settings;
	timeControl?: { baseMs: number; incMs: number };
	/** §7.2 target the selection layer runs at (default `SIM_TELEMETRY.game.targetElo`). */
	targetElo?: number;
}

export interface SessionDriver extends MoveDriver {
	/** The orchestrator the moves went through (`null` before the first move). */
	session(): GameSession | null;
	/** The §8.6 rows the session wrote, `telemetry` included. */
	entries(): readonly TimingLogEntry[];
	dispose(): void;
}

/** The `MoveDriver` that routes every move through a real `GameSession`. */
export function createSessionDriver(options: SessionDriverOptions = {}): SessionDriver {
	const site: Site = options.site ?? "chesscom";
	const gameId = options.gameId ?? "conformance-game";
	// §4.4: the orchestrator gates every acting path on `Settings.enabled`, so the conformance game
	// says it outright — a user with the assistant on, which is what the harness measures — rather
	// than inheriting whatever `DEFAULT_SETTINGS` currently says.
	const settings = options.settings ?? { ...DEFAULT_SETTINGS, enabled: true };
	const timeControl = options.timeControl ?? {
		baseMs: SIM_TELEMETRY.game.baseSec * 1000,
		incMs: SIM_TELEMETRY.game.incSec * 1000,
	};
	const timingLog = new TimingLogWriter();
	let session: GameSession | null = null;
	let autoQueue: AutoQueue | null = null;
	let ply = 0;
	const targetElo = options.targetElo ?? SIM_TELEMETRY.game.targetElo;
	const selection: SelectionState = createSelectionState();
	const rng = createRng(`${gameId}:selection`);
	/** The move the harness has planned; the stub pipeline hands it straight back. */
	let planned: { rec: Recommendation; plan: TimingPlan; ctx: MoveContext } | null = null;

	const pipeline = (timing: TimingModel): SessionPipeline => ({
		run: async (): Promise<RecommendationOutcome | null> => {
			const current = planned;
			if (!current) return null;
			// The real pipeline's last step is `timingModel.planMove`, which is also what writes the
			// §8.6 row; the harness already planned this move, so the row is written from its plan.
			timingLog.append(
				buildTimingLogEntry({
					gameId,
					ply,
					mode: current.plan.mode,
					plannedMs: current.plan.thinkMs,
					alloc: current.plan.features.alloc ?? 0,
					clockMs: current.ctx.myClockMs ?? 0,
					comp: current.plan.features.comp ?? 0,
					eps: current.plan.features.eps ?? 0,
					terms: [],
					persona: settings.strength.persona,
				})
			);
			void timing;
			// §3.2 step 2 for real: the harness fabricates the *lines*, the selection layer picks
			// the move — which is what makes the §13.6 quality columns (`top1`, `cpLoss`) mean
			// something in the export instead of being the harness's own plumbing.
			const chosen = selectMove(current.rec.lines, {
				fen: current.rec.fen,
				targetElo,
				form: 0,
				ply,
				phase: phaseOf(current.rec.fen, ply) ?? "middlegame",
				myClockMs: current.ctx.myClockMs ?? timeControl.baseMs,
				oppClockMs: timeControl.baseMs,
				selectionMode: settings.strength.selectionMode,
				blunderScale: settings.strength.blunderScale,
				engineBestmove: current.rec.lines[0]?.pvUci[0] ?? "",
				rng,
				state: selection,
			});
			return {
				rec: { ...current.rec, chosen },
				// The production pipeline reads `plan.features.n_reasonable` (Appendix D): the count
				// of lines within `nReasonableCp` of the best, NOT the MultiPV count, which is a
				// function of the time budget alone. Read the same source here so the exported
				// telemetry column cannot silently drift back to a budget proxy.
				nReasonable:
					current.rec.plan.features.n_reasonable ??
					current.ctx.nReasonable ??
					Math.max(1, current.rec.lines.length),
				fromBook: false,
				budget: { movetimeMs: 0, depthCap: 0, multiPv: current.rec.lines.length },
				analysis: null,
			};
		},
	});

	function ensure(sw: TelemetrySw, sim: Simulator, tabId: number): GameSession {
		if (session) return session;
		autoQueue = new AutoQueue({
			link: sw.link,
			scheduler: defaultScheduler,
			rng: createRng(`${gameId}:auto-queue`),
		});
		// The driver hands the session its positions explicitly (ruling 6), so the session does not
		// subscribe to the page's own feed — otherwise the harness's `page.arrive()` would race the
		// driver with the same move under a different game id. Everything the session *sends* the
		// page (highlights, keybinds, `boardCheck`) still goes over the real link.
		const link: GameSessionDeps["link"] = {
			post: (id, cmd) => sw.link.post(id, cmd),
			request: (id, cmd, timeoutMs, signal) => sw.link.request(id, cmd, timeoutMs, signal),
			onMessage: (() => () => {}) as GameSessionDeps["link"]["onMessage"],
			isConnected: (id) => sw.link.isConnected(id),
		};
		session = new GameSession({
			tabId,
			link,
			engine: null,
			book: null,
			head: new V1ParametricHead(),
			debugger: sw.debugger,
			focus: sw.focus,
			ownership: sw.ownership,
			timingLog,
			autoQueue,
			// One executor for the whole game: the harness owns it and arms it in the waiting view.
			createExecutor: () => sw.executor,
			createPipeline: pipeline,
			getSettings: () => settings,
			notify: () => {},
			speak: () => Promise.resolve(),
			now: sim.now,
			scheduler: defaultScheduler,
			seed: gameId,
		});
		const meta: GameMeta = {
			gameId,
			site,
			pageKind: "live-game",
			myColor: "w",
			timeControl,
			startedAt: sim.now(),
		};
		session.onHello(site, "live-game");
		session.onGameStarted(meta);
		return session;
	}

	function snapshotOf(
		rec: Recommendation,
		ctx: MoveContext,
		sim: Simulator,
		index: number
	): PositionSnapshot {
		const myClock = ctx.myClockMs ?? timeControl.baseMs;
		return {
			site,
			gameId,
			fen: rec.fen,
			ply: index,
			sideToMove: "w",
			myColor: "w",
			clocks: { w: { ms: myClock, running: true }, b: { ms: timeControl.baseMs, running: true } },
			timeControl,
			capturedAt: sim.now(),
		};
	}

	return {
		session: () => session,
		entries: () => timingLog.entries(),
		dispose() {
			autoQueue?.dispose();
			session?.dispose();
			timingLog.dispose();
		},
		async play({ rec, plan, ctx, sw, sim, hook }) {
			const tabId = (sw.executor as unknown as { tabId: number }).tabId;
			const orchestrator = ensure(sw, sim, tabId);
			const reports: ExecutionReport[] = [];
			const offs = (["executed", "failed", "aborted", "skipped"] as const).map((ev) =>
				sw.executor.on(ev, (r) => reports.push(r))
			);
			planned = { rec, plan, ctx };
			ply += 1;
			try {
				await sw.context.run(async () => {
					await orchestrator.onPosition(snapshotOf(rec, ctx, sim, ply));
					await hook?.();
					const giveUpAt = sim.now() + SIM_TELEMETRY.maxMoveAdvanceMs;
					while (reports.length === 0 && sim.now() < giveUpAt) {
						await sim.time.advance(SIM_TELEMETRY.advanceStepMs);
					}
				});
			} finally {
				for (const off of offs) off();
				planned = null;
			}
			const report = reports[reports.length - 1];
			if (!report)
				throw new Error(
					`session-driver: the session reported nothing (think ${plan.thinkMs.toFixed(0)} ms, mode ${plan.mode})`
				);
			return report.result;
		},
	};
}
