/**
 * Public entry of the site-adapter layer: the `SiteAdapter` contract (§3.4, §3.4a, Appendix C §4)
 * implemented by `chesscom.ts`, the `PageBridge` the adapter consumes for MAIN-world state and
 * drawing (Task 21 implements `PageBridgeClient`; tests use a fake), and `AdapterBase`, the shared
 * board-watching runtime.
 *
 *   - `contract.ts` — the interface and the records it trades in;
 *   - `bridge-protocol.ts` — `PageBridge`, `BRIDGE_KINDS`, `BridgeState`;
 *   - `base/` — `AdapterBase` and its parts;
 *   - `geometry.ts` — square/rect maths, `toRect`.
 */

export { AdapterBase } from "./base/adapter-base";
export { debounced } from "./base/debounce";
export { installFocusEdges } from "./base/focus-edges";
export {
	BRIDGE_KINDS,
	type BridgeState,
	bridgeColor,
	type PageBridge,
} from "./bridge-protocol";
export type {
	AdapterOptions,
	AdapterPositionSnapshot,
	AdapterReading,
	ArrowLine,
	ClockReading,
	DrawOptions,
	FenSource,
	FocusEdge,
	MoveWatch,
	NewGameMode,
	Opponent,
	Point,
	PositionInfo,
	ProbeMatch,
	ProbeReport,
	Rect,
	SelfCheckResult,
	SiteAdapter,
} from "./contract";
export { toRect } from "./geometry";
