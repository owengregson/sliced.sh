# Timing-model evaluation data pipeline (Appendix D §3b.2, §6; Part I §8.6)

Builds the Lichess `%clk` evaluation set the conformance harness (Task 33) uses to compare the
extension's generated `MoveHoldTime` distributions against real human think times. **No model is
trained for the shipped product** — the timing head is ChessMimic (§8.4b item 6) with the v1
parametric head as fallback; `04_train.py` / `05_export.py` exist only so the Appendix D v2-MLP
experiments stay reproducible.

Nothing here runs in the extension or in `bun run check`. Python 3.10+, dependencies:
`zstandard`, `python-chess`, `numpy` (and `torch` for the optional 04/05 steps).

| Step | Script | Input → output |
|---|---|---|
| 1 | `01_download.sh [--out DIR] [YYYY-MM …]` | `database.lichess.org/standard/lichess_db_standard_rated_YYYY-MM.pgn.zst` → `data/raw/` |
| 2 | `02_sample.py RAW.zst… --out data/sample.jsonl --per-cell 60000` | reservoir sample per (rating bucket × tc_class); keeps `TimeControl ∈ {60+0,120+1,180+0,180+2,300+0,300+3,600+0,600+5,900+10}`, Elo 700–2700, non-Arena, ≥ 20 plies, every move with `[%clk]` |
| 3 | `03_features.py data/sample.jsonl --out data/features.jsonl [--engine stockfish]` | per-ply `think = clk_prev − clk_now + inc` for the modelled side (plies 0–1, negative/`moretime` and > 600 s dropped) plus the Appendix D §2 features; engine features need Stockfish MultiPV 4 at depth 10 (`LIMITS.featureDepth`) |
| 4 | `04_train.py data/features.jsonl` (optional) | 28→96→96→32 FiLM MLP, masked CE, 5 % hold-out by game id |
| 5 | `05_export.py data/v2-mlp.pt` (optional) | float16 JSON weights |
| 6 | `06_eval.py data/features.jsonl SIMULATED.jsonl [--filter allie] [--out report.json]` | interval NLL, CRPS, marginal shape (quantiles, spike/tail mass, Hill index) per rating × tc × phase × clock bucket, and the real-vs-simulated per-game classifier AUC |

Simulated rows come from the extension's timing log (`LOCAL_KEYS.timingLog`, exported from the
Engine view) or from the Task 33 harness driving `TimingModel` over the sampled games: one row per
ply with `think` (= `TimingPlan.thinkMs / 1000`), `clock_s`, `opp_clock_s`, `tc`, `phase`, `elo`,
`game`, and optionally the predictive distribution (`pred_buckets` + `bucket_edges`, or
`pred_lognormal = [mu, sigma, p_spike, p_tail]`) for the NLL/CRPS columns.

Acceptance (§8.6): real-vs-simulated classifier AUC ≤ 0.70 for the v1 head and ≤ 0.60 for the
ChessMimic head; think time vs `n_reasonable` correlation ≥ 0.2; tail index within ±0.3 of the
real one.

Parser caveats implemented in `03_features.py` (Appendix D §1.2): Lichess does not run the clock
on either side's first move (plies 0–1 dropped); lag compensation is ignored; negative think
(`moretime`) is dropped; think is capped at `min(clk_prev + inc, 600)`; Arena games are excluded
in step 2 to avoid berserk-halved clocks.
