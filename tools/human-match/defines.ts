/**
 * tools/human-match/defines.ts — kept at its historical path for the entry scripts that import it
 * first; the globals live in `tools/lib/defines.ts` (which `tools/calibration/` imports directly).
 * Must still be the **first** import of an entry script: re-exporting a side-effect module keeps
 * its evaluation before every later import.
 */

import "../lib/defines";
