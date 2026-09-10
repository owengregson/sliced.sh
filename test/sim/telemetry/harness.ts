// test/sim/telemetry/harness.ts
/**
 * The telemetry harness (Task 33): a full simulated bot game on the extension
 * simulator, with the `ac` shadow observing the page. The service-worker half
 * is the real executor stack (`DebuggerManager`, `ContentLink`, `FocusGate`,
 * `HandOwnership`, `MoveExecutor`) fed by the real `TimingModel`; the page
 * half is `createSimulatedSite`. A scripted bot opponent answers every move.
 *
 * Until the `GameSession` orchestrator lands (Task 30) the harness drives the
 * executor directly through the default `MoveDriver`; Task 30 supplies a
 * driver that hands the position to the session instead and everything else
 * — the page half, the shadow, `assertHumanShapedAc` — stays as it is.
 */

import { DEFAULT_SETTINGS } from "@core/constants/defaults";
import { TELEMETRY_BANDS } from "@core/constants/telemetry";
import { createRng, type Rng } from "@core/rng";
import { TimingModel } from "@core/timing/timing-model";
import type { TimingContext } from "@core/timing/types";
import { V1ParametricHead } from "@core/timing/v1-head";
import { defaultScheduler } from "@core/util/scheduler";
import { ContentLink } from "@service/content-link";
import { DebuggerManager } from "@service/debugger-manager";
import { FocusGate, type FocusSnapshot } from "@service/focus-gate";
import { HandOwnership } from "@service/hand-ownership";
import { Keepalive } from "@service/keepalive";
import {
	type ExecutionReport,
	type ExecutorGameConfig,
	type MoveContext,
	MoveExecutor,
} from "@service/move-executor";
import { type CdpCommandRecord, createSimulator, type Simulator } from "@test/sim";
import { bootSwContext, type SwContext } from "@test/sim/contexts/sw-context";
import type { AcObservation } from "@test/sim/telemetry/ac-shadow";
import { SIM_TELEMETRY } from "@test/sim/telemetry/constants";
import { createSimulatedSite, type SimulatedSite } from "@test/sim/telemetry/sim-site";
import type { EvalLine } from "@typedefs/engine";
import type { ExecutionResult, Recommendation, Site, Square } from "@typedefs/game";
import type { PersonaId } from "@typedefs/settings";
import type { AcBlob, LichessBlurBit, MoveTelemetryRecord } from "@typedefs/telemetry";
import type { TimingLogEntry, TimingPlan } from "@typedefs/timing";
import { isNonTrivial, moveMetaOf } from "../../../tools/telemetry-conformance/ac-model";

/** One `Input.dispatchMouseEvent` the executor issued, flattened. */
export interface MouseCommand {
	type: string;
	x: number;
	y: number;
	buttons: number;
	at: number;
}

export interface TelemetrySw {
	readonly context: SwContext;
	readonly keepalive: Keepalive;
	readonly debugger: DebuggerManager;
	readonly link: ContentLink;
	readonly focus: FocusGate;
	readonly ownership: HandOwnership;
	readonly executor: MoveExecutor;
	readonly timing: TimingModel;
}

export interface MoveHook {
	index: number;
	/** Set when this is the replay of a move the focus gate skipped. */
	retryOf?: number;
	tabId: number;
	plan: TimingPlan;
	rec: Recommendation;
	site: SimulatedSite;
	sw: TelemetrySw;
	sim: Simulator;
}

/** What plays one recommended move (the executor today, the `GameSession` in Task 30). */
export interface MoveDriver {
	play(input: {
		rec: Recommendation;
		plan: TimingPlan;
		ctx: MoveContext;
		sw: TelemetrySw;
		sim: Simulator;
		hook?: () => Promise<void>;
	}): Promise<ExecutionResult>;
}

export interface SimulatedGameOptions {
	seed: string;
	moves: number;
	persona?: PersonaId;
	tcClass?: ExecutorGameConfig["tcClass"];
	style?: ExecutorGameConfig["style"];
	previewScale?: number;
	targetElo?: number;
	clock?: { baseSec: number; incSec: number; myStartMs?: number; oppStartMs?: number };
	/** Runs after the move is scheduled and before the clock advances (inject blur / real input). */
	duringMove?: (hook: MoveHook) => Promise<void> | void;
	driver?: MoveDriver;
}

export interface SimulatedMove {
	index: number;
	/** Set on the replay of a move the focus gate skipped. */
	retryOf?: number;
	ply: number;
	uci: string;
	plan: TimingPlan;
	nReasonable: number;
	myClockMs: number;
	result: ExecutionResult;
	commands: MouseCommand[];
	/** The site's blur inside this window, when one was injected … */
	blurAt?: number;
	/** … and when the `FocusGate` learned of it (after the port hop). */
	blurSeenAt?: number;
	/** `FocusGate.snapshot` right after a skipped result. */
	focusAtSkip?: FocusSnapshot;
	/** The shadow's blob for this move (absent when nothing was submitted). */
	observation?: AcObservation;
}

export interface SimulatedGame {
	readonly sim: Simulator;
	readonly tabId: number;
	readonly site: SimulatedSite;
	readonly sw: TelemetrySw;
	readonly persona: PersonaId;
	readonly moves: SimulatedMove[];
	readonly observations: AcObservation[];
	readonly acs: AcBlob[];
	readonly blurBits: LichessBlurBit[];
	/** Focus-moving APIs the extension called during the game (must stay 0). */
	readonly focusApiCalls: { tabsUpdate: number; windowsUpdate: number; bringToFront: number };
	readonly maxStepPx: number;
	dispose(): Promise<void>;
}

/** The default driver: schedule on the executor, let the virtual clock run until the hand rests. */
export const executorDriver: MoveDriver = {
	async play({ rec, plan, ctx, sw, sim, hook }) {
		const reports: ExecutionReport[] = [];
		const offs = (["executed", "failed", "aborted", "skipped"] as const).map((ev) =>
			sw.executor.on(ev, (r) => reports.push(r))
		);
		try {
			await sw.context.run(async () => {
				sw.executor.schedule(rec, plan, ctx);
				await hook?.();
				// Step the clock until the executor reports (not `advanceUntilIdle`: that would run
				// through the debugger's idle-detach timer between moves).
				const giveUpAt = sim.now() + SIM_TELEMETRY.maxMoveAdvanceMs;
				while (reports.length === 0 && sim.now() < giveUpAt) {
					await sim.time.advance(SIM_TELEMETRY.advanceStepMs);
				}
			});
		} finally {
			for (const off of offs) off();
		}
		const report = reports[reports.length - 1];
		if (!report)
			throw new Error(
				`harness: the executor reported nothing for the move (think ${plan.thinkMs.toFixed(0)} ms, mode ${plan.mode}, pending timers ${sim.time.pendingTimers()})`
			);
		return report.result;
	},
};

/**
 * The `MoveTelemetryRecord` of one simulated move — the shape Task 30's `GameSession`
 * must attach to its own timing-log row (`src/types/telemetry.ts` lists each field's
 * source). `null` for a move that submitted nothing (a focus skip), which has no `ac`.
 *
 * The record carries **no §13.6 quality pair**: this path has no selection layer (the harness
 * plays the engine's first line every move), so a `top1` here would be a hard-coded 100 % rather
 * than a measurement. `test/sim/telemetry/session-driver.ts` runs the real `selectMove` and the
 * `GameSession` fills the pair from the resulting `Recommendation`.
 */
export function telemetryRecordOf(move: SimulatedMove): MoveTelemetryRecord | null {
	const obs = move.observation;
	if (!obs) return null;
	return {
		ac: obs.ac,
		lichessBlur: obs.lichessBlur,
		orientationMs: move.plan.orientationMs,
		multiSelectEligible: isNonTrivial(moveMetaOf(move)),
		nReasonable: move.nReasonable,
	};
}

/**
 * The game as the Engine view would export it (§8.6): one `TimingLogEntry` per planned
 * move, `telemetry` attached wherever the move was submitted. `tools/telemetry-conformance/
 * report.py` reads exactly this JSON.
 */
export function timingLogOf(game: SimulatedGame, gameId: string): TimingLogEntry[] {
	return game.moves.map((m) => {
		const f = m.plan.features;
		const entry: TimingLogEntry = {
			gameId,
			ply: m.ply,
			mode: m.plan.mode,
			plannedMs: m.plan.thinkMs,
			actualMs: m.observation?.ac.MoveHoldTime ?? null,
			alloc: f.alloc ?? 0,
			clockMs: m.myClockMs,
			comp: f.comp ?? 0,
			eps: f.eps ?? 0,
			topTerms: [],
			persona: game.persona,
		};
		const telemetry = telemetryRecordOf(m);
		if (telemetry) entry.telemetry = telemetry;
		return entry;
	});
}

function flatten(records: CdpCommandRecord[]): MouseCommand[] {
	return records.map((c) => {
		const p = (c.params ?? {}) as Record<string, unknown>;
		return {
			type: String(p.type),
			x: Number(p.x),
			y: Number(p.y),
			buttons: Number(p.buttons ?? 0),
			at: c.at,
		};
	});
}

/** Four MultiPV lines over the legal moves with `nReasonable` of them inside the reasonable band. */
export function fakeLines(legal: string[], nReasonable: number, rng: Rng): EvalLine[] {
	const pool = legal.filter((u) => u.length === 4);
	const picks: string[] = [];
	const source = pool.length > 0 ? [...pool] : [...legal];
	while (picks.length < SIM_TELEMETRY.lines.count && source.length > 0) {
		picks.push(source.splice(rng.int(0, source.length - 1), 1)[0] as string);
	}
	const L = SIM_TELEMETRY.lines;
	return picks.map((uci, i) => ({
		multipv: i + 1,
		score: {
			cp:
				i < nReasonable
					? L.bestCp - i * L.reasonableStepCp
					: L.bestCp - L.unreasonableCp - i * L.reasonableStepCp,
		},
		depth: L.depth,
		pvUci: [uci],
		pvSan: [],
	}));
}

export async function runSimulatedGame(options: SimulatedGameOptions): Promise<SimulatedGame> {
	const site: Site = "chesscom";
	const persona = options.persona ?? SIM_TELEMETRY.game.persona;
	const tcClass = options.tcClass ?? SIM_TELEMETRY.game.tcClass;
	const targetElo = options.targetElo ?? SIM_TELEMETRY.game.targetElo;
	const baseSec = options.clock?.baseSec ?? SIM_TELEMETRY.game.baseSec;
	const incSec = options.clock?.incSec ?? SIM_TELEMETRY.game.incSec;
	const driver = options.driver ?? executorDriver;
	const rng = createRng(`${options.seed}:harness`);

	const sim = createSimulator({ startAt: SIM_TELEMETRY.startAt });
	sim.time.install();
	const tabId = sim.openTab("https://www.chess.com/play/computer").tabId;
	const focusApiCalls = { tabsUpdate: 0, windowsUpdate: 0, bringToFront: 0 };
	const realTabsUpdate = sim.chrome.tabs.update;
	sim.chrome.tabs.update = ((...args: unknown[]) => {
		focusApiCalls.tabsUpdate += 1;
		return (realTabsUpdate as (...a: unknown[]) => unknown)(...args);
	}) as typeof sim.chrome.tabs.update;
	(sim.chrome.windows as unknown as Record<string, unknown>).update = () => {
		focusApiCalls.windowsUpdate += 1;
	};

	let parts: Omit<TelemetrySw, "context"> | null = null;
	const context = await bootSwContext(sim, {
		entry: async () => {
			const keepalive = new Keepalive();
			const dbg = new DebuggerManager({ keepalive, scheduler: defaultScheduler, now: sim.now });
			await dbg.ready;
			const link = new ContentLink({ scheduler: defaultScheduler, now: sim.now });
			const focus = new FocusGate(link, { now: sim.now });
			const ownership = new HandOwnership(link, { now: sim.now });
			const executor = new MoveExecutor({
				tabId,
				site,
				debugger: dbg,
				link,
				focus,
				ownership,
				now: sim.now,
				scheduler: defaultScheduler,
				persona,
				tcClass,
				style: options.style ?? "auto",
				previewScale: options.previewScale ?? DEFAULT_SETTINGS.execution.previewSelectScale,
				gameSeed: options.seed,
			});
			const timing = new TimingModel(
				new V1ParametricHead(),
				DEFAULT_SETTINGS.timing,
				createRng(`${options.seed}:timing`)
			);
			timing.startGame({ targetElo, profile: persona, baseSec, incSec, site, gameId: options.seed });
			parts = { keepalive, debugger: dbg, link, focus, ownership, executor, timing };
		},
	});
	const booted = parts as Omit<TelemetrySw, "context"> | null;
	if (!booted) throw new Error("harness: the service worker did not boot");
	const swHandle: TelemetrySw = { context, ...booted };
	const page = await createSimulatedSite(sim, tabId, { myColor: "w" });
	await sim.time.runMicrotasks();

	// Arm in the waiting view (§13.4): the debugger attaches before any move window.
	await swHandle.context.run(() => swHandle.executor.arm());

	const moves: SimulatedMove[] = [];
	const observations: AcObservation[] = page.shadow.observations;
	let lastBlurSeenAt: number | null = null;
	const offEdge = swHandle.focus.onEdge((_tab, hasFocus) => {
		if (!hasFocus) lastBlurSeenAt = sim.now();
	});
	const clocks = {
		w: options.clock?.myStartMs ?? baseSec * 1000,
		b: options.clock?.oppStartMs ?? baseSec * 1000,
	};
	const uciHistory: string[] = [];
	const oppThinkHistory: number[] = [];
	const myThinkHistory: number[] = [];
	let evalBefore: number | null = null;

	const pickOpponent = (): string | null => {
		const legal = page.board.legalMoves();
		if (legal.length === 0) return null;
		return legal[rng.int(0, legal.length - 1)] as string;
	};

	const contextFor = (chosen: string, lines: EvalLine[], ply: number): TimingContext => ({
		fen: page.board.fen(),
		ply,
		moves: [...uciHistory],
		myColor: "w",
		chosenMove: chosen,
		lines,
		evalBeforeOppMove: evalBefore,
		expectedOppReply: null,
		myClockMs: clocks.w,
		oppClockMs: clocks.b,
		baseSec,
		incSec,
		oppThinkMsHistory: [...oppThinkHistory],
		myThinkMsHistory: [...myThinkHistory],
		site,
		targetElo,
		profile: persona,
		engineReady: true,
		inputMethod: "drag",
		autoQueen: true,
		nowMs: sim.now(),
	});

	const recommend = (chosen: string, lines: EvalLine[], plan: TimingPlan): Recommendation => ({
		chosen: {
			uci: chosen,
			san: chosen,
			from: chosen.slice(0, 2) as Square,
			to: chosen.slice(2, 4) as Square,
			source: "engine-elo",
			// The harness always plays `lines[0]`; `rankInLines` is 1-based (`selectMove` numbers
			// the best line `1`), so this path is honestly "the engine's first line, every move" —
			// which is exactly why it exports no quality pair (`telemetryRecordOf`).
			rankInLines: 1,
			cpLoss: 0,
			rationale: [],
		},
		lines,
		eval: lines[0]?.score ?? { cp: 0 },
		depth: SIM_TELEMETRY.lines.depth,
		nps: 1_000_000,
		plan,
		computedAt: sim.now(),
		fen: page.board.fen(),
	});

	const playOne = async (
		index: number,
		retryOf: number | undefined,
		chosen: string,
		lines: EvalLine[],
		nReasonable: number
	): Promise<SimulatedMove> => {
		const ply = page.board.ply();
		const plan = swHandle.timing.planMove(contextFor(chosen, lines, ply));
		const rec = recommend(chosen, lines, plan);
		const ctx: MoveContext = {
			myClockMs: clocks.w,
			nReasonable,
			candidates: lines.map((l, i) => ({
				from: (l.pvUci[0] ?? "").slice(0, 2) as Square,
				to: (l.pvUci[0] ?? "").slice(2, 4) as Square,
				uci: l.pvUci[0] ?? "",
				probability: 1 / (i + 1),
			})),
			legalDestinations: (sq) => page.board.legalDestinations(sq),
		};
		const firstCommand = sim.debugger.commands.length;
		const observed = observations.length;
		const entry: SimulatedMove = {
			index,
			ply,
			uci: chosen,
			plan,
			nReasonable,
			myClockMs: clocks.w,
			result: {
				ok: false,
				outcome: "failed",
				tier: "drag",
				attempts: 0,
				endPoint: { x: 0, y: 0 },
				elapsedMs: 0,
				timeline: [],
			},
			commands: [],
		};
		if (retryOf !== undefined) entry.retryOf = retryOf;
		const hook = options.duringMove
			? async () => {
					await options.duringMove?.({
						index,
						...(retryOf !== undefined ? { retryOf } : {}),
						tabId,
						plan,
						rec,
						site: page,
						sw: swHandle,
						sim,
					});
				}
			: undefined;
		entry.result = await driver.play({
			rec,
			plan,
			ctx,
			sw: swHandle,
			sim,
			...(hook ? { hook } : {}),
		});
		entry.commands = flatten(sim.debugger.commands.slice(firstCommand));
		const blurAt = page.lastBlurAt();
		if (blurAt !== null && blurAt >= plan.deadlineMs - plan.thinkMs) {
			entry.blurAt = blurAt;
			if (lastBlurSeenAt !== null && lastBlurSeenAt >= blurAt) entry.blurSeenAt = lastBlurSeenAt;
		}
		if (!entry.result.ok && entry.result.outcome === "skipped")
			entry.focusAtSkip = swHandle.focus.snapshot(tabId);
		const obs = observations[observed];
		if (obs) entry.observation = obs;
		moves.push(entry);
		return entry;
	};

	// The game: White (us) to move first; the scripted bot answers every executed move.
	page.arrive(null, clocks);
	swHandle.focus.positionArrived(tabId, sim.now());
	for (let index = 0; index < options.moves; index++) {
		if (page.board.isGameOver()) break;
		const nReasonable = rng.int(1, SIM_TELEMETRY.maxReasonable);
		const legal = page.board.legalMoves();
		const lines = fakeLines(legal, nReasonable, rng);
		const chosen = lines[0]?.pvUci[0];
		if (!chosen) break;
		let move = await playOne(index, undefined, chosen, lines, nReasonable);
		if (!move.result.ok && move.result.outcome === "skipped") {
			// §13.4: the move is played only after a fresh position/window — the user clicks into the
			// board again, the timing model observes the extra elapsed time, a new window opens.
			swHandle.timing.observe(sim.now() - (move.plan.deadlineMs - move.plan.thinkMs), move.plan);
			await swHandle.context.run(() => sim.time.advance(SIM_TELEMETRY.refocusPauseMs));
			page.clickIntoBoard();
			await sim.time.runMicrotasks();
			page.arrive(null, clocks);
			swHandle.focus.positionArrived(tabId, sim.now());
			move = await playOne(index, index, chosen, lines, nReasonable);
		}
		if (!move.result.ok) break;
		const hold = move.observation?.ac.MoveHoldTime ?? move.result.elapsedMs;
		swHandle.timing.observe(hold, move.plan);
		myThinkHistory.push(hold);
		clocks.w = Math.max(0, clocks.w - hold + incSec * 1000);
		uciHistory.push(
			move.observation?.diag ? `${move.observation.diag.from}${move.observation.diag.to}` : chosen
		);
		evalBefore = lines[0]?.score.cp ?? null;
		// the opponent thinks and replies
		if (page.board.isGameOver()) break;
		const oppThink = rng.int(SIM_TELEMETRY.opponentThinkMs[0], SIM_TELEMETRY.opponentThinkMs[1]);
		await swHandle.context.run(() => sim.time.advance(oppThink));
		const reply = pickOpponent();
		if (reply === null) break;
		clocks.b = Math.max(0, clocks.b - oppThink + incSec * 1000);
		oppThinkHistory.push(oppThink);
		uciHistory.push(reply);
		page.arrive(reply, clocks);
		swHandle.focus.positionArrived(tabId, sim.now());
		await sim.time.runMicrotasks();
	}

	return {
		sim,
		tabId,
		site: page,
		sw: swHandle,
		persona,
		moves,
		observations,
		get acs() {
			return observations.map((o) => o.ac);
		},
		get blurBits() {
			return observations.map((o) => o.lichessBlur);
		},
		get focusApiCalls() {
			return {
				...focusApiCalls,
				bringToFront: sim.debugger.commandsFor("Page.bringToFront").length,
			};
		},
		maxStepPx: TELEMETRY_BANDS.pointer.maxStepPx,
		async dispose() {
			offEdge();
			await swHandle.context.run(() => {
				swHandle.executor.dispose();
				swHandle.focus.dispose();
				swHandle.ownership.dispose();
				swHandle.link.dispose();
				swHandle.debugger.dispose();
			});
			await page.dispose();
			await swHandle.context.teardown();
			sim.time.uninstall();
			await sim.dispose();
		},
	};
}
