/**
 * Typed helpers over `SESSION_KEYS` (ephemeral, cleared on SW restart):
 * per-tab auto-move / debugger flags and the persona sampled per game.
 */

import { chromeSessionGet, chromeSessionSet } from "@core/chrome/storage";
import { SESSION_KEYS } from "@core/constants/storage-keys";
import type { PersonaLatents, TabFlags } from "@typedefs/storage";

type FlagKey = typeof SESSION_KEYS.autoMoveArmed | typeof SESSION_KEYS.debuggerAttached;

async function getFlag(key: FlagKey, tabId: number): Promise<boolean> {
	const flags = await chromeSessionGet(key);
	return flags?.[String(tabId)] === true;
}

/** Unserialised read-modify-write: the owner (Task 9) must serialise concurrent writes per key. */
async function setFlag(key: FlagKey, tabId: number, value: boolean): Promise<void> {
	const flags: TabFlags = { ...((await chromeSessionGet(key)) ?? {}) };
	if (value) flags[String(tabId)] = true;
	else delete flags[String(tabId)];
	await chromeSessionSet(key, flags);
}

export function getAutoMoveArmed(tabId: number): Promise<boolean> {
	return getFlag(SESSION_KEYS.autoMoveArmed, tabId);
}

export function setAutoMoveArmed(tabId: number, armed: boolean): Promise<void> {
	return setFlag(SESSION_KEYS.autoMoveArmed, tabId, armed);
}

export function getDebuggerAttached(tabId: number): Promise<boolean> {
	return getFlag(SESSION_KEYS.debuggerAttached, tabId);
}

export function setDebuggerAttached(tabId: number, attached: boolean): Promise<void> {
	return setFlag(SESSION_KEYS.debuggerAttached, tabId, attached);
}

/** Drop both per-tab flags (call on tab close). */
export async function clearTabSessionFlags(tabId: number): Promise<void> {
	await setFlag(SESSION_KEYS.autoMoveArmed, tabId, false);
	await setFlag(SESSION_KEYS.debuggerAttached, tabId, false);
}

export async function getPersonaForGame(gameId: string): Promise<PersonaLatents | null> {
	const byGame = await chromeSessionGet(SESSION_KEYS.personaByGame);
	return byGame?.[gameId] ?? null;
}

export async function setPersonaForGame(gameId: string, latents: PersonaLatents): Promise<void> {
	const byGame = { ...((await chromeSessionGet(SESSION_KEYS.personaByGame)) ?? {}) };
	byGame[gameId] = latents;
	await chromeSessionSet(SESSION_KEYS.personaByGame, byGame);
}

export async function clearPersonaForGame(gameId: string): Promise<void> {
	const byGame = { ...((await chromeSessionGet(SESSION_KEYS.personaByGame)) ?? {}) };
	if (!(gameId in byGame)) return;
	delete byGame[gameId];
	await chromeSessionSet(SESSION_KEYS.personaByGame, byGame);
}
