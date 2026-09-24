/**
 * Panel snapshot broadcaster (§4.3 `PanelPortMessage`, §10.4). Accepts every
 * `PORT_NAMES.panel` connection, builds the `PanelSnapshot` a panel should see
 * — the game session and hand of the active tab in the panel's window, the
 * engine status, settings, session stats and the license — and pushes it on
 * connect and whenever `notify()` is called, throttled to
 * `TIMINGS.panelSnapshotMinIntervalMs` with one trailing push so a burst ends
 * with the newest state. A side-panel port's `sender` carries no tab or window,
 * so each panel names its own window in a `hello` (`PanelPortCommand`) on every
 * (re)connect; ports are grouped by that window so each window's panel gets the
 * snapshot of its own game tab, and a toast about one tab reaches only the
 * panels showing it. Settings, license and stats live in `chrome.storage.local`;
 * a change to any of them triggers a push on its own.
 *
 * `SnapshotSources` (`panel-broadcaster/sources.ts`) is the narrow read surface the broadcaster
 * needs; the session registry implements it.
 *
 * `observeExecutor()` is how a tab's `MoveExecutor` reaches the panel: every
 * result is stamped with `at` (Task 24 keys the played flash on it), kept as
 * `session.lastExecution`, and an unverified move becomes a
 * `toast` port message named by `TOAST_KEYS` (the copy is the panel's — the
 * service worker never imports `@panel/copy`); hand-state changes push a snapshot.
 *
 * Parts: `panel-broadcaster/broadcaster.ts` (the class: ports, throttling, toasts, executor
 * results), `sources.ts` (the read surface), `snapshot.ts` (assembling one snapshot),
 * `connections.ts` (the open ports grouped by window), `throttle.ts` (the trailing throttle).
 */

export {
	PanelBroadcaster,
	type PanelBroadcasterOptions,
} from "@service/panel-broadcaster/broadcaster";
export type { ToastLevel } from "@service/panel-broadcaster/snapshot";
export {
	type ExecutorHandle,
	type HandSources,
	idleSnapshotSources,
	lateBoundSources,
	type OpponentView,
	type SessionGameView,
	type SessionSource,
	type SnapshotSources,
} from "@service/panel-broadcaster/sources";
