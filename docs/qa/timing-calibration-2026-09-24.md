# Think-time calibration against chess.com players (2026-09-24)

Owner: at high Elo (for example 2700 vs 2700) the bot is too slow on book and opening moves and on
obvious recaptures. Humans often move in under 1 s; the bot takes more than 1 s. The request was to
solve it generally, by calibration: the bot's think times should match real chess.com players of the
advertised rating, per time class × rating × situation, and be verified on held-out players.

This note covers what was measured, what changed in the product, and how it was verified. The
harness is `tools/timing-calibration/`; its README has the pipeline and the commands. Every number
below can be reproduced from `data/timing/calib/`.

<!-- RESULTS -->
