/**
 * The hidden cat-facts view (Appendix F §4.10): opened as a popover with one fact and an
 * "Another" button. Same tokens, no special styling, not in the navigation.
 */

import { createButton } from "../components/button";
import { openPopover, type PopoverHandle } from "../components/popover";
import { COPY } from "../copy";
import { instantiate, part } from "../template";
import html from "./templates/cat-facts.html?raw";

const FACTS: readonly string[] = COPY.catFacts.facts;

/** A fact index different from `previous` (uniform over the rest). */
function nextIndex(previous: number): number {
	if (FACTS.length < 2) return 0;
	const offset = 1 + Math.floor(Math.random() * (FACTS.length - 1));
	return (previous + offset) % FACTS.length;
}

export function openCatFacts(anchor: HTMLElement): PopoverHandle {
	const el = instantiate(html);
	const fact = part(el, ".sl-catfacts__fact");
	let index = Math.floor(Math.random() * FACTS.length);
	fact.textContent = FACTS[index] ?? "";
	const another = createButton(part(el, ".sl-catfacts__actions"), {
		label: COPY.catFacts.another,
		variant: "ghost",
		size: "sm",
		onClick: () => {
			index = nextIndex(index);
			fact.textContent = FACTS[index] ?? "";
		},
	});
	return openPopover(anchor, el, {
		title: COPY.catFacts.title,
		onClose: () => another.dispose(),
	});
}
