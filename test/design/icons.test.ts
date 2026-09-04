// test/design/icons.test.ts — icon registry + vendored Font Awesome verification (Task 7, §10.3).
import { expect, it } from "bun:test";
import { findMissingIcons, verifyIcons } from "../../scripts/gen-icons";
import { ICONS } from "../../src/design/icons";

const FAKE_CSS =
	'.fa-solid,.fas{font-weight:900}.fa-fw{--fa-width:1.25em}.fa-play{--fa:"\\f04b"}.fa-close,.fa-xmark{--fa:"\\f00d"}';

it("transcribes every Appendix F §2.6 entry (60 semantic names)", () => {
	expect(Object.keys(ICONS)).toHaveLength(60);
	expect(ICONS["nav.game"]).toBe("fa-solid fa-chess-knight");
	expect(ICONS["social.discord"]).toBe("fa-brands fa-discord");
	expect(ICONS["feedback.hourglass"]).toBe("fa-regular fa-hourglass-half");
	for (const v of Object.values(ICONS))
		expect(v).toMatch(/^fa-(solid|regular|brands)( fa-[a-z0-9-]+)+$/);
});

it("finds glyph tokens missing from a stylesheet, ignoring style classes", () => {
	expect(
		findMissingIcons(FAKE_CSS, { a: "fa-solid fa-play", b: "fa-solid fa-xmark fa-fw" })
	).toEqual([]);
	expect(findMissingIcons(FAKE_CSS, { a: "fa-solid fa-nope" })).toEqual([
		{ name: "a", token: "fa-nope" },
	]);
	expect(findMissingIcons(FAKE_CSS, { a: "fa-solid play" })).toEqual([{ name: "a", token: "play" }]);
});

it("every ICONS glyph exists in the vendored all.min.css", () => {
	expect(() => verifyIcons()).not.toThrow();
});
