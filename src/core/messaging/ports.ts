/**
 * Resilient `chrome.runtime.connect` ports (§4.3, Appendix B / H.2).
 *
 * `connectPort` is the page side (panel, offscreen, ISOLATED content script):
 * it connects immediately, reconnects after a disconnect or a failed
 * `connect()` with exponential backoff (250 → 4000 ms, doubling, reset once
 * the peer sends a message), and queues `post()` calls while no port is live
 * so they are delivered in order once one is. `acceptPorts` is the service
 * worker side: it filters `onConnect` by port name and hands each connection
 * to `onConnect` as a small typed wrapper.
 *
 * Remember (Q4): on Chrome 114+ an idle port does not keep the SW alive —
 * messages do.
 */

export { type AcceptedPort, acceptPorts } from "./ports/accept";
export {
	type ConnectedPort,
	type ConnectPortOptions,
	connectPort,
	type PortScheduler,
} from "./ports/connect";
