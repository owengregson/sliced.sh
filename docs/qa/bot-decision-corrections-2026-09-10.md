# Bot decision corrections — 2026-09-10

Move history now accompanies the engine position. The adapter supplies the SAN list; the session
replays it from the starting position and checks the entire canonical FEN, including move counters.
If the list is unavailable or stale, the session keeps the contiguous moves it actually observed.
A missing transition resets that partial history at the current board instead of inventing moves.
Opponent pondering, predicted positions and premove searches carry the same validated history.

The analysis cache distinguishes reversible position history and the fifty-move clock. A cached
evaluation from an earlier occurrence cannot silently answer a later repetition. Pawn moves,
captures and lost castling rights discard unreachable repetition history, so useful cache hits
after irreversible moves still work. Restricted searches cannot populate the unrestricted cache.

When the searched evaluation is at least +150 cp, move selection avoids revisiting positions if a
legal searched alternative retains at least +80 cp and gives up at most 150 cp. This includes a
third occurrence the opponent could claim with a legal reply absent from the principal variation.
The same rule applies to every selection mode and projected premove positions. Draws remain an
option when the searched alternatives lose or discard the advantage. Unknown history before an
attachment cannot be recovered without a complete valid move list; the engine cannot promise a
win when every sound continuation draws.

Recognised recapture/trade attempts now use their own higher propensity (about 66% at Elo 1800
with a low generic premove propensity, rising with Elo/persona). Ordinary speculative replies keep
the earlier probability. A lower prediction threshold is permitted only for validated queued
recaptures: the destination must currently hold our piece, and every other legal reply that allows
the queued move must also produce a compatible exchange. A quiet rook block is not safe to queue
merely because it would be the only legal move after one prediction. Such moves remain fast replies
after the expected position actually arrives. Bullet/blitz and the existing strength gate remain.

Shallow-search retries now share the original wall-clock search allowance. They cannot spend a
second full search budget after the first one has exhausted it. Newer clock-only snapshots update
the session without discarding the recommendation or restarting the search.

Opponent time trouble has a separate layer after the timing model and move-selection policy.
Its intensity accounts for both clocks, the starting control and increment. At substantial
pressure, deliberate injected blunders stop; a safe searched check, recapture or capture within
35 cp of the best line can replace a quieter recommendation. Forced mating lines and the
repetition safeguards take precedence. Changed choices explain the clock strategy in their
rationale. An increment can eliminate this pressure even when the displayed clock is small.

Automated coverage includes actual and opponent-claimable threefolds, preserving losing-position
draws, rejecting stale same-board SAN histories, history-aware cache misses and irreversible cache
hits, reduced search-budget retries, premove queue safety, clock-based selection, and queued and
fallback premove simulator scenarios. Live-site feel and clock/network latency still require a
real browser game; simulator results do not establish those properties.

The strength setting now reaches 3650. Both bundled Stockfish binaries report native UCI Elo
support from 1320 to 3190, verified by executing their actual WASM handshakes. Values above the
native ceiling disable Stockfish's strength limiter. At 3650 the selector takes the strongest
searched continuation after repetition safety, with no deliberate mistake or opening-book
substitution. This endpoint means maximum available engine strength, not a measured human Elo.
The high-Elo temperature curve no longer rises again above its 2500 pivot.

Above 3200, the controller automatically selects the full engine and loads its two NNUE files;
3200 is a product cutoff, not a native Stockfish calibration claim. Explicit Big also selects it
below the cutoff. The verified networks total 112,439,224 decoded bytes and persist in OPFS or
IndexedDB. Both official mirrors returned HTTP 200 after their redirects; actual downloads
matched each filename's SHA-256 prefix. The full WASM loaded both networks and completed an
unlimited-strength depth-10 search with no engine errors. Compressed transfer sizes can differ
from the decoded bytes retained in storage. Downloads
use the existing progress, stall and checksum checks. A network switch cancels active searches,
clears cached evaluations and holds new searches until the engine is ready with all options
replayed. A queued search can be cancelled immediately, including when a new game begins.
Download failure fails that search visibly; it does not silently substitute the small engine.
Changing back to a lower target cancels the pending configuration wait and restores smallnet.
