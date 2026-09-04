// test/setup.ts
/**
 * Bun test preload — installs the extension simulator's `chrome` global
 * (Task 8), the compile-time `define` constants the bundler injects into
 * shipped code, and an in-memory IndexedDB.
 *
 * `globalThis.__sim` is the simulator behind the global `chrome`; tests that
 * need the fakes' inspection helpers reach it with `getSimulator()` from
 * `@test/sim` or `(globalThis as { __sim: Simulator }).__sim`.
 */

import "fake-indexeddb/auto";
import { createSimulator } from "@test/sim";

const g = globalThis as Record<string, unknown>;

g.__SL_VERSION__ = "test";
g.__SL_BUILD__ = "test";
g.__SL_SPOOF_SEED__ = "deadbeef01234567deadbeef01234567";
g.__SL_LICENSE_URL__ = "https://license.test/";
g.__SL_LICENSE_ENFORCE__ = false;
g.__SL_DEBUG__ = true;

const sim = createSimulator();
// One loaded, active chess.com tab so `chrome.tabs.query({ active: true })` is never empty.
sim.openTab("https://www.chess.com/play/online", { active: true });

g.chrome = sim.chrome;
g.__sim = sim;
