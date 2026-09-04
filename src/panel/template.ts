/**
 * Template instantiation for `?raw` HTML imports (global constraint: no inline HTML in `.ts`).
 * Each template string is parsed once through a `<template>` element and cloned per use.
 */

const cache = new Map<string, HTMLTemplateElement>();

function parse(html: string): HTMLTemplateElement {
	let tpl = cache.get(html);
	if (!tpl) {
		tpl = document.createElement("template");
		tpl.innerHTML = html;
		cache.set(html, tpl);
	}
	return tpl;
}

/** Clone the template's content as a fragment. */
export function cloneTemplate(html: string): DocumentFragment {
	return parse(html).content.cloneNode(true) as DocumentFragment;
}

/** Clone the template and return its first element (templates are single-rooted). */
export function instantiate<T extends HTMLElement = HTMLElement>(html: string): T {
	const fragment = cloneTemplate(html);
	const root = fragment.firstElementChild;
	if (!root) throw new Error("template has no root element");
	return root as T;
}

/** `querySelector` inside a component root that throws when the anatomy is missing. */
export function part<T extends HTMLElement = HTMLElement>(root: ParentNode, selector: string): T {
	const el = root.querySelector<T>(selector);
	if (!el) throw new Error(`template part not found: ${selector}`);
	return el;
}

export function partOrNull<T extends HTMLElement = HTMLElement>(
	root: ParentNode,
	selector: string
): T | null {
	return root.querySelector<T>(selector);
}
