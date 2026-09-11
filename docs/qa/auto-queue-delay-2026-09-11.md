# Automatic queue delay — panel and settings QC

The Execution section now places Random queue delay and Maximum queue delay next to Auto-queue. The option defaults off; its maximum defaults to 5 minutes. Storage normalizes the maximum to a finite integer in the registered 1–60 minute range. Auto-queue must be on to edit the delay option, and the option must be on to edit its maximum. Disabling either option preserves the saved maximum.

The waiting view, also used after game over, displays the service-provided deadline as `Next game in M:SS`. New snapshots preserve that absolute deadline. At expiry it displays `Starting next game…`; subsequent service states display `Retrying…` or `Matchmaking…`. The countdown stops when canceled, disabled, or unmounted. Screen readers do not announce every second; phase transitions remain status updates.

Validation:

- 42 isolated settings storage, Settings view, and Waiting view tests passed. Added coverage includes migration, malformed values, bounds, partial saves, dependencies, stepper behavior, absolute countdowns, phase updates, cancellation, and timer disposal.
- 30 router tests passed, including game-over routing to the waiting view.
- CSS and constant registry checks passed; scoped Biome and whitespace checks passed.
- Real Chromium preview at 320, 360, and 480 px: delayed queue, matchmaking, retrying, settings off, settings on. All 15 states had no horizontal overflow. Browser clicks enabled both controls and saved an increased maximum of 6 minutes.
- Inspected rendered settings at 320/480 px and waiting countdown at 320 px. Existing panel layout and navigation remain intact.

Artifacts (git-ignored): `build-logs/ui-queue-review/`, including `audit.json` and 15 screenshots. Preview: `http://127.0.0.1:4179/?state=queue` and `?state=settings&search=queue`.

Runtime queue scheduling, persistence, retries, and game-start confirmation are validated separately by the service/content lanes. This fixture verifies the real panel rendering and interactions with a local fake store; it does not start a real game.

## Runtime recovery

The previous queue posted a single unacknowledged command and removed its timer regardless of delivery. The queue now requests a correlated result, retries missing controls and transport failures with a capped backoff, and checks matchmaking until the next game is observed. A clicked control is not considered proof that a game started. Adapter discovery excludes Rematch/Cancel substitutions, hidden/disabled/offscreen controls, and stale-game requests; it releases virtual pointer filtering only before an identified restart control is activated.

The sampled deadline is stored in `chrome.storage.session`, with a synchronous service-worker alarm handler and an ordinary timer for precise foreground operation. The original deadline survives worker idle/restart and port reconnects. Chrome may delay alarm delivery; browser restart or extension reload clears session storage. Hydration and persistence failures retry instead of overwriting unknown saved intent. Closing the tab, disabling the setting, an explicit stop, or leaving supported game/matchmaking pages cancels the queue; matchmaking navigation keeps it.

Game-end messages carry game and receipt identities. Unacknowledged endings are replayed until handled; acknowledged endings restore state without creating a new queue. The service ignores old-game results after a newer game has arrived. Duplicate game ends preserve the existing deadline. Queue scheduling occurs before slow statistics writes, with cancellation guards for an immediately started game.

Targeted service/content tests cover request retries, delayed controls, matchmaking without duplicate activation, random minute boundaries, original deadline restoration, cancel-during-hydration, late replies after cancellation, immediate next-game races, duplicate/stale game ends, settings cancellation, and supported/unsupported navigation. Persistence tests include actual simulator worker teardown/reboot and alarm delivery. Live chess.com matchmaking was not exercised; selector coverage uses repository fixtures.
