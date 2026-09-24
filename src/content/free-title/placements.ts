/**
 * Where the signed-in account's name appears on the page, and so where its badge goes. Identity
 * comes only from the signed-in sidebar profile link; a name elsewhere must agree with it in its
 * text and, when it links, in its link.
 */

import { SELECTORS } from "../adapters/selectors";

const S = SELECTORS.freeTitle;

export type PlacementKind = "small" | "large" | "profile" | "popover";

export interface Placement {
	key: Element;
	parent: Element;
	kind: PlacementKind;
	wrap?: boolean;
	after?: Element;
}

function username(text: string | null): string | null {
	const value = text?.trim().toLowerCase();
	return value && /^[a-z0-9_-]+$/.test(value) ? value : null;
}

/** Reject external links, partial paths and ambiguous encodings, even if their text looks right. */
function member(href: string | null, base: string): string | null {
	if (!href) return null;
	try {
		const url = new URL(href, base);
		if (url.protocol !== "https:" || !["www.chess.com", "chess.com"].includes(url.hostname))
			return null;
		const match = /^\/member\/([^/]+)\/?$/.exec(url.pathname);
		return match?.[1] ? username(decodeURIComponent(match[1])) : null;
	} catch {
		return null;
	}
}

/** The signed-in account: every sidebar profile link must name the same member. */
export function signedInAccount(doc: Document, win: Window): string | null {
	const links = [...doc.querySelectorAll(S.account)];
	const names = links.map((link) => member(link.getAttribute("href"), win.location.href));
	return names.length > 0 && names[0] && names.every((name) => name === names[0]) ? names[0] : null;
}

function owns(block: Element, own: string, win: Window): boolean {
	const names = [...block.querySelectorAll(S.username)].filter(
		(node) => node.closest(S.block) === block
	);
	return (
		names.length > 0 &&
		names.every(
			(node) =>
				username(node.textContent) === own &&
				(!node.hasAttribute("href") || member(node.getAttribute("href"), win.location.href) === own)
		)
	);
}

function ownsPopover(popover: Element, own: string, win: Window): boolean {
	const taglines = [...popover.querySelectorAll(S.tagline)];
	const tagline = taglines[0];
	return (
		taglines.length === 1 &&
		tagline !== undefined &&
		owns(tagline, own, win) &&
		[...popover.querySelectorAll(S.avatar)].every(
			(avatar) => member(avatar.getAttribute("href"), win.location.href) === own
		)
	);
}

/**
 * Every place `own`'s badge belongs. `wrappers` are the badge containers this module created
 * itself, which are never mistaken for the page's own.
 */
export function placementsOf(
	doc: Document,
	win: Window,
	own: string,
	wrappers: WeakSet<Element>
): Placement[] {
	const blocks = [...doc.querySelectorAll(S.block)].filter((block) => {
		const popover = block.closest(S.popover);
		return owns(block, own, win) && (!popover || ownsPopover(popover, own, win));
	});
	const result: Placement[] = blocks.map((block) => ({
		key: block,
		parent: block,
		kind: block.matches(S.large) ? "large" : "small",
	}));
	// Route + main profile identity must agree; a matching history row or popover is not proof.
	const profileBlocks = [...doc.querySelectorAll(`${S.block}${S.large}`)].filter(
		(block) => !block.closest(S.popover)
	);
	if (
		member(win.location.href, win.location.href) === own &&
		profileBlocks.length > 0 &&
		profileBlocks.every((block) => owns(block, own, win))
	) {
		for (const parent of doc.querySelectorAll(S.profile)) {
			if (parent.closest(S.popover)) continue;
			const streak = [...parent.children].find((node) => node.matches(S.profileStreak));
			result.push({ key: parent, parent, kind: "profile", ...(streak ? { after: streak } : {}) });
		}
	}
	for (const popover of doc.querySelectorAll(S.popover)) {
		if (!ownsPopover(popover, own, win)) continue;
		const about = popover.querySelector(S.about);
		const ratings = about?.querySelector(S.ratings);
		if (!about || !ratings || ratings.parentElement !== about) continue;
		const container = about.querySelector(S.popoverBadges);
		const existing = container && !wrappers.has(container) ? container : null;
		result.push({
			key: about,
			parent: existing ?? about,
			kind: "popover",
			wrap: !existing,
			after: ratings,
		});
	}
	return result;
}
