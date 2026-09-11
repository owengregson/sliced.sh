# Panel quality review — 10 September 2026

The panel now uses a two-row header with persistent text navigation, a clear live-session
summary, a quiet move card, and a page-keyboard reference populated from the user's actual
keybindings. Settings includes search and explicit save feedback. The existing vanilla
TypeScript/templates/token-generated CSS architecture and logo files are preserved.

## Findings corrected

| Finding | Result |
| --- | --- |
| Brand, status and navigation competed for one narrow row; labels disappeared below 420 px. | Brand/status and full-width navigation have separate rows; labels remain visible at 320 px. |
| A live session could display the Game view with Settings still highlighted. | Navigation now reflects the mounted route. |
| Live controls looked broken, and the explanation buried every shortcut in a long banner. | Concise read-only explanation, visible action label, separate keyboard reference near the top, and explicit auto-play status. |
| Header measurement assumed a fixed height. | Live layout measures the actual header, banner and added summary/shortcut blocks before collapsing secondary information. |
| Generic disabled opacity made live status controls hard to read. | Live status remains readable; settings are still locked during a game. |
| The move action showed an empty countdown ring without a schedule. | Countdown rings appear only while counting. |
| Two-line help clipping concealed settings instructions. | Help wraps without clipping at every width. |
| Long settings page was difficult to navigate. | Labeled section chips wrap, and search filters both rows and sections with a clear empty state. |
| A storage write failure left the user looking at a falsely saved value. | Inline saving/saved/error status; failed changes restore the saved value; Saved waits for the final queued write. |
| A queued settings change could begin after a game started or its view closed. | Writes check the live lock and aborted view before starting. |
| Async route mounting could repopulate a disposed panel and mount queued pages. | Disposal aborts the pending mount, runs its eventual cleanup and drops queued routes. |
| Startup remained blank while the service worker connected. | Visible loading skeleton and connection explanation. |
| Engine view doubled the shell's horizontal padding. | Shared alignment across every route. |
| Theme token accent drifted from the required brand orange. | Brand fill/focus token is `#ffa71f`; image assets unchanged. |
| Successful moves played sounds and emitted toasts even with a stable board. | Broadcaster no longer emits successful-move toasts; panel ignores legacy ones; sound player rejects move sounds even when control sounds are enabled. |
| Automatic speech left behind an ineffective switch. | Legacy storage remains compatible, but the dead switch is removed; voice selection always configures the explicit speak shortcut. |
| Conversational copy obscured operational state. | Technical labels such as Waiting…, Thinking…, Saved and Engine diagnostics; concise error and restart messages. |
| Evaluation moved or disappeared on the opponent's turn and at compact sizes. | One fixed 160 × 46 px chip below the live header whenever Eval bar is enabled. Current-position analysis updates it on either turn. A visibly labeled Last eval fallback persists through analysis gaps and resets between games; before the first score it shows —. |
| The rating range stopped at 3200 without explaining engine network selection. | Both rating sliders reach 3650 and show the shared 3200 network divider. Help describes automatic large-NNUE download above the cutoff and identifies the maximum as approximate engine strength. |

## Browser review

Run `bun tools/panel-preview.ts` and open `http://127.0.0.1:4179/?state=live`.
This mounts the actual panel shell, views and components with a deterministic mock Chrome
boundary. No account, game, extension loading or engine is required.

Available states: `live`, `thinking`, `opponent`, `cached-opponent`, `cached-thinking`, `no-rec`, `unarmed`, `disabled`, `crashed`, `settings`,
`engine`, `waiting`, `unsupported`, `login`, `expired`, `update`, and `loading`.
Use `&theme=light` for light-theme review, `&search=premove` to exercise settings search,
`&elo=3650` for the rating ceiling, and `&eval=off` to verify the evaluation setting.

A fresh headless Chrome was used at 320, 360 and 480 CSS pixels. The review covers all routes,
the live waiting/error states, loading, settings search/empty results, and light theme.
Screenshots and the layout audit are under `build-logs/ui-review/` (ignored build artifacts).
The latest pass captures 56 screens and checks identical chip coordinates and dimensions through
active, pondering, analysing, cached and pending evaluation states at each width.
Checks assert no horizontal overflow or unnamed visible buttons. Narrow panels scroll vertically;
the move and stop shortcuts stay near the top. This fixture review does not replace a real
extension/game end-to-end check of focus behavior. Live controls remain read-only; native focus
emulation and pointer ownership are tested in the separate input workstream.

## Regression checks

Panel tests cover search restoration and empty results, failed-save rollback, async-router
disposal, active-route navigation, dynamic shortcuts, fixed evaluation position and visibility,
opponent-turn score/WDL normalization, stale score reset, NNUE slider range and divider,
every existing view, silent successful
moves, and retained problem notifications. Broadcaster behavioral tests verify successful
execution updates snapshots without sending a toast, including cross-window isolation.
The panel and design suites pass 219 tests across 30 unique files. CSS registry checks and
TypeScript validation remain part of the repository gate.

Superdesign CLI preflight succeeded, but its login waited for external authorization and did
not complete. The remote canvas was not used; the redesign and review were completed locally.
