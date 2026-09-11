# Clock races, premoves, and conversion

The post-model clock policy is shared by move timing, search budgets, move selection, and the
session. It activates below 10 seconds on the opponent's clock, below 5 seconds on our clock,
or with only our king remaining in a timed game. Increment reduces opponent urgency. Unknown
clocks and untimed games do not trigger a clock race.

Urgency scales the normal search budget down to 30–100 ms and samples a shorter move window,
roughly 60–300 ms in a zero-increment race. Extremely depleted own clocks impose a further cap.
The hand uses that budget for approach and drag, retaining press/release acknowledgement,
position validation, and recovery. It skips decorative pauses, wobble, previews, and post-drop
rest. Timing inference is skipped when this policy already determines execution speed. Browser
scheduling, engine startup, geometry changes, and delivery recovery can still add latency.

Safe offered trades use a separate near-certain premove probability and an 80–220 ms entry delay;
clock races use 0–60 ms. Each predicted capture must pass the same confidence gate as other replies;
legal captures absent from the fresh search are not speculative premove candidates.
The queue gate validates every legal opponent reply: an unexpected reply must invalidate the
recapture or leave a safe exchange. A lone king can queue a move only when it remains legal after
every legal opponent reply. Otherwise the own-turn path chooses a legal move and executes quickly.

Known immediate checkmates and searched forced mates take priority in every strength mode.
Winning endgames compare raw searched scores, avoiding the old saturation that made +10 and +30
equivalent. Conversion rejects searched repetitions, stalemates, insufficient-material draws, and
fifty-move draws when a searched winning alternative exists. Safe pawn progress, promotion, king
approach, and restricting a bare king break close evaluation ties. Slight clock-race skill
relaxation is bounded by searched evaluation and does not override mate or conversion protection.

Opponent-turn cursor activity starts after a stationary interval. Low clocks, queued replies,
forced replies, mate sequences, and lone-king positions keep exploration on our own replies.
Clock policy is refreshed from the running clock between bouts, even without a new board position.

Validation includes real service/executor simulation with actual press and release under 300 ms
for opponent time trouble, own time trouble, and a lone king; search commands below 100 ms;
successful board changes and verification; clock-only exploration updates; and delayed release
acknowledgement races for queued premoves. Statistical tests retain ordinary timing variability
while checking that urgent moves can pass below the former physical floors. Conversion tests and
browser/UI evidence accompany their respective components. These checks demonstrate the corrected
decision paths, not an empirical online checkmate rate.

The conversion audit found two concrete selection causes: `engine-elo` returned before the mate
guard, and the sampling guard protected only mates within three moves while deliberately missing
some low-Elo mates. Regression cases now preserve longer forced mates in all three modes and
select an actual legal mate even when an incomplete score or a third-ranked shallow line would
otherwise hide it. The full strength suite passes 151 tests; the recommendation suite passes 22.
The former 40,000-sample policy test remains intact. A one-position cache of legal mates avoids
repeated legal-move generation for each MultiPV candidate.

Real Stockfish 18 full-network validation ran with `go movetime 30`, MultiPV 6 on our turn and 1
for the defending side, validated full move history, target Elo 800, `engine-elo` selection,
blunder scale 100, and an opponent clock of 1 second. Both NNUE files passed their SHA-256 name
checks. Three winning positions converted with no engine stderr:

| Position | Starting FEN | Finish |
| --- | --- | --- |
| King and queen | `7k/8/8/8/8/5K2/8/6Q1 w - - 0 1` | Checkmate in 9 plies |
| King and rook | `7k/8/8/8/8/5K2/8/6R1 w - - 0 1` | Checkmate in 11 plies |
| Winning promotion | `7k/5K2/6P1/8/8/8/8/8 w - - 0 1` | Promotion, then checkmate in 5 plies |

The local reproduction command was `bun --preload ./test/setup.ts /tmp/sliced-conversion-wasm.ts`;
the move-by-move results are `/tmp/sliced-conversion-wasm-final.log`. The full run took 1.1 seconds,
with measured search-plus-selection time of 24–46 ms on our turns. These are local checks on
specific positions; they do not establish a calibrated Elo or game-wide conversion rate. A
separate pawn-ending fixture evaluated at 0.00 and drew, illustrating why being a pawn ahead alone
does not establish a forced win.

Safe trade propensity is about 97–99% once the candidate is eligible, including low-Elo and slow
time controls; an explicit zero premove propensity is still respected. This is an attempt rate,
not a prediction that the opponent accepts the trade. Fresh distinct root lines at depth 4 or above
must provide at least two alternatives (or every legal reply when forced), at least 60% heuristic
reply confidence, and no more than 45 cp loss against the best root score. Bound, duplicate, shallow,
and missing-score lines cannot manufacture prediction confidence. An unforced recapture also rejects
an exchange losing the opponent more than one pawn after crediting its best immediate takeback on
that square. This is a conservative material filter, not a proof that deeper compensation is absent.
Neutral rapid positions use a cheap legal-offer gate before prediction searches. Tests now reject
unlikely second-ranked trades and unsearched or optimistically scored queen donations, while retaining
frequent equal-piece trades, balanced takeback exchanges, and universally legal king escapes. The representative
full-board trade validation plus fake search took about 21 ms locally. Tactical safety remains
bounded: the queue checks legal branches, immediate mating replies, and recapturing a lower-value
piece with a more valuable piece that could immediately be taken; it is not a complete tactical
proof against arbitrary deeper play.

The legality and draw checks follow the rules of the supported site: Chess.com cancels a premove
that becomes illegal, while stalemate immediately draws the game. See
[Chess.com premove behavior](https://support.chess.com/en/articles/8562432-what-are-pre-moves-and-how-do-they-work),
[Chess.com stalemate rules](https://support.chess.com/en/articles/8557490-what-is-stalemate), and
[FIDE Laws of Chess](https://handbook.fide.com/chapter/e012023). A lone king's universally legal
queue is a timing mechanism; it does not create mating material or guarantee survival.
