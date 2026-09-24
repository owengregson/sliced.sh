/**
 * The colour lane of snapshot publication: which colour the adapter is willing to *state*, and
 * when a change of colour is itself a reason to republish an unmoved position.
 *
 * `delivered` is what the session has actually been *told* — it advances only with a delivery
 * (`deliver`). Advancing it on every reading let a colour this class had just refused to deliver
 * — a render flip — still overwrite the baseline, and the authoritative answer that arrived next
 * then looked like no change at all and was dropped in its turn. (Measured: it broke the owner's
 * own repro, `colour-turn.test.ts:94`.)
 */

import { LIMITS } from "@core/constants/limits";
import { log } from "@core/logger";
import type { Color, Site } from "@typedefs/game";

/** The republish triggers the colour lane contributes to one reading. */
export interface ColourTriggers {
	/** A delivered colour corrected to another definite one. */
	changed: boolean;
	/** The colour just withheld: the session must hear that it is gone. */
	withdrawn: boolean;
	/** A colour learned from nothing on the game already being followed. */
	learned: boolean;
}

export class ColourAuthority {
	/**
	 * `myColor` of the last reading delivered. The colour of a live game arrives *after* its first
	 * reading — the MAIN-world bridge answers `getPlayingAs()` a moment after the board appears, and
	 * before that the live page carries no colour evidence at all — while the position itself has
	 * not moved, so the dedupe key is identical and the session would hold a colourless ply for
	 * ever (owner's live test, 2026-09-09). Learning the colour is therefore a change worth
	 * delivering in its own right. Only `null → known` on the game already being followed counts:
	 * losing it (the page became an analysis board) is not a new position, and regaining it on a
	 * different board is that board's own game start.
	 */
	private lastColor: Color | null = null;
	/** Colour *corrections* this game has already published (`LIMITS.colourCorrectionsPerGame`). */
	private corrections = 0;
	/**
	 * This game spent its corrections and the site then offered another, so the colour is **withheld**
	 * for the rest of it: the cap may bound the republishing, but it may never leave the session
	 * holding a colour we know to be wrong (review R-1).
	 */
	private withheld = false;

	/** `site` is read at log time: a site adapter sets its own only after the base is built. */
	constructor(private readonly site: () => Site) {}

	/** The colour the session was last told (`null` before any, and after a withhold). */
	get delivered(): Color | null {
		return this.lastColor;
	}

	/**
	 * Which colour this class is willing to *state*, given what it has already delivered.
	 *
	 * `getMyColor()`'s last rung is the board's own rendering, and a board the owner turned round by
	 * hand reads the other way. So the render may **supply** a colour when none is known and may never
	 * **replace** one: only the site's own `getPlayingAs()` can change a colour already delivered.
	 *
	 * That rule is about the evidence, not about the position — which is the whole of review R-2.
	 * Gating only the republish of an *unmoved* position left the refused flip riding in on the next
	 * real move, where the key changes and the reading is published for its own sake; with the bridge
	 * silent there is then no authoritative answer to undo it, so the owner got recommendations and
	 * marks for the opponent's side for the rest of the game. A position advancing does not make the
	 * rendering authoritative, and whether the owner flipped the board between moves or during one
	 * makes no difference to what the flip means.
	 */
	stated(offered: Color | null, authoritative: () => Color | null): Color | null {
		if (this.withheld) return null;
		const known = this.lastColor;
		// Nothing delivered yet (the live page's first second), or nothing new to say.
		if (known === null || offered === known) return offered;
		// The site's own answer is the only thing that may overturn a delivered colour…
		if (offered !== null && offered === authoritative()) return offered;
		// …and anything else keeps what the session already has. Including `null`: losing sight of the
		// clocks for a frame is not evidence that the colour changed.
		return known;
	}

	/** Record the colour of the silent baseline reading (`AdapterBase.prime`). */
	baseline(color: Color | null): void {
		this.lastColor = color;
	}

	/** A new game: its corrections are its own, and a withhold does not carry over. */
	newGame(): void {
		this.corrections = 0;
		this.withheld = false;
	}

	/**
	 * A colour that *changes* from one definite answer to another is delivered, whatever else
	 * moved — but only on the authority of the site's own `getPlayingAs()`, and only a bounded
	 * number of times per game.
	 *
	 * Why it must be delivered at all: the dedupe key is the position, so every reading of ply 0
	 * shares one string, and the live page's first readable moment can answer the wrong colour —
	 * the clocks before the board is turned round, a lobby board still showing white at the
	 * bottom, or the bridge cache holding the previous game's `playingAs` (`refreshBridgeState`
	 * merges, and `evaluate()` reads before it refreshes). Publishing only `null → known` left a
	 * `"w" → "b"` correction with no way through at all, and the session kept predicting,
	 * highlighting and playing for the *opponent* until the position itself moved on (owner's live
	 * game, 2026-09-10: white's first move, recommended to a black player, for the whole of
	 * white's turn). The new game's own first reading is the likeliest place to need it, because
	 * the lobby board it replaces answered the colour of the *last* game.
	 *
	 * Why only the bridge may do it: `getMyColor()`'s last rung is the board's own **rendering**
	 * (`bottomColor()`), and the rendering is exactly what a manual board flip changes, so a render
	 * reading may introduce a colour but never overturn one. `stated` is where that rule
	 * lives — it applies to every reading, on a new position as much as on an unmoved one — and the
	 * authority test here is the republish side of it: a correction is a reason to deliver an
	 * *unmoved* position again.
	 *
	 * Why it is capped: every other republish trigger here is structurally one-shot
	 * (`colourLearned` needs `lastColor === null`, `timeControlLearned` needs `lastTimeControl ===
	 * null`, and nothing restores either). This one is not, so an alternating answer would start
	 * and abort a pipeline — and flood the game port with marks — once per reading, for ever.
	 *
	 * And what the cap does when it runs out is **withhold the colour**, not keep the one we have.
	 * A cap that keeps a stale colour fails in the one direction this whole lane forbids: the site
	 * has just told us the owner is playing the other side, so continuing to state the old one
	 * leaves the session recommending, marking and scheduling for the opponent — silently, and for
	 * the rest of the game, with a snapshot internally consistent enough that every guard passes
	 * (review R-1). Answering "no colour" is the honest tail: `GameSession.mayActOn` holds on it
	 * exactly as it holds on the live page's first second, so the assistant acts for *neither*
	 * side, and the refusal says so in the log.
	 */
	enforceCap(authoritative: Color | null): void {
		if (
			!this.withheld &&
			this.lastColor !== null &&
			authoritative !== null &&
			authoritative !== this.lastColor &&
			this.corrections >= LIMITS.colourCorrectionsPerGame
		) {
			this.withheld = true;
			log.warn("adapter.colourWithheld", {
				site: this.site(),
				told: this.lastColor,
				offered: authoritative,
				corrections: this.corrections,
			});
		}
	}

	/**
	 * What may be published of a reading built before `enforceCap` decided (`stated` applies the
	 * withhold to every later reading, `readSnapshot()` included).
	 */
	publishable<S extends { myColor: Color | null }>(snapshot: S): S {
		return this.withheld ? ({ ...snapshot, myColor: null } as S) : snapshot;
	}

	/** The colour lane's republish triggers for a publishable snapshot; counts a correction. */
	triggers(myColor: Color | null, gameChanged: boolean): ColourTriggers {
		// Neither the authority test nor the cap appears here, and both absences are deliberate:
		// `stated` has already decided what this class is *willing* to state, so a colour that
		// differs from the last delivered one is authoritative by construction, and the withhold
		// (`enforceCap`) fires at the cap and empties `snapshot.myColor`. Both conjuncts were in this expression and
		// both were dead — mutations removing them survived the whole suite, which is the measurement
		// that says the rule lives in one place now rather than three.
		const changed = this.lastColor !== null && myColor !== null && this.lastColor !== myColor;
		if (changed) this.corrections += 1;
		// The withhold itself has to reach the session, or it is just as silent as keeping the stale
		// colour was. It fires once: `lastColor` is `null` afterwards.
		const withdrawn = this.withheld && this.lastColor !== null;
		// Learning a colour from nothing is different, and stays limited to the game already being
		// followed: an SPA hop to another page (`/game/<id>` → `/analysis/…` → `/play/computer`)
		// changes the derived game id and re-reads the colour from a board that is no longer the one
		// we were following, and republishing there would start a second session on it.
		const learned = !gameChanged && this.lastColor === null && myColor !== null;
		return { changed, withdrawn, learned };
	}

	/** The session has been told `color`. */
	deliver(color: Color | null): void {
		this.lastColor = color;
	}
}
