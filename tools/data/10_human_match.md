# 10 — Human move-match job (§8.1 of `docs/research/human-move-selection-ideas-2026-09-13.md`)

One question, answered against human games and nothing else: **does our selection wrapper make
the bot's move distribution more or less like a human's at that rating?** No model is tuned, no
Elo is claimed. The owner ruled out calibrating Maia; this job is what replaces calibration as the
accept/reject signal for every wrapper change in §4 of the research note.

The rule (§8.1 step 3): *any wrapper step that lowers `E[log q(m_human)]` is making the bot less
human and is rejected, whatever it does to the rating bands.*

Three pieces, all checked in:

| Piece | Where | Runs in `bun run check`? |
|---|---|---|
| corpus sampler | `tools/data/10_sample_lichess.py` | no (needs the Lichess dumps) |
| replay + report | `tools/human-match/replay.ts` (+ `engine.ts`, `maia.ts`) | only its `--fixture` smoke (`tools/human-match/replay.test.ts`, < 1 s) |
| fixed-pool fixture | `test/fixtures/strength/maia-draw.json` via `tools/human-match/make-fixture.ts` | yes — `test/core/strength/maia-fixture.test.ts`, `consistency.test.ts` |

## 1. Corpus (`10_sample_lichess.py`)

Source: the Lichess open database (`database.lichess.org/standard/`), monthly `.pgn.zst` dumps
fetched with `01_download.sh`. **Nothing is downloaded by the sampler.**

Held-out months. Maia-3 was trained on 2023–2025 Lichess blitz
(`docs/research/maia3-feasibility-2026-09-11.md` §5); use months from **2026-01 onwards** and
confirm the exact training window against the upstream README at the pinned commit
(`tools/data/09_export_maia3.py: PINNED_COMMIT`) before trusting a month — a position the model
saw in training inflates every match metric.

Selection, per game:

- `Event` is `Rated Blitz game` or `Rated Rapid game` (tournament and Arena games are excluded —
  berserk halves clocks; correspondence and classical are out of the product's scope);
- both ratings present; every move carries `[%clk]`; ≥ 20 plies;
- each side is a candidate for the bucket its rating is nearest to (1000 / 1300 / 1600 / 1900 /
  2200 / 2500) when within `--bucket-width` (default ± 100) of it;
- reservoir sampling of `--games-per-bucket` (game, side) pairs per bucket (seeded), then **every
  own move** of each kept pair becomes a row. Whole games, not isolated positions, so the lag-1
  loss autocorrelation and the same-piece rate can be computed along real sequences. At ≈ 35 own
  moves per game the default 250 games give ≈ 9 k positions per bucket — the §8.1 target of 5–10 k.

Row schema (JSONL, one object per own move):

| field | meaning |
|---|---|
| `id` | `<gameId>:<ply>`; the key the frame and policy caches use |
| `gameId`, `ply` | Lichess game id; half-moves played before this position |
| `fen`, `historyFens` | the position; the last ≤ 8 positions oldest → newest ending with `fen` (what `maiaHistoryFens` feeds the encoder) |
| `selfElo`, `oppoElo` | the mover's and the opponent's rating (Maia's two conditioning inputs) |
| `humanMove` | the move played, UCI |
| `clockMs`, `oppClockMs` | the mover's clock before the move; the opponent's after theirs |
| `baseMs`, `incrementMs`, `tc` | the time control |
| `lastMove`, `prevOwnMove` | the opponent's last move; the mover's previous move (recapture row; same-piece rate) |
| `thinkMs` | `clk_prev − clk_now + inc` for the mover (Lichess runs no clock on plies 0–1, which are skipped) |
| `eval` | the dump's `[%eval]` after the opponent's move when present (cp; mates mapped like `cpEffective`), else `null` — informational, the replay produces its own referee scores |
| `bucket` | the sampled bucket |

Dependencies: `zstandard` for the first pass; `python-chess` for the second (SAN → FEN/UCI). Both
imports are guarded: without `python-chess` the sampled games are written to `--games-out` and the
script says what is missing.

```
python3 tools/data/10_sample_lichess.py data/raw/lichess_db_standard_rated_2026-01.pgn.zst \
    --out data/human-match/corpus.jsonl --games-per-bucket 250 --seed 10
```

`data/` is the pipeline's working directory convention (`02_sample.py` writes `data/sample.jsonl`);
keep it out of the repository.

## 2. Replay (`tools/human-match/replay.ts`)

For every row, the **full selection wrapper** as the pipeline runs it, with the same modules:

1. **Maia** at `selfElo` = the player's rating and `oppoElo` = the opponent's, the size
   `maiaSizeFor(selfElo)` (or `--size`), through `encodeMaiaInputs → session.run →
   decodeMaiaOutputs` under the vendored onnxruntime-web (`maia.ts`; the parity test proves this
   path). `--maia` runs it; `--policies FILE` reuses a previous run's `--policies-out`.
2. **Referee** (`engine.ts`, the vendored Stockfish 18 smallnet under Bun): the main MultiPV search
   at `--movetime` (default `SEARCH_BUDGET.moveMs.blitz` = 600 ms), depth cap
   `automaticDepthForElo(selfElo)`, breadth `SEARCH_BUDGET.selectionCandidates` by rating
   (20 / 16 / 12), full strength (`refereeElo(…, maia = true)`); then the pipeline's extra
   `go searchmoves` pass for Maia's unscored favourites (`maiaUnscoredMoves` →
   `maiaExtraSearchmoves`, `MAIA.extraSearchMs`), merged with `mergeLines`; and, when the pool never
   ranked the human move, one single-root search of it — kept **outside the pool**, used only for
   the human baseline. `--engine` runs it; `--frames FILE` reuses `--frames-out`.
3. **Selection**: `--draws` (default 2000) seeded `selectMove` calls per position with the
   production `SelectionContext` (clocks, base, increment, last move, `hybrid` mode, the engine's
   bestmove, `maia` + `maiaExtra`, fresh per-game state each draw) → the empirical `q(m)`, the
   source counts, and the mean `maiaMeters`.

```
bun tools/human-match/replay.ts --corpus data/human-match/corpus.jsonl --engine --maia \
    --frames-out data/human-match/frames.json --policies-out data/human-match/policies.json \
    --draws 400 --out data/human-match/report.md --json data/human-match/report.json
# a wrapper change, same corpus, same frames, same policies:
bun tools/human-match/replay.ts --corpus data/human-match/corpus.jsonl \
    --frames data/human-match/frames.json --policies data/human-match/policies.json \
    --draws 400 --out data/human-match/report-after.md --json data/human-match/report-after.json
```

Smoke (no corpus, no engine, no model): `bun tools/human-match/replay.ts --fixture --draws 200`
replays the checked-in fixture with a **synthetic** human move per position (one seeded draw from
Maia's own distribution) — every metric path runs, the numbers mean nothing. The same run with
`--draws 20 --limit 30` is the test in `tools/human-match/replay.test.ts`.

## 3. Metrics (per bucket; every secondary number for the bot *and* for the humans of the bucket)

| metric | definition |
|---|---|
| `E[log q(m_human)]` | mean log of the wrapper's probability of the human move, add-half smoothed over the legal moves: `(count + 0.5) / (N + 0.5·L)` so an undrawn human move is finite |
| `E[log p(m_human)]` | the same for raw Maia `p` (floored at 1e-9) — the baseline the wrapper must not fall below |
| top-1 agreement | `argmax q = m_human`; also for `p` |
| `E[q(m_human)]`, `E[p(m_human)]` | expected agreement |
| ACPL | `Σ_m q(m)·max(0, cp_best − cp_m)` with `cpEffective` (mates mapped); the human's from the pool line or the single-root score |
| inaccuracy / mistake / blunder | win-probability drop ≥ 0.10 / 0.20 / 0.30 (Lichess), `winProb` on `cpEffective` |
| piece hangs per 40 moves | `hangsPiece` (the selector's never-play rule 4) × 40 |
| mate found | over positions where the frame holds a forced mate for the mover: `Σ q` on mating lines |
| same piece as last move | over positions with `prevOwnMove`: the drawn move starts where the previous own move ended |
| lag-1 loss autocorrelation | Pearson over consecutive own moves of a game: the bot's `E_q[loss]` sequence; the human's loss sequence |
| meters | mean `klFromMaia`, `railedMass`, `unscoredMass`; Maia's share of the draws |

Bot values are expectations under `q`, so they need no extra sampling noise; the human values are
the targets. Report by clock quartile / ambiguity quartile / phase (§8.1 step 4) by filtering the
corpus before the run — the sampler carries `clockMs`, `thinkMs` and `ply` for exactly that.

## 4. Cost

- Referee: ≈ 0.6 s main + 0.15–0.26 s extra + 0.6 s for an unscored human move (rare above 1600) ≈
  0.8–1 s per position → ≈ 12–14 CPU-hours for 50 k positions, trivially parallel across files.
  Cache with `--frames-out`; a wrapper change re-uses the frames.
- Maia: 20 / 50 / 180 ms per query by size, single-threaded.
- Draws: `selectMove` costs ≈ 0.2 ms on an ordinary position but ≈ 2.7 ms on a won one, because
  `conversionPool` replays up to 12 PV plies of every candidate through chess.js on each call (a
  per-move cost in production, a per-draw cost here). 2000 draws ≈ 0.4–5 s per position;
  `--draws 400` (SE ≈ 0.025 at `q = 0.5`) is enough for the accept/reject rule and cuts a full
  sweep to ≈ 4 CPU-hours.

## 5. What this does not answer

Achieved Elo, win rates and anything that needs paired games (§8.4 of the research note). The
fixture tests (`maia-fixture.test.ts`, `consistency.test.ts`) are internal-consistency checks on a
fixed pool, not measurements of humanness; only this job with a real corpus is.
