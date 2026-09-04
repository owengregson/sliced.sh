// test/service/fakes.ts — a hand-driven `ContentLink` stand-in for the focus-gate / ownership units.
import type { GamePortMessage } from "@core/constants";
import type { ContentLinkEvents } from "@service/content-link";

type Listener = (tabId: number, msg: GamePortMessage) => void;

export function fakeLink(windows: Record<number, number>) {
	const listeners = new Set<Listener>();
	const disconnects = new Set<(tabId: number) => void>();
	const link: ContentLinkEvents & {
		emit(tabId: number, msg: GamePortMessage): void;
		disconnect(tabId: number): void;
		listeners(): number;
	} = {
		onMessage(tabId, cb) {
			const l: Listener =
				tabId === "*"
					? (cb as Listener)
					: (id, m) => {
							if (id === tabId) (cb as (m: GamePortMessage) => void)(m);
						};
			listeners.add(l);
			return () => void listeners.delete(l);
		},
		onDisconnect(cb) {
			disconnects.add(cb);
			return () => void disconnects.delete(cb);
		},
		windowIdOf: (tabId) => windows[tabId] ?? null,
		emit(tabId, msg) {
			for (const l of [...listeners]) l(tabId, msg);
		},
		disconnect(tabId) {
			for (const d of [...disconnects]) d(tabId);
		},
		listeners: () => listeners.size + disconnects.size,
	};
	return link;
}
