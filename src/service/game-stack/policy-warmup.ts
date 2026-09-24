import type { MaiaSize } from "@core/constants/maia";
import { maiaSizeForGame } from "@service/game-session/maia-session";
import type { PolicyInferPort } from "@service/handlers/engine/policy-infer";

export interface PolicyWarmupDeps {
	/** The active targets of every live session. */
	liveTargets(): number[];
	/** `Settings.enabled`: nothing is warmed while the assistant is off. */
	enabled(): boolean;
	transport: {
		warmPolicySize(): MaiaSize | undefined;
		setWarmPolicy(size: MaiaSize | undefined): void;
	};
	policy: Pick<PolicyInferPort, "warm">;
}

/**
 * The Maia size the offscreen document keeps resident: the first of `targetElo` and the live
 * sessions' targets that plays at a Maia size. The size the game plays at is also what a
 * *recreated* offscreen document must pre-load: `configure` is re-sent on every reconnect and
 * carries `warmPolicy`, so without this a document torn down mid-game would come back warming
 * only the default size while the session's dedupe still believed the right one was resident.
 */
export function policyWarmup(deps: PolicyWarmupDeps): (targetElo: number) => void {
	return (targetElo) => {
		const targets = [targetElo, ...deps.liveTargets()];
		const size = deps.enabled()
			? (targets.map(maiaSizeForGame).find((candidate) => candidate !== null) ?? undefined)
			: undefined;
		const previous = deps.transport.warmPolicySize();
		deps.transport.setWarmPolicy(size);
		if (size !== undefined && previous !== size) deps.policy.warm(size);
	};
}
