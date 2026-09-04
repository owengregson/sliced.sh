// test/sim/chrome/commands.ts
/** `chrome.commands.onCommand` with a `trigger(command, tab?)` helper standing in for the keypress. */

import type { Bus } from "@test/sim/contexts/bus";

type CommandListener = (command: string, tab?: chrome.tabs.Tab) => void;

export function createCommandsSubsystem(bus: Bus) {
	const onCommand = bus.event<[string, chrome.tabs.Tab | undefined]>();
	const triggered: string[] = [];

	const api = {
		onCommand: {
			addListener: (l: CommandListener) => onCommand.addListener(l),
			removeListener: (l: CommandListener) => onCommand.removeListener(l),
			hasListener: (l: CommandListener) => onCommand.hasListener(l),
		},
		getAll(callback?: (commands: chrome.commands.Command[]) => void) {
			return bus.settle(callback, [] as chrome.commands.Command[]);
		},
	};

	return {
		api,
		/** Simulate the user pressing the shortcut bound to `command`. */
		trigger(command: string, tab?: chrome.tabs.Tab): void {
			triggered.push(command);
			onCommand.fire(command, tab);
		},
		triggered: (): string[] => [...triggered],
	};
}

export type CommandsSubsystem = ReturnType<typeof createCommandsSubsystem>;
