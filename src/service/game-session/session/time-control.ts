/**
 * §4.3 / §4.6: the game's time control and everything built from it — the timing model, the §3.2
 * pipeline over it, the game's starting clock, the hand's motor class — plus the first position's
 * short hold while the site has not reported the clock yet.
 */

import { TIMINGS } from "@core/constants/timings";
import { log } from "@core/logger";
import { createRng } from "@core/rng";
import { tcClass } from "@core/timing/features";
import { TimingModel } from "@core/timing/timing-model";
import type { TcClass } from "@core/timing/types";
import { errorMessage } from "@core/util/errors";
import type { GameMeta, PositionSnapshot, TimeControl } from "@typedefs/game";
import type { Settings } from "@typedefs/settings";
import { timingSettingsFor } from "../presets";
import { RecommendationPipeline } from "../recommendation";
import type { SessionCore } from "./core";
import { claimsFirstMove, MS_PER_S, motorTcClass, timeControlSeconds } from "./position-rules";
import type { SessionPipeline } from "./types";

export class TimeControlProfile {
	/** The time control this game's timing model was built from (`null` = none was known yet). */
	private profiled: TimeControl | null = null;
	/** `holdForTimeControl`: the first position waiting for the site to report the clock. */
	private hold: unknown = null;

	constructor(
		private readonly core: SessionCore,
		/** The pipeline run a released hold starts (`GameSession.runPipeline`). */
		private readonly runPipeline: (snapshot: PositionSnapshot) => Promise<void>
	) {}

	/**
	 * A new game's timing model, from the time control `meta` carries (usually none yet — see
	 * `reprofile`). Returns the game's time-control class and the model.
	 */
	beginGame(
		meta: GameMeta,
		settings: Settings,
		targetElo: number
	): { tc: TcClass; timing: TimingModel } {
		const core = this.core;
		const [baseSec, incSec] = timeControlSeconds(meta);
		const tc = tcClass(baseSec, incSec);
		core.startClockMs = baseSec * MS_PER_S;
		const timing = timingSettingsFor(settings.timing, meta.timeControl);
		this.profiled = meta.timeControl ?? null;

		const model = new TimingModel(core.deps.head, timing, createRng(`${core.gameSeed}:timing`), {
			onEntry: (entry) => core.deps.timingLog.upsert(entry),
		});
		core.timing = model;
		model.startGame({
			targetElo,
			profile: settings.strength.persona,
			baseSec,
			incSec,
			site: meta.site,
			gameId: meta.gameId,
		});
		return { tc, timing: model };
	}

	/** The §3.2 pipeline over `timing`: the harness's, else the engine's, else none. */
	pipelineFor(timing: TimingModel): SessionPipeline | null {
		const deps = this.core.deps;
		if (deps.createPipeline) return deps.createPipeline(timing);
		const engine = deps.engine;
		if (!engine) return null;
		// The §3.2 pipeline over the shared engine, timing model, book and (2026-09-11) the Maia port.
		const policy = deps.policy;
		return new RecommendationPipeline({
			engine,
			timing,
			book: deps.book,
			now: this.core.now,
			...(policy ? { policy } : {}),
		});
	}

	/**
	 * §4.3 / §4.6: the time control arrives on a `position`, not on `gameStarted`.
	 *
	 * This is the load-bearing path, not a fallback. chess.com answers
	 * `board.game.timeControl.get()` only once the game has actually started, and the content
	 * script starts its session from the first readable snapshot — taken before the MAIN-world
	 * bridge has answered anything — so `GameMeta.timeControl` is normally absent and `startGame`
	 * has already built the model, the pipeline and the hand for a clockless game. Everything the
	 * clock drives hangs off this one call: the features' `tcClass` (and with it the compression
	 * factor, the hard caps and the §8.5 emergency regime, all of which the `untimed` branch
	 * bypasses), the §7.4 premove gate (bullet/blitz only) and the hand's own
	 * motor class — a bullet game otherwise keeps a classical hand for its whole length.
	 *
	 * Once per game (`profiled`), at whatever ply it lands: a game whose clock arrives after our
	 * first move must not keep planning as untimed for the rest of its length, so the rebuilt model
	 * *adopts* the previous one's per-game history rather than starting fresh.
	 */
	reprofile(snapshot: PositionSnapshot): void {
		const core = this.core;
		const tc = snapshot.timeControl;
		const timing = core.timing;
		if (!tc || !timing || this.profiled !== null) return;
		const meta = core.game;
		if (!meta) return;
		core.game = { ...meta, timeControl: tc };
		this.profiled = tc;
		const settings = core.settings();
		const next = timingSettingsFor(settings.timing, tc);
		const [baseSec, incSec] = timeControlSeconds(core.game);
		const tcClassOf = tcClass(baseSec, incSec);
		core.startClockMs = baseSec * MS_PER_S;
		core.timing = new TimingModel(
			core.deps.head,
			next,
			createRng(`${core.seed}:${meta.gameId}:timing`),
			{ onEntry: (entry) => core.deps.timingLog.upsert(entry) }
		);
		core.timing.startGame({
			targetElo: core.targetElo(),
			profile: settings.strength.persona,
			baseSec,
			incSec,
			site: meta.site,
			gameId: meta.gameId,
		});
		core.timing.adoptHistory(timing.state);
		core.pipeline = this.pipelineFor(core.timing);
		// The hand's class too, in place: replacing the executor would dispose an armed hand and
		// re-arm it, and a re-arm attaches the debugger — Chrome's infobar, a reflow and a board
		// that moves, mid-game (§13.4 arms in the waiting view precisely to keep that out of a move
		// window). `MoveExecutor.setTimeControlClass` changes the profile the next execution reads.
		core.executor?.setTimeControlClass(motorTcClass(tcClassOf));
		log.info("game-session: time control learned from a position", {
			tabId: core.tabId,
			baseMs: tc.baseMs,
			incMs: tc.incMs,
			tc: tcClassOf,
			// 2026-09-15: was the timing preset; the class's move-time gain (through the user's
			// base speed) is what the re-derived model actually runs at.
			moveTimeScale: next.moveTimeScale,
			ply: snapshot.ply,
		});
	}

	/**
	 * §4.3 meets the board mark: the site reports the time control on a *republish* of the game's
	 * unmoved first position, and a move decided before that republish is decided again when it
	 * lands — on the real budget instead of the untimed one, so usually a different move, with the
	 * arrow on the board jumping under the owner's eyes (owner's report, 2026-09-11). So the first
	 * position of a live game waits `TIMINGS.timeControlGraceMs` for the control before anything is
	 * searched, drawn or scheduled; the republish that carries it releases the hold through
	 * `onPosition` (a different key), and the timer releases it for a page that never answers.
	 * `cancelInFlight` drops the timer with everything else, so a position that moved on cannot be
	 * released into the wrong search.
	 */
	holdForTimeControl(snapshot: PositionSnapshot): boolean {
		const core = this.core;
		if (snapshot.timeControl || this.profiled !== null) return false;
		// The game's first move by the FEN's own counters and placement — but *not* gated on the
		// reading's provenance the way `isGameFirstMove` is: the first reading of a live game is the
		// approximate DOM one, and it is exactly the reading this hold exists for.
		if (!claimsFirstMove(snapshot.fen)) return false;
		if (this.hold !== null) return true;
		log.debug("game-session: first position held for the time control", {
			tabId: core.tabId,
			graceMs: TIMINGS.timeControlGraceMs,
		});
		this.hold = core.scheduler.setTimeout(() => {
			this.hold = null;
			if (core.disposed || core.snapshot !== snapshot || core.rec !== null) return;
			log.info("game-session: no time control reported — deciding the first move untimed", {
				tabId: core.tabId,
			});
			void this.runPipeline(snapshot).catch((error: unknown) =>
				log.warn("game-session: pipeline failed after the time-control hold", {
					error: errorMessage(error),
				})
			);
		}, TIMINGS.timeControlGraceMs);
		return true;
	}

	clearHold(): void {
		if (this.hold === null) return;
		this.core.scheduler.clearTimeout(this.hold);
		this.hold = null;
	}
}
