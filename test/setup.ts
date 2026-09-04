// test/setup.ts
/**
 * Bun test preload — installs the compile-time `define` constants the bundler
 * injects into shipped code, plus a placeholder `chrome` global (replaced by
 * the simulator in Task 8) and an in-memory IndexedDB.
 */

import "fake-indexeddb/auto";

const g = globalThis as Record<string, unknown>;

g.__SL_VERSION__ = "test";
g.__SL_BUILD__ = "test";
g.__SL_SPOOF_SEED__ = "deadbeef01234567deadbeef01234567";
g.__SL_LICENSE_URL__ = "https://license.test/";
g.__SL_LICENSE_ENFORCE__ = false;
g.__SL_DEBUG__ = true;

g.chrome = {} as never;
