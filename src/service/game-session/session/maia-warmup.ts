/**
 * The game's Maia-3 commitment (H6.3) and the model residency that follows it: one size per game,
 * chosen at game start and locked by the first decision, re-committed only by the user's explicit
 * act; and the warm/unwarm calls that keep the right size resident. A change in any input the
 * selection depends on invalidates the work in flight (the session's `selectionChanged` hook).
 */

import { LIMITS } from "@core/constants/limits";
import type { MaiaSize } from "@core/constants/maia";
import { log } from "@core/logger";
import type { Settings } from "@typedefs/settings";
import {
	commitMaiaSize,
	commitmentSuperseded,
	type MaiaCommitment,
	maiaSizeForGame,
} from "../maia-session";
import type { SessionCore } from "./core";

export class MaiaWarmup {
	/** The Maia-3 size last asked to be resident for this session (`warmFor` dedupes on it). */
	private sizeWarmed: MaiaSize | null = null;
	private configuration: string | null = null;
	/** Keep the model fixed within eligible play; active rating changes can disable or re-enable it. */
	commitment: MaiaCommitment | null = null;
	/** H6.3: set by the game's first pipeline run; cleared by an explicit target change. */
	private locked = false;

	constructor(
		private readonly core: SessionCore,
		/** The active selection configuration changed: whatever was prepared under it is void. */
		private readonly selectionChanged: () => void
	) {}

	/** The size this game queries Maia at (`null`: Maia is not queried for this game). */
	size(): MaiaSize | null {
		return this.commitment?.size ?? null;
	}

	/** H6.3: the size this game plays with, from the target as it stands at game start. */
	commitForGame(targetElo: number, settings: Settings): void {
		this.commitment = commitMaiaSize(targetElo, settings.strength);
		this.locked = false;
	}

	/** H6.3: the first move decided locks the game's size; returns it. */
	lockForDecision(): MaiaSize | null {
		const size = this.size();
		this.locked = true;
		return size;
	}

	private configurationKey(): string {
		const core = this.core;
		const settings = core.settings();
		return JSON.stringify([
			settings.enabled,
			core.targetElo(),
			core.opponentInfo?.ratingEstimate ?? null,
			settings.strength.selectionMode,
			settings.strength.blunderScale,
			settings.strength.persona,
			settings.engine,
		]);
	}

	/**
	 * Keep model residency and asynchronous work aligned with the active selection inputs.
	 * `true` when the configuration changed (the session's work was invalidated).
	 */
	warmFor(targetElo: number, force = false): boolean {
		const core = this.core;
		const configuration = this.configurationKey();
		const changed = this.configuration !== null && configuration !== this.configuration;
		this.configuration = configuration;
		if (changed) this.selectionChanged();
		if (this.commitment) {
			const next = commitMaiaSize(targetElo, core.settings().strength);
			if (next.size !== null && this.locked && this.commitment.size !== null)
				next.size = this.commitment.size;
			this.commitment = next;
		}
		const size = core.mayAct() ? maiaSizeForGame(targetElo) : null;
		if (!force && size === this.sizeWarmed) return changed;
		this.sizeWarmed = size;
		core.deps.warmPolicy?.(core.mayAct() ? targetElo : LIMITS.eloMax);
		return changed;
	}

	/**
	 * H6.3: a settings write that changes the *stored* target or the match switch is the user's
	 * explicit act, and it re-commits the game's Maia size (a locked one included); the next warm
	 * follows. Anything else leaves the commitment alone.
	 */
	recommitOnSettings(settings: Settings): void {
		const commit = this.commitment;
		if (!commit || !commitmentSuperseded(commit, settings.strength)) return;
		const next = commitMaiaSize(this.core.targetElo(), settings.strength);
		this.commitment = next;
		this.locked = false;
		if (next.size !== commit.size)
			log.info("game-session: the target changed by hand — the game's Maia size is re-committed", {
				tabId: this.core.tabId,
				from: commit.size,
				to: next.size,
			});
	}
}
