/** Subscription wrapper over `chrome.commands.onCommand` (keyboard shortcuts from the manifest). */

export type CommandHandler = (command: string, tab?: chrome.tabs.Tab) => void;

/** Subscribe to `chrome.commands.onCommand`; returns the unsubscribe. */
export function onCommand(handler: CommandHandler): () => void {
	chrome.commands.onCommand.addListener(handler);
	return () => chrome.commands.onCommand.removeListener(handler);
}
