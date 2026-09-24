import type { MsRange, TimeControlClass } from "../types";

/**
 * Opponent-turn free movement ("pondering", owner 2026-09-12): an *attention plan* of alternating
 * active spells and stills over the opponent's think, with the places the pointer visits read from
 * the position rather than browsed from a candidate list. Every number is a design constant with no
 * behaviour dataset behind it (see `MOTOR_DEFAULTS`); the comment on each says what it is set from.
 */
export const OPPONENT_EXPLORATION = {
	maxCandidates: 10,
	replyBranches: 4,
	/** Lines read as reply → answer → next (the top `readingLines` PVs, at most `readingPlies` plies). */
	readingLines: 3,
	readingPlies: 3,
	/** Threat checks look at our pieces the top `threatReplies` replies attack. */
	threatReplies: 3,
	/**
	 * Quiet before the first bout. Short since the post-drop decision (owner, 2026-09-11) already
	 * chose between resting over a piece and pondering at once; this is the settle, not the rest.
	 */
	initialRestMs: [400, 900] as MsRange,
	lowTimeInitialRestMs: [300, 600] as MsRange,
	lowTimeBoutMs: [1800, 3200] as MsRange,
	lowTimeActiveFrac: [0.3, 0.5] as MsRange,
	lowTimeVisits: [1, 2] as MsRange,
	/**
	 * Fallback spell shape when no attention context is supplied (tests, a session without clocks):
	 * the pre-2026-09-12 bout, an active stretch then a still.
	 */
	boutMs: [3200, 7800] as MsRange,
	activeFrac: [0.68, 0.88] as MsRange,
	orientationMs: [100, 420] as MsRange,
	visits: [2, 5] as MsRange,
	ownBias: [0.38, 0.62] as MsRange,
	switchSideProb: 0.7,
	traceProb: 0.65,
	hoverDwellMs: [180, 650] as MsRange,
	traceDwellMs: [140, 500] as MsRange,
	betweenVisitsMs: [90, 360] as MsRange,
	minDwellMs: 100,
	/**
	 * The attention plan by time-control class. `firstLookMs` is the short first look at the
	 * position after our move; `activeMs`/`stillMs` the spells that alternate after it (bullet:
	 * short and frequent, classical: long stills); `noPonderProb` the share of opponent turns that
	 * get no pondering at all beyond a rest — highest where the expected think is shortest (bullet:
	 * the reply is due before a look is worth it) and raised again at classical (a long expected
	 * think: the hand leans back); `decayHalfLifeMs` the opponent think after which attention has
	 * halved (stills grow, activity thins to an occasional glance — the *very long* think in the
	 * brief). Set from the median human move times per class in the ChessMimic bands (bullet ≈ 1.5 s,
	 * blitz ≈ 4 s, rapid ≈ 10 s, classical ≈ 25 s): a spell is about a third of a median think, a
	 * still about a half, the half-life about two thinks. The first look is long enough to read one
	 * line (six legs of travel and dwell) and is not phase-scaled.
	 */
	attention: {
		bullet: {
			firstLookMs: [600, 1300] as MsRange,
			activeMs: [900, 2000] as MsRange,
			stillMs: [400, 1200] as MsRange,
			noPonderProb: 0.35,
			decayHalfLifeMs: 3_000,
		},
		blitz: {
			firstLookMs: [800, 1800] as MsRange,
			activeMs: [1400, 3400] as MsRange,
			stillMs: [800, 2200] as MsRange,
			noPonderProb: 0.18,
			decayHalfLifeMs: 8_000,
		},
		rapid: {
			firstLookMs: [1100, 2600] as MsRange,
			activeMs: [2200, 5200] as MsRange,
			stillMs: [1500, 4500] as MsRange,
			noPonderProb: 0.1,
			decayHalfLifeMs: 20_000,
		},
		classical: {
			firstLookMs: [1400, 3200] as MsRange,
			activeMs: [2600, 7000] as MsRange,
			stillMs: [2500, 8000] as MsRange,
			noPonderProb: 0.14,
			decayHalfLifeMs: 50_000,
		},
	} satisfies Record<
		TimeControlClass,
		{
			firstLookMs: MsRange;
			activeMs: MsRange;
			stillMs: MsRange;
			noPonderProb: number;
			decayHalfLifeMs: number;
		}
	>,
	/**
	 * Attention decay, applied with `a = 2^(−think / decayHalfLifeMs)`: a still grows by up to
	 * `stillGrowthMax` × (1 − a); the chance that a cycle is active at all falls from 1 toward
	 * `activeFloor`; a cycle that is not active is a single glance with `glanceProb`, else pure
	 * stillness. Set so a fully decayed rapid turn (a ≈ 0) shows one glance per ~15 s.
	 */
	decay: { stillGrowthMax: 2, activeFloor: 0.3, glanceProb: 0.5 },
	/**
	 * A short expected reply (the opponent's clock under `quickReplyClockMs`) adds
	 * `noPonderShortBoost` to the no-ponder share: there is no time for a look before they move.
	 */
	quickReplyClockMs: 15_000,
	noPonderShortBoost: 0.25,
	/**
	 * Game phase (`@core/chess/phase`): opening spells are quick glances (×`opening`), a sharp
	 * middlegame (a capture or check in the top replies) holds longer traces (×`sharp`), the endgame
	 * is between (×`endgame`). Multipliers on the active spell length.
	 */
	phaseActiveScale: { opening: 0.7, middlegame: 1, sharp: 1.35, endgame: 0.85 },
	/**
	 * With a premove or a hold armed the hand is mostly still: the chance a cycle is active, and
	 * the active length multiplier. A held piece cannot ponder at all (the executor never starts a
	 * bout while a hold runs); this covers an armed premove and the checkpoints between.
	 */
	armed: { activeProb: 0.2, activeScale: 0.5 },
	/**
	 * What an active spell does, as weights (the `line`/`threat` weights are scaled by `sharp` in
	 * a sharp position). `candidates` is the pre-2026-09-12 browse, kept as the fallback for a
	 * position with no readable lines.
	 */
	activityWeights: { line: 5, threat: 3, candidates: 2, king: 1, offBoard: 0.5 },
	sharpActivityScale: 1.5,
	/**
	 * The first activity of any active spell (the first look included) is a line reading nearly
	 * always — a human opens a look with the most likely line (multiplier on `line`; ×2.5 leaves a
	 * threat check about a sixth of the openings, which the unit test derives from these weights).
	 */
	firstLookLineScale: 2.5,
	/** Candidate visits per `candidates` activity inside an attention spell (the legacy browse uses `visits`). */
	activityCandidateVisits: [1, 2] as MsRange,
	/** A line is read twice with this probability (a second, quicker pass). */
	rereadProb: 0.3,
	rereadSpeedScale: 0.8,
	/**
	 * Dwells inside a line reading: on the piece (`from`) and on the destination (`to`). Short —
	 * a reading is six legs, and the eye moves on as soon as the move is seen.
	 */
	readFromDwellMs: [100, 300] as MsRange,
	readToDwellMs: [150, 500] as MsRange,
	/** Threat check: pieces looked at per spell, dwell on each (a worried look is longer). */
	threatVisits: [1, 3] as MsRange,
	threatDwellMs: [300, 1100] as MsRange,
	/** The piece the opponent just moved is looked at first in a threat check with this probability. */
	lastMoveFirstProb: 0.6,
	/**
	 * King glance: which king (own more often — "am I safe?") and how long. Also drawn as an
	 * *extra* at the start of any active spell with `kingGlanceProb` (a look at the king before
	 * reading), so the rate over a turn lands in the band the unit test pins.
	 */
	kingOwnProb: 0.65,
	kingDwellMs: [250, 800] as MsRange,
	kingGlanceProb: 0.12,
	/**
	 * Off-board glance: the clock / move-list area beside the board (`SAMPLING.clockBandPx` to the
	 * right, the same band `plausibleStart` uses) or just past an edge (`SAMPLING.offBoardPx`),
	 * never above the viewport origin. Rare — `offBoardGlanceProb` per active spell as an extra,
	 * drawn with the king glance before the spell's activities — with a dwell that reads a clock.
	 */
	offBoardGlanceProb: 0.06,
	offBoardClockProb: 0.7,
	offBoardDwellMs: [350, 1200] as MsRange,
	/**
	 * A still begins with a walk to a rest spot with `restMoveProb` (else the hand stays where the
	 * spell left it): a random piece drawn toward the centre with `EXECUTOR.postDropCentreBias`
	 * (`restPieceProb`), else a point just off the board edge. Never the square we intend to move
	 * to next. Stills hold `stillDwellMs` per dwell — fewer, longer dwells than an active spell.
	 */
	restMoveProb: 0.45,
	restPieceProb: 0.75,
	stillDwellMs: [900, 2600] as MsRange,
	/** The first movement after a still is slower (re-orienting): multiplier on `travelSpeedScale`. */
	reorientSpeedScale: 1.3,
	/** Per-spell trace speed jitter on the persona's motor profile (multiplier on `travelSpeedScale`). */
	traceSpeedScale: [0.85, 1.2] as MsRange,
	/** A glance cycle (decayed attention): one hover, then the still. `glanceMs` covers the travel. */
	glanceMs: [1000, 2200] as MsRange,
	glanceDwellMs: [300, 900] as MsRange,
	/** An active spell too short for its chosen leg tries this many nearest squares for a look. */
	nearestLookTries: 4,
	/** The orientation pause opening an active spell never takes more than this share of it (bullet). */
	orientationMaxFrac: 0.2,
	/** Off-board glance points stay at least this far inside the viewport. */
	viewportPadPx: 4,
} as const;
