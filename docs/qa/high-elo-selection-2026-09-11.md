# High-rating selection probe — 2026-09-11

A reported win at a selected 2700 against a site bot labeled 2800 prompted this
bounded follow-up. The active derived rating still needs to be distinguished
from the saved fixed target when opponent matching is enabled. A single game and
the opponent's label do not measure the bot's playing rating.

No production parameters were changed in this probe. Sixteen native Stockfish 18
smallnet searches ran through the current UCI parser/controller: four positions
at UCI_Elo 2600, 2700, 2800 and 3000, strength limiting enabled, one thread, 32 MB
hash, and the production 600 ms / depth 18 blitz budget. Three positions were
Black to move (after 1.e4, a Ruy Lopez position, an Italian position); the fourth
was Kiwipete. Every result was a complete coherent MultiPV frame.

For each fixed result, 1000 seeded Hybrid/Balanced choices were sampled with both
clocks at 90 seconds in 3+0, form zero and default error scale. Additional replays
held the entire candidate pool and native bestmove fixed while varying only the
requested selector rating.

## Exact policy boundaries

Perception noise reaches its 8 cp floor at 2400. Temperature reaches 0.02 at 2500.
The ordinary loss cutoff reaches 60 cp at 2200, prior exponent reaches 0.2 at 2200,
and base injected-error rate reaches 0.005 at 2500. These settings consequently
plateau across 2600–3000. All four same-pool replays produced exactly identical
move-count distributions at all four ratings.

Before the correction below, the production candidate request changed from twelve roots at 2600 to six
above 2600 for a normal 600 ms blitz search. Different search depths and narrower
pools can change behavior independently of rating noise. For example, after 1.e4
as Black, the twelve-root search at 2600 yielded 17.78 cp mean sampled loss. The
six-root searches at 2700 and 3000 yielded identical 7.48 cp mean loss. This is
candidate/depth evidence, not achieved Elo.

## Why rank quotas do not solve the problem

At 2700 in the Black Ruy position, all six candidates spanned just 12 cp. Sampling
only 18.8% top-1 still produced 5.11 cp mean loss. At 2800 after 1.e4, the native
bestmove ranked fifth but was only 24 cp behind first. Rank has no fixed quality
meaning across positions.

The tactical example exposed a more concrete discontinuity. Its six scores at
2700–3000 were −93, −198, −288, −324, −342 and −356 cp. The second move lost 105 cp,
so the ordinary 60 cp cutoff excluded it. Its win-probability loss was below 0.10,
so the explicit error channel also excluded it as too mild. The sampler therefore
picked the best move 990 times and much larger 195–263 cp errors ten times, never
the second move. At native UCI_Elo 2800 and 3000, Stockfish itself returned that
second move; Hybrid's prior preference could not overcome the ordinary cutoff.

This supports reviewing the interaction between the smooth sampling curve,
ordinary cutoff, native limited choice and explicit error threshold. Raising
random error frequency or assigning fixed second/third-rank quotas would not
address the discontinuity. Any revised high-rating policy needs monotonic,
position-diverse regression evidence and independent game calibration; these four
positions establish neither a human rating nor a win rate.

## Bounded correction

Normal-clock Hybrid now retains the legal native choice once effective Elo reaches
the existing temperature pivot of 2500. This reuses Engine rating mode's guarded
native branch rather than adjusting noise, rank quotas or error probabilities.
The saved UCI_Elo2800 tactical frame is a durable regression fixture:
`test/fixtures/strength/stockfish18-high-elo.json`. Hybrid now retains `d5e6`, the
native second choice with 105 cp searched loss, instead of choosing the best move
or injecting a much larger error. Explicit Persona sampling and Hybrid below the
pivot retain their custom selection. Opponent pressure still applies its existing
bounded accuracy reduction and sampling policy.

The branch preserves immediate and shortest searched mates, rejects a scored
forced loss when a non-mated alternative exists, and cannot restore a native
stalemate or repetition already vetoed by the winning-position guards. A missing
or illegal native move falls back to the best surviving searched move. A legal
native move outside the scored pool remains unranked, with unknown searched loss.
The maximum 3800 setting continues to choose the strongest searched continuation.

High-rating Hybrid now shares native mode's budget-dependent candidate floor,
honoring the configured MultiPV value and legal-move limit. It requests six roots
at the ordinary 600 ms blitz budget both at 2600 and 2700; there is no additional
12-to-6 transition at 2600. The mode transition itself occurs at the existing 2500
pivot. Persona sampling retains its prior candidate breadth. Form affects only
the decision to use native selection, not Persona's breadth bands. Rationale shows
the actual active native target independently of effective form.

The bundled Stockfish 18 advertises a native UCI_Elo ceiling of 3190. Higher active
targets request unlimited search, and this change does not extend native rating
calibration or guarantee a Chess.com/human Elo. Stockfish's official documentation
explains that its limiter biases candidate scores, that MultiPV changes that
candidate population, and that rating comparisons depend on the opponent pool and
time control. [Stockfish FAQ](https://official-stockfish.github.io/docs/stockfish-wiki/Stockfish-FAQ.html#how-do-skill-level-and-uci_elo-work)

Focused validation passed: 60 tests across the selector, captured high-rating
fixture, repetition, conversion, pressure and rating-policy/corpus suites;
31 recommendation tests; six independent native-budget boundary tests; TypeScript
and scoped Biome checks. The native-choice suite explicitly covers the missing,
illegal and unscored native-result cases as well as all mate/draw safeguards.

The complete searches, exact candidate scores, move counts and sent UCI commands
are saved locally in `/tmp/sliced-high-elo-audit/results.json`; the bounded probe
is `/tmp/sliced-high-elo-audit/probe.ts`. No public game was played.
