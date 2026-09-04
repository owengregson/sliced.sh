/** Human-readable text for a thrown value (`Error.message`, falling back to `String(error)`). */
export function errorMessage(error: unknown): string {
	if (error instanceof Error) return error.message || String(error);
	return String(error);
}
