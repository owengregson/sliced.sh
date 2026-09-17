/** Local account decoration. Identity comes only from the signed-in sidebar profile link. */
import {
	FREE_TITLE_ART,
	FREE_TITLE_PROFILE_PATH,
	FREE_TITLES,
	type FreeTitle,
} from "@core/constants/free-title";
import { TIMINGS } from "@core/constants/timings";
import { SELECTORS } from "./adapters/selectors";

const S = SELECTORS.freeTitle;
const C = S.classes;
type Kind = "small" | "large" | "profile" | "popover";
interface Placement {
	key: Element;
	parent: Element;
	kind: Kind;
	wrap?: boolean;
	after?: Element;
}
interface Decoration {
	placement: Placement;
	root: HTMLElement;
	badge: HTMLElement;
	label: HTMLElement;
	hidden: Map<HTMLElement, [string, string, boolean]>;
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

export function createFreeTitle(doc: Document, win: Window) {
	let title: FreeTitle | null = null;
	let disposed = false;
	let queued = false;
	let timer: number | null = null;
	const decorations = new Map<Element, Decoration>();
	const wrappers = new WeakSet<Element>();
	const observer = new (doc.defaultView?.MutationObserver ?? MutationObserver)(schedule);
	const observe = () => {
		if (!title || disposed) return;
		observer.observe(doc.documentElement, {
			childList: true,
			subtree: true,
			characterData: true,
			attributes: true,
			attributeFilter: ["href", "class", "data-user-activity-key", "data-test-element", "style"],
		});
	};
	const element = (tag: string, className: string, text?: string): HTMLElement => {
		const node = doc.createElement(tag);
		node.className = className;
		if (text !== undefined) node.textContent = text;
		return node;
	};
	function crown(size: number): SVGSVGElement {
		const node = doc.createElementNS("http://www.w3.org/2000/svg", "svg");
		node.setAttribute("data-glyph", "game-crown-2");
		node.setAttribute("aria-hidden", "true");
		node.setAttribute("viewBox", "0 0 24 24");
		node.setAttribute("width", String(size));
		node.setAttribute("height", String(size));
		node.setAttribute("fill", "currentColor");
		const path = doc.createElementNS(node.namespaceURI, "path");
		path.setAttribute("d", FREE_TITLE_ART.crown);
		node.append(path);
		return node;
	}
	function restore(
		node: HTMLElement,
		[display, priority, hadStyle]: [string, string, boolean]
	): void {
		if (node.style.getPropertyValue("display") !== "none") return;
		if (display) node.style.setProperty("display", display, priority);
		else node.style.removeProperty("display");
		if (!hadStyle && !node.getAttribute("style")) node.removeAttribute("style");
	}
	function remove(saved: Decoration): void {
		saved.badge.remove();
		if (saved.root !== saved.badge) {
			if (!saved.root.hasChildNodes()) saved.root.remove();
			else wrappers.delete(saved.root);
		}
		for (const [node, style] of saved.hidden) restore(node, style);
		saved.hidden.clear();
	}
	function account(): string | null {
		const links = [...doc.querySelectorAll(S.account)];
		const names = links.map((link) => member(link.getAttribute("href"), win.location.href));
		return names.length > 0 && names[0] && names.every((name) => name === names[0]) ? names[0] : null;
	}
	function owns(block: Element, own: string): boolean {
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
	function placements(own: string): Placement[] {
		const blocks = [...doc.querySelectorAll(S.block)].filter((block) => {
			const popover = block.closest(S.popover);
			return owns(block, own) && (!popover || ownsPopover(popover, own));
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
			profileBlocks.every((block) => owns(block, own))
		) {
			for (const parent of doc.querySelectorAll(S.profile)) {
				if (parent.closest(S.popover)) continue;
				const streak = [...parent.children].find((node) => node.matches(S.profileStreak));
				result.push({ key: parent, parent, kind: "profile", ...(streak ? { after: streak } : {}) });
			}
		}
		for (const popover of doc.querySelectorAll(S.popover)) {
			if (!ownsPopover(popover, own)) continue;
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
	function ownsPopover(popover: Element, own: string): boolean {
		const taglines = [...popover.querySelectorAll(S.tagline)];
		const tagline = taglines[0];
		return (
			taglines.length === 1 &&
			tagline !== undefined &&
			owns(tagline, own) &&
			[...popover.querySelectorAll(S.avatar)].every(
				(avatar) => member(avatar.getAttribute("href"), win.location.href) === own
			)
		);
	}
	function create(placement: Placement): Decoration {
		let root: HTMLElement;
		let label: HTMLElement;
		let badge: HTMLElement | undefined;
		if (placement.kind === "small" || placement.kind === "large") {
			root = label = element("a", C[placement.kind]);
			root.setAttribute("href", new URL(FREE_TITLE_PROFILE_PATH, win.location.href).href);
		} else if (placement.kind === "profile") {
			root = element("a", C.profile);
			root.setAttribute("href", new URL(FREE_TITLE_PROFILE_PATH, win.location.href).href);
			const icon = element("div", C.profileIcon);
			icon.append(crown(24));
			const about = element("div", C.profileAbout);
			label = element("span", C.profileExtra);
			about.append(element("span", C.profileName, "Titled Player"), label);
			root.append(icon, about);
		} else {
			root = element("div", C.popoverBadge);
			label = element("span", C.popoverLabel);
			root.append(crown(12), label);
			if (placement.wrap) {
				badge = root;
				const wrapper = element("div", C.popoverBadges);
				wrapper.append(root);
				wrappers.add(wrapper);
				root = wrapper;
			}
		}
		return { placement, root, badge: badge ?? root, label, hidden: new Map() };
	}
	function render(): void {
		if (disposed) return;
		observer.disconnect();
		try {
			const own = title ? account() : null;
			const desired = own ? placements(own) : [];
			const keys = new Set(desired.map((p) => p.key));
			for (const [key, saved] of decorations) {
				if (!keys.has(key)) {
					remove(saved);
					decorations.delete(key);
				}
			}
			if (!title) return;
			for (const placement of desired) {
				let saved = decorations.get(placement.key);
				if (
					saved &&
					(saved.placement.parent !== placement.parent ||
						saved.placement.kind !== placement.kind ||
						saved.placement.wrap !== placement.wrap)
				) {
					remove(saved);
					decorations.delete(placement.key);
					saved = undefined;
				}
				if (!saved) {
					saved = create(placement);
					decorations.set(placement.key, saved);
				}
				const text =
					placement.kind === "small" || placement.kind === "large" ? title : FREE_TITLES[title];
				if (saved.label.textContent !== text) saved.label.textContent = text;
				saved.root.title = FREE_TITLES[title];
				if (saved.badge !== saved.root && saved.badge.parentElement !== saved.root)
					saved.root.prepend(saved.badge);
				const before =
					placement.after?.parentElement === placement.parent
						? placement.after.nextSibling
						: placement.parent.firstChild;
				if (before !== saved.root) placement.parent.insertBefore(saved.root, before);
				const selector =
					placement.kind === "profile"
						? S.profileNative
						: placement.kind === "popover"
							? S.popoverNative
							: S.title;
				const native = [...placement.parent.children].filter(
					(node) => node !== saved.root && node.matches(selector)
				) as HTMLElement[];
				for (const [node, style] of saved.hidden) {
					if (!native.includes(node)) {
						restore(node, style);
						saved.hidden.delete(node);
					}
				}
				for (const node of native) {
					if (!saved.hidden.has(node))
						saved.hidden.set(node, [
							node.style.getPropertyValue("display"),
							node.style.getPropertyPriority("display"),
							node.hasAttribute("style"),
						]);
					node.style.setProperty("display", "none", "important");
				}
			}
		} finally {
			observe();
		}
	}
	function schedule(): void {
		if (queued || disposed || !title) return;
		queued = true;
		queueMicrotask(() => {
			queued = false;
			render();
		});
	}
	win.addEventListener("popstate", schedule);
	return {
		set(value: FreeTitle | null): void {
			if (disposed) return;
			title = value && Object.hasOwn(FREE_TITLES, value) ? value : null;
			if (timer !== null) win.clearInterval(timer);
			// pushState need not mutate the DOM; recheck the route even on an otherwise static profile.
			timer = title ? win.setInterval(schedule, TIMINGS.adapterSelfCheckIntervalMs) : null;
			render();
		},
		dispose(): void {
			title = null;
			render();
			disposed = true;
			observer.disconnect();
			if (timer !== null) win.clearInterval(timer);
			win.removeEventListener("popstate", schedule);
		},
	};
}
