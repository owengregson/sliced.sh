// scripts/lib/junk-files.ts — files that are never part of a package.

/**
 * Finder / Explorer / AppleDouble droppings: the copy step filters them out and `verify-dist`
 * fails a tree that still holds one (three `.DS_Store`s shipped in the 2026-09-13 zip).
 */
export const JUNK_FILE_RE = /^(?:\.DS_Store|Thumbs\.db|desktop\.ini|\._.+)$/;
