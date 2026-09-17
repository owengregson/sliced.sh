import { afterEach, expect, it } from "bun:test";
import { createFreeTitle } from "@content/free-title";
import { createTabDom } from "@test/sim/dom/tab-dom";
import { type Node as HappyNode, PropertySymbol } from "happy-dom";
import { pageDocument, pageWindow, waitFor } from "./adapters/helpers";

const account =
	'<a class="sidebar-link" data-user-activity-key="profile" href="https://www.chess.com/member/zurdo1969">Profile</a>';
const block = (name: string, classes = "cc-user-block-small", title = "") =>
	`<div class="cc-user-block-component ${classes}">${title}<a class="cc-user-username-component" data-test-element="user-tagline-username" href="/member/${name.toLowerCase()}">${name}</a><div class="cc-country-flag-component">flag</div></div>`;
const native =
	'<a class="cc-user-title-component cc-text-x-small-bold" href="/members/titled-players">NM</a>';
const popover = (name: string) =>
	`<div class="user-popover-content"><a class="user-popover-avatar" href="/member/${name}"></a><div class="user-popover-about">${block(name, "cc-user-block-small user-popover-tagline")}<div class="user-popover-ratings">2494</div></div></div>`;
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const close of cleanup.splice(0)) await close();
});

function boot(html: string, path = "/member/zurdo1969", sidebar = account) {
	const dom = createTabDom(`https://www.chess.com${path}`);
	dom.document.body.innerHTML = sidebar + html;
	// happy-dom 16 otherwise lets GC collect its WeakRef-only mutation delivery closure.
	const retained = new Set<object>();
	const NativeObserver = dom.window.MutationObserver;
	class Observer extends NativeObserver {
		override observe(target: HappyNode, options: MutationObserverInit): void {
			super.observe(target, options);
			for (const listener of target[PropertySymbol.mutationListeners]) {
				const callback = listener.callback.deref();
				if (callback) retained.add(callback);
			}
		}
	}
	Object.defineProperty(dom.window, "MutationObserver", { value: Observer, configurable: true });
	const renderer = createFreeTitle(pageDocument(dom), pageWindow(dom));
	cleanup.push(async () => {
		renderer.dispose();
		await dom.close();
		retained.clear();
	});
	return { dom, renderer, doc: dom.document };
}

it("adds the selected title first only to exact own cards in either game color and game history", () => {
	const { doc, renderer } = boot(
		block("zurdo1969", "cc-user-block-small cc-user-block-white") +
			block("Zurdo1969", "cc-user-block-small cc-user-block-black") +
			block(
				"zurdo1969",
				"cc-user-block-boldest cc-user-block-small game-history-user-tagline-user-block",
				native
			) +
			block("Bab3s", "cc-user-block-small cc-user-block-black", native) +
			block("zurdo19690")
	);
	const cards = [...doc.querySelectorAll(".cc-user-block-component")];
	const others = cards.slice(3).map((card) => card.outerHTML);
	renderer.set("GM");
	for (const card of cards.slice(0, 3)) {
		expect(card.firstElementChild?.tagName).toBe("A");
		expect(card.firstElementChild?.getAttribute("href")).toBe(
			"https://www.chess.com/members/titled-players"
		);
		expect(card.firstElementChild?.textContent).toBe("GM");
		expect(card.firstElementChild?.className).toBe("cc-user-title-component cc-text-x-small-bold");
	}
	expect(cards.slice(3).map((card) => card.outerHTML)).toEqual(others);
	const identity = cards[0]?.firstElementChild;
	renderer.set("IM");
	expect(cards[0]?.firstElementChild).toBe(identity);
	expect(identity?.textContent).toBe("IM");
	renderer.set(null);
	expect(cards[2]?.firstElementChild?.outerHTML).toBe(native);
	expect(cards[0]?.querySelector(".cc-user-title-component")).toBeNull();
});

it("handles text-only history names without matching display names or contradictory profile links", () => {
	const { doc, renderer } = boot(
		'<div class="cc-user-block-component"><div data-test-element="user-tagline-username">zurdo1969</div></div>' +
			block("zurdo1969") +
			block("Bab3s")
	);
	doc.querySelector("a.cc-user-username-component")?.setAttribute("href", "/member/Bab3s");
	renderer.set("NM");
	expect(doc.querySelectorAll(".cc-user-title-component")).toHaveLength(1);
});

it("adds the large title and profile crown only when the profile route and main identity both match", () => {
	const { doc, dom, renderer } = boot(
		block("zurdo1969", "cc-user-block-large") +
			'<div class="cc-section profile-badges"><div class="profile-badge"><span>Diamond Member</span></div></div>'
	);
	renderer.set("FM");
	expect(doc.querySelector(".cc-user-title-component")?.className).toBe(
		"cc-user-title-component cc-text-x-large-bold"
	);
	expect(doc.querySelector(".profile-badges .badges-extra")?.textContent).toBe("FIDE Master");
	expect(doc.querySelector('.profile-badges svg[data-glyph="game-crown-2"]')).not.toBeNull();
	const badge = doc.querySelector(".profile-badges")?.firstElementChild;
	expect(badge?.tagName).toBe("A");
	expect(badge?.getAttribute("href")).toBe("https://www.chess.com/members/titled-players");
	// A streak inserted by the page belongs before the title, even after a previous render.
	const streak = doc.createElement("div");
	streak.className = "profile-badge";
	streak.innerHTML = '<span class="streak-badge-name">173 Day Streak</span>';
	doc.querySelector(".profile-badges")?.append(streak);
	renderer.set("FM");
	expect(streak.nextElementSibling === badge).toBe(true);
	streak.remove();
	renderer.set("FM");
	expect(doc.querySelector(".profile-badges")?.firstElementChild === badge).toBe(true);
	dom.window.history.pushState({}, "", "/member/Bab3s");
	renderer.set("FM");
	expect(doc.querySelector(".profile-badges .badges-titled")).toBeNull();
	expect(doc.querySelector(".profile-badges")?.textContent).toBe("Diamond Member");
});

it("will not decorate somebody else's profile badges using an own card elsewhere on the page", () => {
	const { doc, renderer } = boot(
		block("Bab3s", "cc-user-block-large") + block("zurdo1969") + '<div class="profile-badges"></div>'
	);
	renderer.set("CM");
	expect(doc.querySelector(".profile-badges")?.childElementCount).toBe(0);
	expect(doc.querySelector(".cc-user-block-large .cc-user-title-component")).toBeNull();
});

it("adds both popover badges under ratings, then removes them when the same popover is recycled", async () => {
	const { doc, renderer } = boot(popover("zurdo1969") + popover("Bab3s"));
	const other = doc.querySelectorAll(".user-popover-content")[1];
	const untouched = other?.outerHTML;
	renderer.set("CM");
	const mine = doc.querySelector(".user-popover-content");
	expect(mine?.querySelector(".user-popover-tagline")?.firstElementChild?.textContent).toBe("CM");
	expect(mine?.querySelector(".user-popover-ratings")?.nextElementSibling?.className).toBe(
		"user-popover-badges-component"
	);
	expect(mine?.querySelector(".user-popover-badges-label")?.textContent).toBe("Candidate Master");
	expect(other?.outerHTML).toBe(untouched);
	const name = mine?.querySelector(".cc-user-username-component");
	if (!name || !mine) throw new Error("missing popover");
	name.textContent = "Bab3s";
	name.setAttribute("href", "/member/bab3s");
	await waitFor(() => !mine.querySelector(".cc-user-title-component"));
	expect(mine.querySelector(".user-popover-badges-component")).toBeNull();
});

it("rejects a popover whose avatar contradicts its matching tagline", () => {
	const { doc, renderer } = boot(popover("zurdo1969"));
	doc.querySelector(".user-popover-avatar")?.setAttribute("href", "/member/Bab3s");
	renderer.set("GM");
	expect(doc.querySelector(".cc-user-title-component")).toBeNull();
	expect(doc.querySelector(".user-popover-badges-component")).toBeNull();
});

it("preserves native profile and popover badges, restoring genuine title markup on disable", () => {
	const html =
		block("zurdo1969", "cc-user-block-large", native) +
		'<div class="profile-badges"><a class="profile-badge"><div class="badges-titled"></div><span>National Master</span></a></div>' +
		popover("zurdo1969").replace(
			"</div></div>",
			'<div class="user-popover-badges-component"><div class="user-popover-badges-titled">National Master</div><div class="user-popover-badges-blogger">Top Blogger</div></div></div></div>'
		);
	const { doc, renderer } = boot(html);
	const before = doc.body.innerHTML;
	renderer.set("GM");
	expect(doc.querySelector(".user-popover-badges-blogger")?.textContent).toBe("Top Blogger");
	renderer.set(null);
	expect(doc.body.innerHTML).toBe(before);
});

it("handles account changes, missing identity, duplicate sidebar links and dynamically inserted cards", async () => {
	const { doc, renderer } = boot(block("zurdo1969") + block("Bab3s"));
	renderer.set("GM");
	const profile = doc.querySelector(".sidebar-link");
	profile?.setAttribute("href", "/member/Bab3s");
	await waitFor(
		() => doc.querySelectorAll(".cc-user-block-component")[1]?.firstElementChild?.textContent === "GM"
	);
	expect(doc.querySelector(".cc-user-block-component")?.firstElementChild?.textContent).toBe(
		"zurdo1969"
	);
	doc.body.insertAdjacentHTML("beforeend", block("Bab3s"));
	await waitFor(() => doc.querySelectorAll(".cc-user-title-component").length === 2);
	doc.body.insertAdjacentHTML("afterbegin", account);
	await waitFor(() => doc.querySelectorAll(".cc-user-title-component").length === 0);
	for (const link of doc.querySelectorAll(".sidebar-link")) link.remove();
	renderer.set("IM");
	expect(doc.querySelector(".cc-user-title-component")).toBeNull();
});

it.each([
	"https://evil.test/member/zurdo1969",
	"/member/zurdo1969/extra",
	"/member/zurdo1969%2FBab3s",
	"javascript:alert(1)",
])("rejects malformed or external sidebar profile identity: %s", (href) => {
	const { doc, renderer } = boot(
		block("zurdo1969"),
		"/game/live/123",
		account.replace("https://www.chess.com/member/zurdo1969", href)
	);
	renderer.set("GM");
	expect(doc.querySelector(".cc-user-title-component")).toBeNull();
});
