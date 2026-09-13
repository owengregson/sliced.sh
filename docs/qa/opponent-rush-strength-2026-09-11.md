# Opponent-only rush strength — 2026-09-11

The earlier opponent-pressure adjustment reduced effective Elo by at most 100.
That barely changed low-rating ordinary choices and did nothing to the custom
noise/temperature floors above 2500. High-rating Hybrid deliberately leaves its
native-choice branch under pressure, so the saturated custom cutoff could then
return almost exclusively the strongest searched move. A short search with a
narrow candidate pool compounded this effect.

The new adjustment applies only to opponent-only races: the opponent is below
10 seconds, our clock can afford the separate rush window, and we have more than
a lone king. Existing increment attenuation and the pressure threshold apply.
Own-clock emergencies, lone-king play and ordinary opponent pressure keep their
previous selection behavior. Normal-clock high-rating Hybrid still retains its
guarded native choice.

## Policy

The opponent-only branch reduces the ordinary policy's effective input by up to
350, adds up to 0.05 to its temperature and up to 100 cp to its ordinary gap. These
are policy inputs, not a measured reduction in human Elo. The direct temperature
lift works even when the rating parameters are already at their high-end floors.
Newly admitted ordinary alternatives are bounded by the larger of the previous
ordinary gap and 200 cp raw searched loss, retaining existing broader low-rating
pools. No fixed rank quota or minimum number of errors is imposed.

Explicit-error frequency, perception noise and the forced-loss threshold retain
their previous pressure-adjusted rating inputs. The added penalty therefore
changes ordinary move probabilities without increasing deliberate large-error
injection. Winning-position filtering may expose up to 200 cp of alternatives at
high ratings, but only among the already winning, non-drawing continuations.
Immediate/shortest searched mates, repetition, stalemate and retained-win guards
continue to apply.

Otherwise-comparable rushed choices retain raw loss/rank diagnostics but have
`quality.eligible=false` and reason `opponent-rush`, keeping them out of normal
target-band warnings. Existing mate, shallow, bounded and incomplete exclusions
retain their more specific reasons.

The search integration requests at least 12 candidates for an opponent-only rush,
while honoring a larger configured or rating-driven population and the number of
legal moves. Its wall-clock budget is unchanged by this strength policy.

## Native short-search evidence

Six actual bundled Stockfish 18 smallnet searches used one thread, 32 MB hash,
native targets 1650/2800, 3+0 with our clock 90 s and the opponent 1 s. All returned
complete coherent frames with 20/12 roots. The requested budget was 33 ms; measured
search wall time was 36–58 ms and completed depth was 3–6. Search depth caps followed
the new active-rating policy (16/25); those caps did not bind these short searches.
No native errors occurred.

Each fixed native result was replayed 300 times with seed `pressure-comparison`,
default Hybrid priors, and explicit blunders disabled. “Before” is the selector
captured before this rush change; both selectors received exactly the same pool.

| Position | Target | Top-1 before → after | Mean rank before → after | Mean searched gap before → after |
|---|---:|---:|---:|---:|
| Start |1650|5.7% →5.0%|9.81 →10.36|28.6cp →31.5cp|
| Start |2800|24.7% →16.3%|3.32 →5.42|12.3cp →25.8cp|
| Ruy Lopez |1650|6.3% →5.3%|8.81 →9.72|57.9cp →66.8cp|
| Ruy Lopez |2800|33.7% →16.3%|2.75 →5.27|14.8cp →37.2cp|
| Kiwipete |1650|24.7% →12.7%|6.76 →9.17|125.3cp →160.0cp|
| Kiwipete |2800|98.7% →41.7%|1.01 →2.68|1.0cp →62.2cp|

These are gaps in shallow, fixed candidate scores, not calibrated ACPL or achieved
Elo. Five frames were below the comparable-depth threshold. A near-equivalent
opening pool naturally changes searched gap less than the tactical pool.

The captured native result is durable at
`test/fixtures/strength/stockfish18-opponent-rush.json`. Full before/after counts,
rationale and native commands are in `/tmp/sliced-pressure-audit/results.json`;
the bounded probe is `/tmp/sliced-pressure-audit/probe.ts`.

## Winning endgame

A deterministic legal rook-and-pawn conversion fixture used searched scores
600, 580, 480, 350, 100 cp. Six hundred samples per policy/rating used seed
`endgame-comparison` and no injected blunders.

| Target | Mean searched gap before → after | Mean rank before → after |
|---|---:|---:|
|1650|41.4cp →65.6cp|1.82 →2.09|
|2800|7.8cp →30.3cp|1.39 →1.75|

At 2800, the previous 75 cp conversion window exposed only the top two moves. The
new rush window also selected the still-winning 120 cp-loss king move 114/600 times,
while excluding the 250 cp concession and the continuation that discarded the
established win. The original low-rating window already included the 250 cp move;
that candidate remains available at 1650. This fixture verifies policy behavior,
not the true evaluation of a game or a win-rate improvement.

Exact fixture, counts and command output are saved in
`/tmp/sliced-pressure-audit/endgame.json`; runnable comparison is
`/tmp/sliced-pressure-audit/endgame.ts`.

Focused validation passed:33 strength tests across opponent rush, ordinary
pressure, high-rating native choice, conversion, repetition and rating
sensitivity; TypeScript, scoped Biome and whitespace checks. The existing modest
pressure test now uses12 seconds (outside the opponent-only race), while the
existing emergency cap test explicitly gives our clock1 second. The new suite
covers the separate stronger opponent-only behavior without weakening those
earlier contracts.
