/**
 * SW-side registry of the per-tab game ports (`PORT_NAMES.game`, one per
 * content script). Accepts every connection, keys it by the sender's tab,
 * fans incoming `GamePortMessage`s out to per-tab / global subscribers, and
 * runs request/reply pairs correlated by `id` (`geometry`, `observeMove`,
 * `boardCheck`)
 * with a timeout on the injected scheduler. The executor's verifier and the
 * `FocusGate` / `HandOwnership` consume it; Task 30's content handlers build
 * on the same object, so nothing here is executor-specific.
 *
 * Parts: `content-link/link.ts` (the port registry and fan-out), `pending-requests.ts` (the
 * id-correlated requests and their timeouts), `pointer-state.ts` (the mirrored cursor's owner
 * and version), `types.ts` (request/reply typing and the event surface).
 */

export { ContentLink } from "@service/content-link/link";
export type {
	AnyMessageListener,
	ContentLinkEvents,
	ContentLinkOptions,
	ReplyFor,
	RequestCommand,
	RequestInput,
	RequestKind,
	TabMessageListener,
} from "@service/content-link/types";
