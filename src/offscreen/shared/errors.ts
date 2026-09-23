// src/offscreen/shared/errors.ts
/** The text of a thrown value, for logs and for the `error` fields the port carries. */
export function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
