export const LIMITS = {
	eloMin: 400,
	/** Product strength scale; the top endpoint requests maximum available engine strength. */
	eloMax: 3800,
	/*
	 * The small → full network switch is not a second number: it is `MAIA.eloMax`, the product's one
	 * strength division (owner, 2026-09-15). `LIMITS.nnueSmallEloMax` (3200) is gone with it.
	 */
	engineEloMin: 1320,
	engineEloMax: 3190,
	multiPvMin: 1,
	multiPvMax: 8,
	depthMin: 6,
	depthMax: 30,
	threadsMin: 1,
	threadsMax: 8,
	/**
	 * Owner, 2026-09-13: "default our stockfish to 8 threads, 64mb hash on most devices". The
	 * `auto` thread setting resolves to `min(threadsDefault, navigator.hardwareConcurrency)`, at
	 * least 1 — the device's core count is the only cap (`optionsForSettings`); an explicit
	 * `engine.threads` still wins. The Emscripten glue spawns pthread workers on demand, so no
	 * pool size has to match this.
	 */
	threadsDefault: 8,
	hashMbMin: 16,
	/** Default transposition table (`DEFAULT_SETTINGS.engine.hashMb`), same owner instruction. */
	hashMbDefault: 64,
	hashMbMax: 128,
	blunderScaleMin: 0,
	blunderScaleMax: 2,
	/**
	 * 2026-09-13: the preview-selection slider carries its own Off position at 0 (the former
	 * `execution.previewSelects` segment folded into it); 0.05 is the first audible rate.
	 */
	previewSelectScaleMin: 0,
	previewSelectScaleMax: 2,
	autoQueueMinutesMin: 1,
	autoQueueSessionMinutesMax: 240,
	autoQueueBreakMinutesMax: 180,
	timingLogMax: 200,
	/** Task 26: SW-side ring of recent `LogEntry`s streamed to the panel (Appendix H.2). */
	logRingMax: 500,
	/** Task 26: nps sparkline sample ring (one sample per `UI_TIMINGS.sparklineSampleMs`). */
	npsSparklineSamples: 60,
	/** Engine view: Maia-3 inference-time ring, one sample per recommendation the model answered. */
	policySparklineSamples: 60,
	/** Task 26: |actual − planned| / planned above this renders a `warn` rationale row. */
	timingLogDriftWarn: 0.5,
	analysisCacheEntries: 256,
	/** Finished game identities retained with statistics to ignore lost-receipt replays. */
	finishedGameHistorySize: 256,
	cpClamp: 1000,
	/** Lichess win-probability logistic `win(cp) = 1/(1+e^(−k·cp))` (§7.2, Appendix E §7.2). */
	winProbK: 0.00368208,
	/** The timing model's fixed feature depth `D_f` (§6.5, Appendix D §2). */
	featureDepth: 10,
	/** Smallnet weights bundled in `assets/engine/` (§6.1); `nn-<sha256[0:12]>.nnue`. */
	nnueSmallName: "nn-61e7af4bb97d.nnue",
	/**
	 * The `sf_19` full build's network, bundled as a raw installed asset. Stockfish 19 retired the
	 * secondary net that lived inside the full build (SF18 loaded `[big, small]`), so this is a
	 * one-element list: the loader sets whatever `getRecommendedNnue` reports, so the count is data,
	 * not structure. Kept as a list because `ENGINE_NNUE_SOURCES`, `BUNDLED_NNUE` and the packaging
	 * rules all derive from it, and a future build may ship more than one again.
	 */
	nnueBigNames: ["nn-1a298aa575a0.nnue"],
	/** Raw bytes per `nnue-chunk` / `model-chunk` relayed SW → offscreen (before base64) (Task 12/34). */
	nnueChunkBytes: 4_194_304,
	/** Task 34: onnxruntime-web wasm threads for the timing head (capped `hardwareConcurrency`). */
	timingInferenceThreadsMax: 4,
	/** Task 34: ChessMimic band sessions kept loaded at once (LRU; ≈ 36 MB fp32 each). */
	timingSessionsMax: 2,
	/**
	 * Maia-3 policy sessions resident at once (2026-09-11). Exactly one: the fp16 weights unfold
	 * to fp32 inside the session (≈ 20 / 90 / 310 MB for 5M / 23M / 79M), so a second resident
	 * size is a memory risk in the offscreen document, and only one size answers for a target
	 * Elo at a time. Warming a different size evicts the resident one first.
	 */
	policySessionsMax: 1,
	/**
	 * onnxruntime-web wasm threads for a Maia-3 session (capped `hardwareConcurrency`). The
	 * transformer's matmuls parallelise well, and the query runs beside a Stockfish search that
	 * has its own threads, so this stays at the timing head's cap rather than taking every core.
	 */
	policyInferenceThreadsMax: 4,
	/** Shared `WebAssembly.Memory` initial pages (64 KiB each) tried in order (§6.3). */
	engineMemoryInitialPages: [2560, 1536, 1024],
	/**
	 * Shared `WebAssembly.Memory` maximum pages: 2 GiB, the maximum both engine builds declare. The
	 * old 512 MiB cap predates the full network (2026-09-15): loading it copies the ~140 MiB network
	 * object again and peaks at 509 MiB with the two nets set back to back, 585–646 MiB with a gap
	 * between them. At the cap `memory.grow` fails and a pthread worker traps — the owner's "table
	 * index is out of bounds". Reproduced in Chrome 152: 17/20 boots at 512 MiB with a 300 ms gap,
	 * 0/20 at 2 GiB; two full instances together peaked at 1.3 GiB. A larger maximum reserves no
	 * more: Chrome refused shared memories by count, at the same count for 512 MiB, 1 GiB and 2 GiB.
	 */
	engineMemoryMaxPages: 32768,
	/** Task 23: devices one key may be active on (Appendix F §7.2 "already active on 2 devices"). */
	licenseMaxDevices: 2,
	/**
	 * How many times one game may republish an unmoved position because the colour it answers
	 * *changed* (`SnapshotPublisher.apply`). A correction is rare and authoritative — the site's own
	 * `getPlayingAs()` overturning an earlier reading — so a handful is generous; the cap exists
	 * because every other republish trigger is structurally one-shot and this one is not, and an
	 * alternating answer would otherwise start and abort a pipeline (and flood the game port with
	 * marks) once per reading, for ever.
	 */
	colourCorrectionsPerGame: 3,
} as const;

/**
 * Display ranges for the settings sliders whose values are unbounded scales in storage
 * (`settings-storage` keeps them as finite numbers; the Settings view clamps what it writes and
 * shows to these). Ranges that exist in `LIMITS` are used from there (Task 25).
 */
export const SETTINGS_RANGES = {
	personaEloOffset: { min: -400, max: 400, step: 10 },
	/**
	 * `timing.baseSpeed` — **higher is faster** (owner, 2026-09-15). The reciprocal span of the
	 * `timing.speedScale` slider it replaces (0.25…3, which meant 4×…0.33× the pace): 1/3 rounded
	 * down to the step is 0.35, 1/0.25 is 4. Same 0.05 grid, so a migrated value lands on or
	 * beside a tick.
	 */
	baseSpeed: { min: 0.35, max: 4, step: 0.05 },
	varianceScale: { min: 0, max: 2, step: 0.1 },
	premoveTendency: { min: 0, max: 1, step: 0.05 },
	longThinkFrequency: { min: 0, max: 3, step: 0.1 },
	motorSpeed: { min: 0.5, max: 2, step: 0.05 },
	/** The preview-selection rate; 0 is the Off position (`LIMITS.previewSelectScaleMin`). */
	previewSelectScale: {
		min: LIMITS.previewSelectScaleMin,
		max: LIMITS.previewSelectScaleMax,
		step: 0.05,
	},
	/**
	 * The accuracy offset (`strength.blunderScale`, H2) is shown in Elo: ±`MAIA.slider.eloSpan`
	 * around the target in steps of this many Elo. The leaf itself stays 0–2 in storage
	 * (`LIMITS.blunderScaleMin/Max`); `rows.ts` maps display ↔ storage.
	 */
	accuracyOffsetStepElo: 25,
} as const;

/**
 * §3.6: the license gate is force-valid unless `build.config.json`
 * `licenseEnforce` is true. The only runtime reference to the define.
 */
export const LICENSE_FORCE_VALID = !__SL_LICENSE_ENFORCE__;
