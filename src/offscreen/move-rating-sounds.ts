import { runtimeGetURL } from "@core/chrome/runtime";
import { MSG } from "@core/constants/messages";
import { MOVE_RATING_SOUNDS, SOUNDS_DIR } from "@core/constants/sounds";
import { log } from "@core/logger";
import { installMessageRouter } from "@core/messaging/router";

export interface MoveRatingAudio {
	preload?: string;
	play(): Promise<void> | void;
	pause(): void;
	addEventListener(type: "ended" | "error", listener: () => void): void;
	removeEventListener(type: "ended" | "error", listener: () => void): void;
}

export interface MoveRatingSoundPlayer {
	/** True means playback was attempted; browsers may still reject the play promise. */
	play(tabId: number, quality: unknown): boolean;
	stop(tabId: number): void;
	dispose(): void;
}

interface Voice {
	stop(): void;
}

function pause(source: MoveRatingAudio): void {
	try {
		source.pause();
	} catch {
		// A failed media element must not interrupt board or engine updates.
	}
}

/** Each verdict has its own voice, so adjacent moves can finish sounding together. */
export function createMoveRatingSoundPlayer(
	createAudio: (url: string) => MoveRatingAudio = (url) => new Audio(url)
): MoveRatingSoundPlayer {
	const tabs = new Map<number, Set<Voice>>();
	const primed = new Map<string, MoveRatingAudio>();
	let disposed = false;
	const makeAudio = (filename: string): MoveRatingAudio => {
		const source = createAudio(runtimeGetURL(`${SOUNDS_DIR}${filename}`));
		source.preload = "auto";
		return source;
	};
	// The five short clips total roughly 50 KB; warm them without playing anything.
	for (const filename of Object.values(MOVE_RATING_SOUNDS)) {
		try {
			primed.set(filename, makeAudio(filename));
		} catch (error) {
			log.debug("move-rating-sounds: preload unavailable", { filename, error });
		}
	}

	function stop(tabId: number): void {
		for (const voice of tabs.get(tabId) ?? []) voice.stop();
	}

	return {
		play(tabId, quality) {
			if (
				disposed ||
				!Number.isInteger(tabId) ||
				tabId < 0 ||
				typeof quality !== "string" ||
				!Object.hasOwn(MOVE_RATING_SOUNDS, quality)
			) {
				return false;
			}
			let cleanup: (() => void) | undefined;
			try {
				const filename = MOVE_RATING_SOUNDS[quality as keyof typeof MOVE_RATING_SOUNDS];
				const source = primed.get(filename) ?? makeAudio(filename);
				primed.delete(filename);
				const voices = tabs.get(tabId) ?? new Set<Voice>();
				tabs.set(tabId, voices);
				let finished = false;
				const finish = (shouldPause: boolean): void => {
					if (finished) return;
					finished = true;
					source.removeEventListener("ended", onEnded);
					source.removeEventListener("error", onError);
					voices.delete(voice);
					if (voices.size === 0) tabs.delete(tabId);
					if (shouldPause) pause(source);
				};
				const onEnded = (): void => finish(false);
				const onError = (): void => finish(true);
				const voice: Voice = { stop: onError };
				cleanup = voice.stop;
				voices.add(voice);
				source.addEventListener("ended", onEnded);
				source.addEventListener("error", onError);
				const started = source.play();
				if (started) {
					void started.then(
						() => {
							// A clear can arrive while the media element is still starting.
							if (finished) pause(source);
						},
						(error: unknown) => {
							finish(true);
							log.debug("move-rating-sounds: playback rejected", { quality, error });
						}
					);
				}
				return true;
			} catch (error) {
				cleanup?.();
				log.debug("move-rating-sounds: playback unavailable", { quality, error });
				return false;
			}
		},
		stop,
		dispose() {
			disposed = true;
			for (const tabId of tabs.keys()) stop(tabId);
			for (const source of primed.values()) pause(source);
			primed.clear();
		},
	};
}

/** The trusted sender supplies the tab identity; messages cannot stop another tab's voices. */
export function serveMoveRatingSounds(
	player: MoveRatingSoundPlayer = createMoveRatingSoundPlayer()
): () => void {
	const router = installMessageRouter();
	router.on(MSG.OFFSCREEN_MOVE_RATING_SOUND, (message, sender) => {
		const tabId = sender.tab?.id;
		if (
			sender.id !== chrome.runtime.id ||
			tabId === undefined ||
			!Number.isInteger(tabId) ||
			tabId < 0 ||
			(sender.frameId !== undefined && sender.frameId !== 0)
		) {
			return false;
		}
		if (message.quality === null) {
			player.stop(tabId);
			return true;
		}
		return player.play(tabId, message.quality);
	});
	router.install();
	return () => {
		router.dispose();
		player.dispose();
	};
}
