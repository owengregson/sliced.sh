// The check registries' order is the order problems are reported in, and part of the contract.
import { describe, expect, it } from "bun:test";
import { SOURCE_RULES } from "../../scripts/check-constants";
import { DIST_CHECKS } from "../../scripts/verify-dist";

describe("check registries", () => {
	it("verify-dist runs its checks in the documented rule order", () => {
		expect(DIST_CHECKS.map((c) => c.name)).toEqual([
			"manifest",
			"references",
			"budgets",
			"bundle-content",
			"source-maps",
			"packaged-models",
			"junk-files",
			"engine-dir",
		]);
	});

	it("check-constants fails on the first source rule with hits, in this order", () => {
		expect(SOURCE_RULES.map((r) => r.name)).toEqual([
			"duplicate-constants",
			"forbidden-page-apis",
			"url-literals",
		]);
	});
});
