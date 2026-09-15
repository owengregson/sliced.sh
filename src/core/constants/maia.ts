/** Maia-3 policy assets, rating boundaries and engine-verification constraints. */

export const MAIA_DIR = "assets/models/maia3/";

/** The shipped sizes. Exactly one since 2026-09-13; the type stays so a size is still a name. */
export const MAIA_SIZES = ["79m"] as const;
export type MaiaSize = (typeof MAIA_SIZES)[number];

export interface MaiaModelFile {
	/** File name under `MAIA_DIR` in the *built* package (one whole `.onnx`). */
	file: string;
	bytes: number;
	sha256: string;
	/** Lossless compression in the built extension only. */
	packed?: boolean;
	/**
	 * Number of `<file>.part<i>` slices the file is stored as in the *source* repository
	 * (the Git host's 100 MB per-file cap); the build joins them. `1` = stored whole.
	 */
	parts: number;
	/** Upstream checkpoint on Hugging Face the export came from. */
	upstream: { repo: string; revision: string; checkpoint: string; bytes: number; sha256: string };
	params: number;
	/** Embedding width / attention heads (8 blocks in every size). */
	dModel: number;
	heads: number;
}

/** `<size>` → the shippable fp16-weight ONNX as exported (checked by `test/scripts/maia-assets.test.ts`). */
export const MAIA_MODEL_FILES: Readonly<Record<MaiaSize, MaiaModelFile>> = {
	"79m": {
		file: "maia3-79m.onnx",
		bytes: 156_212_736,
		sha256: "37fe2f32cd44f2733ce5cafd90d9aa4c444340da8661df36420ae4e65ebd6a88",
		packed: true,
		parts: 2,
		upstream: {
			repo: "UofTCSSLab/Maia3-79M",
			revision: "a107d6ceb7b298cb04ae1da4edffe2939858b894",
			checkpoint: "maia3-79m.pt",
			bytes: 315_651_851,
			sha256: "3fc6181d5db789b45a15305732148757ae74efa3e0028e81ba335b462dac45c2",
		},
		params: 78_899_716,
		dModel: 1024,
		heads: 32,
	},
};

/** Side files written next to the models. */
export const MAIA_FILES = {
	manifest: "models.json",
	license: "LICENSE",
	/** `<file>.part<i>` — the repository's split of a file over the Git per-file cap. */
	partSuffix: ".part",
	/** Slice size of a split source file (under the 100 MB cap with room for the hosting limit). */
	partBytes: 95_000_000,
} as const;

export const MAIA_UPSTREAM = {
	name: "Maia-3",
	repo: "https://github.com/CSSLab/maia3",
	/** The weights are distributed by the repository's licence ("see repo" on every model card). */
	license: "AGPL-3.0-or-later",
	licenseName: "GNU Affero General Public License v3.0 or later",
	licenseUrl: "https://www.gnu.org/licenses/agpl-3.0.html",
	copyright: "Copyright 2026 CSSLab, University of Toronto (https://github.com/CSSLab/maia3)",
	paper: "https://arxiv.org/abs/2605.19091",
	paperTitle: "Chessformer: A Unified Architecture for Chess Modeling (ICLR 2026)",
	hub: "https://huggingface.co/collections/MaiaChess/maia3",
} as const;

/** Model-input contract shared by the encoder, the export and the fixture. */
export const MAIA_INPUT = {
	/** Positions per query: the current one and up to 7 before it (the earliest repeated to fill). */
	history: 8,
	/** One-hot piece planes per position: 6 types × {side to move, opponent}. */
	planes: 12,
	/** `history × planes` features per square. */
	tokenDim: 96,
	squares: 64,
	/** 64×64 from→to pairs then 8×8×4 promotions (`q, r, b, n`, rank 7→8 in the mirrored frame). */
	moveVocab: 4352,
	fromTo: 4096,
	promotionPieces: ["q", "r", "b", "n"] as const,
	/** The ratings are divided by this and clamped to `[0, 1]` inside the model. */
	eloScale: 5000,
	eloMin: 0,
	eloMax: 5000,
	inputs: { tokens: "tokens", selfElo: "self_elo", oppoElo: "oppo_elo" },
	outputs: { move: "move_logits", value: "value_logits" },
} as const;

/**
 * Where Maia selects, which size, and how the distribution is turned into a move. Every number
 * here is a calibration knob; `docs/qa/maia-selection-2026-09-11.md` records what each was set
 * from.
 */
export const MAIA = {
	/** Inclusive Maia-led boundary; these product settings are not measured playing Elos. */
	eloMax: 3000,
	/** Maximum self-rating supplied to the model; actual opponent rating stays unchanged. */
	conditioningEloMax: 3000,
	/** Tighten verification gradually while retaining the existing policy through 2800. */
	upperVerification: { fromElo: 2800, fullElo: 3000, maxCpLoss: 80 },
	/**
	 * Size by target Elo, nearest band at or below the ceiling. One band since 2026-09-13: the
	 * 79M model answers for every rating (the paper's largest is the most accurate everywhere —
	 * 57.1 % move-match against 55.4 / 56.6 % for the dropped 5M / 23M — and the rating it is
	 * asked about is a model input, so the Elo slider still decides *whom* it imitates). The
	 * band's edge is `eloMax`; the structure is kept so a size is still chosen through one path.
	 */
	sizeBands: [{ maxElo: 3000, size: "79m" }] as ReadonlyArray<{ maxElo: number; size: MaiaSize }>,
	/**
	 * Warmed on connect before the settings are known. The only size, so the cold load (≈ 0.7 s
	 * session create + ≈ 0.3 s warm-up query single-threaded, plus the 156 MB read) is paid once,
	 * from the waiting view, and the game's first move finds it resident.
	 */
	defaultSize: "79m" as MaiaSize,
	/**
	 * How long a query may take before the pipeline gives up on it and selects with the engine's
	 * own policy for that move. Runs in parallel with the search, so a 79M query (≈ 184 ms p50 /
	 * 214 ms p95 single-threaded wasm; up to 4 threads in the browser) is normally hidden behind a
	 * ≥ 400 ms search; a cold session load (≈ 1 s) is the one thing that can trip it, once, when
	 * the offscreen document was recreated mid-game.
	 */
	inferenceBudgetMs: 1_500,
	/**
	 * Sampling temperature over the legal-move distribution: `p^(1/T)`, renormalised. `1` is the
	 * model's own distribution — the owner's ruling (2026-09-11): run the models as advertised and
	 * take the rating they are conditioned on at face value, no cooling and no calibration sweep.
	 * Since H2 (2026-09-13) nothing scales it: the mistakes knob is an Elo offset (`slider`).
	 */
	temperature: 1,
	/**
	 * A candidate outside the engine's scored set cannot be judged by the rails, so the draw is
	 * over scored legal moves and renormalised. The referee search's MultiPV set is widened by one
	 * extra `go searchmoves` on Maia's unscored favourites (the `extra*` knobs below) so a human
	 * favourite the engine did not rank is still scored and can be drawn (2026-09-12, the owner:
	 * "the maia model should be able to more freely choose"). If the combined set still holds less
	 * than this share of Maia's mass, the pipeline selects from what is scored and says so in the
	 * rationale — a diagnostic threshold, nothing gates on it.
	 */
	minScoredMass: 0.35,
	/**
	 * The extra referee search runs when Maia's unscored legal moves (each at `p ≥ minProb`) carry
	 * at least this much of its mass together …
	 */
	extraMassMin: 0.06,
	/**
	 * … or when the single most likely unscored move carries at least this much on its own (at
	 * the current `extraMassMin` the mass rule already implies this one; it is kept so the two can
	 * be re-tuned apart).
	 */
	extraTopProb: 0.12,
	/** The extra search scores at most this many of the unscored moves, Maia's most likely first. */
	extraCandidates: 6,
	/**
	 * The extra search's movetime cap. It is bounded again by what is left of the move's own search
	 * budget and floored at `SEARCH_BUDGET.minMovetimeMs`; a cached referee answer leaves the
	 * whole budget, a fresh one leaves the floor.
	 */
	extraSearchMs: 260,
	/**
	 * Hard tail guard in win-fraction loss (raw, unjittered), by effective Elo — flat outside,
	 * linear between. Maia already plays the rating's mistakes; this only stops the once-a-game
	 * move that turns a won game into a lost one being drawn *because* it had 3 % of the mass.
	 */
	lossCap: [
		[800, 0.55],
		[1400, 0.45],
		[2000, 0.35],
		[2600, 0.25],
	] as ReadonlyArray<readonly [number, number]>,
	/** A move under this probability is never drawn (noise floor of the masked softmax). */
	minProb: 0.005,
	/**
	 * H1 (2026-09-13): the hang rail (never-play rule 4, "the PV shows the opponent capturing next
	 * and the line loses ≥ `hangPieceLoss`") by the Maia rating. Below `offElo` the rail is off — an
	 * 800 hangs pieces to two-move tactics and Maia already carries that as a learned, predictable
	 * event (McIlroy-Young 2020); `lossCap` stays the absolute backstop. Between `offElo` and
	 * `fullElo` it fires with probability linear in E, drawn **once per move** (not per candidate);
	 * from `fullElo` it always fires. Below `cheapViewElo` "hangs" is judged with the one-ply
	 * `hangsOutright` view (a human who does not search does not see the deep refutation either);
	 * from it with the deep-PV `hangsPiece` view.
	 */
	hangRail: { offElo: 1100, fullElo: 2000, cheapViewElo: 1600 },
	/**
	 * H11 (2026-09-13): survivors whose draw weight is at least this fraction of the top weight form
	 * the tie band, the only place the technique/conversion prior may reorder Maia's answer — it
	 * decides only where the human model is close to indifferent, and never re-weights outside it.
	 */
	tieBandRatio: 0.7,
	/**
	 * H13 (2026-09-13), the free approximation of "practical difficulty": when we are behind
	 * (best raw score ≤ `behindCp`, side-to-move POV) the survivors inside the H11 tie band are
	 * weighted by `1 + trickiness`, normalised to mean 1 over the band, so a near-equal candidate
	 * the opponent can only meet one quiet way is preferred to one they answer on autopilot (HvS
	 * §2.9, §11.3). Without the opponent-conditioned Maia query the term is a proxy read off the
	 * lines already on hand: `trickiness = clamp(|Δwin| / minReplyLoss, 0, 1)`, where `Δwin` is the
	 * win-fraction gap between the candidate and the best *other* survivor (how sharp the line is —
	 * the opponent's precise reply is what holds the candidate's score to `cpRaw`), multiplied by
	 * `forcingReplyWeight` when the PV's reply is a capture or a check (a forcing only-reply is easy
	 * to find; a quiet one is the trick). `minReplyLoss` is H13's own threshold ("the second-best
	 * reply loses ≥ 0.25"). Gated because it changes results, not only realism; the pick's quality
	 * sample is left as it is (no `reason` literal exists for it yet).
	 */
	practical: { behindCp: -200, minReplyLoss: 0.25, forcingReplyWeight: 0.5, enabled: true },
	/**
	 * H12 (2026-09-13): tilt as per-game state. After an adverse swing of `swingCp` or more between
	 * the score of our previous pick and this position's top score, the bot tilts with probability
	 * `probAtFloor · clamp((probFloorElo − E) / (probFloorElo − probFullElo), 0, 1)` — `probAtFloor`
	 * at or below `probFullElo`, zero at or above `probFloorElo` — and while tilted the Maia rating
	 * carries a further `elo` penalty (through the same capped context channel as ambiguity) for
	 * `moves` moves, this one included.
	 */
	tilt: { swingCp: 150, elo: 100, moves: 3, probFloorElo: 1400, probAtFloor: 0.5, probFullElo: 800 },
	/** The opponent rating when none is known: our own effective rating (a mirror match). */
	oppoFallbackSelf: true,
	/**
	 * H2 (2026-09-13): the user's mistakes knob (`Settings.strength.blunderScale`, 0–2, default 1)
	 * is an **Elo offset** on the rating Maia is asked about and the rails judge at, not a
	 * temperature: `ΔE = eloSpan · (blunderScale − 1)` — slider 0 plays `eloSpan` above the target,
	 * slider 2 `eloSpan` below. Tempering heats the whole distribution uniformly (a 6× boost of the
	 * never-played tail at T = 1.5), which is engine noise, not human error; asking for a lower
	 * rating moves mass the way the population moves it. `temperature` stays 1.
	 */
	slider: { eloSpan: 250 },
	/**
	 * H5 (2026-09-13): a human's effective strength on *this* move is the rating minus what they
	 * are giving it. Each term is 0…1 and costs at most its Elo weight; the clock and think terms
	 * interact multiplicatively (Cüvitoğlu 2026: the product explodes, not the sum), and the total
	 * is capped so the query stays inside Maia's calibrated range. The pipeline computes the clock
	 * and think terms before the query (`SelectionContext.contextEloPenalty`); the selector adds
	 * the ambiguity term from Maia's own entropy after the answer.
	 */
	context: {
		/** Elo at full clock pressure (clock at 0 of the base; `clockPressure` = 1 − clock/base). */
		clockElo: 120,
		/** Elo at the shortest think (`estimatedThinkMs` at 0 of the class base). */
		thinkElo: 100,
		/** Extra Elo when both clock and think terms are high (their product). */
		interactionElo: 130,
		/** Elo at maximal ambiguity (normalised Maia entropy 1). */
		ambiguityElo: 120,
		/** Total penalty cap in Elo. */
		maxPenalty: 350,
		/** Elo rating floor of any Maia query or rail judgement. */
		eloFloor: 400,
	},
	/** Above the Maia-led boundary, human preferences choose among progressively closer engine lines. */
	prior: {
		eloMax: 3200,
		gapCp: { start: 12, end: 4 },
		/** Weight floor lets an engine continuation survive when Maia assigns it negligible mass. */
		floorWeight: 0.02,
		size: "79m" as MaiaSize,
	},
} as const;
