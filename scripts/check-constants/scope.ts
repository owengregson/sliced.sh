// scripts/check-constants/scope.ts — which source directories each rule treats specially.

/** Registry files: the one place a namespaced literal, a marked number or a URL may be defined. */
export const REGISTRY_DIRS = [
	"src/core/constants/",
	"src/design/",
	"src/content/adapters/selectors.ts",
];

/** Directories whose sources run in or beside the host page (§13.3 rule 2). */
export const PAGE_REALM_DIRS = ["src/content/", "src/page/"];

/** Directory `gen:pagescript` writes the emitted programs to (repo-relative). */
export const GENERATED_PAGE_DIR = "src/page/generated/";

export function isRegistryFile(f: string): boolean {
	return REGISTRY_DIRS.some((d) => f.startsWith(d) || f === d);
}
