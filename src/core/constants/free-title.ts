/** Local cosmetic titles; no account or server-side title is changed. */
export const FREE_TITLES = {
	GM: "Grandmaster",
	IM: "International Master",
	NM: "National Master",
	FM: "FIDE Master",
	CM: "Candidate Master",
} as const;

export type FreeTitle = keyof typeof FREE_TITLES;

export const FREE_TITLE_PROFILE_PATH = "/members/titled-players";

export const FREE_TITLE_ART = {
	crown:
		"m19 20v2h-14v-2zm-17.73-13.43c1.03-1.03 2.2-1.03 2.9-.33.57.57.67 1.4 0 2.4l3.07 2.27c.07.07.23.03.3-.07l2.83-4h-.5c-1.1 0-1.57-.77-1.57-1.5 0-.8.7-1.5 1.57-1.5h.63v-.73c0-.9.7-1.6 1.5-1.6.83 0 1.5.7 1.5 1.6v.73h.63c.87 0 1.57.7 1.57 1.5 0 .73-.47 1.5-1.57 1.5h-.5l2.87 4c.07.1.17.13.27.07l3.03-2.23c-.67-1-.57-1.87.03-2.43.7-.73 1.87-.7 2.9.33l-3.73 11.43h-14zm0 0",
} as const;
