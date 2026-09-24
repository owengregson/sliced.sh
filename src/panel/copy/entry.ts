/**
 * The views around a game: login, expired, unsupported, waiting and update (Task 23; Appendix F
 * §4.1–4.3, §4.8–4.10), including the strings the §7.2 table leaves implicit.
 */

import { SITE } from "./site";

export const LOGIN_COPY = {
	title: "sliced",
	subtitle: `Chess assistant for ${SITE}`,
	fieldLabel: "License key",
	hint: "Keys look like SL-XXXX-XXXX-XXXX.",
	button: "Continue",
	loading: "Checking key…",
	invalid: "Invalid license key. Verify the key in Account.",
	deviceLimit: (n: number): string => `Device limit reached (${n}). Remove a device in Account.`,
	offline: "Connection failed. Check network access and retry.",
	expired: (date: string): string => `This key expired on ${date}.`,
	link: "Get a license key",
	reveal: "Show key",
	hide: "Hide key",
} as const;

export const UNSUPPORTED_COPY = {
	title: "Unsupported page",
	body: `Open a ${SITE} game in this tab.`,
	note: "Auto-play stays off until a game starts.",
} as const;

export const NON_GAME_COPY = {
	title: "No game detected",
	body: "Start or join a game.",
} as const;

export const WAITING_COPY = {
	title: "Waiting…",
	meta: (engine: string): string => `${SITE} · ${engine}`,
	engineReady: "engine ready",
	engineLoading: "engine loading",
	watching: "Connected",
	reading: "Reading position…",
	queueDelay: (remaining: string): string => `Next game in ${remaining}`,
	queueBreak: (remaining: string): string => `Session break · Next session in ${remaining}`,
	queueStarting: "Starting next game…",
	queueRetrying: "Retrying…",
	queueSearching: "Matchmaking…",
	/** The rematch step (2026-09-13): the offer is out; the ordinary queue follows at the deadline. */
	queueRematch: (seconds: string): string => `Rematch offered · queueing in ${seconds}s`,
	autoplayTooltip: "Turns on when a game starts",
	preArmed: "Armed for next game",
	/** §4.4: the master switch is off, so there is nothing to arm (`COPY.move.disabled` names it). */
	autoplayOff: "Assistant disabled in Settings",
} as const;

export const UPDATE_COPY = {
	title: (version: string): string => `sliced ${version} is ready`,
	primary: "Restart and update",
	later: "Later",
	note: "Restart pauses assistance; the game continues. Update between games.",
} as const;

export const EXPIRED_COPY = {
	title: "License expired",
	body: (date: string): string =>
		`Assistance disabled since ${date}. Renewal required. Settings retained.`,
	renew: "Renew at sliced.sh",
	differentKey: "Enter a different key",
	revokedTitle: "License invalid",
	revokedBody: "Key revoked or replaced. Verify the key in Account.",
	ipLimitTitle: "Device limit reached",
} as const;

export const LOGIN_VIEW_COPY = {
	placeholder: "SL-XXXX-XXXX-XXXX",
	tryAgain: "Try again",
	manageDevices: "Manage devices",
	renew: "Renew",
	expiredNoDate: "This key has expired.",
	version: (version: string): string => `v${version}`,
} as const;

export const EXPIRED_VIEW_COPY = {
	bodyNoDate: "Assistance disabled. Renewal required. Settings retained.",
	recheck: "Check again",
	signedIn: (maskedKey: string): string => `Signed in with ${maskedKey}`,
} as const;

export const UNSUPPORTED_VIEW_COPY = { chesscom: SITE, play: "Play" } as const;

export const WAITING_VIEW_COPY = {
	engineStopped: "engine stopped",
	opponent: "Opponent",
	noOpponent: "No opponent",
	bot: "Bot",
	rating: (rating: number): string => `Rated ${rating}`,
	ratingUnknown: "opponent rating unknown",
	target: (elo: number): string => `Target ${elo}`,
	lastSession: "Statistics",
	session: (games: number, moves: number, avg: string): string =>
		`${games} games · ${moves} moves · ${avg}s avg move`,
	newGame: "Start a new game",
} as const;

export const CAT_FACTS_COPY = {
	title: "Cat facts",
	another: "Another",
	facts: [
		"A group of kittens is called a kindle.",
		"Cats spend about two thirds of their lives asleep.",
		"A cat's nose print is unique, much like a human fingerprint.",
		"Cats can rotate their ears 180 degrees.",
		"The oldest known pet cat lived around 9,500 years ago in Cyprus.",
		"A cat cannot see directly under its own nose.",
		"Cats have a third eyelid called the haw.",
		"Adult cats only meow to communicate with humans, not with other cats.",
	],
} as const;
