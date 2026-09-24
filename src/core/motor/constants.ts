/**
 * Motor design constants — every number of Part I §9.3–§9.5 and Appendix G
 * §2.3, §7–§8 lives here exactly once (C1). Rates are design constants (V2.3:
 * no behaviour dataset); the conformance harness checks plausibility bands.
 *
 * The registry is split by domain under `./constants/`; this file is its single entry point.
 */

export * from "./constants/exploration";
export * from "./constants/gesture";
export * from "./constants/modulation";
export * from "./constants/opponent-exploration";
export * from "./constants/pointer";
export * from "./constants/preview";
