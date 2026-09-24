/**
 * Offscreen engine host (§6.3 `engine-host.ts`, §6.4 backpressure).
 *
 * `EngineHost` owns exactly one Stockfish instance and speaks the engine port
 * protocol (`EnginePortCommand` in, `EnginePortMessage` out):
 *   - `configure` boots the engine (first command) or reboots it for a new
 *     variant; `uci` lines go to `sf.uci` (queued while booting); `loadNnue`
 *     sets the named nets in order; `restart` quits and re-boots at once.
 *   - engine output: `info` lines are coalesced per multipv index and
 *     forwarded at most every `TIMINGS.engineInfoForwardMs` (`currmove`
 *     progress lines are dropped, `info string` passes straight through);
 *     every other line flushes the pending infos first so order is kept.
 *   - `sf.onError` (stderr) is a crash: status `crashed` carrying the message,
 *     then a reboot after `TIMINGS.engineRestartBackoffMs[attempt]`; once the
 *     steps are exhausted the host stays `crashed`. A completed search
 *     (`bestmove`) or an explicit restart resets the attempt counter.
 *   - status: `booting → loading-nnue → ready`, `searching` on `go`, `ready`
 *     on `bestmove`; `EngineStatus.version` starts as the loaded module name
 *     and becomes the engine's `id name` once seen; `nps` follows the last
 *     `info` line.
 *
 * `serveEnginePort` is the port side: the service worker initiates
 * (`RemoteEngine` → `runtime.connect`), the document *accepts* — §6.3's
 * "connects / re-connects" prose is implemented as "accept the SW's connection
 * and re-send the current status on each new one", which is how the engine
 * state survives a service-worker restart. Only the newest accepted port is
 * routed; its disconnect aborts pending NNUE downloads. The first `configure`
 * carrying `warmTiming` pre-warms the timing head's default band (Task 34);
 * without it nothing is loaded, so a v1 user pays nothing. Likewise `warmPolicy`
 * pre-loads that Maia-3 size (2026-09-11), and `policy` / `policy-warm` route to
 * the policy host; a served document without one answers `not-available`.
 *
 * Module map: `engine-host/host.ts` (the lifecycle), `info-coalescer.ts` (backpressure),
 * `reboot-backoff.ts` (crash reboots), `uci-lines.ts` (reading the relayed traffic),
 * `router.ts` (where each command goes) and `serve.ts` (accepting the port).
 */

export { EngineHost } from "./engine-host/host";
export type { ModelStoreLike, NnueStoreLike } from "./engine-host/router";
export { type ServedEngine, type ServeEngineDeps, serveEnginePort } from "./engine-host/serve";
export type { BootHooks, EngineHostDeps, HostNnueStore, HostScheduler } from "./engine-host/types";
