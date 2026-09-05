// test/panel/views/login.test.ts — Appendix F §4.1 / §7.2: the login view collects the key with
// auto-formatting, submits on Enter / paste / Continue, maps every `LicenseState` to its hint,
// locks the button width while loading and never takes focus. §4.10: seven clicks on the mark.
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { IMAGES, LICENSE_FORCE_VALID, LIMITS, MSG, UI_TIMINGS } from "@core/constants";
import { ANIM } from "@panel/animation-manager";
import { COPY } from "@panel/copy";
import { caretAfterFormat, formatLicenseKey, isCompleteLicenseKey } from "@panel/views/license-key";
import { loginView } from "@panel/views/login";
import type { LicenseState } from "@typedefs/settings";
import { bootPanelDom, click, key, mount, type PanelDom } from "../dom";
import { makeSnapshot } from "../fixtures";
import { type FakeStore, fakeStore, makeContext } from "./fake-store";

let dom: PanelDom;
let cleanup: (() => void) | null = null;
let store: FakeStore;
let container: HTMLElement;

beforeEach(async () => {
	dom = await bootPanelDom();
	store = fakeStore(makeSnapshot({ license: "unknown" }));
	container = mount(document.createElement("main"));
});
afterEach(async () => {
	cleanup?.();
	cleanup = null;
	await dom.teardown();
});

async function mountLogin(): Promise<void> {
	cleanup = await loginView.mount(makeContext(container, store));
}

const input = (): HTMLInputElement => {
	const el = container.querySelector<HTMLInputElement>(".sl-input__control");
	if (!el) throw new Error("no input");
	return el;
};
const button = (): HTMLButtonElement => {
	const el = container.querySelector<HTMLButtonElement>(".sl-login__submit .sl-button");
	if (!el) throw new Error("no submit button");
	return el;
};
const hint = (): string => container.querySelector(".sl-input__hint")?.textContent ?? "";

function type(value: string): void {
	input().value = value;
	input().dispatchEvent(new Event("input", { bubbles: true }));
}
function paste(value: string): void {
	input().dispatchEvent(new Event("paste", { bubbles: true, cancelable: true }));
	type(value);
}
function license(status: LicenseState["status"], extra: Partial<LicenseState> = {}): void {
	const snapshot = makeSnapshot({ license: status });
	snapshot.license = { ...snapshot.license, ...extra };
	store.emit(snapshot);
}

describe("formatLicenseKey", () => {
	it("uppercases, strips the prefix and dashes into SL-XXXX-XXXX-XXXX", () => {
		expect(formatLicenseKey("")).toBe("");
		expect(formatLicenseKey("S")).toBe("SL-");
		expect(formatLicenseKey("sl")).toBe("SL-");
		expect(formatLicenseKey("SL-")).toBe("SL-");
		expect(formatLicenseKey("7f3")).toBe("SL-7F3");
		expect(formatLicenseKey("SL-7F3K")).toBe("SL-7F3K");
		expect(formatLicenseKey("SL-7F3K1")).toBe("SL-7F3K-1");
		expect(formatLicenseKey("sl7f3kab12cd34")).toBe("SL-7F3K-AB12-CD34");
		expect(formatLicenseKey("SL-7F3K-AB12-CD34-EXTRA")).toBe("SL-7F3K-AB12-CD34");
		expect(formatLicenseKey(" sl 7f3k_ab12.cd34 ")).toBe("SL-7F3K-AB12-CD34");
		expect(formatLicenseKey("l")).toBe("SL-");
		expect(isCompleteLicenseKey("SL-7F3K-AB12-CD34")).toBe(true);
		expect(isCompleteLicenseKey("SL-7F3K-AB12-CD3")).toBe(false);
	});

	it("shrinking edits never re-add the prefix or a trailing dash; the caret follows the edit", () => {
		expect(formatLicenseKey("SL", "SL-")).toBe("");
		expect(formatLicenseKey("S", "SL")).toBe("");
		expect(formatLicenseKey("SL-", "SL-7")).toBe("");
		expect(formatLicenseKey("SL-7F3K", "SL-7F3K-1")).toBe("SL-7F3K");
		expect(formatLicenseKey("SL-7F3KAB12", "SL-7F3K-AB12-C")).toBe("SL-7F3K-AB12");
		// Growing from a shrunken state re-adds the separators.
		expect(formatLicenseKey("SL-7F3K1", "SL-7F3K")).toBe("SL-7F3K-1");
		// Caret: after the inserted character for a mid-string edit, at the end for typing.
		expect(caretAfterFormat("SL-7FX3K-AB12", 6, "SL-7FX3-KAB1-2")).toBe(6);
		expect(caretAfterFormat("SL-7F3K1", 8, "SL-7F3K-1")).toBe(9);
		expect(caretAfterFormat("7F", 2, "SL-7F")).toBe(5);
		expect(caretAfterFormat("S", 1, "SL-")).toBe(3); // nothing but separators left: the end
		expect(caretAfterFormat("SL-7F3K-AB12-CD34", 0, "SL-7F3K-AB12-CD34")).toBe(0);
	});

	it("typing the prefix into a field that already shows it never doubles it", () => {
		// The prefix in progress: S, L and - are consumed, not turned into body.
		expect(formatLicenseKey("SL-L", "SL-")).toBe("SL-");
		expect(formatLicenseKey("SL-l", "SL-")).toBe("SL-");
		expect(formatLicenseKey("SL--", "SL-")).toBe("SL-");
		expect(formatLicenseKey("SLL-", "SL-")).toBe("SL-"); // caret before the dash
		expect(formatLicenseKey("SL-7", "SL-")).toBe("SL-7");
		expect(formatLicenseKey("SL-S7", "SL-")).toBe("SL-7");
		// Index-0 insertion into an already-prefixed value keeps the shown prefix as prefix.
		expect(formatLicenseKey("SSL-7F3K", "SL-7F3K")).toBe("SL-7F3K");
		expect(formatLicenseKey("-SL-7F3K", "SL-7F3K")).toBe("SL-7F3K");
		expect(formatLicenseKey("SLSL-7F3K", "SL-7F3K")).toBe("SL-7F3K");
		expect(formatLicenseKey("7SL-7F3K", "SL-7F3K")).toBe("SL-77F3-K");
		// A paste after the prefix in progress still reads as a whole key.
		expect(formatLicenseKey("SL-SL-7F3K-AB12-CD34", "SL-")).toBe("SL-7F3K-AB12-CD34");
		expect(formatLicenseKey("SL-7f3kab12cd34", "SL-")).toBe("SL-7F3K-AB12-CD34");
		// Outside the prefix zone nothing changes.
		expect(formatLicenseKey("SL-7F3K-", "SL-7F3K")).toBe("SL-7F3K");
		expect(formatLicenseKey("SL-7F3KA", "SL-7F3K")).toBe("SL-7F3K-A");
	});
});

describe("loginView", () => {
	it("renders the §4.1 anatomy from copy and focuses nothing", async () => {
		await mountLogin();
		const root = container.querySelector<HTMLElement>("[data-view=login]");
		expect(root).not.toBeNull();
		const mark = container.querySelector<HTMLImageElement>(".sl-login__mark");
		expect(mark?.getAttribute("src")).toContain(IMAGES.mark);
		expect(mark?.getAttribute("width")).toBe("64");
		expect(mark?.getAttribute("height")).toBe("64");
		expect(container.querySelector(".sl-view__title")?.textContent).toBe(COPY.login.title);
		expect(container.querySelector(".sl-login__tagline")?.textContent).toBe(COPY.login.subtitle);
		expect(container.querySelector(".sl-input__label")?.textContent).toBe(COPY.login.fieldLabel);
		expect(input().classList.contains("sl-type-mono")).toBe(true);
		expect(input().getAttribute("placeholder")).toBe(COPY.loginView.placeholder);
		expect(container.querySelector(".sl-input")?.classList.contains("sl-input--lg")).toBe(true);
		expect(hint()).toBe(COPY.login.hint);
		expect(button().textContent?.trim()).toBe(COPY.login.button);
		expect(button().classList.contains("sl-button--primary")).toBe(true);
		expect(button().classList.contains("sl-button--lg")).toBe(true);
		const link = container.querySelector<HTMLElement>(".sl-login__link [data-action=open-url]");
		expect(link?.dataset.url).toBe("website");
		expect(container.querySelector(".sl-login__link")?.textContent).toContain(COPY.login.link);
		expect(container.querySelector(".sl-login__version")?.textContent).toBe(
			COPY.loginView.version(__SL_VERSION__)
		);
		// No community link ships until a real invite exists (review ruling): the footer has
		// the version only, and no dead `open-url` targets.
		expect(container.querySelectorAll(".sl-login__footer [data-action]")).toHaveLength(0);
		expect(container.querySelector(".sl-icon[data-icon]")?.className).toContain("fa-fw");
		expect(document.activeElement).toBe(document.body);
	});

	it("auto-formats the key while typing and toggles reveal", async () => {
		await mountLogin();
		type("s");
		expect(input().value).toBe("SL-");
		type("SL-7f3k");
		expect(input().value).toBe("SL-7F3K");
		type("SL-7F3Kab12cd34xx");
		expect(input().value).toBe("SL-7F3K-AB12-CD34");
		expect(input().type).toBe("text");
		const eye = container.querySelector<HTMLButtonElement>(".sl-input__trailing");
		expect(eye?.getAttribute("aria-label")).toBe(COPY.login.hide);
		if (eye) click(eye);
		expect(input().type).toBe("password");
		expect(eye?.getAttribute("aria-label")).toBe(COPY.login.reveal);
	});

	it("Backspace walks back to an empty field and a mid-string edit keeps the caret", async () => {
		await mountLogin();
		type("SL-7");
		expect(input().value).toBe("SL-7");
		type("SL-"); // Backspace removed the 7
		expect(input().value).toBe("");
		type("S");
		expect(input().value).toBe("SL-");
		type("SL"); // Backspace removed the dash
		expect(input().value).toBe("");
		// Insert an X after "7F" with the caret there: the value re-flows, the caret stays after X.
		type("SL-7F3K-AB12");
		input().value = "SL-7FX3K-AB12";
		input().setSelectionRange(6, 6);
		input().dispatchEvent(new Event("input", { bubbles: true }));
		expect(input().value).toBe("SL-7FX3-KAB1-2");
		expect(input().selectionStart).toBe(6);
		expect(input().selectionEnd).toBe(6);
	});

	it("typing the key as printed, one character at a time, yields SL-7F3K-AB12-CD34 and submits", async () => {
		await mountLogin();
		let typed = "";
		for (const ch of "sl-7f3k-ab12-cd34") {
			// Each keystroke inserts at the caret, which sits at the end after every format pass.
			const caret = input().selectionStart ?? input().value.length;
			typed = input().value.slice(0, caret) + ch + input().value.slice(caret);
			input().value = typed;
			input().setSelectionRange(caret + 1, caret + 1);
			input().dispatchEvent(new Event("input", { bubbles: true }));
		}
		expect(input().value).toBe("SL-7F3K-AB12-CD34");
		expect(input().selectionStart).toBe("SL-7F3K-AB12-CD34".length);
		expect(store.dispatched).toEqual([]); // typing never auto-submits (§4.1: paste does)
		key(input(), "keydown", { key: "Enter", code: "Enter" });
		expect(store.dispatched).toEqual([{ type: MSG.PANEL_LOGIN, key: "SL-7F3K-AB12-CD34" }]);
	});

	it("inserting a prefix character at index 0 of a prefixed value is dropped; a body character joins the body", async () => {
		await mountLogin();
		type("SL-7F3K");
		input().value = "SSL-7F3K";
		input().setSelectionRange(1, 1);
		input().dispatchEvent(new Event("input", { bubbles: true }));
		expect(input().value).toBe("SL-7F3K");
		expect(input().selectionStart).toBe(0);
		input().value = "7SL-7F3K";
		input().setSelectionRange(1, 1);
		input().dispatchEvent(new Event("input", { bubbles: true }));
		expect(input().value).toBe("SL-77F3-K");
		expect(input().selectionStart).toBe(4); // right after the inserted 7
	});

	it("Enter submits: dispatches PANEL_LOGIN, locks the width and shows the loading label", async () => {
		await mountLogin();
		type("SL-7F3K-AB12-CD34");
		const pending = store.hold();
		button().getBoundingClientRect = () => ({ width: 200 }) as DOMRect;
		key(input(), "keydown", { key: "Enter", code: "Enter" });
		expect(store.dispatched).toEqual([{ type: MSG.PANEL_LOGIN, key: "SL-7F3K-AB12-CD34" }]);
		expect(button().style.width).toBe("200px");
		expect(button().classList.contains("sl-button--loading")).toBe(true);
		expect(button().getAttribute("aria-busy")).toBe("true");
		expect(button().getAttribute("aria-disabled")).toBe("true");
		expect(button().textContent?.trim()).toBe(COPY.login.loading);
		// A second Enter while loading does not dispatch again.
		key(input(), "keydown", { key: "Enter", code: "Enter" });
		expect(store.dispatched).toHaveLength(1);
		pending.settle({ status: "invalid", checkedAt: 1 } satisfies LicenseState);
		await dom.tick(0);
		expect(button().style.width).toBe("");
		expect(button().classList.contains("sl-button--loading")).toBe(false);
		expect(button().textContent?.trim()).toBe(COPY.login.button);
		// The reply is reflected before the next snapshot arrives.
		expect(hint()).toBe(COPY.login.invalid);
		expect(input().getAttribute("aria-invalid")).toBe("true");
	});

	it("force-valid: an empty key still submits (the SW unlocks regardless)", async () => {
		expect(LICENSE_FORCE_VALID).toBe(true);
		await mountLogin();
		click(button());
		expect(store.dispatched).toEqual([{ type: MSG.PANEL_LOGIN, key: "" }]);
	});

	it("paste of a full key submits after duration.6; a partial paste does not", async () => {
		await mountLogin();
		paste("SL-7F3K-AB12");
		await dom.tick(ANIM.duration[6]);
		expect(store.dispatched).toEqual([]);
		paste("sl7f3kab12cd34");
		expect(input().value).toBe("SL-7F3K-AB12-CD34");
		expect(store.dispatched).toEqual([]);
		await dom.tick(ANIM.duration[6] - 1);
		expect(store.dispatched).toEqual([]);
		await dom.tick(1);
		expect(store.dispatched).toEqual([{ type: MSG.PANEL_LOGIN, key: "SL-7F3K-AB12-CD34" }]);
	});

	it("a padded paste is trimmed, formatted and still auto-submits", async () => {
		await mountLogin();
		paste("  sl-7f3k-ab12-cd34\n");
		expect(input().value).toBe("SL-7F3K-AB12-CD34");
		await dom.tick(ANIM.duration[6]);
		expect(store.dispatched).toEqual([{ type: MSG.PANEL_LOGIN, key: "SL-7F3K-AB12-CD34" }]);
	});

	it("clears the paste timer on cleanup", async () => {
		await mountLogin();
		paste("SL-7F3K-AB12-CD34");
		cleanup?.();
		cleanup = null;
		await dom.tick(ANIM.duration[6] * 2);
		expect(store.dispatched).toEqual([]);
		expect(container.children).toHaveLength(0);
	});

	it("maps every LicenseState to the §7.2 hint copy", async () => {
		await mountLogin();
		license("unknown");
		expect(hint()).toBe(COPY.login.hint);
		expect(input().hasAttribute("aria-invalid")).toBe(false);

		license("invalid");
		expect(hint()).toBe(COPY.login.invalid);
		expect(input().getAttribute("aria-invalid")).toBe("true");
		expect(container.querySelector(".sl-input")?.classList.contains("sl-input--invalid")).toBe(true);
		expect(container.querySelector(".sl-input__hint--danger")).not.toBeNull();

		license("ip_limit");
		expect(hint()).toBe(COPY.login.deviceLimit(LIMITS.licenseMaxDevices));
		const manage = container.querySelector<HTMLElement>(".sl-login__extra .sl-button");
		expect(manage?.textContent?.trim()).toBe(COPY.loginView.manageDevices);
		expect(manage?.dataset.action).toBe("open-url");

		license("network_error");
		expect(hint()).toBe(COPY.login.offline);
		expect(button().textContent?.trim()).toBe(COPY.loginView.tryAgain);
		expect(container.querySelector(".sl-login__extra .sl-button")).toBeNull();

		license("expired", { expiresAt: Date.UTC(2026, 7, 12, 12) });
		expect(hint()).toBe(COPY.login.expired("12 Aug 2026"));
		const renew = container.querySelector<HTMLElement>(".sl-login__extra .sl-button");
		expect(renew?.textContent?.trim()).toBe(COPY.loginView.renew);
		expect(button().textContent?.trim()).toBe(COPY.login.button);

		license("expired");
		expect(hint()).toBe(COPY.loginView.expiredNoDate);

		license("valid");
		expect(hint()).toBe(COPY.login.hint);
		expect(container.querySelector(".sl-login__extra .sl-button")).toBeNull();
	});

	it("a rejected dispatch reads as offline", async () => {
		await mountLogin();
		store.answer(new Error("no receiver"), { reject: true });
		click(button());
		await dom.tick(0);
		expect(hint()).toBe(COPY.login.offline);
		expect(button().textContent?.trim()).toBe(COPY.loginView.tryAgain);
	});

	it("§4.10: seven clicks on the mark within 3 s open the cat-facts popover", async () => {
		await mountLogin();
		const mark = container.querySelector<HTMLElement>(".sl-login__mark");
		if (!mark) throw new Error("no mark");
		for (let i = 0; i < UI_TIMINGS.easterEggClicks - 1; i += 1) click(mark);
		expect(document.querySelector(".sl-popover")).toBeNull();
		await dom.tick(UI_TIMINGS.easterEggWindowMs);
		click(mark); // the window expired: this is click 1 again
		expect(document.querySelector(".sl-popover")).toBeNull();
		for (let i = 0; i < UI_TIMINGS.easterEggClicks - 1; i += 1) click(mark);
		const pop = document.querySelector<HTMLElement>(".sl-popover");
		expect(pop).not.toBeNull();
		expect(pop?.querySelector(".sl-popover__title")?.textContent).toBe(COPY.catFacts.title);
		const facts: readonly string[] = COPY.catFacts.facts;
		const fact = pop?.querySelector(".sl-catfacts__fact")?.textContent ?? "";
		expect(facts).toContain(fact);
		const another = pop?.querySelector<HTMLElement>(".sl-catfacts__actions .sl-button");
		expect(another?.textContent?.trim()).toBe(COPY.catFacts.another);
		if (another) click(another);
		const next = pop?.querySelector(".sl-catfacts__fact")?.textContent ?? "";
		expect(next).not.toBe(fact);
		expect(facts).toContain(next);
		expect(document.activeElement).toBe(document.body);
		cleanup?.();
		cleanup = null;
		await dom.tick(0);
		expect(document.querySelector(".sl-popover")).toBeNull();
	});
});
